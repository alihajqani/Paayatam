# Glossary — Persian ↔ English

Two purposes: keep **user-facing Persian consistent** across the Mini App, bot and channel, and keep
**code strictly English** (identifiers, tables, enums, API fields, logs).

**Rule:** Persian appears only in user-facing strings and in this file. Never in an identifier, a column name,
an enum value, a log line or an API field name.

---

## 1. Domain concepts

| English (code) | Persian (UI) | Notes |
|---|---|---|
| Activity / Event | فعالیت | The core entity. Prefer **فعالیت** over «رویداد» — warmer, matches the product's tone |
| Host | میزبان | The creator of an activity |
| Participant | شرکت‌کننده | Someone who requested to join |
| Guest | مهمان | The participant's role inside a chat |
| Request (to join) | درخواست شرکت | |
| Capacity | ظرفیت | |
| Remaining capacity | ظرفیت باقی‌مانده | |
| Waitlist | لیست انتظار | |
| Waitlist position | جایگاه در لیست انتظار | |
| Promotion (from waitlist) | ارتقا از لیست انتظار | |
| Anonymous chat | گفتگوی ناشناس | The differentiator; name it prominently |
| Alias | نام مستعار | Per-chat, e.g. «میهمان ۱» |
| Coin | سکه | |
| Trust Score | امتیاز اعتماد | Never «نمره» — that reads as a school grade |
| Review | بازخورد | Prefer **بازخورد** over «نظر»: it is mutual and structured, not a public opinion |
| Blind review | بازخورد دوسویهٔ پنهان | Explain on first use |
| Report | گزارش تخلف | «گزارش» alone is ambiguous |
| Moderation | بررسی و تأیید | |
| Blacklist | فهرست واژگان ممنوع | Internal/admin term |
| Boost | ارتقای نمایش | |
| VIP placement | نمایش ویژه | |
| Referral | معرفی دوستان | |
| Interest | علاقه‌مندی | |
| Category | دسته‌بندی | |
| City | شهر | |
| District / Area | منطقه | |
| Cancellation | لغو | |
| No-show | عدم حضور | |
| Grace period | مهلت بدون جریمه | |
| Penalty | جریمه | |
| Terms and conditions | قوانین و شرایط استفاده | |
| Consent | پذیرش قوانین | |

## 2. Status labels

| Enum (code) | Persian (UI) |
|---|---|
| `PENDING_MODERATION` | در انتظار بررسی |
| `PUBLISHED` | منتشر شده |
| `REJECTED` | تأیید نشده |
| `HIDDEN` | پنهان شده |
| `ONGOING` | در حال برگزاری |
| `COMPLETED` | برگزار شده |
| `EXPIRED` | منقضی شده |
| `CANCELLED_BY_HOST` | لغو شده توسط میزبان |
| `PENDING` | در انتظار پاسخ میزبان |
| `WAITLISTED` | در لیست انتظار |
| `ACCEPTED` | پذیرفته شده |
| `CANCELLED_BY_PARTICIPANT` | لغو شده توسط شرکت‌کننده |
| `NO_SHOW` | عدم حضور |
| Chat `ANONYMOUS` | ناشناس |
| Chat `OPEN` | باز |
| Chat `CLOSED` | بسته شده |

## 3. Error messages (`messageFa`)

Every API error returns a stable `code` **and** a Persian `messageFa`. Rules: say what happened, say what to
do next, never expose internals, never blame the user.

| `code` | `messageFa` |
|---|---|
| `INVALID_INIT_DATA` | اطلاعات ورود معتبر نیست. لطفاً برنامه را از داخل تلگرام باز کنید. |
| `INIT_DATA_EXPIRED` | نشست شما منقضی شده است. لطفاً دوباره وارد شوید. |
| `TERMS_NOT_ACCEPTED` | برای استفاده از این بخش، ابتدا قوانین را بپذیرید. |
| `AGE_BELOW_MINIMUM` | استفاده از پایه‌تَم برای افراد زیر ۱۸ سال امکان‌پذیر نیست. |
| `PROFILE_INCOMPLETE` | برای ادامه، ابتدا پروفایل خود را کامل کنید. |
| `CITY_NOT_AVAILABLE` | پایه‌تَم فعلاً فقط در تهران فعال است. |
| `DUPLICATE_REQUEST` | شما قبلاً برای این فعالیت درخواست داده‌اید. |
| `HOST_CANNOT_JOIN` | شما میزبان این فعالیت هستید. |
| `EVENT_FULL_NO_WAITLIST` | ظرفیت این فعالیت تکمیل شده است. |
| `EVENT_NOT_JOINABLE` | امکان ثبت درخواست برای این فعالیت وجود ندارد. |
| `NOT_ELIGIBLE_GENDER` | این فعالیت برای گروه دیگری در نظر گرفته شده است. |
| `NOT_ELIGIBLE_AGE` | سن شما در محدودهٔ تعیین‌شده برای این فعالیت نیست. |
| `CAPACITY_EXCEEDED` | متأسفانه آخرین ظرفیت هم‌زمان توسط فرد دیگری پر شد. |
| `CAPACITY_BELOW_ACCEPTED` | ظرفیت نمی‌تواند کمتر از تعداد افراد پذیرفته‌شده باشد. |
| `INSUFFICIENT_COINS` | سکهٔ کافی ندارید. |
| `CONTENT_BLOCKED` | متن واردشده با قوانین انتشار مطابقت ندارد. لطفاً آن را ویرایش کنید. |
| `ALREADY_REPORTED` | شما قبلاً این مورد را گزارش کرده‌اید. |
| `ALREADY_REVIEWED` | شما قبلاً بازخورد خود را ثبت کرده‌اید. |
| `REVIEW_WINDOW_CLOSED` | مهلت ثبت بازخورد به پایان رسیده است. |
| `CHAT_CLOSED` | این گفتگو بسته شده است. |
| `CHAT_NOT_OPEN` | اشتراک‌گذاری اطلاعات تماس فقط پس از پذیرش امکان‌پذیر است. |
| `CONFLICT_STALE_VERSION` | این فعالیت توسط شما در جای دیگری ویرایش شده است. لطفاً صفحه را تازه کنید. |
| `RATE_LIMITED` | تعداد درخواست‌های شما زیاد است. لطفاً کمی بعد دوباره تلاش کنید. |
| `EVENT_QUOTA_EXCEEDED` | به سقف ساخت فعالیت در روز رسیده‌اید. |
| `BOT_BLOCKED` | ربات پایه‌تَم را در تلگرام از حالت مسدود خارج کنید تا اعلان‌ها را دریافت کنید. |
| `INTERNAL_ERROR` | خطایی رخ داد. لطفاً دوباره تلاش کنید. |

## 4. Bot message templates

| Key | Persian |
|---|---|
| `chat.anonymous_intro` | این گفتگو ناشناس است. نام، شماره تماس و شناسهٔ تلگرام شما نمایش داده نمی‌شود. |
| `chat.media_rejected` | در این نسخه فقط ارسال متن امکان‌پذیر است. |
| `chat.message_deleted` | «پیام حذف شد» |
| `chat.opened` | درخواست شما پذیرفته شد. اکنون می‌توانید اطلاعات تماس را در صورت تمایل به اشتراک بگذارید. |
| `participation.requested_host` | یک درخواست جدید برای فعالیت شما ثبت شد. |
| `participation.accepted` | درخواست شما پذیرفته شد. |
| `participation.rejected` | متأسفانه درخواست شما پذیرفته نشد. |
| `waitlist.promoted_participant` | جای خالی ایجاد شد. درخواست شما اکنون در انتظار پاسخ میزبان است. |
| `waitlist.promoted_host` | یک درخواست از لیست انتظار ارتقا یافت و در انتظار تصمیم شماست. |
| `review.reminder` | بازخورد خود را دربارهٔ این فعالیت ثبت کنید. |
| `review.revealed` | بازخوردها منتشر شد. |

## 5. Typography and formatting

- **Font:** Vazirmatn, self-hosted (never a CDN — the CSP forbids external hosts, and Iranian reachability
  is unreliable).
- **Direction:** `dir="rtl"` at the root; **logical CSS properties only** (`margin-inline-start`, never
  `margin-left`).
- **Digits:** Persian digits (۰۱۲۳۴۵۶۷۸۹) for display, produced by a view-layer formatter. **All internal
  values stay Latin** so sorting and arithmetic are unaffected.
- **Half-space (نیم‌فاصله, ZWNJ U+200C):** required in compound words — «می‌شود» not «می شود». The
  normalization pipeline (ADR-0012) folds variants for search and moderation, but UI copy uses correct ZWNJ.
- **Dates:** Jalali for display, converted in the Vue layer. **The API speaks ISO-8601 UTC exclusively** —
  no Jalali date is ever stored or transmitted (ADR-0008).
- **Currency:** Toman, thousands-separated with Persian digits: «۱۲۰٬۰۰۰ تومان».
- **Tone:** polite plural (شما), warm and direct. Avoid bureaucratic phrasing and avoid exclamation marks.
