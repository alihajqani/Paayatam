import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { MessageCipher } from '../chat/message-cipher';
import { OutboxService } from '../outbox/outbox.service';

/** The longest a single direct message may be. */
export const DIRECT_MESSAGE_MAX = 1000;
export const DIRECT_MESSAGE_MIN = 2;

export interface DirectMessageDetail {
  publicId: string;
  eventPublicId: string;
  eventTitle: string;
  /** Who wrote it, by display name. Never a Telegram identifier (invariant 7). */
  senderDisplayName: string;
  body: string;
  seenAt: Date | null;
  createdAt: Date;
  /** Whether the reader of this detail is the one who received it. */
  viewerIsRecipient: boolean;
}

/**
 * Direct messages about an activity (v0.7.0).
 *
 * ── Why this is not the anonymous chat ──────────────────────────────────────
 *
 * `ChatService` owns a *conversation* that belongs to a participation. It opens
 * when somebody asks to join, uses aliases instead of names, masks contact
 * details until both sides consent, carries a status machine, a per-chat
 * sequence, a retention clock, and a relay that routes a typed reply back into
 * the right conversation by remembering which message the sender pressed reply
 * on. Every one of those exists to protect two strangers who have not met and
 * have not agreed to.
 *
 * This is the other thing somebody wants: **a message to the host about their
 * activity, before deciding anything**. The writer may never join. There is no
 * participation to hang a chat from, nothing to keep anonymous beyond what they
 * choose to write, and no conversation to open or close.
 *
 * The decisive difference is the one the product asked for: **contact details
 * are not masked here**. Exchanging a phone number or a Telegram handle so two
 * people can arrange a lift is the point, and the notification says so — with the
 * warning that it is the reader's own risk. Sharing a table with the place where
 * masking *is* the guarantee is how that warning eventually stops being true.
 *
 * ── What is shared ─────────────────────────────────────────────────────────
 *
 * `MessageCipher`, so a database dump is not a transcript (ADR-0009), and the
 * outbox, so a message and the notification about it commit together or not at
 * all (ADR-0005).
 *
 * ── Who may write to whom ──────────────────────────────────────────────────
 *
 * Two rules, and both are checked here rather than assumed from a button:
 *
 *  * **Starting a thread** is addressed to the *host* of the activity, by
 *    anybody who is not the host. There is no other addressee — the recipient is
 *    derived from the event, never taken from the caller.
 *  * **Replying** is addressed to the sender of the message being answered, and
 *    only the account that *received* it may do so. So a thread stays between the
 *    two people it started between, and a stranger holding a public id can
 *    neither read a message nor answer one.
 */
@Injectable()
export class DirectMessageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cipher: MessageCipher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Start a thread: a message to the host of an activity.
   *
   * The recipient is **derived from the event**, so there is no addressee for a
   * caller to tamper with. A host writing to their own activity is refused with
   * the same code the join path uses for the same mistake.
   */
  async send(senderUserId: string, eventPublicId: string, body: string): Promise<string> {
    const text = normalizeBody(body);

    const event = await this.prisma.event.findUnique({
      where: { publicId: eventPublicId },
      select: { id: true, publicId: true, title: true, hostUserId: true, deletedAt: true },
    });
    // Not-found and deleted answer identically: an id must not be an oracle.
    if (!event || event.deletedAt !== null) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    if (event.hostUserId === senderUserId) throw new AppError(ErrorCode.HOST_CANNOT_JOIN);

    return this.write({
      senderUserId,
      recipientUserId: event.hostUserId,
      eventId: event.id,
      eventPublicId: event.publicId,
      eventTitle: event.title,
      body: text,
      parentId: null,
    });
  }

  /**
   * Answer one.
   *
   * The addressee is the parent's sender, and only the parent's **recipient** may
   * write it — which is what keeps a thread between the two people it started
   * between, and what makes a public id useless to anybody else.
   */
  async reply(senderUserId: string, parentPublicId: string, body: string): Promise<string> {
    const text = normalizeBody(body);

    const parent = await this.prisma.directMessage.findUnique({
      where: { publicId: parentPublicId },
      select: {
        id: true,
        senderUserId: true,
        recipientUserId: true,
        event: { select: { id: true, publicId: true, title: true } },
      },
    });
    // Same 404 for "no such message" and "not addressed to you" (T3.3).
    if (!parent || parent.recipientUserId !== senderUserId) {
      throw new AppError(ErrorCode.NOT_FOUND);
    }

    return this.write({
      senderUserId,
      recipientUserId: parent.senderUserId,
      eventId: parent.event.id,
      eventPublicId: parent.event.publicId,
      eventTitle: parent.event.title,
      body: text,
      parentId: parent.id,
    });
  }

  /**
   * Read one, as the account it was addressed to, and record that it was read.
   *
   * The two halves are one transaction: a reader who has seen the words and a
   * sender who is told so must not be able to come apart. `seen_at` is written
   * once — a second open is not a second reading, and the sender is told once.
   */
  async view(userId: string, publicId: string): Promise<DirectMessageDetail> {
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.directMessage.findUnique({
        where: { publicId },
        select: {
          id: true,
          publicId: true,
          senderUserId: true,
          recipientUserId: true,
          bodyCiphertext: true,
          bodyNonce: true,
          keyVersion: true,
          seenAt: true,
          createdAt: true,
          event: { select: { publicId: true, title: true } },
          sender: { select: { publicId: true, profile: { select: { displayName: true } } } },
        },
      });
      // A message belongs to exactly two accounts. Everybody else is told it does
      // not exist, which is the same answer they get for one that truly does not.
      if (!row || (row.recipientUserId !== userId && row.senderUserId !== userId)) {
        throw new AppError(ErrorCode.NOT_FOUND);
      }

      const viewerIsRecipient = row.recipientUserId === userId;
      const firstRead = viewerIsRecipient && row.seenAt === null;

      if (firstRead) {
        await tx.directMessage.update({ where: { id: row.id }, data: { seenAt: now } });

        /**
         * The sender is told, once.
         *
         * Emitted only on the *first* read, inside the transaction that records
         * it: a second open is not a second reading, and «دیده شد» arriving twice
         * would read as a second message.
         */
        await this.outbox.emit(
          {
            aggregateType: 'direct_message',
            aggregateId: row.id,
            eventType: 'direct.message_seen',
            payload: {
              messagePublicId: row.publicId,
              eventPublicId: row.event.publicId,
              eventTitle: row.event.title,
              senderUserPublicId: row.sender.publicId,
            },
          },
          tx,
        );
      }

      return {
        publicId: row.publicId,
        eventPublicId: row.event.publicId,
        eventTitle: row.event.title,
        senderDisplayName: row.sender.profile?.displayName ?? 'کاربر پایه‌تَم',
        // `Buffer.from` because Prisma hands back a `Uint8Array` and the cipher
        // wants a `Buffer` — the same conversion `ChatService.readMessages` makes,
        // and it copies nothing that matters at these sizes.
        body: this.cipher.decrypt({
          ciphertext: Buffer.from(row.bodyCiphertext),
          nonce: Buffer.from(row.bodyNonce),
          keyVersion: row.keyVersion,
        }),
        seenAt: firstRead ? now : row.seenAt,
        createdAt: row.createdAt,
        viewerIsRecipient,
      };
    });
  }

  /**
   * The write both entry points share.
   *
   * Private because the *addressing* is the part that must not be reachable from
   * outside: `send` derives the recipient from the event and `reply` from the
   * message being answered, and neither takes one from a caller.
   */
  private async write(input: {
    senderUserId: string;
    recipientUserId: string;
    eventId: string;
    eventPublicId: string;
    eventTitle: string;
    body: string;
    parentId: string | null;
  }): Promise<string> {
    const now = this.clock.now();
    const sealed = this.cipher.encrypt(input.body);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.directMessage.create({
        data: {
          eventId: input.eventId,
          senderUserId: input.senderUserId,
          recipientUserId: input.recipientUserId,
          bodyCiphertext: new Uint8Array(sealed.ciphertext),
          bodyNonce: new Uint8Array(sealed.nonce),
          keyVersion: sealed.keyVersion,
          parentId: input.parentId,
          createdAt: now,
        },
        select: { id: true, publicId: true },
      });

      /**
       * The audit trail records **that** a message was sent, never what it said.
       *
       * The body is the whole reason the row is encrypted; copying it into
       * `audit_log`, which staff read, would undo that in the one place nobody
       * would think to look (ADR-0009).
       */
      await this.audit.record(
        {
          actorType: 'USER',
          actorId: input.senderUserId,
          action: 'direct.message_sent',
          targetType: 'direct_message',
          targetId: created.id,
          after: { eventId: input.eventId, isReply: input.parentId !== null },
        },
        tx,
      );

      await this.outbox.emit(
        {
          aggregateType: 'direct_message',
          aggregateId: created.id,
          eventType: 'direct.message_sent',
          payload: {
            messagePublicId: created.publicId,
            eventPublicId: input.eventPublicId,
            eventTitle: input.eventTitle,
            recipientUserPublicId: await publicIdOf(tx, input.recipientUserId),
            senderDisplayName: await displayNameOf(tx, input.senderUserId),
            isReply: input.parentId !== null,
          },
        },
        tx,
      );

      return created.publicId;
    });
  }
}

/**
 * Trimmed, bounded, and refused rather than truncated.
 *
 * Truncating would deliver half of what somebody wrote without telling them,
 * which for a message arranging a meeting is the half that says where.
 */
function normalizeBody(body: string): string {
  const text = body.trim();
  if (text.length < DIRECT_MESSAGE_MIN || text.length > DIRECT_MESSAGE_MAX) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'body' });
  }
  return text;
}

async function publicIdOf(tx: Prisma.TransactionClient, userId: string): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return user.publicId;
}

/**
 * The name the other party is shown.
 *
 * A **display name**, never a Telegram handle: what a reader sees of a stranger
 * is what that stranger put in their profile, and everything beyond it is theirs
 * to give up in the body of a message if they choose to.
 */
async function displayNameOf(tx: Prisma.TransactionClient, userId: string): Promise<string> {
  const profile = await tx.userProfile.findUnique({
    where: { userId },
    select: { displayName: true },
  });
  return profile?.displayName ?? 'کاربر پایه‌تَم';
}
