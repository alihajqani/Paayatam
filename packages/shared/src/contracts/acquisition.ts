import { z } from 'zod';

/**
 * Where an account came from — first touch, recorded once, when `/start`
 * creates it.
 *
 * ── Why these five and no more ──────────────────────────────────────────────
 *
 * They are the five shapes a `/start` payload can have, and nothing else can be
 * known at the moment an account is created. `CAMPAIGN` is the one an operator
 * controls — `?start=src_<tag>` on an ad, a bio, a post in somebody else's
 * channel. `EVENT_LINK` is a channel post's button or an event a host shared;
 * `REFERRAL` is an invite link; `DIRECT` is a bare `/start`. `OTHER` is every
 * payload that is none of them, and it keeps the payload itself, because the
 * likeliest source of one is an operator who built an ad link without the
 * prefix — and a report that filed that ad under «مستقیم» would be a report
 * about the wrong campaign.
 *
 * Accounts created before attribution existed have no row at all. That absence
 * is a sixth answer the report gives («پیش از ردیابی»), and it is deliberately not
 * a value here: nothing may ever *write* it.
 */
export const ACQUISITION_SOURCES = [
  'DIRECT',
  'CAMPAIGN',
  'REFERRAL',
  'EVENT_LINK',
  'OTHER',
] as const;
export const acquisitionSource = z.enum(ACQUISITION_SOURCES);
export type AcquisitionSource = z.infer<typeof acquisitionSource>;

/**
 * What each source is called in the panel.
 *
 * Total over the enum by type (PROJECT_MEMORY §7.7): a sixth source fails the
 * build here instead of appearing on the report as a Latin word.
 */
export const ACQUISITION_SOURCE_FA: Record<AcquisitionSource, string> = {
  DIRECT: 'مستقیم، بدون لینک',
  CAMPAIGN: 'کمپین',
  REFERRAL: 'دعوت دوستان',
  EVENT_LINK: 'لینک رویداد (کانال یا اشتراک‌گذاری)',
  OTHER: 'لینک ناشناخته',
};

/** The row for accounts that have no attribution because they predate it. */
export const UNATTRIBUTED_FA = 'پیش از ردیابی';

/**
 * A campaign link is `https://t.me/<bot>?start=src_<tag>`.
 *
 * Telegram allows 1–64 characters of `A-Za-z0-9_-` in `start`, so the tag has
 * sixty after the prefix. It is **lower-cased on the way in**: an operator who
 * writes `TgAds` on one ad and `tgads` on the next means one campaign, and
 * splitting it would halve both rows of the report.
 */
export const CAMPAIGN_START_PREFIX = 'src_';
export const CAMPAIGN_TAG_MAX_LENGTH = 60;
const CAMPAIGN_TAG_PATTERN = /^[a-z0-9_-]{1,60}$/;

/** The tag as it is stored, or null when it is not one Telegram could carry. */
export function normalizeCampaignTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase();
  return CAMPAIGN_TAG_PATTERN.test(tag) ? tag : null;
}

/**
 * The report's window, in days. Absent means all time.
 *
 * Bounded, because the window is interpolated into a date and a request for a
 * hundred thousand days is a request for a date before the calendar.
 */
export const acquisitionReportQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
});
export type AcquisitionReportQuery = z.infer<typeof acquisitionReportQuery>;

/**
 * One source — or one campaign tag — and how far its people got.
 *
 * Every column after `users` is a count of the same people, so each is read as
 * a share of `users`. They are **not** a strict funnel: somebody can host an
 * event without ever asking to join one.
 */
export const acquisitionFunnel = z.object({
  users: z.number().int().nonnegative(),
  termsAccepted: z.number().int().nonnegative(),
  profileComplete: z.number().int().nonnegative(),
  /** Asked to join at least one event, whatever became of the request. */
  requested: z.number().int().nonnegative(),
  /** Attended at least one event: a participation that reached `COMPLETED`. */
  attended: z.number().int().nonnegative(),
  /** Created at least one event of their own. */
  hosted: z.number().int().nonnegative(),
  /** Blocked the bot. The loudest thing a user who did not want to be here can say. */
  botBlocked: z.number().int().nonnegative(),
});
export type AcquisitionFunnel = z.infer<typeof acquisitionFunnel>;

export const acquisitionRow = acquisitionFunnel.extend({
  /** Null is «پیش از ردیابی». */
  source: acquisitionSource.nullable(),
  /**
   * The campaign tag, or the unrecognised payload. Null for the sources that are
   * reported whole — a row per referral code or per event would be a list of
   * people and events, not a report on where users come from.
   */
  ref: z.string().nullable(),
});
export type AcquisitionRow = z.infer<typeof acquisitionRow>;

export const acquisitionReportResponse = z.object({
  /** Null when the report covers all time. */
  windowDays: z.number().int().positive().nullable(),
  /** ISO; the earliest account creation the window admits. */
  since: z.string().nullable(),
  /** ISO; when the first attribution was recorded — the day tracking began. */
  trackingSince: z.string().nullable(),
  totals: acquisitionFunnel,
  /** Largest first, capped. */
  rows: z.array(acquisitionRow),
  /** Rows past the cap. The totals still count them. */
  omittedRows: z.number().int().nonnegative(),
  /** For the link builder. Never the token. */
  botUsername: z.string(),
});
export type AcquisitionReportResponse = z.infer<typeof acquisitionReportResponse>;
