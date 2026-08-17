import { Prisma } from '@payetam/db';

/**
 * ADR-0006's `lockEventForUpdate`, and the only place in the product that writes
 * `SELECT … FOR UPDATE`.
 *
 * The ADR asks for exactly this: one documented helper that every capacity path
 * calls. The point is auditability — "every operation that can change
 * `accepted_count` takes the event row lock first" is a claim a reviewer can
 * check by finding the callers of these three functions, rather than by reading
 * every service looking for a raw query.
 *
 * Raw SQL because Prisma has no first-class `FOR UPDATE`. Tagged `Prisma.sql`
 * templates throughout, so the column list is a composed fragment and every
 * value is a bound parameter — there is no string concatenation here for CI's
 * SQL grep to catch and none for an attacker to reach.
 *
 * Three rules travel with the lock, and callers are responsible for all three:
 *
 *  1. **Lock first.** This is the first statement of the transaction.
 *  2. **Lock only.** No second lock while holding it — one resource, so lock
 *     ordering is total and deadlock impossible by construction.
 *  3. **Nothing slow inside.** No network call of any kind. Every joiner of a
 *     popular event queues behind this lock, so work done under it is work they
 *     all wait for. Notifications go through the outbox, which is a local insert.
 */
export interface LockedEvent {
  id: string;
  publicId: string;
  hostUserId: string;
  status: string;
  capacity: number;
  acceptedCount: number;
  startsAt: Date;
  deletedAt: Date | null;
  /**
   * Carried so the notifications these paths emit can name the event.
   *
   * Every template that says «…» about an event reads `eventTitle` from the outbox
   * payload, and no emitter provided one — so all of them rendered «» to real users.
   * The title has to come from inside the transaction that emits the row, and the
   * event row is already being read here; fetching it separately would be a second
   * query under the lock, which rule 3 exists to prevent.
   */
  title: string;
}

/**
 * The projection every capacity path needs.
 *
 * Narrow on purpose: the lock is held while the transaction runs, so a column
 * selected here is a column somebody may be tempted to do something slow with.
 * `title` earns its place by being the opposite: a plain string copied straight into
 * an outbox payload, on a row this query already reads.
 */
const LOCKED_COLUMNS = Prisma.sql`
  e."id",
  e."public_id"      AS "publicId",
  e."host_user_id"   AS "hostUserId",
  e."status"::text   AS "status",
  e."capacity",
  e."accepted_count" AS "acceptedCount",
  e."starts_at"      AS "startsAt",
  e."deleted_at"     AS "deletedAt",
  e."title"
`;

export async function lockEventForUpdate(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<LockedEvent | null> {
  const rows = await tx.$queryRaw<LockedEvent[]>(
    Prisma.sql`SELECT ${LOCKED_COLUMNS} FROM "event" e WHERE e."id" = ${eventId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

export async function lockEventByPublicIdForUpdate(
  tx: Prisma.TransactionClient,
  publicId: string,
): Promise<LockedEvent | null> {
  const rows = await tx.$queryRaw<LockedEvent[]>(
    Prisma.sql`SELECT ${LOCKED_COLUMNS} FROM "event" e WHERE e."public_id" = ${publicId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/**
 * The same lock, reached through one of the event's participations.
 *
 * `FOR UPDATE OF e` locks the event row and *only* the event row, even though the
 * query reads a participant to find it. That is what keeps rule 2 true when the
 * caller starts from a participant id: one lock, on the single resource every
 * capacity path contends for. The participant row needs no lock of its own,
 * because every writer of it holds this one first.
 */
export async function lockEventByParticipantPublicIdForUpdate(
  tx: Prisma.TransactionClient,
  participantPublicId: string,
): Promise<LockedEvent | null> {
  const rows = await tx.$queryRaw<LockedEvent[]>(
    Prisma.sql`
      SELECT ${LOCKED_COLUMNS}
      FROM "event" e
      JOIN "event_participant" p ON p."event_id" = e."id"
      WHERE p."public_id" = ${participantPublicId}
      FOR UPDATE OF e
    `,
  );
  return rows[0] ?? null;
}
