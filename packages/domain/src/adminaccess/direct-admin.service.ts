import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { MessageCipher } from '../crypto/message-cipher';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** One side of a conversation, as the panel names it. */
export interface DirectParty {
  publicId: string;
  displayName: string;
  isHost: boolean;
}

export interface DirectThreadSummary {
  eventPublicId: string;
  eventTitle: string;
  participants: [DirectParty, DirectParty];
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
}

export interface DirectThreadMessage {
  publicId: string;
  senderPublicId: string;
  body: string;
  isReply: boolean;
  createdAt: Date;
  seenAt: Date | null;
}

export interface DirectThread {
  eventPublicId: string;
  eventTitle: string;
  participants: [DirectParty, DirectParty];
  messages: DirectThreadMessage[];
  /** Public ids of whichever side has blocked the other. */
  blockedBy: string[];
}

/** The longest conversation one read returns. Far past any real thread. */
const THREAD_MESSAGE_CAP = 500;

const DEFAULT_LIMIT = 30;

/** A name for an account whose profile is gone or was never written. */
const NO_NAME = 'بدون نام';

interface ThreadRow {
  event_public_id: string;
  event_title: string;
  host_user_id: string;
  a_public_id: string;
  a_user_id: string;
  a_name: string | null;
  b_public_id: string;
  b_user_id: string;
  b_name: string | null;
  messages: bigint;
  first_at: Date;
  last_at: Date;
}

/**
 * Direct messages in the panel, as conversations (ADR-0020).
 *
 * ── What a conversation is ──────────────────────────────────────────────────
 *
 * There is no thread table. A message names an activity, a sender and a
 * recipient, and a reply names its parent — but a host who writes to a guest
 * first and a guest who writes to the host later are one conversation to
 * anybody reading it, and two roots to the reply chain. So a conversation here
 * is **every message between the same two accounts about the same activity**,
 * oldest first, whichever of them started it.
 *
 * ── Who may read, and what it leaves behind ─────────────────────────────────
 *
 * `direct.read`, held by `SUPER_ADMIN` alone, asserted here rather than only in
 * a guard (invariant 12). Listing conversations shows who wrote to whom and
 * when — never the words — and writes nothing. **Opening one decrypts it, and
 * writes `direct.thread_read`** naming the conversation: a permission says who
 * may look, the row says who did.
 */
@Injectable()
export class DirectAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly cipher: MessageCipher,
    private readonly audit: AuditService,
  ) {}

  /** Conversations, most recently active first. */
  async listThreads(
    session: AdminSession,
    filter: { userPublicId?: string; limit?: number; offset?: number },
  ): Promise<{ threads: DirectThreadSummary[]; total: number }> {
    this.access.assertPermission(session, PERMISSIONS.DIRECT_READ);

    let userId: string | null = null;
    if (filter.userPublicId !== undefined) {
      const user = await this.prisma.user.findUnique({
        where: { publicId: filter.userPublicId },
        select: { id: true },
      });
      if (!user) return { threads: [], total: 0 };
      userId = user.id;
    }

    const limit = filter.limit ?? DEFAULT_LIMIT;
    const offset = filter.offset ?? 0;

    /**
     * `LEAST`/`GREATEST` fold the two directions of a conversation into one
     * group, which is the whole definition above in one line. Tagged, so every
     * value is a bound parameter (T10).
     */
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<ThreadRow[]>`
        SELECT e."public_id" AS event_public_id,
               e."title" AS event_title,
               e."host_user_id" AS host_user_id,
               ua."public_id" AS a_public_id,
               ua."id" AS a_user_id,
               pa."display_name" AS a_name,
               ub."public_id" AS b_public_id,
               ub."id" AS b_user_id,
               pb."display_name" AS b_name,
               t.messages,
               t.first_at,
               t.last_at
          FROM (
            SELECT "event_id",
                   LEAST("sender_user_id", "recipient_user_id") AS a,
                   GREATEST("sender_user_id", "recipient_user_id") AS b,
                   COUNT(*) AS messages,
                   MIN("created_at") AS first_at,
                   MAX("created_at") AS last_at
              FROM "direct_message"
             WHERE ${userId}::text IS NULL
                OR "sender_user_id" = ${userId}
                OR "recipient_user_id" = ${userId}
             GROUP BY 1, 2, 3
          ) t
          JOIN "event" e ON e."id" = t."event_id"
          JOIN "user" ua ON ua."id" = t.a
          JOIN "user" ub ON ub."id" = t.b
          LEFT JOIN "user_profile" pa ON pa."user_id" = t.a
          LEFT JOIN "user_profile" pb ON pb."user_id" = t.b
         ORDER BY t.last_at DESC
         LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(*) AS total
          FROM (
            SELECT 1
              FROM "direct_message"
             WHERE ${userId}::text IS NULL
                OR "sender_user_id" = ${userId}
                OR "recipient_user_id" = ${userId}
             GROUP BY "event_id",
                      LEAST("sender_user_id", "recipient_user_id"),
                      GREATEST("sender_user_id", "recipient_user_id")
          ) t
      `,
    ]);

    return {
      threads: rows.map((row) => ({
        eventPublicId: row.event_public_id,
        eventTitle: row.event_title,
        participants: [
          {
            publicId: row.a_public_id,
            displayName: row.a_name ?? NO_NAME,
            isHost: row.a_user_id === row.host_user_id,
          },
          {
            publicId: row.b_public_id,
            displayName: row.b_name ?? NO_NAME,
            isHost: row.b_user_id === row.host_user_id,
          },
        ],
        messageCount: Number(row.messages),
        firstMessageAt: row.first_at,
        lastMessageAt: row.last_at,
      })),
      total: Number(counted[0]?.total ?? 0n),
    };
  }

  /**
   * One conversation, decrypted, oldest first — and an audit row saying so.
   *
   * The three ids are validated as a set: an activity and two accounts that
   * never exchanged a message are `NOT_FOUND`, the same as ids that name nothing,
   * so the endpoint cannot be used to ask whether two people know each other.
   */
  async readThread(
    session: AdminSession,
    query: { eventPublicId: string; userPublicId: string; otherUserPublicId: string },
  ): Promise<DirectThread> {
    this.access.assertPermission(session, PERMISSIONS.DIRECT_READ);

    const [event, users] = await Promise.all([
      this.prisma.event.findUnique({
        where: { publicId: query.eventPublicId },
        select: { id: true, publicId: true, title: true, hostUserId: true },
      }),
      this.prisma.user.findMany({
        where: { publicId: { in: [query.userPublicId, query.otherUserPublicId] } },
        select: { id: true, publicId: true, profile: { select: { displayName: true } } },
      }),
    ]);
    const first = users.find((user) => user.publicId === query.userPublicId);
    const second = users.find((user) => user.publicId === query.otherUserPublicId);
    if (!event || !first || !second || first.id === second.id) {
      throw new AppError(ErrorCode.NOT_FOUND);
    }

    const [rows, blocks] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: {
          eventId: event.id,
          OR: [
            { senderUserId: first.id, recipientUserId: second.id },
            { senderUserId: second.id, recipientUserId: first.id },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: THREAD_MESSAGE_CAP,
        select: {
          publicId: true,
          senderUserId: true,
          parentId: true,
          bodyCiphertext: true,
          bodyNonce: true,
          keyVersion: true,
          createdAt: true,
          seenAt: true,
        },
      }),
      this.prisma.directMessageBlock.findMany({
        where: {
          OR: [
            { blockerUserId: first.id, blockedUserId: second.id },
            { blockerUserId: second.id, blockedUserId: first.id },
          ],
        },
        select: { blockerUserId: true },
      }),
    ]);
    if (rows.length === 0) throw new AppError(ErrorCode.NOT_FOUND);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'direct.thread_read',
      targetType: 'event',
      targetId: event.id,
      // Which conversation, never what it said: the body is encrypted precisely
      // so that a table staff read is not a transcript (ADR-0009).
      after: {
        userPublicId: first.publicId,
        otherUserPublicId: second.publicId,
        messages: rows.length,
      },
    });

    const publicIdOf = (userId: string): string =>
      userId === first.id ? first.publicId : second.publicId;
    const party = (user: typeof first): DirectParty => ({
      publicId: user.publicId,
      displayName: user.profile?.displayName ?? NO_NAME,
      isHost: user.id === event.hostUserId,
    });

    return {
      eventPublicId: event.publicId,
      eventTitle: event.title,
      participants: [party(first), party(second)],
      messages: rows.map((row) => ({
        publicId: row.publicId,
        senderPublicId: publicIdOf(row.senderUserId),
        body: this.cipher.decrypt({
          ciphertext: Buffer.from(row.bodyCiphertext),
          nonce: Buffer.from(row.bodyNonce),
          keyVersion: row.keyVersion,
        }),
        isReply: row.parentId !== null,
        createdAt: row.createdAt,
        seenAt: row.seenAt,
      })),
      blockedBy: blocks.map((block) => publicIdOf(block.blockerUserId)),
    };
  }
}
