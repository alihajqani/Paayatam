import { Prisma } from '@payetam/db';

/**
 * The two conditions every «رفتار کاربران» report shares.
 *
 * In one file because two services read `bot_interaction`, and a report that
 * forgot one of these would disagree with the page beside it: one total with
 * the operator's own testing in it and one without, or one that counts a block
 * as a visit.
 *
 * Both are `Prisma.sql` fragments built from **string literals only** — no
 * value from a request is ever part of the text — so they are parameterised
 * like the templates they are placed in, and nothing here is the
 * `$queryRawUnsafe` CI fails the build on.
 */

/**
 * Staff are in no total.
 *
 * At this size the operator pressing buttons after a release is a visible share
 * of all traffic, and a report that counted it would be measuring the testing.
 * An account is staff when its Telegram id is linked to an admin (ADR-0018).
 *
 * The subquery reads `telegram_account` to make that match and **selects
 * nothing from it** — the pattern `AcquisitionReportService` documents for
 * `bot_blocked`. No Telegram id reaches a result row, so none can reach a
 * response (ADR-0009, invariant 7). A row with no user passes: `NULL = …` is
 * never true, so nobody is found to exclude it.
 *
 * `userId` is the column to test, as a fragment — `i."user_id"` for an
 * interaction, `n."user_id"` for a notification.
 */
export function notStaff(userId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "telegram_account" staff_account
    JOIN "admin_telegram_link" staff_link
      ON staff_link."telegram_user_id" = staff_account."telegram_user_id"
    WHERE staff_account."user_id" = ${userId}
  )`;
}

/** `notStaff` for the alias every query here gives `bot_interaction`. */
export const NOT_STAFF: Prisma.Sql = notStaff(Prisma.sql`i."user_id"`);

/**
 * Something a person did, as opposed to something that happened to the bot.
 *
 * A block and an unblock are recorded so the drop-off report can ask what came
 * before them. They are not a step anybody took *in* the bot, and counting
 * them as activity would make blocking the bot look like using it.
 */
export const IS_ACTIVITY: Prisma.Sql = Prisma.sql`i."kind" NOT IN ('BLOCKED', 'UNBLOCKED')`;
