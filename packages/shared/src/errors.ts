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

  // Events
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  EVENT_NOT_JOINABLE: 'EVENT_NOT_JOINABLE',
  EVENT_QUOTA_EXCEEDED: 'EVENT_QUOTA_EXCEEDED',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  CAPACITY_BELOW_ACCEPTED: 'CAPACITY_BELOW_ACCEPTED',
  CONFLICT_STALE_VERSION: 'CONFLICT_STALE_VERSION',

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

  // Reviews (ADR-0011)
  ALREADY_REVIEWED: 'ALREADY_REVIEWED',
  REVIEW_WINDOW_CLOSED: 'REVIEW_WINDOW_CLOSED',
  REVIEW_NOT_EDITABLE: 'REVIEW_NOT_EDITABLE',

  // Moderation
  ALREADY_REPORTED: 'ALREADY_REPORTED',

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
  CITY_NOT_AVAILABLE: 'پایه‌تَم فعلاً فقط در تهران فعال است.',
  INVALID_DISTRICT: 'منطقهٔ انتخاب‌شده با شهر انتخابی هم‌خوانی ندارد.',

  EVENT_NOT_FOUND: 'این فعالیت یافت نشد.',
  EVENT_NOT_JOINABLE: 'امکان ثبت درخواست برای این فعالیت وجود ندارد.',
  EVENT_QUOTA_EXCEEDED: 'به سقف ساخت فعالیت در روز رسیده‌اید.',
  CONTENT_BLOCKED: 'متن واردشده با قوانین انتشار مطابقت ندارد. لطفاً آن را ویرایش کنید.',
  CAPACITY_BELOW_ACCEPTED: 'ظرفیت نمی‌تواند کمتر از تعداد افراد پذیرفته‌شده باشد.',
  CONFLICT_STALE_VERSION: 'این فعالیت در جای دیگری ویرایش شده است. لطفاً صفحه را تازه کنید.',

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

  ALREADY_REVIEWED: 'شما قبلاً بازخورد خود را ثبت کرده‌اید.',
  REVIEW_WINDOW_CLOSED: 'مهلت ثبت بازخورد به پایان رسیده است.',
  REVIEW_NOT_EDITABLE: 'این بازخورد دیگر قابل ویرایش نیست.',

  ALREADY_REPORTED: 'شما قبلاً این مورد را گزارش کرده‌اید.',

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
  ALREADY_REVIEWED: 409,
  ALREADY_REPORTED: 409,
  CAPACITY_EXCEEDED: 409,
  CONFLICT_STALE_VERSION: 409,
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
