import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type {
  ChatActionType,
  ChatMessageKind,
  ChatParticipantRole,
  ChatStatus,
  Prisma,
} from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { HOST_ALIAS, HOST_ALIAS_INDEX, guestAlias } from './alias';
import type { InboundTextMessage } from './inbound-message';
import { MessageCipher } from './message-cipher';
import {
  CHAT_ANONYMOUS_INTRO,
  CHAT_CLOSED_NOTICE,
  CHAT_MESSAGE_DELETED,
  CHAT_OPENED,
  chatContactShared,
} from './messages';
import { assertChatTransition, isLiveChat } from './state-machine';
import { sanitizeInbound, type RedactionKind } from './sanitizer';

/** How long a closed conversation is kept before the M15 purge (ADR-0009, D5). */
export const RETENTION_DAYS_AFTER_CLOSE = 90;

/** What a chat looks like to one of the two people in it. */
export interface ChatSummary {
  publicId: string;
  eventPublicId: string;
  eventTitle: string;
  status: ChatStatus;
  role: ChatParticipantRole;
  /** What the *other* side sees you called. */
  alias: string;
  /** What you see them called. */
  counterpartAlias: string;
  /** Whether you have consented to share contact details here. */
  contactShared: boolean;
  counterpartContactShared: boolean;
  lastMessageAt: Date | null;
  unreadCount: number;
  createdAt: Date;
}

export interface ChatMessageDetail {
  /** Chat-scoped ordinal. The only message identifier that leaves the backend. */
  seq: number;
  kind: ChatMessageKind;
  /** Null for a SYSTEM message: the platform is not a participant. */
  senderAlias: string | null;
  /** Whether the caller wrote it. */
  mine: boolean;
  text: string;
  /** Which masking rules fired, so a sender can see their number was removed. */
  redactionKinds: RedactionKind[];
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface ChatPage {
  chat: ChatSummary;
  /** Oldest first, so a client appends rather than reverses. */
  messages: ChatMessageDetail[];
  /** The seq to pass as `beforeSeq` for the previous page; null at the start. */
  nextBeforeSeq: number | null;
}

/** What the join transaction gets back, so its response can carry the chat. */
export interface CreatedChat {
  id: string;
  publicId: string;
  guestAlias: string;
}

/**
 * The anonymous relay (ADR-0009, plan §3.4).
 *
 * Two strangers negotiate a real-world meeting before either knows who the other
 * is. Everything in this file exists to keep that true, and the ordering of the
 * five layers in plan §3.6 is the ordering of the reasoning:
 *
 *  1. **Nothing here can read `telegram_account`.** This service takes and
 *     returns internal ids and public ids. The Telegram identifier it must never
 *     leak is not something it can reach even by mistake.
 *  2. **Every outward shape is built field by field**, never spread — see
 *     `toSummary` and `toMessage`.
 *  3. **Aliases come from `alias.ts`** and are a function of the chat, not the
 *     person.
 *  4. **`sanitizeInbound` runs before the cipher**, so what is stored is what the
 *     recipient saw. A masked phone number is masked in the ciphertext too, which
 *     is how "phone numbers are never stored" (§8) stays literally true.
 *  5. The CI leak scan covers the endpoints over this service.
 *
 * **On locking.** Chat transactions take no event lock, and the lifecycle methods
 * that *are* called from inside one (`createForParticipant`, `openForParticipant`,
 * `closeForParticipant`) take no lock of their own. The ordering is therefore
 * always event → chat and never the reverse, so ADR-0006's rule 2 keeps holding:
 * a capacity transaction still holds exactly one lock. Sequence numbers are
 * allocated by `UPDATE … SET next_seq = next_seq + 1 RETURNING`, whose implicit
 * row lock is taken and released inside a transaction that wants nothing else.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cipher: MessageCipher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ── lifecycle, driven by participation ─────────────────────────────────────

  /**
   * Create the chat for a join request.
   *
   * Called from inside the join transaction, under the event lock it already
   * holds (plan §3.4, step 5). That placement is what makes the alias numbering
   * correct without any locking of its own: every joiner of an event serialises
   * on that lock, so the count this reads cannot change under it and two
   * simultaneous requests cannot both become «میهمان ۳».
   */
  async createForParticipant(
    tx: Prisma.TransactionClient,
    input: {
      eventId: string;
      participantId: string;
      hostUserId: string;
      guestUserId: string;
    },
    now: Date,
  ): Promise<CreatedChat> {
    const priorChats = await tx.anonymousChat.count({ where: { eventId: input.eventId } });
    const aliasIndex = priorChats + 1;
    const alias = guestAlias(aliasIndex);

    const chat = await tx.anonymousChat.create({
      data: {
        eventId: input.eventId,
        participantId: input.participantId,
        status: 'ANONYMOUS',
        createdAt: now,
        chatParticipants: {
          create: [
            {
              userId: input.hostUserId,
              role: 'HOST',
              alias: HOST_ALIAS,
              aliasIndex: HOST_ALIAS_INDEX,
              createdAt: now,
            },
            {
              userId: input.guestUserId,
              role: 'GUEST',
              alias,
              aliasIndex,
              createdAt: now,
            },
          ],
        },
      },
      select: { id: true, publicId: true },
    });

    // The chat opens with the platform saying what it is. Written as a stored
    // message rather than rendered by each client, so both surfaces show the same
    // sentence and it sits in sequence where it happened.
    await this.writeSystemMessage(tx, chat.id, CHAT_ANONYMOUS_INTRO, now);

    return { id: chat.id, publicId: chat.publicId, guestAlias: alias };
  }

  /**
   * The host accepted: ANONYMOUS → OPEN.
   *
   * Called from inside the accept transaction, so a chat cannot be open for a
   * request that failed to be accepted, and cannot stay anonymous for one that
   * succeeded.
   */
  async openForParticipant(
    tx: Prisma.TransactionClient,
    participantId: string,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    const chat = await this.chatOfParticipant(tx, participantId);
    // Nothing to open: M6 predates the chat tables, so a participation created
    // before this migration has no chat. Silently doing nothing is right — the
    // acceptance itself is not in question.
    if (!chat) return;

    assertChatTransition(chat.status, 'OPEN', chat.id);

    await tx.anonymousChat.update({
      where: { id: chat.id },
      data: { status: 'OPEN', openedAt: now },
    });

    await this.writeSystemMessage(tx, chat.id, CHAT_OPENED, now);
    await this.recordAction(tx, chat.id, 'ACCEPT', actorUserId, now);

    await this.audit.record(
      {
        actorType: 'USER',
        actorId: actorUserId,
        action: 'chat.opened',
        targetType: 'anonymous_chat',
        targetId: chat.id,
        before: { status: chat.status },
        after: { status: 'OPEN' },
      },
      tx,
    );
  }

  /**
   * The request ended, so the conversation does: → CLOSED.
   *
   * Rejection, cancellation and expiry all reach this. A chat that outlived its
   * request would be two strangers messaging each other with nothing left to
   * arrange, which is exactly the thing the platform exists not to become.
   */
  async closeForParticipant(
    tx: Prisma.TransactionClient,
    participantId: string,
    input: { reason: string; actorUserId?: string; action?: ChatActionType },
    now: Date,
  ): Promise<void> {
    const chat = await this.chatOfParticipant(tx, participantId);
    if (!chat) return;
    // Already over. Closing twice is not an error — a host who rejects a request
    // whose participant just cancelled should not get a 409 for it.
    if (!isLiveChat(chat.status)) return;

    await this.closeChat(
      tx,
      { id: chat.id, status: chat.status },
      {
        reason: input.reason,
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        action: input.action ?? 'CLOSE',
      },
      now,
    );
  }

  // ── the relay ──────────────────────────────────────────────────────────────

  /**
   * Relay a message from one side of a chat to the other.
   *
   * The privacy-critical path (plan §3.4). Sanitize, then encrypt, then store,
   * then emit — in that order, and the order is the argument:
   *
   *  - Sanitizing first means the plaintext that reaches the cipher is already
   *    the plaintext the recipient will see. There is no second copy holding the
   *    unmasked original, because there is no point in the pipeline where one
   *    exists to be written.
   *  - Emitting last, inside the same transaction, means the message and its
   *    delivery instruction commit together (ADR-0005). A crash cannot store a
   *    message nobody is told about, or announce one that was rolled back.
   *
   * The outbox payload carries ids and an alias, never the body. Delivery reads
   * the row and decrypts it, so `outbox_event.payload` — an unencrypted jsonb
   * column — never holds a word anybody wrote.
   */
  async send(
    userId: string,
    chatPublicId: string,
    message: InboundTextMessage,
  ): Promise<ChatMessageDetail> {
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const context = await this.loadMembership(tx, chatPublicId, userId);
      if (!isLiveChat(context.chat.status)) throw new AppError(ErrorCode.CHAT_CLOSED);

      const sanitized = sanitizeInbound(message, {
        maskContactDetails: masksContactDetails(context.chat.status, context.me.contactSharedAt),
      });
      // A message that was nothing but a phone number leaves nothing to relay.
      // Refusing it beats sending a lone «حذف شد», which tells the recipient
      // nothing and reads like a bug in the product rather than a rule of it.
      if (sanitized.isEmpty) throw new AppError(ErrorCode.CHAT_MESSAGE_EMPTY);

      const seq = await this.nextSeq(tx, context.chat.id);

      const created = await tx.chatMessage.create({
        data: {
          chatId: context.chat.id,
          senderParticipantId: context.me.id,
          seq,
          kind: 'TEXT',
          ...this.encryptBody(sanitized.text),
          // Kinds and counts, never the removed text. The same rule
          // `moderation_case.matched_terms` follows (M4): the record says which
          // rule fired, and the subject is where the text would live — except
          // that here the masked text was never stored at all, which is what
          // makes §8's "phone numbers are never stored" true rather than
          // aspirational.
          redactions: summarizeRedactions(sanitized.redactions.map((r) => r.kind)),
          ...(message.telegramMessageId !== undefined
            ? { sourceTelegramMessageId: BigInt(message.telegramMessageId) }
            : {}),
          createdAt: now,
        },
      });

      await this.outbox.emit(
        {
          aggregateType: 'chat_message',
          aggregateId: created.id,
          eventType: 'chat.message',
          payload: {
            chatPublicId,
            seq,
            senderAlias: context.me.alias,
            recipientUserPublicId: context.counterpartUserPublicId,
          },
        },
        tx,
      );

      return toMessage(
        {
          seq,
          kind: 'TEXT',
          senderParticipantId: context.me.id,
          editedAt: null,
          deletedAt: null,
          createdAt: now,
          redactions: created.redactions,
        },
        sanitized.text,
        context.me.id,
        context.aliasByParticipantId,
      );
    });
  }

  /**
   * A sender edited their message in Telegram, and the relayed copy follows
   * (D10).
   *
   * Keyed on `(sender, telegram message id)` because that is what an
   * `edited_message` update gives the bot — it names a message in the sender's
   * own conversation with the bot, not one of ours. Editing is only ever the
   * sender's, so a wrong `userId` finds nothing rather than finding somebody
   * else's message.
   */
  async editBySourceMessage(
    userId: string,
    telegramMessageId: number,
    message: InboundTextMessage,
  ): Promise<ChatMessageDetail> {
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.chatMessage.findFirst({
        where: {
          sourceTelegramMessageId: BigInt(telegramMessageId),
          sender: { userId },
          deletedAt: null,
        },
        select: { id: true, chatId: true, seq: true, senderParticipantId: true, createdAt: true },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

      const context = await this.loadMembershipByChatId(tx, existing.chatId, userId);
      // An edit to a closed conversation changes a record of what was said after
      // the conversation ended. The original stands.
      if (!isLiveChat(context.chat.status)) throw new AppError(ErrorCode.CHAT_CLOSED);

      const sanitized = sanitizeInbound(message, {
        maskContactDetails: masksContactDetails(context.chat.status, context.me.contactSharedAt),
      });
      if (sanitized.isEmpty) throw new AppError(ErrorCode.CHAT_MESSAGE_EMPTY);

      const updated = await tx.chatMessage.update({
        where: { id: existing.id },
        data: {
          ...this.encryptBody(sanitized.text),
          redactions: summarizeRedactions(sanitized.redactions.map((r) => r.kind)),
          editedAt: now,
        },
      });

      await this.outbox.emit(
        {
          aggregateType: 'chat_message',
          aggregateId: existing.id,
          eventType: 'chat.message_edited',
          payload: {
            chatPublicId: context.chat.publicId,
            seq: existing.seq,
            senderAlias: context.me.alias,
            recipientUserPublicId: context.counterpartUserPublicId,
          },
        },
        tx,
      );

      return toMessage(
        { ...updated, redactions: updated.redactions },
        sanitized.text,
        context.me.id,
        context.aliasByParticipantId,
      );
    });
  }

  /**
   * The sender deleted their message (D10).
   *
   * The row survives, marked. ADR-0009 is explicit that the recipient's *view*
   * respects the sender's intent while the evidentiary record does not disappear:
   * a message deleted immediately after it was sent is the shape most abuse
   * takes, and a platform that erases it on request cannot investigate the report
   * that follows.
   */
  async deleteBySourceMessage(userId: string, telegramMessageId: number): Promise<void> {
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.chatMessage.findFirst({
        where: {
          sourceTelegramMessageId: BigInt(telegramMessageId),
          sender: { userId },
          deletedAt: null,
        },
        select: { id: true, chatId: true, seq: true },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

      const context = await this.loadMembershipByChatId(tx, existing.chatId, userId);

      await tx.chatMessage.update({ where: { id: existing.id }, data: { deletedAt: now } });

      await this.outbox.emit(
        {
          aggregateType: 'chat_message',
          aggregateId: existing.id,
          eventType: 'chat.message_deleted',
          payload: {
            chatPublicId: context.chat.publicId,
            seq: existing.seq,
            recipientUserPublicId: context.counterpartUserPublicId,
            // What the recipient's copy becomes. Carried so the relay renders the
            // same sentence the Mini App does.
            replacementText: CHAT_MESSAGE_DELETED,
          },
        },
        tx,
      );
    });
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** Every chat the caller is in, newest conversation first. */
  async listForUser(userId: string): Promise<ChatSummary[]> {
    const memberships = await this.prisma.chatParticipant.findMany({
      where: { userId },
      include: {
        chat: {
          include: {
            event: { select: { publicId: true, title: true } },
            chatParticipants: true,
          },
        },
      },
    });

    const chatIds = memberships.map((m) => m.chatId);
    if (chatIds.length === 0) return [];

    const activity = await this.prisma.chatMessage.groupBy({
      by: ['chatId'],
      where: { chatId: { in: chatIds } },
      _max: { createdAt: true },
    });
    const lastMessageAt = new Map(activity.map((row) => [row.chatId, row._max.createdAt]));

    const summaries = await Promise.all(
      memberships.map(async (membership) => {
        const counterpart = membership.chat.chatParticipants.find((p) => p.id !== membership.id);
        if (!counterpart) throw new Error(`chat ${membership.chatId} has only one participant`);

        const unreadCount = await this.prisma.chatMessage.count({
          where: {
            chatId: membership.chatId,
            // "Not written by me", which includes the ones written by nobody.
            // Stated as an explicit OR because `{ not: id }` on a nullable column
            // is SQL's `sender_participant_id <> $1`, and that is NULL — not true
            // — for a SYSTEM row. The accidental reading would silently drop
            // «the other side shared their contact details» from the badge, which
            // is one of the few notices in this product that genuinely needs to
            // be noticed.
            OR: [{ senderParticipantId: null }, { senderParticipantId: { not: membership.id } }],
            ...(membership.lastReadAt !== null ? { createdAt: { gt: membership.lastReadAt } } : {}),
          },
        });

        return toSummary(membership, counterpart, membership.chat, unreadCount, [
          lastMessageAt.get(membership.chatId) ?? null,
        ]);
      }),
    );

    return summaries.sort(
      (a, b) =>
        (b.lastMessageAt ?? b.createdAt).getTime() - (a.lastMessageAt ?? a.createdAt).getTime(),
    );
  }

  /**
   * One conversation, decrypted.
   *
   * Reading marks the caller's side read. That write is deliberately not a
   * separate endpoint: an unread count that only clears when a client remembers
   * to call something is an unread count that is wrong.
   */
  async readMessages(
    userId: string,
    chatPublicId: string,
    options: { limit?: number; beforeSeq?: number } = {},
  ): Promise<ChatPage> {
    const now = this.clock.now();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    const context = await this.loadMembership(this.prisma, chatPublicId, userId);

    const rows = await this.prisma.chatMessage.findMany({
      where: {
        chatId: context.chat.id,
        ...(options.beforeSeq !== undefined ? { seq: { lt: options.beforeSeq } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit,
    });

    const messages = rows
      .map((row) => toMessage(row, this.readBody(row), context.me.id, context.aliasByParticipantId))
      .reverse();

    await this.prisma.chatParticipant.update({
      where: { id: context.me.id },
      data: { lastReadAt: now },
    });

    const oldest = messages[0];
    return {
      chat: await this.summaryFor(context, 0),
      messages,
      // A full page means there is plausibly another one behind it. A short page
      // means we reached the start of the conversation.
      nextBeforeSeq: rows.length === limit && oldest ? oldest.seq : null,
    };
  }

  // ── actions ────────────────────────────────────────────────────────────────

  /**
   * Either party ends the conversation.
   *
   * Both sides can, and neither needs the other's agreement: a chat somebody
   * wants out of is a chat they get out of. The request itself is untouched —
   * withdrawing from an event is `POST /participants/:id/cancel`, and conflating
   * the two would let "stop messaging me" cancel somebody's Saturday.
   */
  async close(userId: string, chatPublicId: string, reason?: string): Promise<ChatSummary> {
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const context = await this.loadMembership(tx, chatPublicId, userId);
      if (!isLiveChat(context.chat.status)) throw new AppError(ErrorCode.CHAT_CLOSED);

      await this.closeChat(
        tx,
        { id: context.chat.id, status: context.chat.status },
        { reason: reason ?? 'closed_by_participant', actorUserId: userId, action: 'CLOSE' },
        now,
      );

      const refreshed = await this.loadMembership(tx, chatPublicId, userId);
      return this.summaryFor(refreshed, 0, tx);
    });
  }

  /**
   * "I am willing to exchange contact details here."
   *
   * What this does *not* do is reveal anything. The platform holds no phone
   * number to hand over and will not surrender a Telegram username (invariant 7);
   * what the consent changes is that this participant's own messages stop being
   * masked, so they can type their number themselves and have it arrive. That is
   * exactly the shape §8 describes — "never stored, relayed in-chat after
   * explicit consent only" — and it keeps the disclosure the user's act rather
   * than the platform's.
   *
   * OPEN only (ADR-0009). Before acceptance there is no meeting to arrange, and
   * an anonymous stage that can be switched off on request is not an anonymous
   * stage.
   */
  async shareContact(userId: string, chatPublicId: string): Promise<ChatSummary> {
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const context = await this.loadMembership(tx, chatPublicId, userId);
      if (context.chat.status !== 'OPEN') throw new AppError(ErrorCode.CHAT_NOT_OPEN);
      // Idempotent: pressing the button twice is one decision, not two.
      if (context.me.contactSharedAt !== null) return this.summaryFor(context, 0, tx);

      await tx.chatParticipant.update({
        where: { id: context.me.id },
        data: { contactSharedAt: now },
      });

      await this.recordConsent(tx, userId, now);
      await this.recordAction(tx, context.chat.id, 'SHARE_CONTACT', userId, now);
      await this.writeSystemMessage(tx, context.chat.id, chatContactShared(context.me.alias), now);

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'chat.contact_shared',
          targetType: 'anonymous_chat',
          targetId: context.chat.id,
          after: { role: context.me.role },
        },
        tx,
      );

      await this.outbox.emit(
        {
          aggregateType: 'anonymous_chat',
          aggregateId: context.chat.id,
          eventType: 'chat.contact_shared',
          payload: {
            chatPublicId,
            sharerAlias: context.me.alias,
            recipientUserPublicId: context.counterpartUserPublicId,
          },
        },
        tx,
      );

      const refreshed = await this.loadMembership(tx, chatPublicId, userId);
      return this.summaryFor(refreshed, 0, tx);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Allocate the next sequence number.
   *
   * One statement, so two senders in the same chat serialise on the row's
   * implicit write lock rather than on anything this code has to remember to
   * take. `MAX(seq) + 1` would race under READ COMMITTED and need a retry loop;
   * an explicit `SELECT … FOR UPDATE` would be the second one in a product that
   * has exactly one on purpose (ADR-0006).
   */
  private async nextSeq(tx: Prisma.TransactionClient, chatId: string): Promise<number> {
    const updated = await tx.anonymousChat.update({
      where: { id: chatId },
      data: { nextSeq: { increment: 1 } },
      select: { nextSeq: true },
    });
    return updated.nextSeq;
  }

  private async writeSystemMessage(
    tx: Prisma.TransactionClient,
    chatId: string,
    text: string,
    now: Date,
  ): Promise<void> {
    const seq = await this.nextSeq(tx, chatId);

    await tx.chatMessage.create({
      data: {
        chatId,
        senderParticipantId: null,
        seq,
        kind: 'SYSTEM',
        ...this.encryptBody(text),
        createdAt: now,
      },
    });
  }

  /**
   * Encrypt into the three columns that hold a body.
   *
   * The copy through `Uint8Array` is not ceremony. Prisma's `Bytes` is
   * `Uint8Array<ArrayBuffer>`, while Node's `Buffer` may be backed by a
   * `SharedArrayBuffer` and is typed accordingly — so TypeScript is right to
   * refuse the assignment, and one conversion here beats three at the call sites
   * or, worse, one `as` that silences it everywhere.
   */
  private encryptBody(text: string): {
    bodyCiphertext: Uint8Array<ArrayBuffer>;
    bodyNonce: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  } {
    const body = this.cipher.encrypt(text);
    return {
      bodyCiphertext: new Uint8Array(body.ciphertext),
      bodyNonce: new Uint8Array(body.nonce),
      keyVersion: body.keyVersion,
    };
  }

  /**
   * Close, and start the retention clock on everything in the conversation.
   *
   * The messages get `retention_expires_at` here rather than at purge time
   * because the deadline is a fact about this conversation — it was decided when
   * the chat closed, and a policy change six weeks later must not silently move
   * the date on messages already written (the same argument that makes
   * `cancellation_bucket` a stored column in M6).
   */
  private async closeChat(
    tx: Prisma.TransactionClient,
    chat: { id: string; status: ChatStatus },
    input: { reason: string; actorUserId?: string; action: ChatActionType },
    now: Date,
  ): Promise<void> {
    assertChatTransition(chat.status, 'CLOSED', chat.id);

    const retentionExpiresAt = new Date(
      now.getTime() + RETENTION_DAYS_AFTER_CLOSE * 24 * 3_600_000,
    );

    // Written before the status change so the notice is inside the conversation
    // it is about, and so it inherits the same retention as everything else.
    await this.writeSystemMessage(tx, chat.id, CHAT_CLOSED_NOTICE, now);

    await tx.anonymousChat.update({
      where: { id: chat.id },
      data: {
        status: 'CLOSED',
        closedAt: now,
        closedByUserId: input.actorUserId ?? null,
        closeReason: input.reason,
        retentionExpiresAt,
      },
    });

    await tx.chatMessage.updateMany({
      where: { chatId: chat.id },
      data: { retentionExpiresAt },
    });

    await this.recordAction(tx, chat.id, input.action, input.actorUserId ?? null, now);

    await this.audit.record(
      {
        actorType: input.actorUserId !== undefined ? 'USER' : 'SYSTEM',
        ...(input.actorUserId !== undefined ? { actorId: input.actorUserId } : {}),
        action: 'chat.closed',
        targetType: 'anonymous_chat',
        targetId: chat.id,
        before: { status: chat.status },
        after: { status: 'CLOSED', reason: input.reason },
      },
      tx,
    );
  }

  private async recordAction(
    tx: Prisma.TransactionClient,
    chatId: string,
    action: ChatActionType,
    actorUserId: string | null,
    now: Date,
  ): Promise<void> {
    await tx.chatAction.create({ data: { chatId, action, actorUserId, createdAt: now } });
  }

  /**
   * Record consent to the contact-sharing policy.
   *
   * `UNIQUE (user_id, policy_version_id, context)` means this is one row per user
   * per policy version, not one per chat — so it records that the user accepted
   * the terms under which contact details may be exchanged, while `chat_action`
   * records each individual act of doing so. ADR-0009 asks for both, and this is
   * the division the schema permits: the policy decision is a property of the
   * person, the act is a property of the conversation.
   *
   * `createMany` + `skipDuplicates` for idempotence, exactly as onboarding does.
   */
  private async recordConsent(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<void> {
    const policy = await tx.policyVersion.findFirst({
      where: { isCurrent: true, type: 'PRIVACY' },
      select: { id: true },
    });
    // A deployment with no current privacy policy is misconfigured, and M17's
    // launch checklist seeds one. Refusing to share contact details over it would
    // punish the user for that; the `chat_action` row still records the act, so
    // nothing goes unrecorded.
    if (!policy) return;

    await tx.consent.createMany({
      data: [
        {
          userId,
          policyVersionId: policy.id,
          context: 'CONTACT_SHARE',
          acceptedAt: now,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async chatOfParticipant(
    tx: Prisma.TransactionClient,
    participantId: string,
  ): Promise<{ id: string; status: ChatStatus } | null> {
    return tx.anonymousChat.findUnique({
      where: { participantId },
      select: { id: true, status: true },
    });
  }

  /**
   * Resolve "is this caller in this chat, and what are they called in it?".
   *
   * A non-member gets `NOT_FOUND`, not `FORBIDDEN`. The plan's M8 test list says
   * 403, and this is a deliberate departure from it for the reason T3.3 gives and
   * the rest of the codebase already follows: a 403 confirms that a chat with
   * that id exists, and confirming the existence of a private conversation to
   * somebody who is not in it is itself a disclosure.
   */
  private async loadMembership(
    tx: Prisma.TransactionClient,
    chatPublicId: string,
    userId: string,
  ): Promise<ChatContext> {
    const chat = await tx.anonymousChat.findUnique({
      where: { publicId: chatPublicId },
      include: {
        event: { select: { publicId: true, title: true } },
        chatParticipants: { include: { user: { select: { publicId: true } } } },
      },
    });
    if (!chat) throw new AppError(ErrorCode.NOT_FOUND);
    return this.toContext(chat, userId);
  }

  private async loadMembershipByChatId(
    tx: Prisma.TransactionClient,
    chatId: string,
    userId: string,
  ): Promise<ChatContext> {
    const chat = await tx.anonymousChat.findUnique({
      where: { id: chatId },
      include: {
        event: { select: { publicId: true, title: true } },
        chatParticipants: { include: { user: { select: { publicId: true } } } },
      },
    });
    if (!chat) throw new AppError(ErrorCode.NOT_FOUND);
    return this.toContext(chat, userId);
  }

  private toContext(chat: ChatWithMembers, userId: string): ChatContext {
    const me = chat.chatParticipants.find((p) => p.userId === userId);
    if (!me) throw new AppError(ErrorCode.NOT_FOUND);

    const counterpart = chat.chatParticipants.find((p) => p.id !== me.id);
    if (!counterpart) throw new Error(`chat ${chat.id} has only one participant`);

    return {
      chat,
      me,
      counterpart,
      counterpartUserPublicId: counterpart.user.publicId,
      aliasByParticipantId: new Map(chat.chatParticipants.map((p) => [p.id, p.alias])),
    };
  }

  private async summaryFor(
    context: ChatContext,
    unreadCount: number,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<ChatSummary> {
    const activity = await tx.chatMessage.aggregate({
      where: { chatId: context.chat.id },
      _max: { createdAt: true },
    });

    return toSummary(context.me, context.counterpart, context.chat, unreadCount, [
      activity._max.createdAt,
    ]);
  }

  /**
   * Decrypt for display.
   *
   * A deleted message is never decrypted for a reader: its row survives as the
   * evidentiary record (D10), but the only thing a participant sees is the
   * placeholder. The distinction is the whole of D10 — the sender's intent
   * governs the view, the record governs the investigation.
   */
  private readBody(row: {
    kind: ChatMessageKind;
    deletedAt: Date | null;
    bodyCiphertext: Uint8Array;
    bodyNonce: Uint8Array;
    keyVersion: number;
  }): string {
    if (row.deletedAt !== null) return CHAT_MESSAGE_DELETED;

    return this.cipher.decrypt({
      ciphertext: Buffer.from(row.bodyCiphertext),
      nonce: Buffer.from(row.bodyNonce),
      keyVersion: row.keyVersion,
    });
  }
}

/**
 * Is masking on for this sender?
 *
 * Exported and pure so the rule is testable without a database: it is the switch
 * that decides whether a phone number reaches another human, which makes it worth
 * more than an inline conditional.
 */
export function masksContactDetails(status: ChatStatus, contactSharedAt: Date | null): boolean {
  if (status !== 'OPEN') return true;
  return contactSharedAt === null;
}

/** `[{ kind, count }]` — which rules fired, never what they removed. */
function summarizeRedactions(kinds: RedactionKind[]): { kind: RedactionKind; count: number }[] {
  const counts = new Map<RedactionKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

function redactionKindsOf(stored: unknown): RedactionKind[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'kind' in entry
        ? String((entry as { kind: unknown }).kind)
        : null,
    )
    .filter((kind): kind is RedactionKind => kind !== null);
}

/**
 * Field by field, never a spread (§3.6 layer 2).
 *
 * `chat_participant` carries a `user_id` and `chat_message` carries the sender's
 * participant id and a Telegram message id. A spread would hand all three to a
 * caller the moment somebody added a column, and the caller here is the other
 * person in an anonymous conversation.
 */
function toSummary(
  me: {
    alias: string;
    role: ChatParticipantRole;
    contactSharedAt: Date | null;
  },
  counterpart: { alias: string; contactSharedAt: Date | null },
  chat: {
    publicId: string;
    status: ChatStatus;
    createdAt: Date;
    event: { publicId: string; title: string };
  },
  unreadCount: number,
  [lastMessageAt]: [Date | null],
): ChatSummary {
  return {
    publicId: chat.publicId,
    eventPublicId: chat.event.publicId,
    eventTitle: chat.event.title,
    status: chat.status,
    role: me.role,
    alias: me.alias,
    counterpartAlias: counterpart.alias,
    contactShared: me.contactSharedAt !== null,
    counterpartContactShared: counterpart.contactSharedAt !== null,
    lastMessageAt,
    unreadCount,
    createdAt: chat.createdAt,
  };
}

function toMessage(
  row: {
    seq: number;
    kind: ChatMessageKind;
    senderParticipantId: string | null;
    editedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
    redactions: unknown;
  },
  text: string,
  myParticipantId: string,
  aliasByParticipantId: Map<string, string>,
): ChatMessageDetail {
  return {
    seq: row.seq,
    kind: row.kind,
    senderAlias:
      row.senderParticipantId === null
        ? null
        : (aliasByParticipantId.get(row.senderParticipantId) ?? null),
    mine: row.senderParticipantId === myParticipantId,
    text,
    redactionKinds: redactionKindsOf(row.redactions),
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

interface ChatMember {
  id: string;
  userId: string;
  alias: string;
  aliasIndex: number;
  role: ChatParticipantRole;
  contactSharedAt: Date | null;
  lastReadAt: Date | null;
  user: { publicId: string };
}

interface ChatWithMembers {
  id: string;
  publicId: string;
  status: ChatStatus;
  createdAt: Date;
  event: { publicId: string; title: string };
  chatParticipants: ChatMember[];
}

interface ChatContext {
  chat: ChatWithMembers;
  me: ChatMember;
  counterpart: ChatMember;
  counterpartUserPublicId: string;
  aliasByParticipantId: Map<string, string>;
}
