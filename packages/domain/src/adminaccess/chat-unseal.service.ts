import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { MessageCipher } from '../chat/message-cipher';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** One decrypted message, as a moderator sees it. */
export interface UnsealedMessage {
  seq: number;
  /** The per-chat alias, not a name. Who «میهمان ۱» is stays outside this. */
  senderAlias: string | null;
  kind: string;
  body: string;
  sentAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface UnsealGrant {
  grantId: string;
  chatPublicId: string;
  expiresAt: Date;
}

/**
 * Break-glass access to a private conversation (ADR-0010, T14).
 *
 * This is the most dangerous capability in the product, because the feature it
 * reaches into is the one whose entire promise is that nobody can read it. The
 * promise the product actually makes is narrower than "nobody", and it is worth
 * writing down exactly: **two users are anonymous to each other, and staff can
 * read a conversation only with a case, a reason, and a record.** ADR-0009 says as
 * much, and §8 refuses to overclaim it to users.
 *
 * Three conditions, **all** required, none sufficient:
 *
 *  1. the `chat.read` permission,
 *  2. an **open `moderation_case` naming this chat**, and
 *  3. a **written reason**.
 *
 * The grant then lasts fifteen minutes. Every individual message read writes its
 * own `audit_log` row — not one row for the session, one per message — so "what
 * did they actually look at" is answerable rather than inferable.
 *
 * The condition doing the most work is the second one. A permission alone would
 * make chat reading a thing moderators can do; requiring a case means somebody had
 * to report something first, which puts the decision to look outside the person
 * looking.
 */
@Injectable()
export class ChatUnsealService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly cipher: MessageCipher,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ask for the fifteen minutes.
   *
   * Refuses in three different ways, and each refusal is its own error so a
   * moderator who is missing a case is told to open one rather than being told
   * "forbidden" and guessing.
   */
  async grant(
    session: AdminSession,
    chatPublicId: string,
    reason: string,
    ipHash?: string,
  ): Promise<UnsealGrant> {
    const now = this.clock.now();
    this.access.assertPermission(session, PERMISSIONS.CHAT_READ);

    const trimmed = reason.trim();
    // Matches the CHECK on the column. A reason nobody has to write is a reason
    // nobody writes, and "investigating" is not one either — but length is the
    // only part a machine can judge, and the weekly digest is what judges the rest.
    if (trimmed.length < 10) throw new AppError(ErrorCode.UNSEAL_REASON_REQUIRED);

    const chat = await this.prisma.anonymousChat.findUnique({
      where: { publicId: chatPublicId },
      select: { id: true },
    });
    if (!chat) throw new AppError(ErrorCode.NOT_FOUND);

    /**
     * The condition that matters most: an **open case naming this chat**.
     *
     * Without it, `chat.read` alone would make reading private conversations
     * something a moderator can simply decide to do. With it, somebody had to
     * report the conversation first, so the decision to look originates outside
     * the person looking.
     */
    const openCase = await this.prisma.moderationCase.findFirst({
      where: {
        subjectType: 'MESSAGE',
        subjectId: chat.id,
        status: { in: ['OPEN', 'IN_REVIEW', 'ESCALATED'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!openCase) throw new AppError(ErrorCode.UNSEAL_REQUIRES_OPEN_CASE);

    const minutes = await this.settings.getInt('moderation.unseal_window_minutes');
    const grant = await this.prisma.chatUnsealGrant.create({
      data: {
        chatId: chat.id,
        adminUserId: session.adminUserId,
        moderationCaseId: openCase.id,
        reason: trimmed,
        grantedAt: now,
        expiresAt: new Date(now.getTime() + minutes * 60_000),
      },
      select: { id: true, expiresAt: true },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'chat.unseal_granted',
      targetType: 'anonymous_chat',
      targetId: chat.id,
      // The reason is the admin's own justification for their own act, so it
      // belongs in the trail — unlike a user's words about another user, which do
      // not (ADR-0009).
      after: { caseId: openCase.id, reason: trimmed, expiresAt: grant.expiresAt.toISOString() },
      ...(ipHash !== undefined ? { ipHash } : {}),
    });

    return { grantId: grant.id, chatPublicId, expiresAt: grant.expiresAt };
  }

  /**
   * Read the conversation, under a live grant.
   *
   * **One audit row per message**, which is the part of T14 that is easy to
   * soften into "one row per session" and must not be. A session row answers
   * "somebody opened this chat"; a per-message row answers "they read messages 4
   * through 9 and stopped", and only the second is evidence.
   *
   * Aliases, not names. A moderator reading a conversation to judge abuse needs
   * to see who said what *within it*; they do not need the identities behind the
   * aliases, and this projection does not carry them.
   */
  async read(session: AdminSession, grantId: string): Promise<UnsealedMessage[]> {
    const now = this.clock.now();
    this.access.assertPermission(session, PERMISSIONS.CHAT_READ);

    const grant = await this.prisma.chatUnsealGrant.findUnique({
      where: { id: grantId },
      select: {
        id: true,
        chatId: true,
        adminUserId: true,
        expiresAt: true,
        moderationCaseId: true,
      },
    });
    if (!grant) throw new AppError(ErrorCode.NOT_FOUND);
    // Somebody else's grant is not a grant. Same 404 as a missing one: whether a
    // colleague is investigating a chat is not information this endpoint gives out.
    if (grant.adminUserId !== session.adminUserId) throw new AppError(ErrorCode.NOT_FOUND);
    if (grant.expiresAt <= now) throw new AppError(ErrorCode.UNSEAL_GRANT_EXPIRED);

    const rows = await this.prisma.chatMessage.findMany({
      where: { chatId: grant.chatId },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        kind: true,
        bodyCiphertext: true,
        bodyNonce: true,
        keyVersion: true,
        createdAt: true,
        editedAt: true,
        deletedAt: true,
        sender: { select: { alias: true } },
      },
      take: 500,
    });

    for (const row of rows) {
      await this.audit.record({
        actorType: 'ADMIN',
        actorId: session.adminUserId,
        action: 'chat.message_read',
        targetType: 'chat_message',
        targetId: row.id,
        // The row records *that* it was read and under which grant. It never
        // records the body — an audit trail that copies the plaintext out of the
        // encrypted column defeats the column (ADR-0009, T15).
        after: { grantId: grant.id, caseId: grant.moderationCaseId, seq: Number(row.seq) },
      });
    }

    await this.prisma.chatUnsealGrant.update({
      where: { id: grant.id },
      data: { readCount: { increment: rows.length } },
    });

    return rows.map((row) => ({
      seq: Number(row.seq),
      senderAlias: row.sender?.alias ?? null,
      kind: row.kind,
      body: this.cipher.decrypt({
        // The columns come back as `Uint8Array`; the cipher takes `Buffer`.
        ciphertext: Buffer.from(row.bodyCiphertext),
        nonce: Buffer.from(row.bodyNonce),
        keyVersion: row.keyVersion,
      }),
      sentAt: row.createdAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
    }));
  }

  /**
   * Every unseal in a window, for the weekly digest to `SUPER_ADMIN` (T14).
   *
   * The digest is the control that makes misuse visible **to somebody other than
   * the person doing it**, which is the only kind of oversight that works on a
   * capability its own holder authorises. Sending it is M13's job; producing it is
   * this.
   */
  async recentGrants(since: Date): Promise<
    Array<{
      adminEmail: string;
      chatPublicId: string;
      reason: string;
      grantedAt: Date;
      readCount: number;
    }>
  > {
    const rows = await this.prisma.chatUnsealGrant.findMany({
      where: { grantedAt: { gte: since } },
      orderBy: { grantedAt: 'desc' },
      select: {
        reason: true,
        grantedAt: true,
        readCount: true,
        adminUser: { select: { email: true } },
        chat: { select: { publicId: true } },
      },
    });

    return rows.map((row) => ({
      adminEmail: row.adminUser.email,
      chatPublicId: row.chat.publicId,
      reason: row.reason,
      grantedAt: row.grantedAt,
      readCount: row.readCount,
    }));
  }
}
