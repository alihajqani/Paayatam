import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import {
  MessagingService,
  type MessageCampaignSummary,
  type MessageAudience,
} from '../messaging/messaging.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** What an operator is shown before they confirm. A count, never a list. */
export interface AudiencePreview {
  recipients: number;
  /** Which filters actually narrowed, so the preview explains itself. */
  appliedFilters: string[];
  /** The message as validated. Present so the panel renders what will be sent. */
  bodyText: string;
  parseMode: 'HTML' | null;
}

/**
 * A user's Telegram identity, for the one permission that may see it (phase 12).
 *
 * `telegramUserId` is a **string** on the wire and that is not cosmetic:
 * `telegram_account.telegram_user_id` is a BIGINT, `JSON.stringify` throws on a
 * bigint, and the schema notes that as a useful accident — serialising one by
 * mistake fails loudly. Converting deliberately, at the one boundary allowed to,
 * keeps the accident working everywhere else.
 */
export interface TelegramIdentity {
  telegramUserId: string;
  username: string | null;
  /**
   * A link that will actually open, or null.
   *
   * `https://t.me/<username>` when there is a username. **Null otherwise** — and
   * the honest answer rather than a `tg://user?id=…`, which resolves only for a
   * client that already has that peer cached and does nothing at all from a
   * browser. A link that works for the operator who tested it and silently fails
   * for everyone else is worse than no link.
   */
  directLink: string | null;
  /** Why there is no link, so the panel can say so rather than showing a gap. */
  linkUnavailableReason: 'NO_USERNAME' | null;
  botBlocked: boolean;
  lastSeenAt: Date;
}

/**
 * Messaging and Telegram identity, from the panel (M22 phases 4 and 12).
 *
 * A thin layer over `MessagingService` on purpose: everything about *what may be
 * sent and to whom* belongs to the domain, and everything about *who may ask* is
 * here. That split is ADR-0010 rule 2 — the check is in the service the caller
 * reaches, which is this one, and the jobs and scripts that reach `MessagingService`
 * directly are not asking on anybody's behalf.
 *
 * Two permissions rather than one. `message.send` covers a named recipient;
 * `message.broadcast` covers a filter. The blast radius differs by orders of
 * magnitude, a broadcast cannot be recalled, and a mistake in it is the fastest
 * way to get a bot restricted — which would take every other message in the
 * product down with it.
 */
@Injectable()
export class MessagingAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly messaging: MessagingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Which permission an audience needs.
   *
   * An audience naming exactly one user is a direct message; anything else is a
   * broadcast, **including a list of two**. The line is drawn at one rather than
   * at "is a filter", because a hand-written list of four hundred public ids is a
   * broadcast by every measure that matters.
   */
  private assertMayTarget(session: AdminSession, audience: MessageAudience): void {
    const single =
      audience.userPublicIds !== undefined &&
      audience.userPublicIds.length === 1 &&
      audience.cityIds === undefined &&
      audience.status === undefined &&
      audience.profileComplete === undefined &&
      audience.hasHostedEvent === undefined &&
      audience.participatedCategoryIds === undefined &&
      audience.everyone !== true;

    this.access.assertPermission(session, PERMISSIONS.MESSAGE_SEND);
    if (!single) this.access.assertPermission(session, PERMISSIONS.MESSAGE_BROADCAST);
  }

  /**
   * How many people this would reach, and nothing about who they are.
   *
   * The count is the whole answer. Returning even a sample would turn
   * `message.send` into a way to enumerate users by city, by activity or by
   * onboarding state — which is a data export wearing a preview's clothes.
   */
  async preview(
    session: AdminSession,
    input: { audience: MessageAudience; bodyText: string; parseMode?: 'HTML' | undefined },
  ): Promise<AudiencePreview> {
    this.assertMayTarget(session, input.audience);

    const recipients = await this.messaging.estimate(input.audience);

    return {
      recipients,
      appliedFilters: describeAudience(input.audience),
      bodyText: input.bodyText,
      parseMode: input.parseMode ?? null,
    };
  }

  /**
   * Compose a campaign. Still `DRAFT` — nothing is sent by this call.
   *
   * The audit row carries the audience, the recipient count and the body's
   * **length**, never the body. `audit_log` is a surface staff export and a
   * broadcast body is up to four thousand characters; the campaign row is where
   * the text lives, and it is the thing the audit row points at.
   */
  async create(
    session: AdminSession,
    input: {
      kind: 'DIRECT' | 'BROADCAST';
      bodyText: string;
      parseMode?: 'HTML' | undefined;
      audience: MessageAudience;
      dryRun?: boolean | undefined;
      idempotencyKey: string;
    },
  ): Promise<MessageCampaignSummary> {
    this.assertMayTarget(session, input.audience);

    const campaign = await this.messaging.createCampaign({
      kind: input.kind,
      bodyText: input.bodyText,
      ...(input.parseMode !== undefined ? { parseMode: input.parseMode } : {}),
      audience: input.audience,
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      idempotencyKey: input.idempotencyKey,
      actor: { type: 'ADMIN', adminUserId: session.adminUserId },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: campaign.dryRun ? 'message.previewed' : 'message.drafted',
      targetType: 'message_campaign',
      targetId: campaign.publicId,
      after: {
        kind: campaign.kind,
        dryRun: campaign.dryRun,
        recipients: campaign.estimatedRecipients,
        bodyLength: input.bodyText.length,
        parseMode: input.parseMode ?? 'plain',
        audience: describeAudience(input.audience),
      },
    });

    return campaign;
  }

  /**
   * The second button, and the only one that leads to delivery.
   *
   * Re-checks the permission against the campaign's **stored** audience rather
   * than against anything in this request. An operator who could draft it can not
   * necessarily send it, and the draft is where the audience was decided.
   */
  async confirm(session: AdminSession, publicId: string): Promise<MessageCampaignSummary> {
    // The base permission **before** the read, so a session that holds neither key
    // is refused rather than told whether the campaign exists. The audience-aware
    // check follows, against what the draft actually stored.
    this.access.assertPermission(session, PERMISSIONS.MESSAGE_SEND);
    const existing = await this.messaging.get(publicId);
    this.assertMayTarget(session, existing.audience);

    const campaign = await this.messaging.confirm(publicId, session.adminUserId);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'message.confirmed',
      targetType: 'message_campaign',
      targetId: publicId,
      after: { kind: campaign.kind, recipients: campaign.counts.total },
    });

    return campaign;
  }

  async cancel(session: AdminSession, publicId: string): Promise<MessageCampaignSummary> {
    this.access.assertPermission(session, PERMISSIONS.MESSAGE_SEND);
    const existing = await this.messaging.get(publicId);
    this.assertMayTarget(session, existing.audience);

    const campaign = await this.messaging.cancel(publicId, session.adminUserId);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'message.cancelled',
      targetType: 'message_campaign',
      targetId: publicId,
      after: { sent: campaign.counts.sent, skipped: campaign.counts.skipped },
    });

    return campaign;
  }

  async resume(session: AdminSession, publicId: string): Promise<MessageCampaignSummary> {
    this.access.assertPermission(session, PERMISSIONS.MESSAGE_SEND);
    const existing = await this.messaging.get(publicId);
    this.assertMayTarget(session, existing.audience);

    const campaign = await this.messaging.resume(publicId);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'message.resumed',
      targetType: 'message_campaign',
      targetId: publicId,
      after: { pending: campaign.counts.pending },
    });

    return campaign;
  }

  async list(
    session: AdminSession,
    filters: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<{ rows: MessageCampaignSummary[]; total: number }> {
    this.access.assertPermission(session, PERMISSIONS.MESSAGE_SEND);
    return this.messaging.list({
      ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
      ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
    });
  }

  async get(session: AdminSession, publicId: string): Promise<MessageCampaignSummary> {
    this.access.assertPermission(session, PERMISSIONS.MESSAGE_SEND);
    return this.messaging.get(publicId);
  }

  // ── Telegram identity (phase 12) ───────────────────────────────────────────

  /**
   * A user's Telegram id and username, for the one permission that may see them.
   *
   * `telegram_account` is a separate table precisely so that no careless `include`
   * anywhere else can reach it (ADR-0009), and `AdminInsightService.getUser` says
   * in as many words that it does not read it. This is the documented exception:
   * `user.telegram.read`, held by `SUPER_ADMIN` alone.
   *
   * **Every call writes an audit row**, because the read is the sensitive act. A
   * permission says who *may* look; the row says who *did*, and only the second
   * one answers a question after the fact.
   */
  async telegramIdentity(session: AdminSession, userPublicId: string): Promise<TelegramIdentity> {
    this.access.assertPermission(session, PERMISSIONS.USER_TELEGRAM_READ);

    const user = await this.prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: {
        id: true,
        telegramAccount: {
          select: {
            telegramUserId: true,
            usernameCached: true,
            botBlocked: true,
            lastSeenAt: true,
          },
        },
      },
    });
    if (!user?.telegramAccount) throw new AppError(ErrorCode.NOT_FOUND);

    const account = user.telegramAccount;
    const username = normalizeUsername(account.usernameCached);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'user.telegram_viewed',
      targetType: 'user',
      targetId: user.id,
      // Which user was looked at, never what was seen. Copying the Telegram id
      // into `audit_log` would put it in the one table this permission exists to
      // keep it out of.
      after: { userPublicId, hadUsername: username !== null },
    });

    return {
      telegramUserId: account.telegramUserId.toString(),
      username,
      directLink: username === null ? null : `https://t.me/${username}`,
      linkUnavailableReason: username === null ? 'NO_USERNAME' : null,
      botBlocked: account.botBlocked,
      lastSeenAt: account.lastSeenAt,
    };
  }
}

/**
 * A Telegram username, or null.
 *
 * Cached from whatever Telegram last told us, so it can be absent, empty, or
 * carry a leading `@` depending on where it came from. Validated against
 * Telegram's own rule — 5–32 of `[A-Za-z0-9_]` — rather than trusted, because the
 * value ends up in a URL the panel renders as a link, and a cached string with a
 * `/` in it would build a link to somewhere else entirely.
 */
function normalizeUsername(cached: string | null): string | null {
  if (cached === null) return null;
  const trimmed = cached.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{5,32}$/.test(trimmed) ? trimmed : null;
}

/**
 * The audience in words, for the preview and the audit row.
 *
 * Names the filters, never their contents beyond a count: «۳ شهر» rather than
 * three city ids, so an audit trail somebody exports does not become a record of
 * which cities were targeted with what.
 */
function describeAudience(audience: MessageAudience): string[] {
  const applied: string[] = [];
  if (audience.everyone === true) applied.push('everyone');
  if (audience.userPublicIds !== undefined) {
    applied.push(`users:${String(new Set(audience.userPublicIds).size)}`);
  }
  if (audience.cityIds !== undefined) {
    applied.push(`cities:${String(new Set(audience.cityIds).size)}`);
  }
  if (audience.status !== undefined) applied.push(`status:${audience.status}`);
  if (audience.profileComplete !== undefined) {
    applied.push(`profileComplete:${String(audience.profileComplete)}`);
  }
  if (audience.hasHostedEvent !== undefined) {
    applied.push(`hasHostedEvent:${String(audience.hasHostedEvent)}`);
  }
  if (audience.participatedCategoryIds !== undefined) {
    applied.push(`categories:${String(new Set(audience.participatedCategoryIds).size)}`);
  }
  return applied;
}
