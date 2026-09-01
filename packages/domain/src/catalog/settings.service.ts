import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';

/**
 * Reads policy numbers out of `app_setting`.
 *
 * ADR-0007 and ADR-0011: every tunable number in the product — reward amounts,
 * penalty thresholds, the report threshold, ranking weights — lives in the
 * database so tuning is a config change rather than a deploy.
 *
 * The defaults below are not a second source of truth. They are what the system
 * does when a row is missing: on a fresh database, before the seed has run, or
 * after someone deletes a key by hand. The alternative — throwing — would mean a
 * missing config row takes onboarding down, which is a worse failure than
 * granting the documented default. Every default here matches plan §11.
 */
export const SETTING_DEFAULTS = {
  /** Coins granted once, when a user first completes their profile. */
  'economy.onboarding_reward_coins': 50,

  /**
   * The referral pair (plan §11), paid only after the referred user **attends**
   * an event — not on signup. A referral that pays out for creating an account
   * pays out for creating accounts (T6).
   */
  'economy.referral_referrer_coins': 30,
  'economy.referral_referred_coins': 10,

  /**
   * The two coin sinks in MVP (plan §2.9). Boost buys 24 hours near the top of
   * discovery; VIP is a one-off placement flag.
   */
  'economy.boost_coins': 40,
  'economy.boost_duration_hours': 24,
  'economy.vip_coins': 100,

  /**
   * What the three M22 promotion actions cost (phase 5).
   *
   * Here rather than as constants for the reason §11 gives about every other
   * number in this table: an operator who finds that five coins is too steep for
   * a first event has to be able to change it without a deploy, and a price that
   * only exists in a compiled bundle cannot be changed at all.
   *
   * **Zero is a legitimate value and means free**, which is how the feature is
   * rolled back: set `economy.event_create_coins` to 0 and creating an event stops
   * costing anything, with no code path removed and no migration. The services
   * skip the ledger write entirely at zero, so a free action leaves no row
   * claiming somebody paid nothing.
   */
  'economy.event_create_coins': 5,
  /**
   * The channel publication a new activity gets by default.
   *
   * Charged **with** `event_create_coins` in the same transaction, so registering
   * an activity costs `5 + 10 = 15` and puts it in the channel without the host
   * asking. Two settings rather than one `event_register_coins`, because the two
   * halves buy different things and an operator has to be able to price them
   * apart — and because the create charge already exists in the ledger under its
   * own type, which a merged number would have made unreadable.
   *
   * **The split is deliberately not shown to the user.** The bot says «ثبت فعالیت
   * ۱۵ سکه هزینه دارد» and stops; a host choosing between two line items they
   * cannot decline is a choice that does not exist.
   */
  'economy.event_channel_publish_coins': 10,
  /**
   * Renewing a channel post — publishing the same activity again so it is seen
   * again. Cheaper than the original publication because the activity is already
   * in the channel's history; what is being bought is position, not reach.
   */
  'economy.event_channel_send_coins': 5,
  'economy.event_top_invite_coins': 20,
  /**
   * What asking to join an activity costs (v0.6.3).
   *
   * **Zero, and the zero is the point.** Joining has been free on every surface
   * since M6, and the channel post's «شرکت می‌کنم» button reaches the same
   * `ParticipationService.join` the in-bot button does — so a non-zero default
   * would start charging for every join everywhere, on a live product, as a side
   * effect of adding a button to a channel post.
   *
   * The price exists so an operator can set one without a deploy, which is what
   * §11 puts tunable numbers in the database for. At zero the service writes no
   * ledger row at all: `coin_ledger.amount` may not be zero, and a row claiming
   * somebody paid nothing is worse than no row.
   *
   * A waitlisted request is charged like an accepted one, and deliberately: what
   * is being paid for is the *ask*, which consumes a host's attention and a slot
   * of the daily quota whether or not a seat was free. Refunding a rejection
   * would make the price a deposit, which is a different product decision and
   * one nobody has taken.
   */
  'economy.event_join_coins': 0,
  /**
   * How many people one paid invitation reaches (phase 11).
   *
   * A setting rather than the literal 20 the requirement names, because the
   * price and the reach are tuned against each other and changing one without
   * the other is how a promotion stops making sense. The selector never returns
   * more than this however many candidates qualify.
   */
  'events.top_invite_max_recipients': 20,

  /**
   * How the top-20 selector ranks candidates (phase 11).
   *
   * In `app_setting` for §11's reason — "all tunable numbers in the database" —
   * and because this particular set is a *product experiment*: whether previous
   * attendance in the same category predicts turnout better than living in the
   * right city is a question the numbers should be able to answer without a
   * deploy.
   *
   * The scale is arbitrary and the ordering is not. Every term is bounded, the
   * total is bounded, and the score is a plain sum — so "why was this person
   * chosen?" is answered by a breakdown stored beside the invitation rather than
   * by re-running a model. **Nothing here uses an attribute the product does not
   * already collect for another purpose**, and nothing infers one.
   */
  'invite.weight_same_city': 30,
  'invite.weight_interest_match': 20,
  'invite.weight_category_history': 25,
  'invite.weight_recent_activity': 15,
  /** Trust contributes at most this much, scaled by the 0–100 score. */
  'invite.weight_trust': 10,
  /**
   * Subtracted from anybody invited to *anything* recently.
   *
   * The one term that pushes down rather than up, and the reason it exists is
   * that a good score is otherwise self-reinforcing: the same twenty people would
   * be picked for every event until they muted the bot. A penalty is cheaper than
   * a quota and needs no second table.
   */
  'invite.penalty_recent_invite': 20,
  'invite.recent_invite_days': 14,
  /** How recently somebody must have taken part to count as active. */
  'invite.recent_activity_days': 30,

  /**
   * Where a new account starts (plan §11). The 0–100 *range* is deliberately not
   * here: ADR-0007 writes it into the schema as a CHECK, and a configurable clamp
   * over a fixed constraint would be a setting whose only possible effect is a
   * constraint violation.
   */
  'trust.initial_score': 50,
  /** Completing a profile is the first thing that moves the score (plan §11). */
  'trust.profile_complete_delta': 5,

  /**
   * Referral velocity, recorded in `fraud_signals` rather than enforced.
   *
   * T6 asks for velocity limits and for `fraud_signals` for admin review, and the
   * order matters: a false positive here silently steals somebody's reward, so
   * this flags for a human instead of refusing. The real control is that the
   * reward requires an attended event, which does not scale to a farm.
   */
  'referral.velocity_window_hours': 24,
  'referral.velocity_threshold': 10,
  /** The legal minimum age for the platform. Enforced at profile write (plan §4.1). */
  'profile.min_age_years': 18,
  /** Events a host may create in one Tehran day (plan §11, T6.1). */
  'events.max_per_day': 5,
  /** Upcoming, non-retired events a host may hold at once (plan §11). */
  'events.max_concurrent_active': 3,

  /**
   * How long a host has to decide, and how close to the event a decision still
   * means anything: the deadline is `min(now + 24h, starts_at - 3h)` (plan §11).
   * Both matter because a PENDING request holds a seat — these numbers bound how
   * long an undecided request keeps one out of circulation.
   */
  'participation.host_response_hours': 24,
  'participation.min_hours_before_event': 3,
  /** Cancel within this many minutes of being accepted and it costs nothing. */
  'participation.grace_minutes': 15,

  /**
   * The promoted-request deadline: `min(now + 12h, starts_at - 3h)` (ADR-0011).
   *
   * Shorter than the 24 hours a fresh request gets, and deliberately so — a
   * promotion happens because a seat came free, which is later in the event's
   * life and leaves less room to dither. Separate keys from the
   * `participation.*` pair above even though the second number matches today,
   * because ADR-0011 names them separately and they are tuned against different
   * things.
   */
  'waitlist.promotion_deadline_hours': 12,
  'waitlist.min_hours_before_event': 3,

  /**
   * What a cancellation costs, by how late it was (plan §11, M10).
   *
   * Stored as **positive magnitudes**, negated at the point of charge. A signed
   * default is a setting an admin can accidentally make a *reward* by dropping a
   * minus sign, and "how much does a late cancellation cost?" is a question whose
   * answer should never be negative.
   *
   * `GRACE` and `GT_24H` are absent on purpose rather than present as zeros: §11
   * prices only the two late buckets and the no-show. A cancellation more than a
   * day out is free, and a key holding zero would invite somebody to price it
   * without noticing that the whole product promises it is free.
   *
   * **Rollback is a config change, no deploy**: set these to 0 and cancellation
   * stops costing anything, which is exactly what the plan's rollback line asks
   * for.
   */
  'cancellation.coins_h24_to_h3': 15,
  'cancellation.trust_h24_to_h3': 3,
  'cancellation.coins_lt_3h': 40,
  'cancellation.trust_lt_3h': 8,
  'cancellation.coins_no_show': 60,
  'cancellation.trust_no_show': 15,

  /**
   * The host's side (ADR-0011, D9).
   *
   * The multiplier applies to whatever a *participant* would have paid for the
   * same lateness, because one host cancellation harms N people rather than one.
   * It is a fraction, so it is read with `getNumber`; the two trust numbers are
   * the host's own and are not derived from the participant table at all — §11
   * splits them at 24 hours only, where a participant has three buckets.
   */
  'cancellation.host_penalty_multiplier': 1.5,
  'cancellation.host_trust_gt24h': 5,
  'cancellation.host_trust_lt24h': 12,

  /**
   * Attending something is the one routine way a score goes up (plan §11: +2,
   * capped at +2 per day).
   *
   * The cap is what stops a host and a friend running six events a day to farm
   * reputation off each other — the same reasoning that puts the referral reward
   * behind an attended event (T6).
   */
  'trust.attendance_delta': 2,
  'trust.attendance_daily_cap': 2,

  /**
   * The blind-review window (ADR-0011, D7). Measured from the event's **end**.
   *
   * It opens a day later rather than immediately because a review written in the
   * car park is a review of the last five minutes. Seven days to write one, and
   * one hour to change your mind about what you wrote.
   */
  'review.window_opens_hours': 24,
  'review.window_deadline_days': 7,
  'review.edit_window_minutes': 60,
  /**
   * D7a, and the one sub-decision the plan explicitly flags for override.
   *
   * At the deadline with only one side written, that review **is** revealed —
   * the reviewer's effort stays visible — but by default it does not move the
   * score, because somebody who never reviewed cannot have their reputation moved
   * by a counterparty they had no opportunity to answer. Set this true to change
   * that, with no deploy.
   */
  'review.partial_reveal_affects_trust': 0,
  /** Coins for writing one (plan §11). Paid on submission — see `ReviewService`. */
  'economy.review_reward_coins': 10,
  /**
   * What a star is worth to the person receiving it (plan §11).
   *
   * Stored **signed**, unlike the cancellation penalties: these are not "how much
   * does it cost", they are "which way does it move", and a table where three of
   * five entries are negative reads more honestly with the signs in it than with
   * a magnitude and a rule about when to negate.
   */
  'trust.review_rating_5': 3,
  'trust.review_rating_4': 1,
  'trust.review_rating_3': 0,
  'trust.review_rating_2': -2,
  'trust.review_rating_1': -5,

  /**
   * The channel (plan §1, M14).
   *
   * `enabled` is a kill switch rather than a feature flag: a public surface the
   * product cannot stop writing to is a public surface that keeps posting through
   * an incident. `1` is on, `0` is off, and it is read on every pass.
   *
   * The trending threshold is deliberately a *request* count rather than a view
   * count — asking to join is a real signal a person produced, while a view is
   * mostly a measure of how often something was already shown.
   */
  'channel.enabled': 1,
  'channel.trending_request_threshold': 10,

  /**
   * Distinct reporters before a subject is auto-hidden and a case opened
   * (plan §11).
   *
   * Three is low on purpose. Hiding is reversible and a moderator decides what
   * actually happens; what the automation decides is only that enough people
   * objected for a human to look, and that in the meantime the thing should stop
   * being seen. `UNIQUE (target, reporter)` is what makes "three" mean three
   * people rather than three clicks.
   */
  'moderation.report_threshold': 3,
  /** How long a break-glass chat grant lasts (ADR-0010, T14: fifteen minutes). */
  'moderation.unseal_window_minutes': 15,

  /**
   * How long after an event ends before attendance is settled.
   *
   * A window rather than "immediately at the end": the host has to be able to
   * report a no-show, and nobody does that from the pavement outside the café.
   * It matches the review window opening at T+24h (§11), so the two things a host
   * is asked to do about a finished event become available together.
   */
  'participation.settlement_delay_hours': 24,

  // Ranking weights (plan §11). Fractions, not integers — read with `getNumber`.
  // Trust is capped at 0.10 deliberately: §12 resolves "Trust Score in ranking"
  // against "no unfair discrimination" by keeping trust a tenth of the signal, so
  // a new host with a neutral score is never buried.
  'ranking.weight_time_proximity': 0.35,
  'ranking.weight_popularity': 0.2,
  'ranking.weight_recency': 0.15,
  'ranking.weight_boost': 0.15,
  'ranking.weight_trust': 0.1,
  'ranking.weight_interest_match': 0.05,

  /**
   * Gift-code campaign limits (M19, ADR-0016).
   *
   * ADR-0015 kept *every per-campaign* number on the `gift_code` row, and that is
   * unchanged: the coins, the window, the caps and the kill switch are columns,
   * because two simultaneous campaigns cannot share one setting. These two are
   * different in kind — they are **platform** limits on what a campaign may be,
   * which is exactly what §11 says belongs here.
   *
   * `max_batch_size` bounds one bulk mint. A thousand codes is a large campaign
   * and a synchronous request that still returns in well under a second; past it
   * the honest answer is a second batch, not a longer transaction holding a
   * unique index.
   *
   * `max_per_user_limit` is **1**, and it is a setting rather than a constant so
   * that raising it is a decision somebody makes, records and can undo — not a
   * deploy. ADR-0016 explains why 1 is the right default: a code redeemable twice
   * by one person is almost always a mistake, and the two protections that make a
   * campaign bounded (the global cap and the per-user limit) collapse into one
   * when the second is loosened.
   */
  'giftcode.max_batch_size': 1000,
  'giftcode.max_per_user_limit': 1,
  /**
   * The gift-code kill switch — `1` is on, `0` is off.
   *
   * A **platform** switch, which is what makes it belong here rather than on a
   * row: `gift_code.is_active` stops one campaign, and stopping one campaign is
   * not the thing an operator needs when a code has leaked to a channel with
   * forty thousand members and the answer is "no codes at all until we work out
   * what happened". Doing that today meant disabling every campaign one at a
   * time, in an order that leaves the last one live longest.
   *
   * Off refuses redemption on **every** surface — the bot's form, `/gift <code>`
   * and `POST /gift-codes/redeem` — because the check is in the service that owns
   * the act, which is where the channel-membership gate is and for the same
   * reason. Minting and disabling codes in the panel keep working while it is
   * off: an operator has to be able to clean up during the incident they turned
   * it off for.
   */
  'giftcode.enabled': 1,

  /**
   * Whether a deploy tells every user that it happened — `1` is on, `0` is off.
   *
   * The message is one sentence and one instruction («یک بار /start را بزنید»),
   * and it exists because a deploy silently invalidates things the user is
   * holding: reply-keyboard labels that moved, a half-finished wizard whose step
   * keys changed, inline buttons whose `callback_data` this build may no longer
   * parse. Without it, the release reaches people as «این دکمه دیگر کار نمی‌کند».
   *
   * A switch rather than a constant because a broadcast to the entire user base
   * is the single loudest thing this product can do, and an operator shipping
   * three hotfixes in an afternoon must be able to turn it off for the second
   * and third. `ReleaseAnnouncementService` reads it at boot, so flipping it
   * takes effect on the next deploy — which is exactly when it is decided.
   */
  'release.announce_enabled': 1,
} as const satisfies Record<string, number>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * An integer policy number.
   *
   * Falls back to the documented default when the row is absent, and also when
   * the stored value is not an integer. A garbled `app_setting` row is an admin
   * mistake; letting it become `NaN` coins would turn that mistake into a
   * corrupted ledger, which no amount of later correction fully undoes.
   *
   * **Pass `tx` when reading inside a transaction.** Without it this borrows a
   * second connection from the pool while the caller still holds the first, and
   * N concurrent callers doing that exhaust the pool and wait on each other
   * forever. It shows up as "Unable to start a transaction in the given time" —
   * a message that describes the symptom and hides the cause completely.
   */
  async getInt(key: SettingKey, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return this.read(key, (value) => Number.isInteger(value), tx);
  }

  /**
   * A fractional policy number — a ranking weight, a penalty multiplier.
   *
   * Same fallback discipline as `getInt`, minus the integrality requirement.
   * Kept as a separate method rather than relaxing `getInt`, because a coin
   * amount that arrives as 12.5 is a bug and should still be rejected.
   */
  async getNumber(key: SettingKey, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return this.read(key, (value) => Number.isFinite(value), tx);
  }

  /** Reads several keys at once. One round trip instead of one per weight. */
  async getNumbers<K extends SettingKey>(
    keys: readonly K[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Record<K, number>> {
    const rows = await tx.appSetting.findMany({ where: { key: { in: [...keys] } } });
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    return Object.fromEntries(
      keys.map((key) => {
        const value = stored.get(key);
        return [
          key,
          typeof value === 'number' && Number.isFinite(value) ? value : SETTING_DEFAULTS[key],
        ];
      }),
    ) as Record<K, number>;
  }

  private async read(
    key: SettingKey,
    accept: (value: number) => boolean,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const row = await tx.appSetting.findUnique({ where: { key } });
    if (!row) return SETTING_DEFAULTS[key];

    const value = row.value;
    return typeof value === 'number' && accept(value) ? value : SETTING_DEFAULTS[key];
  }
}
