import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import {
  INTERACTION_FUNNEL_SCREENS,
  INTERACTION_QUIET_DAYS,
  INTERACTION_WIZARD_MARKS,
  type AcquisitionSource,
  type InteractionFormFunnel,
  type InteractionOnboardingFunnel,
  type InteractionReturnCohort,
} from '@payetam/shared';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { IS_ACTIVITY, NOT_STAFF, notStaff } from './interaction-report.sql';
import { PERMISSIONS } from './permissions';

export interface InteractionFunnels {
  windowDays: number;
  since: Date;
  onboarding: {
    totals: InteractionOnboardingFunnel;
    rows: (InteractionOnboardingFunnel & { source: AcquisitionSource | null })[];
  };
  forms: InteractionFormFunnel[];
}

export interface InteractionDropoff {
  windowDays: number;
  since: Date;
  quietDays: number;
  quietUsers: number;
  lastSeen: {
    screen: string | null;
    wizardKind: string | null;
    wizardStep: string | null;
    users: number;
  }[];
  refusals: { action: string; detail: string | null; count: number; users: number }[];
  gates: { gate: string; count: number; users: number }[];
  stale: { action: string; count: number; users: number }[];
  failures: { action: string; count: number }[];
  unclaimedText: { count: number; users: number };
  unsupported: { count: number; users: number };
  blocks: {
    total: number;
    withinFiveMinutes: number;
    withinDay: number;
    lastScreens: { screen: string | null; blocks: number }[];
  };
}

export interface InteractionReturn {
  windowDays: number;
  since: Date;
  cohorts: {
    totals: InteractionReturnCohort;
    rows: (InteractionReturnCohort & { source: AcquisitionSource | null })[];
  };
  notifications: {
    templateKey: string;
    sent: number;
    recipients: number;
    tapped: number;
    followedWithinDay: number;
  }[];
}

/** Rows on one screen of the longer lists. */
const MAX_ROWS = 100;

/**
 * What a submitted form is called inside the form queries.
 *
 * `finished_wizard` is a column of its own (migration 0066), and the queries
 * below fold it back into the list of a form's steps so "where was this person
 * last seen in this form" has one list to read. The name never leaves this
 * file: it is not a value `wizard_step` can hold, and it is filtered out of
 * every list of steps that is returned.
 */
const SUBMITTED = '$submitted';

const DAY_MS = 86_400_000;

/**
 * Funnels, drop-off and return — the second half of «رفتار کاربران».
 *
 * ── Why a second service ────────────────────────────────────────────────────
 *
 * `InteractionReportService` answers "how much": how many people, how many
 * taps, how often refused. Every question here is about **order** — which step
 * came last, what was on screen before a block, whether anything happened a
 * week after arriving — so every query here is a window function or a
 * correlated subquery over one person's rows in time. Two files because a
 * reader fixing a count should not have to read eleven of those first.
 *
 * ── People, not rows ────────────────────────────────────────────────────────
 *
 * Every number is a count of people unless its name says otherwise. Somebody
 * who opens the profile form three times and finishes it once is one person
 * who started and one who finished: a funnel in attempts would say the form
 * loses two thirds of the people it in fact keeps.
 *
 * ── The same two rules as the first half ────────────────────────────────────
 *
 * Staff are in no total, and a block is not something somebody *did* — both
 * from `interaction-report.sql.ts`, so the six tabs of one page cannot disagree
 * about who is counted. `dashboard.read`, asserted here (invariant 12). One
 * tagged template per statement; nothing is built at runtime. Nothing writes.
 */
@Injectable()
export class InteractionJourneyReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
  ) {}

  async funnels(session: AdminSession, windowDays: number): Promise<InteractionFunnels> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since = this.since(windowDays);
    const formRows = formRowsSince(since);

    const [onboarding, steps, forms] = await Promise.all([
      /**
       * The accounts the window created, and how far each got — ever, not only
       * inside the window: somebody who arrived on its last day and finished
       * their profile the next morning did finish it.
       *
       * Three kinds of evidence, each used where it is the truest available.
       * `onboarding_state` and `event_participant` are facts about the account.
       * "Was shown the list" and "was shown an event" are read from `screen`,
       * because the tap is not the fact: `/start event_…` from somebody who
       * owes a sign-up step is a tap on an event link that shows the terms.
       */
      this.prisma.$queryRaw<
        {
          source: AcquisitionSource | null;
          arrived: bigint;
          pressed_anything: bigint;
          terms_accepted: bigint;
          profile_complete: bigint;
          opened_discovery: bigint;
          opened_event: bigint;
          requested: bigint;
        }[]
      >`
        SELECT a."source"::text AS source,
               COUNT(*) AS arrived,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "bot_interaction" later
                 WHERE later."user_id" = i."user_id"
                   AND later."kind" NOT IN ('START', 'BLOCKED', 'UNBLOCKED')
               )) AS pressed_anything,
               COUNT(*) FILTER (
                 WHERE u."onboarding_state" IN ('TERMS_ACCEPTED', 'PROFILE_COMPLETE')
               ) AS terms_accepted,
               COUNT(*) FILTER (WHERE u."onboarding_state" = 'PROFILE_COMPLETE') AS profile_complete,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "bot_interaction" shown
                 WHERE shown."user_id" = i."user_id"
                   AND shown."screen" = ${INTERACTION_FUNNEL_SCREENS.DISCOVERY}
               )) AS opened_discovery,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "bot_interaction" shown
                 WHERE shown."user_id" = i."user_id"
                   AND shown."screen" = ${INTERACTION_FUNNEL_SCREENS.EVENT}
               )) AS opened_event,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "event_participant" ep WHERE ep."user_id" = i."user_id"
               )) AS requested
        FROM "bot_interaction" i
        JOIN "user" u ON u."id" = i."user_id"
        LEFT JOIN "user_acquisition" a ON a."user_id" = i."user_id"
        WHERE i."created_account" AND i."created_at" >= ${since} AND ${NOT_STAFF}
        GROUP BY 1
      `,
      /**
       * Each form's steps: how many people reached each, and how many were
       * left on it.
       *
       * `first_seen` and `step_rank` order the steps the way people meet them,
       * without this file knowing any wizard's definition: a step's place is
       * the average of where it fell in each person's own run. A form with an
       * optional step some people skip still lists it where the rest found it.
       *
       * "Left here" is the last thing a person was shown in that form, for the
       * people who never sent it. Closing a form is not being left on a step —
       * the last row is then the cancellation itself — which is why a cancel
       * shows up in the form's totals and on no step.
       */
      this.prisma.$queryRaw<
        { kind: string; step: string; users: bigint; step_rank: number; left_here: bigint }[]
      >`
        WITH ${formRows},
        finished AS (
          SELECT DISTINCT user_id, kind FROM form_rows WHERE step = ${SUBMITTED}
        ),
        last_row AS (
          SELECT DISTINCT ON (user_id, kind) user_id, kind, step
          FROM form_rows
          ORDER BY user_id, kind, created_at DESC, id DESC
        ),
        first_seen AS (
          SELECT user_id, kind, step, MIN(created_at) AS first_at
          FROM form_rows
          GROUP BY 1, 2, 3
        ),
        ranked AS (
          SELECT user_id, kind, step,
                 ROW_NUMBER() OVER (PARTITION BY user_id, kind ORDER BY first_at) AS step_rank
          FROM first_seen
        )
        SELECT r.kind AS kind,
               r.step AS step,
               COUNT(*) AS users,
               AVG(r.step_rank)::float8 AS step_rank,
               COUNT(*) FILTER (WHERE l.step = r.step AND f.user_id IS NULL) AS left_here
        FROM ranked r
        JOIN last_row l ON l.user_id = r.user_id AND l.kind = r.kind
        LEFT JOIN finished f ON f.user_id = r.user_id AND f.kind = r.kind
        GROUP BY 1, 2
        ORDER BY 1, 4, 2
      `,
      this.prisma.$queryRaw<
        { kind: string; started: bigint; submitted: bigint; cancelled: bigint }[]
      >`
        WITH ${formRows}
        SELECT kind,
               COUNT(DISTINCT user_id) AS started,
               COUNT(DISTINCT user_id) FILTER (WHERE step = ${SUBMITTED}) AS submitted,
               COUNT(DISTINCT user_id) FILTER (
                 WHERE step = ${INTERACTION_WIZARD_MARKS.CANCELLED}
               ) AS cancelled
        FROM form_rows
        GROUP BY 1
      `,
    ]);

    const rows = onboarding
      .map((row) => ({
        source: row.source,
        arrived: Number(row.arrived),
        pressedAnything: Number(row.pressed_anything),
        termsAccepted: Number(row.terms_accepted),
        profileComplete: Number(row.profile_complete),
        openedDiscovery: Number(row.opened_discovery),
        openedEvent: Number(row.opened_event),
        requested: Number(row.requested),
      }))
      .sort(bySizeThenSource);

    return {
      windowDays,
      since,
      onboarding: { totals: sumOnboarding(rows), rows },
      forms: forms
        .map((form) => ({
          kind: form.kind,
          started: Number(form.started),
          submitted: Number(form.submitted),
          cancelled: Number(form.cancelled),
          steps: steps
            .filter((step) => step.kind === form.kind && isAStep(step.step))
            .map((step) => ({
              step: step.step,
              users: Number(step.users),
              leftHere: Number(step.left_here),
            })),
        }))
        .sort((a, b) => b.started - a.started || a.kind.localeCompare(b.kind)),
    };
  }

  async dropoff(session: AdminSession, windowDays: number): Promise<InteractionDropoff> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since = this.since(windowDays);
    const quietBefore = new Date(this.clock.now().getTime() - INTERACTION_QUIET_DAYS * DAY_MS);

    const [lastSeen, refusals, gates, unanswered, noise, blocks] = await Promise.all([
      /**
       * People who stopped: their last action, ever, is inside the window and
       * at least a week old. "Ever" matters — the inner query is not windowed,
       * so somebody active yesterday is not listed by an older row of theirs.
       *
       * Grouped by what they were left looking at, which for somebody in the
       * middle of a form is the form and the question.
       */
      this.prisma.$queryRaw<
        {
          screen: string | null;
          wizard_kind: string | null;
          wizard_step: string | null;
          users: bigint;
        }[]
      >`
        WITH last_step AS (
          SELECT DISTINCT ON (i."user_id")
                 i."created_at" AS seen_at, i."screen", i."wizard_kind", i."wizard_step"
          FROM "bot_interaction" i
          WHERE ${IS_ACTIVITY} AND i."user_id" IS NOT NULL AND ${NOT_STAFF}
          ORDER BY i."user_id", i."created_at" DESC, i."id" DESC
        )
        SELECT "screen" AS screen,
               "wizard_kind" AS wizard_kind,
               "wizard_step" AS wizard_step,
               COUNT(*) AS users
        FROM last_step
        WHERE seen_at >= ${since} AND seen_at < ${quietBefore}
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC, 1 NULLS LAST, 2 NULLS LAST, 3 NULLS LAST
      `,
      this.prisma.$queryRaw<
        { action: string; detail: string | null; count: bigint; users: bigint }[]
      >`
        SELECT i."action" AS action, i."detail" AS detail,
               COUNT(*) AS count, COUNT(DISTINCT i."user_id") AS users
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND i."outcome" = 'REFUSED' AND ${NOT_STAFF}
        GROUP BY 1, 2
        ORDER BY 3 DESC, 1, 2
      `,
      // By gate and not by action: a person turned back from three different
      // buttons is one person who owes one step.
      this.prisma.$queryRaw<{ gate: string | null; count: bigint; users: bigint }[]>`
        SELECT i."detail" AS gate, COUNT(*) AS count, COUNT(DISTINCT i."user_id") AS users
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND i."outcome" = 'GATED' AND ${NOT_STAFF}
        GROUP BY 1
        ORDER BY 2 DESC, 1
      `,
      this.prisma.$queryRaw<{ outcome: string; action: string; count: bigint; users: bigint }[]>`
        SELECT i."outcome"::text AS outcome, i."action" AS action,
               COUNT(*) AS count, COUNT(DISTINCT i."user_id") AS users
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since} AND i."outcome" IN ('STALE', 'FAILED') AND ${NOT_STAFF}
        GROUP BY 1, 2
        ORDER BY 3 DESC, 2
      `,
      this.prisma.$queryRaw<{ action: string; count: bigint; users: bigint }[]>`
        SELECT i."action" AS action, COUNT(*) AS count, COUNT(DISTINCT i."user_id") AS users
        FROM "bot_interaction" i
        WHERE i."created_at" >= ${since}
          AND i."action" IN ('text:unclaimed', 'unsupported')
          AND ${NOT_STAFF}
        GROUP BY 1
      `,
      /**
       * Every block in the window, with what the person had last been shown
       * and how long they had had an account.
       *
       * The age is from `user.created_at`, not from the first recorded
       * interaction: an account older than this table has no arrival row, and
       * measuring it from its first *recorded* tap would file a long-standing
       * member's block under "left within five minutes".
       */
      this.prisma.$queryRaw<
        { screen: string | null; blocks: bigint; within_five: bigint; within_day: bigint }[]
      >`
        WITH blocked AS (
          SELECT i."created_at" AS blocked_at,
                 u."created_at" AS arrived_at,
                 (
                   SELECT earlier."screen"
                   FROM "bot_interaction" earlier
                   WHERE earlier."user_id" = i."user_id"
                     AND earlier."created_at" < i."created_at"
                     AND earlier."kind" NOT IN ('BLOCKED', 'UNBLOCKED')
                   ORDER BY earlier."created_at" DESC, earlier."id" DESC
                   LIMIT 1
                 ) AS last_screen
          FROM "bot_interaction" i
          JOIN "user" u ON u."id" = i."user_id"
          WHERE i."kind" = 'BLOCKED' AND i."created_at" >= ${since} AND ${NOT_STAFF}
        )
        SELECT last_screen AS screen,
               COUNT(*) AS blocks,
               COUNT(*) FILTER (
                 WHERE blocked_at - arrived_at <= interval '5 minutes'
               ) AS within_five,
               COUNT(*) FILTER (WHERE blocked_at - arrived_at <= interval '1 day') AS within_day
        FROM blocked
        GROUP BY 1
        ORDER BY 2 DESC, 1 NULLS LAST
      `,
    ]);

    const countOf = (action: string): { count: number; users: number } => {
      const row = noise.find((candidate) => candidate.action === action);
      return { count: Number(row?.count ?? 0), users: Number(row?.users ?? 0) };
    };

    return {
      windowDays,
      since,
      quietDays: INTERACTION_QUIET_DAYS,
      quietUsers: lastSeen.reduce((sum, row) => sum + Number(row.users), 0),
      lastSeen: lastSeen.slice(0, MAX_ROWS).map((row) => ({
        screen: row.screen,
        wizardKind: row.wizard_kind,
        wizardStep: row.wizard_step,
        users: Number(row.users),
      })),
      refusals: refusals.slice(0, MAX_ROWS).map((row) => ({
        action: row.action,
        detail: row.detail,
        count: Number(row.count),
        users: Number(row.users),
      })),
      gates: gates.map((row) => ({
        gate: row.gate ?? 'unknown',
        count: Number(row.count),
        users: Number(row.users),
      })),
      stale: unanswered
        .filter((row) => row.outcome === 'STALE')
        .map((row) => ({
          action: row.action,
          count: Number(row.count),
          users: Number(row.users),
        })),
      failures: unanswered
        .filter((row) => row.outcome === 'FAILED')
        .map((row) => ({ action: row.action, count: Number(row.count) })),
      unclaimedText: countOf('text:unclaimed'),
      unsupported: countOf('unsupported'),
      blocks: {
        total: blocks.reduce((sum, row) => sum + Number(row.blocks), 0),
        withinFiveMinutes: blocks.reduce((sum, row) => sum + Number(row.within_five), 0),
        withinDay: blocks.reduce((sum, row) => sum + Number(row.within_day), 0),
        lastScreens: blocks.map((row) => ({ screen: row.screen, blocks: Number(row.blocks) })),
      },
    };
  }

  /** `return` is a word the language keeps; the report is named for what it asks. */
  async returning(session: AdminSession, windowDays: number): Promise<InteractionReturn> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const since = this.since(windowDays);
    const now = this.clock.now().getTime();
    const [oneDayAgo, sevenDaysAgo, thirtyDaysAgo] = [1, 7, 30].map(
      (days) => new Date(now - days * DAY_MS),
    ) as [Date, Date, Date];

    const [cohorts, notifications] = await Promise.all([
      /**
       * Each "came back after N days" has its own denominator: the accounts
       * that arrived at least N days ago. An account three days old can be
       * asked about day one and cannot yet be asked about day seven, and
       * dividing by everybody would count it as a week-seven loss on day four.
       *
       * "Came back" is something done at least N days after arriving. A block
       * is not a return.
       */
      this.prisma.$queryRaw<
        {
          source: AcquisitionSource | null;
          arrived: bigint;
          eligible_1: bigint;
          returned_1: bigint;
          eligible_7: bigint;
          returned_7: bigint;
          eligible_30: bigint;
          returned_30: bigint;
        }[]
      >`
        SELECT a."source"::text AS source,
               COUNT(*) AS arrived,
               COUNT(*) FILTER (WHERE i."created_at" <= ${oneDayAgo}) AS eligible_1,
               COUNT(*) FILTER (WHERE i."created_at" <= ${oneDayAgo} AND EXISTS (
                 SELECT 1 FROM "bot_interaction" later
                 WHERE later."user_id" = i."user_id"
                   AND later."kind" NOT IN ('BLOCKED', 'UNBLOCKED')
                   AND later."created_at" >= i."created_at" + interval '1 day'
               )) AS returned_1,
               COUNT(*) FILTER (WHERE i."created_at" <= ${sevenDaysAgo}) AS eligible_7,
               COUNT(*) FILTER (WHERE i."created_at" <= ${sevenDaysAgo} AND EXISTS (
                 SELECT 1 FROM "bot_interaction" later
                 WHERE later."user_id" = i."user_id"
                   AND later."kind" NOT IN ('BLOCKED', 'UNBLOCKED')
                   AND later."created_at" >= i."created_at" + interval '7 days'
               )) AS returned_7,
               COUNT(*) FILTER (WHERE i."created_at" <= ${thirtyDaysAgo}) AS eligible_30,
               COUNT(*) FILTER (WHERE i."created_at" <= ${thirtyDaysAgo} AND EXISTS (
                 SELECT 1 FROM "bot_interaction" later
                 WHERE later."user_id" = i."user_id"
                   AND later."kind" NOT IN ('BLOCKED', 'UNBLOCKED')
                   AND later."created_at" >= i."created_at" + interval '30 days'
               )) AS returned_30
        FROM "bot_interaction" i
        LEFT JOIN "user_acquisition" a ON a."user_id" = i."user_id"
        WHERE i."created_account" AND i."created_at" >= ${since} AND ${NOT_STAFF}
        GROUP BY 1
      `,
      /**
       * What the product sent on its own, and what followed.
       *
       * `dedupe_key NOT LIKE 'bot:%'` is what "on its own" means: a reply to
       * somebody's own update is keyed `bot:<update>:<template>` by
       * `BotService.reply`, and everything else came from the outbox.
       *
       * `tapped` is exact — a button on that very message, matched by the
       * message id Telegram gave it. `followed` is not: it is anything the
       * person did in the next day, which the message can only share the
       * credit for. Both are shown, and named for what they are.
       */
      this.prisma.$queryRaw<
        {
          template_key: string;
          sent: bigint;
          recipients: bigint;
          tapped: bigint;
          followed: bigint;
        }[]
      >`
        SELECT n."template_key" AS template_key,
               COUNT(*) AS sent,
               COUNT(DISTINCT n."user_id") AS recipients,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "bot_interaction" tap
                 WHERE tap."user_id" = n."user_id"
                   AND tap."kind" = 'CALLBACK'
                   AND tap."message_id" = n."telegram_message_id"
                   AND tap."created_at" >= n."sent_at"
               )) AS tapped,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "bot_interaction" next_step
                 WHERE next_step."user_id" = n."user_id"
                   AND next_step."kind" NOT IN ('BLOCKED', 'UNBLOCKED')
                   AND next_step."created_at" >= n."sent_at"
                   AND next_step."created_at" < n."sent_at" + interval '1 day'
               )) AS followed
        FROM "notification" n
        WHERE n."sent_at" >= ${since}
          AND n."dedupe_key" NOT LIKE 'bot:%'
          AND ${notStaff(Prisma.sql`n."user_id"`)}
        GROUP BY 1
        ORDER BY 2 DESC, 1
      `,
    ]);

    const rows = cohorts
      .map((row) => ({
        source: row.source,
        arrived: Number(row.arrived),
        eligibleDay1: Number(row.eligible_1),
        returnedDay1: Number(row.returned_1),
        eligibleDay7: Number(row.eligible_7),
        returnedDay7: Number(row.returned_7),
        eligibleDay30: Number(row.eligible_30),
        returnedDay30: Number(row.returned_30),
      }))
      .sort(bySizeThenSource);

    return {
      windowDays,
      since,
      cohorts: { totals: sumCohorts(rows), rows },
      notifications: notifications.slice(0, MAX_ROWS).map((row) => ({
        templateKey: row.template_key,
        sent: Number(row.sent),
        recipients: Number(row.recipients),
        tapped: Number(row.tapped),
        followedWithinDay: Number(row.followed),
      })),
    };
  }

  private since(windowDays: number): Date {
    return new Date(this.clock.now().getTime() - windowDays * DAY_MS);
  }
}

/**
 * Every row that says something about a form, one per person per moment.
 *
 * Two kinds of row are folded into one list:
 *
 *  - **a position** — the form and step left on screen. A cancelled form has
 *    no kind of its own (`ConversationService` has cleared the draft by then),
 *    so it takes the kind of that person's row before it, which is the step it
 *    was cancelled from.
 *  - **a submission the product accepted** — `finished_wizard`, as the
 *    pseudo-step `$submitted`. A refused submission is deliberately not one:
 *    the draft survives it and the person is still on the review screen, so
 *    their last position stands and they are counted as left there.
 *
 * `LAG` runs over all of a person's rows in the window before any is filtered
 * out, which is what lets a cancel find the step it followed.
 */
function formRowsSince(since: Date): Prisma.Sql {
  return Prisma.sql`
    attributed AS (
      SELECT i."id" AS id,
             i."user_id" AS user_id,
             i."created_at" AS created_at,
             i."outcome" AS outcome,
             i."wizard_step" AS step,
             i."finished_wizard" AS finished,
             COALESCE(
               i."wizard_kind",
               LAG(i."wizard_kind") OVER (
                 PARTITION BY i."user_id" ORDER BY i."created_at", i."id"
               )
             ) AS kind
      FROM "bot_interaction" i
      WHERE i."created_at" >= ${since} AND i."user_id" IS NOT NULL AND ${NOT_STAFF}
    ),
    form_rows AS (
      SELECT id, user_id, created_at, kind, step
      FROM attributed
      WHERE kind IS NOT NULL AND step IS NOT NULL
      UNION ALL
      SELECT id, user_id, created_at, finished AS kind, ${SUBMITTED} AS step
      FROM attributed
      WHERE finished IS NOT NULL AND outcome = 'OK'
    )`;
}

/** A question, or the review screen — not the two ways a form ends. */
function isAStep(step: string): boolean {
  return step !== SUBMITTED && step !== INTERACTION_WIZARD_MARKS.CANCELLED;
}

/** Largest first; a tie is broken by name so a reload does not reshuffle it. */
function bySizeThenSource(
  a: { arrived: number; source: string | null },
  b: { arrived: number; source: string | null },
): number {
  return b.arrived - a.arrived || (a.source ?? '~').localeCompare(b.source ?? '~');
}

function sumOnboarding(rows: InteractionOnboardingFunnel[]): InteractionOnboardingFunnel {
  const total: InteractionOnboardingFunnel = {
    arrived: 0,
    pressedAnything: 0,
    termsAccepted: 0,
    profileComplete: 0,
    openedDiscovery: 0,
    openedEvent: 0,
    requested: 0,
  };
  for (const row of rows) {
    total.arrived += row.arrived;
    total.pressedAnything += row.pressedAnything;
    total.termsAccepted += row.termsAccepted;
    total.profileComplete += row.profileComplete;
    total.openedDiscovery += row.openedDiscovery;
    total.openedEvent += row.openedEvent;
    total.requested += row.requested;
  }
  return total;
}

function sumCohorts(rows: InteractionReturnCohort[]): InteractionReturnCohort {
  const total: InteractionReturnCohort = {
    arrived: 0,
    eligibleDay1: 0,
    returnedDay1: 0,
    eligibleDay7: 0,
    returnedDay7: 0,
    eligibleDay30: 0,
    returnedDay30: 0,
  };
  for (const row of rows) {
    total.arrived += row.arrived;
    total.eligibleDay1 += row.eligibleDay1;
    total.returnedDay1 += row.returnedDay1;
    total.eligibleDay7 += row.eligibleDay7;
    total.returnedDay7 += row.returnedDay7;
    total.eligibleDay30 += row.eligibleDay30;
    total.returnedDay30 += row.returnedDay30;
  }
  return total;
}
