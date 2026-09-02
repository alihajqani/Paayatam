/**
 * The error catalogue.
 *
 * Every API error carries a stable machine-readable `code` and a user-facing
 * Persian `messageFa`. The pairing lives here, in one place, because a code with
 * no Persian message means an end user eventually sees an English string or a
 * blank dialog — and that failure only shows up in production, in front of a user.
 * `errors.test.ts` asserts the mapping is total, so adding a code without a message
 * fails the build.
 *
 * Message guidance (docs/glossary-fa.md): say what happened, say what to do next,
 * never expose internals, never blame the user.
 */

export const ErrorCode = {
  // Authentication and session (ADR-0004)
  INVALID_INIT_DATA: 'INVALID_INIT_DATA',
  INIT_DATA_EXPIRED: 'INIT_DATA_EXPIRED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  USER_BANNED: 'USER_BANNED',

  // Onboarding
  TERMS_NOT_ACCEPTED: 'TERMS_NOT_ACCEPTED',
  POLICY_VERSION_STALE: 'POLICY_VERSION_STALE',
  AGE_BELOW_MINIMUM: 'AGE_BELOW_MINIMUM',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  INVALID_INTEREST: 'INVALID_INTEREST',
  CITY_NOT_AVAILABLE: 'CITY_NOT_AVAILABLE',
  INVALID_DISTRICT: 'INVALID_DISTRICT',
  /** A `customCategoryLabel` was sent for a category that does not allow one (M21). */
  CUSTOM_LABEL_NOT_ALLOWED: 'CUSTOM_LABEL_NOT_ALLOWED',
  /** A category that allows a custom label was chosen without one (M21). */
  CUSTOM_LABEL_REQUIRED: 'CUSTOM_LABEL_REQUIRED',

  // Events
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  EVENT_NOT_JOINABLE: 'EVENT_NOT_JOINABLE',
  /**
   * Too many events created **today** (`events.max_per_day`).
   *
   * Split from the concurrency quota below in v0.6.5. The two shared one code and
   * therefore one Persian sentence — the daily one — so a host stopped by the
   * concurrency limit read that they had hit a daily cap, and the operator who
   * then raised the daily cap in the panel saw nothing change. A message that
   * names the wrong limit makes the right limit look broken.
   */
  EVENT_QUOTA_EXCEEDED: 'EVENT_QUOTA_EXCEEDED',
  /** Too many events still ahead of this host at once (`events.max_concurrent_active`). */
  EVENT_ACTIVE_QUOTA_EXCEEDED: 'EVENT_ACTIVE_QUOTA_EXCEEDED',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  CAPACITY_BELOW_ACCEPTED: 'CAPACITY_BELOW_ACCEPTED',
  CONFLICT_STALE_VERSION: 'CONFLICT_STALE_VERSION',
  EVENT_ALREADY_STARTED: 'EVENT_ALREADY_STARTED',

  // Participation (ADR-0006)
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  HOST_CANNOT_JOIN: 'HOST_CANNOT_JOIN',
  EVENT_FULL_NO_WAITLIST: 'EVENT_FULL_NO_WAITLIST',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  NOT_ELIGIBLE_GENDER: 'NOT_ELIGIBLE_GENDER',
  NOT_ELIGIBLE_AGE: 'NOT_ELIGIBLE_AGE',
  TRUST_TOO_LOW: 'TRUST_TOO_LOW',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // Chat (ADR-0009)
  CHAT_CLOSED: 'CHAT_CLOSED',
  CHAT_NOT_OPEN: 'CHAT_NOT_OPEN',
  CHAT_MEDIA_UNSUPPORTED: 'CHAT_MEDIA_UNSUPPORTED',
  CHAT_MESSAGE_EMPTY: 'CHAT_MESSAGE_EMPTY',

  // Economy (ADR-0007)
  INSUFFICIENT_COINS: 'INSUFFICIENT_COINS',
  INVALID_REFERRAL_CODE: 'INVALID_REFERRAL_CODE',
  SELF_REFERRAL: 'SELF_REFERRAL',
  ALREADY_REFERRED: 'ALREADY_REFERRED',
  REFERRAL_WINDOW_CLOSED: 'REFERRAL_WINDOW_CLOSED',
  EVENT_NOT_BOOSTABLE: 'EVENT_NOT_BOOSTABLE',
  /**
   * The event cannot receive paid invitations right now (M22 phase 11).
   *
   * Its own code rather than a reuse of `EVENT_NOT_BOOSTABLE`, because the two
   * lead to different sentences: one is about promotion and one is about people,
   * and a host reading «قابل نردبان کردن نیست» after pressing «دعوت» would be
   * reading about a different feature.
   */
  EVENT_NOT_INVITABLE: 'EVENT_NOT_INVITABLE',
  /** This event has already been bought a place in the channel (M22 phase 5). */
  EVENT_ALREADY_IN_CHANNEL: 'EVENT_ALREADY_IN_CHANNEL',
  /**
   * Gift codes (M18). Four codes rather than one, because the four are things a
   * user can act on differently: retype it, ask for a new one, stop trying, or
   * find out they already have the coins. A single «کد معتبر نیست» would be an
   * oracle for none of them and an explanation for none of them either.
   *
   * `GIFT_CODE_INVALID` deliberately covers both "no such code" and "disabled",
   * for the reason `INVALID_REFERRAL_CODE` covers both "unknown" and "banned
   * referrer": distinguishing them turns the endpoint into a way to enumerate
   * which codes exist.
   */
  GIFT_CODE_INVALID: 'GIFT_CODE_INVALID',
  GIFT_CODE_EXPIRED: 'GIFT_CODE_EXPIRED',
  GIFT_CODE_ALREADY_REDEEMED: 'GIFT_CODE_ALREADY_REDEEMED',
  GIFT_CODE_EXHAUSTED: 'GIFT_CODE_EXHAUSTED',
  GIFT_CODE_DUPLICATE: 'GIFT_CODE_DUPLICATE',
  /**
   * The whole feature is switched off — `giftcode.enabled` is 0.
   *
   * Separate from `GIFT_CODE_INVALID`, and it does not weaken the oracle argument
   * above: this answer is the same for every string anybody types, so it
   * distinguishes no code from any other. What it distinguishes is "the product
   * is not taking codes right now" from "that code is wrong", which is the
   * difference between a user retyping and a user stopping.
   */
  GIFT_CODE_DISABLED: 'GIFT_CODE_DISABLED',

  // Reviews (ADR-0011)
  ALREADY_REVIEWED: 'ALREADY_REVIEWED',
  REVIEW_WINDOW_CLOSED: 'REVIEW_WINDOW_CLOSED',
  REVIEW_NOT_EDITABLE: 'REVIEW_NOT_EDITABLE',

  // Moderation
  ALREADY_REPORTED: 'ALREADY_REPORTED',
  CANNOT_REPORT_OWN_CONTENT: 'CANNOT_REPORT_OWN_CONTENT',

  // Admin (ADR-0010)
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  UNSEAL_REQUIRES_OPEN_CASE: 'UNSEAL_REQUIRES_OPEN_CASE',
  UNSEAL_REASON_REQUIRED: 'UNSEAL_REASON_REQUIRED',
  UNSEAL_GRANT_EXPIRED: 'UNSEAL_GRANT_EXPIRED',
  FOUR_EYES_REQUIRED: 'FOUR_EYES_REQUIRED',

  // Legal documents (M22 phase 8)
  /**
   * One open draft per document type, at a time.
   *
   * Two drafts of the terms is a question about which one is "the" next version,
   * and the answer would be whichever got published first — which is not a
   * decision anybody made.
   */
  POLICY_DRAFT_EXISTS: 'POLICY_DRAFT_EXISTS',
  /** A published or archived version cannot be edited. That is what makes consent mean something. */
  POLICY_NOT_EDITABLE: 'POLICY_NOT_EDITABLE',
  /** The version typed back to confirm publication did not match the draft. */
  POLICY_CONFIRMATION_MISMATCH: 'POLICY_CONFIRMATION_MISMATCH',
  /** Archiving the current version would leave the type with none, and lock out onboarding. */
  POLICY_IS_CURRENT: 'POLICY_IS_CURRENT',

  // Outbound messaging (M22 phase 4)
  /**
   * The body is empty, too long, or carries markup Telegram will not accept.
   *
   * Refused rather than sanitised: an operator who pasted markup from a document
   * should find out before four thousand people receive something mangled, and a
   * sanitiser that drops half a tag produces a message nobody wrote. `details`
   * carries every problem so the panel can name them all at once.
   */
  MESSAGE_FORMAT_INVALID: 'MESSAGE_FORMAT_INVALID',
  /** A rehearsal cannot be promoted into a send. Compose it again for real. */
  MESSAGE_DRY_RUN: 'MESSAGE_DRY_RUN',

  // The event channel (M22 phase 6)
  /**
   * The user has to join the channel before this operation is available.
   *
   * `details.joinUrl` carries where to send them, so the client renders a working
   * button rather than a sentence about a channel it cannot name.
   */
  CHANNEL_MEMBERSHIP_REQUIRED: 'CHANNEL_MEMBERSHIP_REQUIRED',
  /**
   * A membership requirement with nothing behind it, refused from either end:
   * turning it on with no reachable channel, or removing the last one while it
   * is on. `details.reason` distinguishes them.
   */
  CHANNEL_NOT_CONFIGURED: 'CHANNEL_NOT_CONFIGURED',

  // Catalog administration (M21)
  /** Two categories cannot share a slug — it is the identifier code refers to. */
  CATALOG_SLUG_TAKEN: 'CATALOG_SLUG_TAKEN',
  /**
   * Refusing to delete a tag events already reference.
   *
   * Deactivation is the answer, and it is what the panel offers instead:
   * deleting would either orphan published events or cascade them away, and
   * `is_active` exists exactly so neither has to happen (migration 0003).
   */
  CATALOG_TAG_IN_USE: 'CATALOG_TAG_IN_USE',
  /**
   * Deactivating a city that profiles or events point at, without confirming.
   *
   * Not a refusal — a **second step**. The details carry the counts so the panel
   * can say «۲۳۴ پروفایل و ۱۲ فعالیت» rather than «مطمئنید؟», and the same request
   * with `confirmReferences` goes through. Turning a city off is a real operation
   * with real consequences for people already in it, and finding that out from the
   * support queue is the failure this exists to prevent (M22 phase 9).
   */
  CITY_HAS_REFERENCES: 'CITY_HAS_REFERENCES',

  // Platform
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  BOT_BLOCKED: 'BOT_BLOCKED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Persian messages shown directly to users. Keep in sync with docs/glossary-fa.md.
 * The test asserts this record is total over ErrorCode.
 */
export const ERROR_MESSAGES_FA: Record<ErrorCode, string> = {
  INVALID_INIT_DATA: 'اطلاعات ورود معتبر نیست. لطفاً برنامه را از داخل تلگرام باز کنید.',
  INIT_DATA_EXPIRED: 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.',
  UNAUTHENTICATED: 'برای ادامه، لطفاً دوباره وارد شوید.',
  USER_BANNED: 'دسترسی این حساب کاربری محدود شده است.',

  TERMS_NOT_ACCEPTED: 'برای استفاده از این بخش، ابتدا قوانین را بپذیرید.',
  POLICY_VERSION_STALE: 'قوانین به‌روزرسانی شده است. لطفاً نسخهٔ جدید را مطالعه و تأیید کنید.',
  AGE_BELOW_MINIMUM: 'استفاده از پایه‌تَم برای افراد زیر ۱۸ سال امکان‌پذیر نیست.',
  PROFILE_INCOMPLETE: 'برای ادامه، ابتدا پروفایل خود را کامل کنید.',
  INVALID_INTEREST: 'یکی از علاقه‌مندی‌های انتخاب‌شده معتبر نیست.',
  // Reworded in M21: the product serves 1,252 cities, and a message naming
  // Tehran would now be wrong in 1,251 of them.
  CITY_NOT_AVAILABLE: 'پایه‌تَم هنوز در شهر انتخاب‌شده فعال نیست.',
  INVALID_DISTRICT: 'منطقهٔ انتخاب‌شده با شهر انتخابی هم‌خوانی ندارد.',
  CUSTOM_LABEL_NOT_ALLOWED: 'برای این دستهٔ تفریح نمی‌توان عنوان دلخواه ثبت کرد.',
  CUSTOM_LABEL_REQUIRED: 'برای دستهٔ «سایر» باید نوع تفریح را بنویسید.',

  EVENT_NOT_FOUND: 'این فعالیت یافت نشد.',
  EVENT_NOT_JOINABLE: 'امکان ثبت درخواست برای این فعالیت وجود ندارد.',
  EVENT_QUOTA_EXCEEDED: 'به سقف ساخت فعالیت در روز رسیده‌اید. فردا دوباره تلاش کنید.',
  EVENT_ACTIVE_QUOTA_EXCEEDED:
    'به سقف فعالیت‌های همزمان رسیده‌اید. یکی از فعالیت‌های در پیش رو را به پایان برسانید یا لغو کنید و دوباره تلاش کنید.',
  CONTENT_BLOCKED: 'متن واردشده با قوانین انتشار مطابقت ندارد. لطفاً آن را ویرایش کنید.',
  CAPACITY_BELOW_ACCEPTED: 'ظرفیت نمی‌تواند کمتر از تعداد افراد پذیرفته‌شده باشد.',
  CONFLICT_STALE_VERSION: 'این مورد در جای دیگری ویرایش شده است. لطفاً صفحه را تازه کنید.',
  EVENT_ALREADY_STARTED: 'این فعالیت شروع شده است و دیگر نمی‌توان آن را لغو کرد.',

  DUPLICATE_REQUEST: 'شما قبلاً برای این فعالیت درخواست داده‌اید.',
  HOST_CANNOT_JOIN: 'شما میزبان این فعالیت هستید.',
  EVENT_FULL_NO_WAITLIST: 'ظرفیت این فعالیت تکمیل شده است.',
  CAPACITY_EXCEEDED: 'متأسفانه آخرین ظرفیت هم‌زمان توسط فرد دیگری پر شد.',
  NOT_ELIGIBLE_GENDER: 'این فعالیت برای گروه دیگری در نظر گرفته شده است.',
  NOT_ELIGIBLE_AGE: 'سن شما در محدودهٔ تعیین‌شده برای این فعالیت نیست.',
  TRUST_TOO_LOW: 'امتیاز اعتماد شما برای شرکت در این فعالیت کافی نیست.',
  INVALID_STATE_TRANSITION: 'این عملیات در وضعیت فعلی امکان‌پذیر نیست.',

  CHAT_CLOSED: 'این گفتگو بسته شده است.',
  CHAT_NOT_OPEN: 'اشتراک‌گذاری اطلاعات تماس فقط پس از پذیرش امکان‌پذیر است.',
  CHAT_MEDIA_UNSUPPORTED: 'در این نسخه فقط ارسال متن امکان‌پذیر است.',
  CHAT_MESSAGE_EMPTY:
    'پیام شما فقط شامل اطلاعات تماس بود و ارسال نشد. تا پیش از پذیرش درخواست، امکان ' +
    'رد و بدل کردن اطلاعات تماس وجود ندارد.',

  INSUFFICIENT_COINS: 'سکهٔ کافی ندارید.',
  INVALID_REFERRAL_CODE: 'این کد دعوت معتبر نیست.',
  SELF_REFERRAL: 'نمی‌توانید کد دعوت خودتان را استفاده کنید.',
  ALREADY_REFERRED:
    'شما پیش‌تر کد معرف ثبت کرده‌اید. هر حساب فقط یک بار و فقط یک کد می‌پذیرد.',
  REFERRAL_WINDOW_CLOSED:
    'کد دعوت فقط در روزهای نخست پس از ساختن حساب پذیرفته می‌شود و این مهلت برای حساب شما گذشته است.',
  EVENT_NOT_BOOSTABLE: 'این فعالیت قابل نردبان کردن نیست.',
  EVENT_NOT_INVITABLE:
    'برای این فعالیت نمی‌توان دعوت‌نامه فرستاد. فعالیت باید منتشر شده و هنوز شروع نشده باشد.',
  EVENT_ALREADY_IN_CHANNEL: 'این فعالیت پیش‌تر برای انتشار در کانال ثبت شده است.',
  GIFT_CODE_INVALID: 'این کد هدیه معتبر نیست.',
  GIFT_CODE_EXPIRED: 'مهلت استفاده از این کد هدیه به پایان رسیده است.',
  GIFT_CODE_ALREADY_REDEEMED: 'شما پیش‌تر از این کد هدیه استفاده کرده‌اید.',
  GIFT_CODE_EXHAUSTED: 'ظرفیت استفاده از این کد هدیه تکمیل شده است.',
  GIFT_CODE_DUPLICATE: 'کدی با این عنوان از قبل وجود دارد.',
  GIFT_CODE_DISABLED: 'استفاده از کدهای هدیه در حال حاضر غیرفعال است.',

  ALREADY_REVIEWED: 'شما قبلاً بازخورد خود را ثبت کرده‌اید.',
  REVIEW_WINDOW_CLOSED: 'مهلت ثبت بازخورد به پایان رسیده است.',
  REVIEW_NOT_EDITABLE: 'این بازخورد دیگر قابل ویرایش نیست.',

  ALREADY_REPORTED: 'شما قبلاً این مورد را گزارش کرده‌اید.',
  CANNOT_REPORT_OWN_CONTENT: 'نمی‌توانید محتوای خودتان را گزارش کنید.',

  INVALID_CREDENTIALS: 'ایمیل، رمز عبور یا کد تأیید نادرست است.',
  ACCOUNT_LOCKED: 'این حساب موقتاً قفل شده است. کمی بعد دوباره تلاش کنید.',
  UNSEAL_REQUIRES_OPEN_CASE:
    'برای دسترسی به گفتگو، ابتدا باید پروندهٔ بازی برای آن وجود داشته باشد.',
  UNSEAL_REASON_REQUIRED: 'برای دسترسی به گفتگو، ثبت دلیل الزامی است.',
  UNSEAL_GRANT_EXPIRED: 'مهلت دسترسی به این گفتگو به پایان رسیده است.',
  FOUR_EYES_REQUIRED: 'این تغییر به تأیید یک مدیر دیگر نیاز دارد.',

  POLICY_DRAFT_EXISTS: 'برای این سند از قبل یک پیش‌نویس باز وجود دارد. همان را ویرایش کنید.',
  POLICY_NOT_EDITABLE: 'نسخهٔ منتشرشده قابل ویرایش نیست. نسخهٔ تازه‌ای بسازید.',
  POLICY_CONFIRMATION_MISMATCH: 'شمارهٔ نسخه‌ای که وارد کردید با پیش‌نویس هم‌خوانی ندارد.',
  POLICY_IS_CURRENT: 'نسخهٔ جاری را نمی‌توان بایگانی کرد. ابتدا نسخهٔ تازه‌ای منتشر کنید.',

  // Plural since v0.3.1: the requirement is a list, and «کانال پایه‌تَم» would be
  // an instruction somebody cannot follow when they have joined one of three.
  // Which ones are outstanding is in `details.channels`; this is the fallback the
  // client renders when it has nothing better.
  CHANNEL_MEMBERSHIP_REQUIRED:
    'برای انجام این کار، ابتدا در کانال‌های پایه‌تَم عضو شوید و سپس دوباره تلاش کنید.',
  // Two situations, one sentence, because both are the same mistake seen from
  // different ends: a requirement with nothing behind it. `details.reason` says
  // which — `NO_JOIN_LINK` or `LAST_ACTIVE_CHANNEL` — and the panel renders it.
  CHANNEL_NOT_CONFIGURED:
    'برای اجباری کردن عضویت، دست‌کم یک کانال فعال با پیوند عضویت لازم است. ' +
    'تا وقتی چنین کانالی وجود ندارد، این تنظیم ممکن نیست.',

  MESSAGE_FORMAT_INVALID: 'متن پیام برای تلگرام معتبر نیست. طول و قالب‌بندی را بررسی کنید.',
  MESSAGE_DRY_RUN:
    'این یک پیش‌نمایش است و قابل ارسال نیست. پیام را دوباره برای ارسال واقعی بسازید.',

  CATALOG_SLUG_TAKEN: 'این شناسه پیش‌تر برای تفریح دیگری ثبت شده است.',
  CATALOG_TAG_IN_USE:
    'این تفریح در فعالیت‌های ثبت‌شده استفاده شده است؛ به‌جای حذف، آن را غیرفعال کنید.',
  CITY_HAS_REFERENCES:
    'این شهر در پروفایل‌ها یا فعالیت‌های ثبت‌شده استفاده شده است. برای غیرفعال کردن، تأیید کنید.',

  FORBIDDEN: 'شما به این بخش دسترسی ندارید.',
  NOT_FOUND: 'مورد درخواستی یافت نشد.',
  VALIDATION_FAILED: 'اطلاعات واردشده کامل یا معتبر نیست.',
  RATE_LIMITED: 'تعداد درخواست‌های شما زیاد است. لطفاً کمی بعد دوباره تلاش کنید.',
  BOT_BLOCKED: 'ربات پایه‌تَم را در تلگرام از حالت مسدود خارج کنید تا اعلان‌ها را دریافت کنید.',
  INTERNAL_ERROR: 'خطایی رخ داد. لطفاً دوباره تلاش کنید.',
};

/** HTTP status per code. Anything unlisted is a 400. */
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INIT_DATA: 401,
  INIT_DATA_EXPIRED: 401,
  UNAUTHENTICATED: 401,
  USER_BANNED: 403,
  TERMS_NOT_ACCEPTED: 403,
  /**
   * 403, alongside `TERMS_NOT_ACCEPTED` rather than defaulting to 400 (M22).
   *
   * From M22 this code has two callers, and both are refusals of the same kind:
   * `ConsentService.acceptPolicies` rejecting a submission against superseded
   * versions, and the `@RequiresCurrentPolicies()` gate refusing a write until the
   * new version is accepted. "You may not do this yet" is 403; a 400 would say the
   * request was malformed, which it is not. Clients branch on `code`, never on the
   * status, so nothing that worked before reads differently.
   */
  POLICY_VERSION_STALE: 403,
  FORBIDDEN: 403,
  HOST_CANNOT_JOIN: 403,
  TRUST_TOO_LOW: 403,
  NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  DUPLICATE_REQUEST: 409,
  ALREADY_REFERRED: 409,
  REFERRAL_WINDOW_CLOSED: 409,
  GIFT_CODE_ALREADY_REDEEMED: 409,
  GIFT_CODE_EXHAUSTED: 409,
  GIFT_CODE_DUPLICATE: 409,
  GIFT_CODE_DISABLED: 403,
  ALREADY_REVIEWED: 409,
  ALREADY_REPORTED: 409,
  CANNOT_REPORT_OWN_CONTENT: 403,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  UNSEAL_REQUIRES_OPEN_CASE: 403,
  UNSEAL_REASON_REQUIRED: 400,
  UNSEAL_GRANT_EXPIRED: 403,
  FOUR_EYES_REQUIRED: 403,
  CAPACITY_EXCEEDED: 409,
  CONFLICT_STALE_VERSION: 409,
  CATALOG_SLUG_TAKEN: 409,
  CATALOG_TAG_IN_USE: 409,
  CITY_HAS_REFERENCES: 409,
  MESSAGE_FORMAT_INVALID: 422,
  CHANNEL_MEMBERSHIP_REQUIRED: 403,
  CHANNEL_NOT_CONFIGURED: 409,
  MESSAGE_DRY_RUN: 409,
  POLICY_DRAFT_EXISTS: 409,
  POLICY_NOT_EDITABLE: 409,
  POLICY_IS_CURRENT: 409,
  EVENT_ALREADY_STARTED: 409,
  EVENT_ALREADY_IN_CHANNEL: 409,
  INVALID_STATE_TRANSITION: 409,
  REVIEW_NOT_EDITABLE: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    messageFa: string;
    details?: unknown;
  };
}

/**
 * The single error type thrown by domain services.
 *
 * Domain code throws these; the HTTP layer and the bot layer each render them
 * their own way. That is what lets one service back both the Mini App and the
 * bot without either one inventing its own error vocabulary (ADR-0001).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, details?: unknown) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code] ?? 400;
    if (details !== undefined) {
      this.details = details;
    }
  }

  get messageFa(): string {
    return ERROR_MESSAGES_FA[this.code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        messageFa: this.messageFa,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
