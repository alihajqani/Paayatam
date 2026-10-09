import type { Prisma } from '@payetam/db';
import { TEMPLATES } from '@payetam/telegram';
import type { DomainEvent } from '../outbox/outbox.service';

/** What failed to arrive, which decides the sentence the sender reads. */
export type BlockedCounterpartReason = 'JOIN_REQUEST' | 'DIRECT_MESSAGE' | 'ACCEPTED';

/**
 * The notifications one side of an activity sends the other (v0.24.0).
 *
 * Only these three. Each is the direct result of somebody's own tap, so each
 * has a sender who is now waiting on a reply that a block makes impossible.
 * Everything else the product sends on its own initiative (a reminder, a
 * rejection, a settlement) has nobody waiting on it, and telling a host «your
 * rejected guest blocked the bot» is noise.
 */
const REASON_BY_TEMPLATE: Readonly<Record<string, BlockedCounterpartReason>> = {
  [TEMPLATES.PARTICIPATION_REQUESTED_HOST]: 'JOIN_REQUEST',
  [TEMPLATES.DIRECT_MESSAGE_RECEIVED]: 'DIRECT_MESSAGE',
  [TEMPLATES.PARTICIPATION_ACCEPTED]: 'ACCEPTED',
};

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The outbox row that tells a sender their message hit a blocked bot, or null.
 *
 * ── Why the sender is looked up rather than read from the payload ───────────
 *
 * None of the three payloads names its sender as a user: `direct.message_sent`
 * carries a display name and `participation.accepted` carries nothing about the
 * host. Resolving here, from the event and the message the payload already
 * points at, works for every notification already queued, and keeps the three
 * emitters untouched.
 *
 * ── Why a seed is skipped ───────────────────────────────────────────────────
 *
 * A seed account has no Telegram link, so there is nobody to tell — and a
 * notice addressed to one would only become another undeliverable row. Seed
 * activities also stay undisclosed, which rules out ever explaining one.
 *
 * Null whenever anything is missing, never a throw: this runs inside the
 * transaction that records the block, and a garbled old payload must not stop
 * that from committing.
 */
export async function blockedCounterpartEvent(
  tx: Prisma.TransactionClient,
  input: {
    notificationId: string;
    blockedUserId: string;
    templateKey: string;
    payload: Prisma.JsonValue;
  },
): Promise<DomainEvent | null> {
  const reason = REASON_BY_TEMPLATE[input.templateKey];
  if (reason === undefined) return null;
  if (typeof input.payload !== 'object' || input.payload === null) return null;
  if (Array.isArray(input.payload)) return null;
  const payload = input.payload as Record<string, unknown>;

  const eventPublicId = text(payload, 'eventPublicId');
  if (eventPublicId === null) return null;
  const event = await tx.event.findUnique({
    where: { publicId: eventPublicId },
    select: { title: true, hostUserId: true },
  });
  if (event === null) return null;

  const senderUserId = await senderOf(tx, reason, payload, event.hostUserId);
  if (senderUserId === null || senderUserId === input.blockedUserId) return null;

  const [sender, blocked] = await Promise.all([
    tx.user.findUnique({
      where: { id: senderUserId },
      select: { publicId: true, isSeed: true },
    }),
    tx.userProfile.findUnique({
      where: { userId: input.blockedUserId },
      select: { displayName: true },
    }),
  ]);
  if (sender === null || sender.isSeed) return null;

  return {
    aggregateType: 'notification',
    aggregateId: input.notificationId,
    eventType: 'delivery.counterpart_blocked',
    payload: {
      senderUserPublicId: sender.publicId,
      blockedDisplayName: blocked?.displayName ?? 'کاربر پایتم',
      blockedRole: input.blockedUserId === event.hostUserId ? 'HOST' : 'GUEST',
      reason,
      eventPublicId,
      eventTitle: event.title,
    },
  };
}

async function senderOf(
  tx: Prisma.TransactionClient,
  reason: BlockedCounterpartReason,
  payload: Record<string, unknown>,
  hostUserId: string,
): Promise<string | null> {
  switch (reason) {
    // The host accepted; the host is who is waiting to hear it landed.
    case 'ACCEPTED':
      return hostUserId;

    case 'JOIN_REQUEST': {
      const guest = text(payload, 'participantUserPublicId');
      if (guest === null) return null;
      const user = await tx.user.findUnique({ where: { publicId: guest }, select: { id: true } });
      return user?.id ?? null;
    }

    case 'DIRECT_MESSAGE': {
      const message = text(payload, 'messagePublicId');
      if (message === null) return null;
      const row = await tx.directMessage.findUnique({
        where: { publicId: message },
        select: { senderUserId: true },
      });
      return row?.senderUserId ?? null;
    }
  }
}
