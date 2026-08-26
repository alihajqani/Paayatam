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
  EVENT_QUOTA_EXCEEDED: 'EVENT_QUOTA_EXCEEDED',
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
  EVENT_NOT_BOOSTABLE: 'EVENT_NOT_BOOSTABLE',
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
  EVENT_QUOTA_EXCEEDED: 'به سقف ساخت فعالیت در روز رسیده‌اید.',
  CONTENT_BLOCKED: 'متن واردشده با قوانین انتشار مطابقت ندارد. لطفاً آن را ویرایش کنید.',
  CAPACITY_BELOW_ACCEPTED: 'ظرفیت نمی‌تواند کمتر از تعداد افراد پذیرفته‌شده باشد.',
  CONFLICT_STALE_VERSION: 'این فعالیت در جای دیگری ویرایش شده است. لطفاً صفحه را تازه کنید.',
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
  ALREADY_REFERRED: 'شما قبلاً با کد دعوت دیگری ثبت شده‌اید.',
  EVENT_NOT_BOOSTABLE: 'این فعالیت قابل نردبان کردن نیست.',
  GIFT_CODE_INVALID: 'این کد هدیه معتبر نیست.',
  GIFT_CODE_EXPIRED: 'مهلت استفاده از این کد هدیه به پایان رسیده است.',
  GIFT_CODE_ALREADY_REDEEMED: 'شما پیش‌تر از این کد هدیه استفاده کرده‌اید.',
  GIFT_CODE_EXHAUSTED: 'ظرفیت استفاده از این کد هدیه تکمیل شده است.',
  GIFT_CODE_DUPLICATE: 'کدی با این عنوان از قبل وجود دارد.',

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

  CATALOG_SLUG_TAKEN: 'این شناسه پیش‌تر برای تفریح دیگری ثبت شده است.',
  CATALOG_TAG_IN_USE:
    'این تفریح در فعالیت‌های ثبت‌شده استفاده شده است؛ به‌جای حذف، آن را غیرفعال کنید.',

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
  FORBIDDEN: 403,
  HOST_CANNOT_JOIN: 403,
  TRUST_TOO_LOW: 403,
  NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  DUPLICATE_REQUEST: 409,
  ALREADY_REFERRED: 409,
  GIFT_CODE_ALREADY_REDEEMED: 409,
  GIFT_CODE_EXHAUSTED: 409,
  GIFT_CODE_DUPLICATE: 409,
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
  EVENT_ALREADY_STARTED: 409,
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
