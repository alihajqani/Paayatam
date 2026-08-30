import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { PERMISSIONS, type Permission, type RoleKey } from './permissions';

/**
 * What a moderator may do **from the bot**, and nothing else (ADR-0018).
 *
 * ── Why this list is hard-coded and not a role ──────────────────────────────
 *
 * A role is data an operator edits; this is the boundary of a *channel*. The bot
 * authenticates with a Telegram account and no second factor — no password, no
 * TOTP, no CSRF token, no session that can be revoked from Redis in a second —
 * so what it can reach has to be decided in code, by people reading this file,
 * rather than by whoever last edited a row.
 *
 * The test of the list is one question: **what does an attacker who has taken
 * over a moderator's Telegram get?** With this list, a queue of moderation cases
 * and the ability to decide them — which is bad, recoverable, and audited under
 * the moderator's name. With `coin.adjust` on it, the product's currency. With
 * `chat.read`, the private conversations the whole product exists to protect.
 * With `role.manage`, everything, permanently.
 *
 * So: reading the queue, and deciding a case. Adding anything here is an ADR,
 * not a commit.
 */
export const BOT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.EVENT_MODERATE,
  PERMISSIONS.REPORT_REVIEW,
] as const;

/**
 * A moderator's Telegram identity (ADR-0018).
 *
 * ── What this changes about ADR-0010, stated plainly ────────────────────────
 *
 * ADR-0010's second decision reads: *"the identity system is separate, and the
 * separation is the security control … admin access does not follow from a staff
 * member's personal Telegram being taken over."* A moderation queue inside the
 * bot needs precisely that correspondence, so this service is the documented
 * exception and ADR-0018 is the argument for it.
 *
 * Four properties bound the trade, and each one is enforced here rather than
 * described:
 *
 *  1. **The link is granted, never derived.** `link` requires `role.manage`,
 *     takes a reason, and writes an audit row. Nothing about signing into the
 *     panel — and nothing about a Telegram display name matching an admin's —
 *     creates one.
 *  2. **The session is a strict subset.** `sessionFor` intersects the admin's
 *     real permissions with `BOT_PERMISSIONS`, so a `SUPER_ADMIN` on the bot is
 *     a moderator and no more. The intersection is in this direction on purpose:
 *     the bot can never *grant* what a role does not.
 *  3. **`admin_user` still has no foreign key to `user`.** The Telegram id is
 *     carried directly, which keeps the two identity systems disjoint tables.
 *  4. **Revocation is a delete**, exactly as a role revocation is, and it takes
 *     effect on the next update — there is no cached session to outlive it.
 *
 * ── Why there is no session token ───────────────────────────────────────────
 *
 * The panel's session is a Redis key because a browser needs something to carry
 * between requests. A Telegram update carries its sender, verified by the
 * webhook secret and by Telegram itself, on every single call — so the session
 * is *derived per update* and there is nothing to steal, nothing to expire and
 * nothing to leave signed in on a shared machine. That is the one respect in
 * which this channel is stronger than the panel.
 */
@Injectable()
export class AdminTelegramService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The admin session this Telegram account may act under, or null.
   *
   * **Null is the common answer**, and it has to be cheap: every message the bot
   * receives asks this question. One indexed lookup on a UNIQUE column, and the
   * roles only when a link exists.
   *
   * A suspended admin resolves to null, like a missing link — the account being
   * unusable and the link being absent are the same fact from the moderator's
   * side, and distinguishing them in a bot reply would tell whoever holds the
   * Telegram account that it *is* linked to a staff member.
   */
  async sessionFor(telegramUserId: bigint): Promise<AdminSession | null> {
    const link = await this.prisma.adminTelegramLink.findUnique({
      where: { telegramUserId },
      select: {
        adminUser: {
          select: {
            id: true,
            email: true,
            displayName: true,
            status: true,
            roles: { select: { role: { select: { key: true } } } },
          },
        },
      },
    });

    if (link === null) return null;
    const admin = link.adminUser;
    if (admin.status !== 'ACTIVE') return null;

    const roles = admin.roles.map((row) => row.role.key as RoleKey);

    return {
      adminUserId: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      roles,
      /**
       * The intersection, not the union.
       *
       * `permissionsFor` is the same function the panel's login uses, so the two
       * surfaces cannot disagree about what a role grants — and the filter is
       * what makes the bot a narrower door rather than a second one of the same
       * width. A role that loses `event.moderate` loses it here too, on the next
       * update.
       */
      permissions: permissionsFor(roles).filter((permission) =>
        BOT_PERMISSIONS.includes(permission),
      ),
    };
  }

  /**
   * Whether this Telegram account has a moderation queue to open.
   *
   * Used by the worker to decide whether the persistent menu carries the
   * moderation button. Deliberately **not** `sessionFor(...) !== null`: this
   * question is asked on the way to sending an ordinary notification, and it
   * should not load roles to answer a yes/no about a keyboard.
   */
  async isLinked(telegramUserId: bigint): Promise<boolean> {
    const count = await this.prisma.adminTelegramLink.count({
      where: { telegramUserId, adminUser: { status: 'ACTIVE' } },
    });
    return count > 0;
  }

  /**
   * Grant a moderator the bot queue.
   *
   * `role.manage` because this **is** a capability grant: it gives a Telegram
   * account the ability to act as a staff member, which is the same kind of
   * decision as adding a role and is held by `SUPER_ADMIN` alone. Invariant 12
   * in the shape it always takes — `assertPermission` first, `audit.record`
   * last, and neither optional.
   *
   * Refuses rather than overwrites when either side is already linked. An
   * overwrite would silently move somebody else's access, and "who has this"
   * would then be answerable only from the audit log.
   */
  async link(
    session: AdminSession,
    input: { adminUserId: string; telegramUserId: bigint; reason: string },
  ): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.ROLE_MANAGE);

    const reason = input.reason.trim();
    // The same bar `decideCase` sets on its note: a grant nobody explained is not
    // reviewable later.
    if (reason.length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    await this.prisma.$transaction(async (tx) => {
      const subject = await tx.adminUser.findUnique({
        where: { id: input.adminUserId },
        select: { id: true, status: true },
      });
      if (!subject) throw new AppError(ErrorCode.NOT_FOUND);
      if (subject.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

      const clash = await tx.adminTelegramLink.findFirst({
        where: {
          OR: [{ adminUserId: input.adminUserId }, { telegramUserId: input.telegramUserId }],
        },
        select: { id: true },
      });
      if (clash) throw new AppError(ErrorCode.DUPLICATE_REQUEST);

      await tx.adminTelegramLink.create({
        data: {
          adminUserId: input.adminUserId,
          telegramUserId: input.telegramUserId,
          grantedById: session.adminUserId,
          reason,
        },
      });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'admin.telegram_linked',
          targetType: 'admin_user',
          targetId: input.adminUserId,
          /**
           * The Telegram id is **not** in the audit row.
           *
           * Invariant 7 has no exception for `audit_log`, which is read in the
           * panel by anybody holding `audit.read` — a permission `MODERATOR`
           * holds and `user.telegram.read` deliberately is not. What is recorded
           * is that a link was granted, to whom, by whom, and why; the id itself
           * lives in the one table that carries it.
           */
          after: { reason, granted: true },
        },
        tx,
      );
    });
  }

  /**
   * Revoke it.
   *
   * A delete, exactly as a role revocation is, and it takes effect on the very
   * next update — `sessionFor` reads the table every time and there is no cached
   * session anywhere to outlive this.
   *
   * Idempotent from the caller's side is *not* what this is: revoking a link
   * that does not exist answers `NOT_FOUND`, because "I removed their access"
   * and "there was none" are different things for somebody acting on an incident.
   */
  async unlink(session: AdminSession, adminUserId: string, reason: string): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.ROLE_MANAGE);

    const trimmed = reason.trim();
    if (trimmed.length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.adminTelegramLink.findUnique({
        where: { adminUserId },
        select: { id: true },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

      await tx.adminTelegramLink.delete({ where: { id: existing.id } });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'admin.telegram_unlinked',
          targetType: 'admin_user',
          targetId: adminUserId,
          after: { reason: trimmed, granted: false },
        },
        tx,
      );
    });
  }
}
