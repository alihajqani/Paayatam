import { z } from 'zod';
import { acquisitionSource } from './acquisition';

/**
 * What people do in the bot — one row per Telegram update (migration 0065).
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * `user_acquisition` says which link created an account, and `audit_log` says
 * which states changed. Neither says what somebody *did*: which button, how
 * often, what they were shown, and what refused them. That is what an operator
 * needs to tell a link that is tapped from one that is not, and a form people
 * finish from one they leave.
 *
 * ── What is never in it ─────────────────────────────────────────────────────
 *
 * No message text, and no Telegram identifier. An `action` is the *name* of
 * what was pressed with every id taken out, so the vocabulary below is closed
 * enough to label and open enough that a new button needs no migration.
 */
export const INTERACTION_KINDS = [
  'START',
  'COMMAND',
  'CALLBACK',
  /** A tap on the persistent reply keyboard, which Telegram delivers as text. */
  'KEYBOARD',
  'TEXT',
  'PHOTO',
  'UNSUPPORTED',
  'BLOCKED',
  'UNBLOCKED',
] as const;
export const interactionKind = z.enum(INTERACTION_KINDS);
export type InteractionKind = z.infer<typeof interactionKind>;

export const INTERACTION_KIND_FA: Record<InteractionKind, string> = {
  START: 'شروع یا لینک',
  COMMAND: 'دستور تایپ‌شده',
  CALLBACK: 'دکمهٔ زیر پیام',
  KEYBOARD: 'دکمهٔ منوی پایین',
  TEXT: 'متن',
  PHOTO: 'عکس',
  UNSUPPORTED: 'پیام پشتیبانی‌نشده',
  BLOCKED: 'بلاک کردن ربات',
  UNBLOCKED: 'برداشتن بلاک',
};

/**
 * How the bot answered.
 *
 * `REFUSED` is the product saying no — a full event, not enough coins — and
 * carries the error code. `GATED` is somebody who has not finished signing up
 * being sent back to the step they owe. `STALE` is a button the bot no longer
 * understands. `FAILED` is a bug. `NO_ACCOUNT` is a sender the bot does not
 * know, or one who is banned or deleted.
 */
export const INTERACTION_OUTCOMES = [
  'OK',
  'REFUSED',
  'GATED',
  'STALE',
  'FAILED',
  'NO_ACCOUNT',
] as const;
export const interactionOutcome = z.enum(INTERACTION_OUTCOMES);
export type InteractionOutcome = z.infer<typeof interactionOutcome>;

export const INTERACTION_OUTCOME_FA: Record<InteractionOutcome, string> = {
  OK: 'انجام شد',
  REFUSED: 'رد شد',
  GATED: 'پشت ثبت‌نام ماند',
  STALE: 'دکمهٔ ازکارافتاده',
  FAILED: 'خطای ربات',
  NO_ACCOUNT: 'بدون حساب',
};

/** Which sign-up step sent somebody back, for a `GATED` row's `detail`. */
export const INTERACTION_GATES = ['terms', 'channel', 'profile', 'app_access'] as const;
export type InteractionGate = (typeof INTERACTION_GATES)[number];

export const INTERACTION_GATE_FA: Record<InteractionGate, string> = {
  terms: 'پذیرش قوانین',
  channel: 'عضویت در کانال',
  profile: 'تکمیل پروفایل',
  app_access: 'عضویت در کانال (کل ربات)',
};

/**
 * Where a form stands when it is not on one of its own steps.
 *
 * `wizard_step` holds a step key, or one of these. The `$` cannot appear in a
 * step key (the wizard codec allows `a-z0-9_`), so a form that one day names a
 * step `summary` does not collide with the screen that summarises it.
 *
 * **Submitting is not one of them.** A form that was sent is recorded in
 * `finished_wizard` (migration 0066), because the same update can open the
 * next form and `wizard_step` has room for only one. With an `OK` outcome that
 * is a finished form; with `REFUSED`, one somebody tried to finish and the
 * product declined — the draft survives, and the next row says whether they
 * tried again.
 */
export const INTERACTION_WIZARD_MARKS = {
  SUMMARY: '$summary',
  CANCELLED: '$cancelled',
} as const;

/** A person's consecutive interactions with no gap longer than this are one visit. */
export const INTERACTION_SESSION_GAP_MINUTES = 30;

/** Raw rows are kept this long, so a window cannot reach further back. */
export const INTERACTION_MAX_WINDOW_DAYS = 180;

/**
 * How long somebody has to be gone before the drop-off report says they left.
 *
 * A week, because the product is about weekend plans: somebody who has not
 * opened the bot across one whole week has skipped a full cycle of what it
 * offers. Shorter would count people who are merely between plans.
 */
export const INTERACTION_QUIET_DAYS = 7;

/**
 * The screens two funnel steps are read from.
 *
 * "Opened the list" and "opened an event" are facts about what was **drawn**,
 * not about what was pressed: `/start event_…` from somebody who still owes a
 * sign-up step is a tap on an event link that shows them the terms. The
 * `screen` column is what tells the two apart, so the funnel reads it.
 */
export const INTERACTION_FUNNEL_SCREENS = {
  DISCOVERY: 'bot.discover',
  EVENT: 'bot.event_detail',
} as const;

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * Commands, as the panel calls them.
 *
 * Shared by three actions — typed (`cmd:`), the reply keyboard (`kb:`) and the
 * inline menu (`mn:c:`) — because the same command reached three ways is one
 * destination, and the report is clearer when all three rows read alike.
 */
const COMMAND_FA: Readonly<Record<string, string>> = {
  start: 'شروع',
  menu: 'منوی اصلی',
  help: 'راهنما',
  create_event: 'ساختن برنامه',
  discover: 'دیدن برنامه‌ها',
  balance: 'موجودی سکه',
  wallet: 'کیف پول',
  referral: 'دعوت دوستان',
  gift: 'کد هدیه',
  requests: 'درخواست‌های من',
  myevents: 'برنامه‌های من',
  reviews: 'نظرهای ننوشته',
  myreviews: 'نظرها دربارهٔ من',
  profile: 'پروفایل',
  trust: 'امتیاز اعتماد',
  edit_profile: 'ویرایش پروفایل',
  interests: 'علاقه‌مندی‌ها',
  terms: 'قوانین و حریم خصوصی',
  settings: 'تنظیمات',
  bug: 'گزارش مشکل',
  moderate: 'داوری',
  event: 'باز کردن یک برنامه با کد',
  myevent: 'باز کردن برنامهٔ خودم با کد',
  unknown: 'دستور ناشناخته',
};

const ACTION_FA: Readonly<Record<string, string>> = {
  'start:direct': 'شروع بدون لینک',
  'start:campaign': 'لینک کمپین',
  'start:event': 'لینک «جزئیات برنامه»',
  'start:join': 'لینک «شرکت می‌کنم»',
  'start:host': 'لینک «میزبانش می‌شوم»',
  'start:referral': 'لینک دعوت دوستان',
  'start:other': 'لینک ناشناخته',

  'text:answer': 'جواب تایپ‌شده به یک فرم',
  'text:unclaimed': 'متنی که ربات کاری با آن نکرد',
  photo: 'فرستادن عکس',
  unsupported: 'پیام پشتیبانی‌نشده (استیکر، صدا، فایل)',
  blocked: 'بلاک کردن ربات',
  unblocked: 'برداشتن بلاک',

  'chat:accept': 'میزبان: پذیرفتن درخواست (از اعلان)',
  'chat:reject': 'میزبان: رد درخواست (از اعلان)',

  'ev:show': 'دیدن جزئیات برنامه',
  'ev:join': 'درخواست شرکت',
  'ev:joinyes': 'تأیید درخواست شرکت',
  'ev:cancel': 'انصراف از برنامه',
  'ev:cancelyes': 'تأیید انصراف',
  'ev:disp': 'اعتراض: «من حاضر بودم»',
  'ev:habs': 'اعتراض: «میزبان نیامد»',
  'ev:hresp': 'پاسخ میزبان به اعتراض',
  'ev:hrev': 'دیدن نظرها دربارهٔ میزبان',
  'ev:who': 'میزبان: چه کسانی می‌آیند',
  'ev:noshow': 'میزبان: ثبت غیبت',
  'ev:noshowyes': 'میزبان: تأیید غیبت',
  'ev:post': 'میزبان: ارسال به کانال',
  'ev:postyes': 'میزبان: تأیید ارسال به کانال',
  'ev:invite': 'میزبان: دعوت از افراد',
  'ev:inviteyes': 'میزبان: تأیید دعوت',
  'ev:drop': 'میزبان: لغو برنامه',
  'ev:dropyes': 'میزبان: تأیید لغو برنامه',
  'ev:acc': 'میزبان: پذیرفتن درخواست (از فهرست)',
  'ev:rej': 'میزبان: رد درخواست (از فهرست)',

  'dm:write': 'نوشتن پیام به میزبان',
  'dm:view': 'دیدن پیام مستقیم',
  'dm:reply': 'جواب دادن به پیام مستقیم',
  'dm:guest': 'میزبان: نوشتن به مهمان',
  'dm:block': 'بلاک کردن فرستندهٔ پیام',
  'dm:unblock': 'برداشتن بلاک فرستنده',

  'rv:rate': 'امتیاز دادن',
  'rv:edit': 'ویرایش نظر',
  'rp:ask': 'شروع گزارش تخلف',
  'rp:reason': 'انتخاب دلیل گزارش تخلف',

  'sg:host': '«میزبانش می‌شوم» زیر یک پیشنهاد',
  'cd:gift': 'وارد کردن کد هدیه',
  'cd:ref': 'وارد کردن کد دعوت',
  'by:coins': 'خرید سکه',
  'cg:recheck': 'بررسی دوبارهٔ عضویت کانال',

  'pf:name': 'ویرایش پروفایل: نام',
  'pf:birth': 'ویرایش پروفایل: سال تولد',
  'pf:loc': 'ویرایش پروفایل: شهر',
  'pf:bio': 'ویرایش پروفایل: دربارهٔ من',
  'pf:tags': 'ویرایش پروفایل: علاقه‌مندی‌ها',

  'mn:root': 'منوی دکمه‌ای: صفحهٔ اول',
  'gd:index': 'راهنما: فهرست',
  'gd:commands': 'راهنما: فهرست دستورها',
  'gd:guide': 'راهنما: خواندن یک صفحه',

  'pl:s': 'اسناد حقوقی: فهرست',
  'pl:t': 'اسناد حقوقی: قوانین',
  'pl:p': 'اسناد حقوقی: حریم خصوصی',
  'pl:c': 'اسناد حقوقی: آیین‌نامهٔ رفتار',

  'st:c': 'تنظیمات: اعلان پیام‌ها',
  'st:e': 'تنظیمات: اعلان برنامه‌ها',
  'st:m': 'تنظیمات: اعلان کمپین‌ها',
  'st:p': 'تنظیمات: حریم خصوصی',
  'st:g': 'تنظیمات: زبان',
  'st:n': 'تنظیمات: پروفایل',
  'st:b': 'تنظیمات: فهرست بلاک‌شده‌ها',

  'bk:d': 'بازگشت به فهرست برنامه‌ها',
  'bk:m': 'بازگشت به برنامه‌های من',
  dc: 'فهرست برنامه‌ها: فیلتر یا صفحهٔ بعد',
  mv: 'برنامه‌های من: صفحهٔ بعد',
  wl: 'کیف پول: صفحهٔ بعد',
  ts: 'امتیاز اعتماد: صفحهٔ بعد',
  gn: 'انتخاب جنسیت',

  'ad:list': 'داوری: فهرست پرونده‌ها',
  'ad:open': 'داوری: باز کردن پرونده',
  'ad:claim': 'داوری: برداشتن پرونده',
  'ad:release': 'داوری: رها کردن پرونده',
  'ad:escalate': 'داوری: ارجاع پرونده',

  'wz:back': 'فرم: قدم قبل',
  'wz:skip': 'فرم: رد کردن این قدم',
  'wz:cancel': 'فرم: بستن',
  'wz:confirm': 'فرم: ثبت نهایی',
  'wz:goto': 'فرم: رفتن به یک قدم',
  'wz:page': 'فرم: صفحهٔ بعد گزینه‌ها',
  'wz:agree': 'قوانین: «می‌پذیرم»',
  'wz:recheck': 'قوانین: بررسی دوباره',
  'wz:details': 'فرم: افزودن جزئیات بیشتر',
  'wz:done': 'فرم: «تمام» در انتخاب چندتایی',
};

/**
 * What an action is called in the panel.
 *
 * Never throws and never returns nothing: an action nobody has named yet is
 * shown by its key, which is how a new button looks until somebody labels it.
 */
export function interactionActionLabel(action: string): string {
  const known = ACTION_FA[action];
  if (known !== undefined) return known;

  const [family, ...rest] = action.split(':');
  const tail = rest.join(':');
  const command = COMMAND_FA[rest[rest.length - 1] ?? ''];

  if (family === 'cmd') return `دستور: ${command ?? tail}`;
  if (family === 'kb' && rest[0] === 'group') return `منوی پایین: دستهٔ ${rest[1] ?? ''}`;
  if (family === 'kb') return `منوی پایین: ${command ?? tail}`;
  if (family === 'mn' && rest[0] === 'c') return `منوی دکمه‌ای: ${command ?? rest[1] ?? ''}`;
  if (family === 'mn' && rest[0] === 'g') return `منوی دکمه‌ای: دستهٔ ${rest[1] ?? ''}`;
  if (family === 'wz') return `فرم: جواب قدم ${tail}`;
  return action;
}

const WIZARD_FA: Readonly<Record<string, string>> = {
  ACCEPT_POLICIES: 'پذیرش قوانین',
  COMPLETE_PROFILE: 'تکمیل پروفایل',
  EDIT_PROFILE: 'فرم پروفایل',
  CREATE_EVENT: 'ساختن برنامه',
  EDIT_EVENT: 'ویرایش برنامه',
  WRITE_REVIEW: 'نوشتن نظر',
  FILE_REPORT: 'گزارش تخلف',
  ADMIN_CASE: 'تصمیم داوری',
  REDEEM_CODE: 'وارد کردن کد',
  BUG_REPORT: 'گزارش مشکل',
  DIRECT_MESSAGE: 'پیام مستقیم',
  NO_SHOW_CLAIM: 'اعتراض به غیبت',
};

/** A form, as the panel calls it. Its key when nobody has named it yet. */
export function interactionWizardLabel(kind: string): string {
  return WIZARD_FA[kind] ?? kind;
}

/**
 * Where a form stands: one of the two marks, or the step somebody was left on.
 *
 * A step is shown by its key. The questions themselves live in the wizard
 * definitions, in `@payetam/domain`, which the panel does not depend on — and a
 * key like `title` or `city` says enough to find the question it names.
 */
export function interactionStepLabel(step: string): string {
  if (step === INTERACTION_WIZARD_MARKS.SUMMARY) return 'بازبینی نهایی';
  if (step === INTERACTION_WIZARD_MARKS.CANCELLED) return 'بسته شد';
  return `قدم ${step}`;
}

/**
 * The bot's own screens, by what is on them.
 *
 * Keyed by template, because that is what `bot_interaction.screen` holds. Only
 * the templates a reply to an update can draw are here; a template sent on the
 * product's initiative — an acceptance, a reminder — is not a screen somebody
 * navigated to, and is shown by its key if it ever appears.
 */
const SCREEN_FA: Readonly<Record<string, string>> = {
  'bot.welcome': 'خوش‌آمد',
  'bot.referral_accepted': 'تأیید کد دعوت',
  'bot.notice': 'یک پیام کوتاه از ربات',
  'bot.help': 'راهنما',
  'bot.balance': 'موجودی سکه',
  'bot.requests': 'درخواست‌های من',
  'bot.my_events': 'برنامه‌های من',
  'bot.profile': 'پروفایل',
  'bot.profile_edit': 'ویرایش پروفایل',
  'bot.discover': 'فهرست برنامه‌ها',
  'bot.reviews': 'نظرهای ننوشته',
  'bot.wizard': 'یک فرم',
  'bot.event_created': 'برنامه ساخته شد',
  'bot.consent_accepted': 'قوانین پذیرفته شد',
  'bot.channel_gate': 'درخواست عضویت در کانال',
  'bot.terms_standing': 'اسناد حقوقی',
  'bot.wallet': 'کیف پول',
  'bot.coin_packages': 'بسته‌های سکه',
  'bot.referral': 'دعوت دوستان',
  'bot.confirm_spend': 'تأیید خرج کردن سکه',
  'bot.coins_short': 'سکهٔ کافی ندارد',
  'bot.event_detail': 'صفحهٔ برنامه',
  'bot.suggestion': 'یک پیشنهاد',
  'bot.trust': 'امتیاز اعتماد',
  'bot.report_reasons': 'دلیل‌های گزارش تخلف',
  'bot.received_reviews': 'نظرها دربارهٔ من',
  'bot.settings': 'تنظیمات',
  'bot.participants': 'فهرست شرکت‌کننده‌ها',
  'bot.admin_cases': 'صف داوری',
  'bot.menu': 'منو',
  'bot.event_held': 'پرسش «برنامه برگزار شد؟»',
  'bot.direct_message': 'پیام مستقیم',
};

/** A screen, as the panel calls it. Its template key when nobody has named it. */
export function interactionScreenLabel(templateKey: string): string {
  return SCREEN_FA[templateKey] ?? templateKey;
}

/**
 * Messages the product sends on its own initiative, by what they tell somebody.
 *
 * These are not screens anybody navigated to — they arrive — and the return
 * report asks which of them bring people back.
 */
const NOTIFICATION_FA: Readonly<Record<string, string>> = {
  'participation.requested.host': 'میزبان: درخواست تازه رسید',
  'participation.requested.guest': 'مهمان: درخواستت ثبت شد',
  'participation.accepted': 'مهمان: درخواستت پذیرفته شد',
  'participation.rejected': 'مهمان: درخواستت رد شد',
  'participation.cancelled.host': 'میزبان: یک مهمان انصراف داد',
  'participation.expired': 'مهمان: درخواستت بی‌جواب ماند',
  'waitlist.promoted.guest': 'مهمان: از صف انتظار جا باز شد',
  'waitlist.promoted.host': 'میزبان: یک نفر از صف انتظار آمد',
  'event.cancelled': 'برنامه لغو شد',
  'event.reminder_guest': 'مهمان: یادآور برنامه',
  'event.reminder_host': 'میزبان: یادآور برنامه',
  'event.attendance_prompt': 'میزبان: «همه آمدند؟»',
  'review.window_open': 'وقت نظر دادن است',
  'review.revealed': 'نظرها باز شد',
  'participation.no_show': 'مهمان: غیبت برایت ثبت شد',
  'participation.no_show_dispute_offer': 'مهمان: می‌توانی به غیبت اعتراض کنی',
  'no_show.host_absent_reported': 'میزبان: گزارش «میزبان نیامد»',
  'no_show.claim_decided': 'نتیجهٔ اعتراض به غیبت',
  'moderation.content_hidden': 'محتوایت پنهان شد',
  'moderation.content_restored': 'محتوایت برگشت',
  'direct.message_received': 'پیام مستقیم تازه',
  'direct.message_seen': 'پیامت دیده شد',
  'account.blocked': 'حساب مسدود شد',
  'referral.qualified.referrer': 'پاداش دعوت دوست',
  'referral.qualified.referrer_capped': 'دعوت دوست، بدون پاداش (سقف پر شده)',
  'referral.qualified.referred': 'پاداش ورود با دعوت',
  'host.settled': 'میزبان: تسویهٔ برنامه',
  'economy.comeback_granted': 'سکهٔ بازگشت',
  'profile.gender_request': 'درخواست انتخاب جنسیت',
};

/** A message the product sent, as the panel calls it. Its key when unnamed. */
export function interactionNotificationLabel(templateKey: string): string {
  return NOTIFICATION_FA[templateKey] ?? SCREEN_FA[templateKey] ?? templateKey;
}

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * The window, in days.
 *
 * Capped at the retention period: a longer window would silently report the
 * same numbers and read as "nothing happened before that".
 */
export const interactionWindowQuery = z.object({
  days: z.coerce.number().int().min(1).max(INTERACTION_MAX_WINDOW_DAYS).default(30),
});
export type InteractionWindowQuery = z.infer<typeof interactionWindowQuery>;

const count = z.number().int().nonnegative();

export const interactionOverviewResponse = z.object({
  windowDays: z.number().int().positive(),
  /** ISO; the earliest interaction the window admits. */
  since: z.string(),
  /** ISO; the first interaction ever recorded — the day tracking began. */
  trackingSince: z.string().nullable(),
  totals: z.object({
    interactions: count,
    /** Distinct people with at least one interaction. */
    activeUsers: count,
    /** Visits: runs of one person's interactions with no 30-minute gap. */
    sessions: count,
    /** Mean interactions per visit, to one decimal. */
    stepsPerSession: z.number().nonnegative(),
    /** Accounts a `/start` created inside the window. */
    newAccounts: count,
    /** Of those, the ones that never did anything except `/start`. */
    newAccountsSilent: count,
  }),
  /** One entry per Tehran calendar day that had any interaction, oldest first. */
  byDay: z.array(z.object({ day: z.string(), interactions: count, activeUsers: count })),
  byKind: z.array(z.object({ kind: interactionKind, interactions: count, users: count })),
  byOutcome: z.array(z.object({ outcome: interactionOutcome, interactions: count })),
  /** Tehran hour of day, 0–23; hours with nothing are absent. */
  byHour: z.array(z.object({ hour: z.number().int().min(0).max(23), interactions: count })),
});
export type InteractionOverviewResponse = z.infer<typeof interactionOverviewResponse>;

/**
 * One link, and what happened each time it was followed.
 *
 * `taps` counts every `/start` the link produced, where `user_acquisition`
 * counts only the one that created an account. `returningUsers` are people who
 * followed it with an account they already had — the readers of a channel post
 * who are already members, which acquisition cannot see at all.
 */
export const interactionLinkRow = z.object({
  action: z.string(),
  /** The campaign tag, or the event's or suggestion's public id. */
  ref: z.string().nullable(),
  /** The event's or suggestion's title, when the link names one that exists. */
  title: z.string().nullable(),
  taps: count,
  users: count,
  newAccounts: count,
  returningUsers: count,
});
export type InteractionLinkRow = z.infer<typeof interactionLinkRow>;

export const interactionLinksResponse = z.object({
  windowDays: z.number().int().positive(),
  since: z.string(),
  rows: z.array(interactionLinkRow),
  /** Rows past the cap. */
  omittedRows: count,
});
export type InteractionLinksResponse = z.infer<typeof interactionLinksResponse>;

export const interactionActionRow = z.object({
  kind: interactionKind,
  action: z.string(),
  count,
  users: count,
  refused: count,
  gated: count,
  stale: count,
  failed: count,
  /** The commonest error code among the refusals, or null when there were none. */
  topRefusal: z.string().nullable(),
  /** Mean handling time in milliseconds. */
  averageMs: count,
});
export type InteractionActionRow = z.infer<typeof interactionActionRow>;

export const interactionActionsResponse = z.object({
  windowDays: z.number().int().positive(),
  since: z.string(),
  rows: z.array(interactionActionRow),
  omittedRows: count,
});
export type InteractionActionsResponse = z.infer<typeof interactionActionsResponse>;

/** One person's trail, newest first. `before` is the cursor the last page returned. */
export const userInteractionsQuery = z.object({
  before: z.string().datetime().optional(),
});
export type UserInteractionsQuery = z.infer<typeof userInteractionsQuery>;

export const userInteractionItem = z.object({
  id: z.string(),
  /** ISO. */
  at: z.string(),
  kind: interactionKind,
  action: z.string(),
  ref: z.string().nullable(),
  outcome: interactionOutcome,
  detail: z.string().nullable(),
  /** The template of the last screen drawn in answer. */
  screen: z.string().nullable(),
  wizardKind: z.string().nullable(),
  wizardStep: z.string().nullable(),
  /** The form this update submitted; `outcome` says whether it was accepted. */
  finishedWizard: z.string().nullable(),
  durationMs: count,
});
export type UserInteractionItem = z.infer<typeof userInteractionItem>;

export const userInteractionsResponse = z.object({
  items: z.array(userInteractionItem),
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: z.string().nullable(),
});
export type UserInteractionsResponse = z.infer<typeof userInteractionsResponse>;

// ── Funnels ─────────────────────────────────────────────────────────────────

/**
 * How far the accounts a window created got.
 *
 * Every column after `arrived` counts the same people again, so each is read
 * as a share of `arrived`. It is a funnel in the order somebody normally goes,
 * and **not a strict one**: a person can open an event from a link before they
 * have ever seen the list.
 *
 * Two of the columns are facts about the account (`termsAccepted`,
 * `profileComplete`) and one about the product (`requested`); the other three
 * are read from what the bot recorded. That mix is deliberate: the report
 * should say what is true, and a state is truer than a tap that led to it.
 */
export const interactionOnboardingFunnel = z.object({
  arrived: count,
  /** Did anything at all after `/start`. */
  pressedAnything: count,
  termsAccepted: count,
  profileComplete: count,
  /** Was shown the list of events at least once. */
  openedDiscovery: count,
  /** Was shown an event's own page at least once. */
  openedEvent: count,
  /** Asked to join at least one event, whatever became of the request. */
  requested: count,
});
export type InteractionOnboardingFunnel = z.infer<typeof interactionOnboardingFunnel>;

export const interactionOnboardingRow = interactionOnboardingFunnel.extend({
  /** Null is an account with no attribution row. */
  source: acquisitionSource.nullable(),
});
export type InteractionOnboardingRow = z.infer<typeof interactionOnboardingRow>;

/**
 * One form, by how many people reached each of its steps.
 *
 * Counted in **people, not attempts**: somebody who opens the profile form
 * three times and finishes it once is one person who started and one who
 * finished. `leftHere` is where the people who never finished were last seen —
 * the question that lost them.
 */
export const interactionFormFunnel = z.object({
  kind: z.string(),
  started: count,
  /** Submitted, and the product accepted it. */
  submitted: count,
  cancelled: count,
  /** In the order people typically meet them. */
  steps: z.array(
    z.object({
      /** A step key, or `$summary` for the review screen. */
      step: z.string(),
      users: count,
      /** Never finished, and this was the last step they were shown. */
      leftHere: count,
    }),
  ),
});
export type InteractionFormFunnel = z.infer<typeof interactionFormFunnel>;

export const interactionFunnelsResponse = z.object({
  windowDays: z.number().int().positive(),
  since: z.string(),
  onboarding: z.object({
    totals: interactionOnboardingFunnel,
    rows: z.array(interactionOnboardingRow),
  }),
  /** Most started first. */
  forms: z.array(interactionFormFunnel),
});
export type InteractionFunnelsResponse = z.infer<typeof interactionFunnelsResponse>;

// ── Drop-off ────────────────────────────────────────────────────────────────

const countAndUsers = z.object({ count, users: count });

export const interactionDropoffResponse = z.object({
  windowDays: z.number().int().positive(),
  since: z.string(),
  /** How many days of silence count as having left. */
  quietDays: z.number().int().positive(),
  /** People whose last interaction is inside the window and at least `quietDays` old. */
  quietUsers: count,
  /**
   * Where those people were last seen: the screen they were left on, and the
   * form and step when they were in the middle of one.
   */
  lastSeen: z.array(
    z.object({
      screen: z.string().nullable(),
      wizardKind: z.string().nullable(),
      wizardStep: z.string().nullable(),
      users: count,
    }),
  ),
  /** What the product said no to, by what was being attempted. */
  refusals: z.array(
    z.object({ action: z.string(), detail: z.string().nullable(), count, users: count }),
  ),
  /** People sent back to a sign-up step they owed. */
  gates: z.array(z.object({ gate: z.string(), count, users: count })),
  /** Buttons the bot no longer honours. */
  stale: z.array(z.object({ action: z.string(), count, users: count })),
  /** The bot's own bugs, by what was being attempted. */
  failures: z.array(z.object({ action: z.string(), count })),
  /** Typed text no form was waiting for. */
  unclaimedText: countAndUsers,
  /** Stickers, voice notes, files: things the bot refuses. */
  unsupported: countAndUsers,
  blocks: z.object({
    total: count,
    /** Blocked within five minutes of creating the account. */
    withinFiveMinutes: count,
    withinDay: count,
    /** The last screen each of them had been shown; null when nothing was recorded. */
    lastScreens: z.array(z.object({ screen: z.string().nullable(), blocks: count })),
  }),
});
export type InteractionDropoffResponse = z.infer<typeof interactionDropoffResponse>;

// ── Return ──────────────────────────────────────────────────────────────────

/**
 * Of the accounts a window created, how many were still using the bot later.
 *
 * `returnedDayN` is somebody who did something at least N days after they
 * arrived. `eligibleDayN` is how many arrived long enough ago to be asked the
 * question at all — the denominator. Dividing by `arrived` instead would make
 * every recent sign-up look like somebody who never came back.
 */
export const interactionReturnCohort = z.object({
  arrived: count,
  eligibleDay1: count,
  returnedDay1: count,
  eligibleDay7: count,
  returnedDay7: count,
  eligibleDay30: count,
  returnedDay30: count,
});
export type InteractionReturnCohort = z.infer<typeof interactionReturnCohort>;

export const interactionReturnRow = interactionReturnCohort.extend({
  source: acquisitionSource.nullable(),
});
export type InteractionReturnRow = z.infer<typeof interactionReturnRow>;

export const interactionReturnResponse = z.object({
  windowDays: z.number().int().positive(),
  since: z.string(),
  cohorts: z.object({
    totals: interactionReturnCohort,
    rows: z.array(interactionReturnRow),
  }),
  /**
   * Messages the product sent on its own, and what followed. `tapped` is a
   * button on that very message; `followedWithinDay` is anything at all in the
   * next twenty-four hours, which a message can only take part of the credit for.
   */
  notifications: z.array(
    z.object({
      templateKey: z.string(),
      sent: count,
      recipients: count,
      tapped: count,
      followedWithinDay: count,
    }),
  ),
});
export type InteractionReturnResponse = z.infer<typeof interactionReturnResponse>;
