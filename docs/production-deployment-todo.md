# راهنمای گام‌به‌گام استقرار پایه‌تَم روی سرور واقعی

**این فایل یک TODO است، نه مستند رسمی پروژه.** عمداً commit نشده و در `git status` به‌صورت untracked
می‌ماند. اگر خواستید بخشی از مخزن شود، خودتان آن را اضافه کنید.

**مخاطب:** کسی که تجربهٔ استقرار زیادی ندارد و می‌خواهد پایه‌تَم را برای یک **آزمایش واقعی و کنترل‌شده**
بالا بیاورد — نه یک استقرار سازمانی بزرگ.

**هر دستور در این فایل از خود مخزن استخراج شده است.** هر جا مقداری را نمی‌دانستم یا باید خودتان تصمیم
بگیرید، با یکی از این برچسب‌ها مشخص شده:

| برچسب | یعنی |
|---|---|
| `NEEDS DECISION` | باید تصمیم بگیرید؛ پیش‌فرض امن پیشنهاد شده |
| `NEEDS SECRET` | باید مقدار محرمانه بسازید یا بگیرید — **هرگز در git نگذارید** |
| `NEEDS VERIFICATION` | باید روی سرور خودتان بررسی شود؛ از روی کد قابل اثبات نبود |

**هیچ رمز، توکن، کلید یا مقدار واقعی در این فایل نیست و نباید اضافه شود.**

---

## ۱. وضعیت فعلی پروژه

### چه چیزی ساخته شده

آخرین مایل‌استون **M19** است و هر دو بلاکر انتشار بسته شده‌اند:

- **API** (`apps/api`) — NestJS روی Fastify. سه سطح مسیر: `/api/v1` برای مینی‌اپ (Bearer JWT)،
  `/admin/v1` برای پنل مدیریت (کوکی + CSRF)، و `/telegram/webhook/:secretPath` برای تلگرام.
  به‌علاوهٔ `/health`، `/ready`، `/metrics`.
- **Worker** (`apps/worker`) — NestJS standalone با BullMQ. **تنها چیزی در محصول که با تلگرام حرف
  می‌زند.** رله‌ٔ outbox، هشت جاروب زمان‌بندی‌شده، انتشار در کانال.
- **Mini App** (`apps/miniapp`) — Vue 3، ۱۳ صفحه، RTL فارسی، تم از خود تلگرام.
- **Admin Panel** (`apps/admin`) — Vue 3، ۱۲ صفحه، RTL فارسی، پالت مستقل. **در M19 ساخته شد.**
- **PostgreSQL 16** + **Redis 7**.

قابلیت‌هایی که کامل و تست‌شده‌اند: احراز هویت تلگرام، پروفایل و onboarding، ساخت و بررسی خودکار
فعالیت، جست‌وجو و فیلتر، درخواست شرکت با قفل ظرفیت، لیست انتظار، گفت‌وگوی ناشناس رمزنگاری‌شده،
سکه و دفتر تغییرناپذیر، امتیاز اعتماد، بازخورد دوسویهٔ پنهان، گزارش تخلف و صف بررسی، کدهای هدیه با
کمپین و تحلیل، معرفی دوستان با حالت «رد شده»، گزارش رخدادها، سقف تعداد درخواست، و متریک.

### چه چیزی آماده تولید است

| بخش | وضعیت |
|---|---|
| کد برنامه (API، Worker، هر دو SPA) | ✅ آماده — همهٔ تست‌ها سبز |
| مهاجرت‌های پایگاه داده | ✅ ۱۸ مهاجرت دست‌نویس، همه اعمال‌شدنی با `db:migrate:deploy` |
| اسکریپت پشتیبان‌گیری | ✅ `tools/backup.sh` — تست‌شده |
| اسکریپت تمرین بازیابی | ✅ `tools/restore-rehearsal.sh` |
| احراز هویت، CSRF، RBAC | ✅ ساخته و تست‌شده (۳۵ عملیات در ماتریس RBAC) |
| سلامت و آمادگی | ✅ `/health` و `/ready` |
| متریک | ✅ `/metrics` — فقط از شبکهٔ خصوصی/loopback پاسخ می‌دهد |

### چه چیزی فقط برای توسعهٔ محلی است — و بزرگ‌ترین شکاف استقرار

> ⛔ **`docker-compose.yml` موجود فقط Postgres و Redis را بالا می‌آورد و صریحاً می‌گوید
> development-only.** خط اول همان فایل: *«Production compose (api, worker, nginx, TLS) arrives in
> M16 as `docker/docker-compose.prod.yml`»* — **آن فایل ساخته نشده است.**

نتیجهٔ عملی و مهم:

| چیزی که وجود ندارد | تأیید شد با |
|---|---|
| هیچ `Dockerfile` در کل مخزن | `find . -name 'Dockerfile*'` → خالی |
| هیچ `docker-compose.prod.yml` | پوشهٔ `docker/` وجود ندارد |
| هیچ فایل پیکربندی nginx | `find . -name '*nginx*'` → خالی |
| هیچ اسکریپت استقرار | فقط `tools/devstack.sh` که برای لوکال است |
| هیچ systemd unit | — |

**این یعنی بخش زیرساخت استقرار باید یک بار به‌صورت دستی ساخته شود.** بخش‌های ۵ تا ۸ همین فایل دقیقاً
همان کار را قدم‌به‌قدم توضیح می‌دهند. کد آماده است؛ *بسته‌بندی* استقرار آماده نیست.

`tools/devstack.sh` و اهداف `make dev`, `make tunnel`, `make webhook` **فقط برای لوکال‌اند**. تونل
`cloudflared` هر بار نام میزبان تازه‌ای می‌گیرد و برای تولید مناسب نیست.

### ریسک‌ها و بلاکرهای فعلی

از `docs/threat-model.md` §۴ و `docs/launch-readiness.md` §۱۰:

| # | ریسک | وضعیت |
|---|---|---|
| R1 | سن ۱۸+ خوداظهاری است | ⚠️ پذیرفته‌شده — بدون مالک |
| R2 | رمزنگاری در برابر سرور در معرض خطر محافظت نمی‌کند | ⚠️ پذیرفته‌شده |
| R3 | مدیر ارشد با دسترسی مستقیم به دیتابیس همهٔ کنترل‌ها را دور می‌زند | ⚠️ پذیرفته‌شده |
| R4 | یک VPS، بدون افزونگی | ⚠️ پذیرفته‌شده |
| R5 | وابستگی کامل به شرایط استفادهٔ تلگرام | ⚠️ **نیازمند بررسی حقوقی** |
| R6 | مقاومت Sybil ناقص است | ⚠️ پذیرفته‌شده |
| R7 | هم‌بستگی زمانی در گفت‌وگو | ⚠️ پذیرفته‌شده |
| R8 | میزبان می‌فهمد یک نفر به دو فعالیت او درخواست داده | ⚠️ پذیرفته‌شده و **به کاربر اعلام می‌شود** |
| R9 | پنل مدیریت فقط با ورود محافظت می‌شود | ⚠️ **باید قبل از تولید حل شود — بخش ۸.۵** |
| R10 | دستهٔ کدهای هدیهٔ ساخته‌شده قابل بازیابی نیست | ⚠️ عمدی |

**هیچ‌کدام از R1 تا R10 مالک مشخص ندارد.** این قدیمی‌ترین مورد باز پروژه است.

از `docs/threat-model.md` جدول‌های ⏳ (ساخته نشده):

- `T5.4` سخت‌سازی آپلود تصویر — **فعلاً مسئله نیست**: هیچ مسیر آپلودی در API فعال نیست
  (`STORAGE_*` تعریف شده و توسط کدی خوانده نمی‌شود). `NEEDS VERIFICATION` اگر بعداً آپلود اضافه شد.
- `T6.6` DoS در سطح برنامه — بدون CDN/WAF در MVP.
- `T7.1` رمزنگاری پشتیبان خارج از سرور — **باید خودتان انجام دهید، بخش ۱۷**.
- `T7.3` اسکن اسرار در CI.
- `T7.4` آرشیو WAL — **پیکربندی دستی، بخش ۱۷**.

### چه چیزی از کد تأیید شد و چه چیزی نیاز به بررسی دستی دارد

**تأیید شد از روی کد و اجرای واقعی:**

- تمام دستورها، پورت‌ها، مسیرها و نام سرویس‌های این فایل.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `make check`, `make build` — همه سبز.
- ۱۸۹۷ تست در ۸۲ فایل، همه سبز (شامل ۹۸۸ تست یکپارچگی روی PostgreSQL واقعی).
- گیت B4 حریم خصوصی: ۲۰ ادعا، همه سبز.
- تطبیق دفتر سکه روی دیتابیس زنده: ۲۴ حساب، **صفر مغایرت**.

**نیازمند بررسی دستی روی سرور شما:**

- رفتار پشت nginx واقعی و TLS واقعی.
- «کوکی `Secure` روی دامنهٔ واقعی» — لوکال کار می‌کند چون مرورگرها `localhost` را امن می‌دانند.
- دسترسی تلگرام به وب‌هوک از اینترنت عمومی.
- ضبط زندهٔ حریم خصوصی از دو حساب واقعی تلگرام (`docs/b4-privacy-gate.md` §۵).

---

## ۲. هدف استقرار و معماری پیشنهادی

### پیشنهاد برای آزمایش اولیه

| مورد | پیشنهاد | چرا |
|---|---|---|
| سرور | **یک VPS خارج از ایران** | ADR-0001: `api.telegram.org` از رنج‌های IP ایران در دسترس نیست |
| مشخصات | ۴ vCPU / ۸ GB / ۸۰ GB SSD | ADR-0001 همین را می‌گوید؛ برای MVP دو مرتبه بزرگ‌تر از نیاز است |
| سیستم‌عامل | **Ubuntu 24.04 LTS** | `NEEDS DECISION` — پیش‌فرض امن |
| Postgres و Redis | **در Docker، روی همان سرور** | فایل Compose موجود همین را می‌کند؛ ساده‌ترین مسیر برای آزمایش |
| API و Worker | **مستقیم روی سرور با systemd** | `NEEDS DECISION` — هیچ Dockerfile وجود ندارد؛ ساختن image کار اضافه است |
| nginx | **مستقیم روی سرور** (نه در Docker) | مدیریت گواهی با certbot ساده‌تر است |
| TLS | **Let's Encrypt + certbot** | رایگان و خودکار |

> **چرا systemd و نه Docker برای API و Worker؟** چون هیچ Dockerfile در مخزن نیست و نوشتن یکی برای
> اولین استقرار، یک لایهٔ خطای اضافه است. هر دو برنامه `node dist/main.js` هستند و systemd دقیقاً
> همین را می‌خواهد. اگر بعداً image خواستید، تصمیمی است که بعد از آزمایش اول گرفته می‌شود.

### جریان ترافیک

```text
                       کاربر تلگرام                     مدیر (کارمند)
                            |                                |
                          HTTPS                            HTTPS
                            |                                |
                app.example.com                    admin.example.com
                            |                                |
                            +------------- nginx -------------+
                            |                                |
              +-------------+--------------+                 |
              |                            |                 |
        فایل‌های ثابت                  /api/v1/*         /admin/v1/*
        (Mini App dist)          /telegram/webhook/*    (فایل‌های ثابت
              |                            |             Admin dist)
              |                            |                 |
              |                     127.0.0.1:3000 -----------+
              |                            |
              |                          API
              |                            |
              |            +---------------+---------------+
              |            |                               |
              |     127.0.0.1:55432                 127.0.0.1:56379
              |      PostgreSQL (Docker)             Redis (Docker)
              |            |                               |
              |            +---------------+---------------+
              |                            |
              |                         Worker
              |                            |
              |                     api.telegram.org
              |                            |
              +----------------------- تلگرام ------------------+
```

### چه چیزی عمومی و چه چیزی خصوصی

| سرویس | پورت | دسترسی |
|---|---|---|
| nginx | 80, 443 | 🌐 **عمومی** |
| API | 3000 | 🔒 فقط `127.0.0.1` |
| Mini App (dev server) | 5173 | ⛔ **در تولید اصلاً اجرا نمی‌شود** — فقط فایل ثابت |
| Admin Panel (dev server) | 5174 | ⛔ **در تولید اصلاً اجرا نمی‌شود** — فقط فایل ثابت |
| PostgreSQL | 55432 | 🔒 فقط `127.0.0.1` |
| Redis | 56379 | 🔒 فقط `127.0.0.1` |
| Worker | ندارد | 🔒 هیچ پورتی باز نمی‌کند |

### ⚠️ چرا هر دو SPA باید هم‌مبدأ با API باشند

این مهم‌ترین محدودیت معماری استقرار است و از کد ثابت می‌شود:

1. **API هیچ هدر CORS نمی‌فرستد.** `apps/api/src/common/security-headers.ts` را ببینید — هیچ
   `Access-Control-Allow-Origin` وجود ندارد.
2. **مینی‌اپ**: `apps/miniapp/src/api/client.ts` → `BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''`
   و بعد `fetch(\`${BASE_URL}/api/v1${path}\`)`. یعنی به‌صورت پیش‌فرض **مسیر نسبی** روی همان مبدأ.
3. **پنل مدیریت**: همان الگو با `VITE_ADMIN_API_BASE_URL` و `/admin/v1`، و علاوه بر آن کوکی نشست با
   `path=/admin` و `SameSite=Lax` و `Secure`. مبدأ متفاوت یعنی کوکی اصلاً فرستاده نمی‌شود.

> **نتیجه:** روی `app.example.com` هم فایل‌های مینی‌اپ سرو می‌شود و هم `/api/v1` پراکسی می‌شود.
> روی `admin.example.com` هم فایل‌های پنل سرو می‌شود و هم `/admin/v1` پراکسی می‌شود.
> **دامنهٔ جداگانهٔ `api.example.com` لازم نیست و اگر بسازید کار نمی‌کند** — مگر اینکه CORS اضافه کنید
> که کار جدیدی است و اینجا پیشنهاد نمی‌شود.

> ⚠️ **نکتهٔ مستندسازی:** `docs/admin-panel.md` §۸ نمونهٔ nginx با `location /admin { alias ...; }`
> دارد. **آن نمونه با build فعلی کار نمی‌کند**، چون هیچ‌کدام از دو `vite.config.ts` مقدار `base`
> ندارند و بنابراین دارایی‌ها با مسیر `/assets/...` ارجاع می‌شوند، نه `/admin/assets/...`.
> راه‌حل درست برای وضعیت فعلی: **میزبان اختصاصی** (`admin.example.com`) که پنل را روی `/` سرو کند.
> (اگر حتماً زیرمسیر می‌خواهید، باید `base: '/admin/'` به `apps/admin/vite.config.ts` اضافه شود —
> این یک تغییر کد است و در این TODO انجام نشده.)

---

## ۳. چه چیزهایی باید تهیه کنید

- [ ] **سرور VPS** — *الزامی*
  - چرا: همه‌چیز روی آن اجرا می‌شود.
  - حداقل: ۴ vCPU / ۸ GB RAM / ۸۰ GB SSD، **خارج از ایران**.
  - ذخیره کنید: IP، کاربر ریشه، کلید SSH.
  - `NEEDS DECISION` — انتخاب ارائه‌دهنده با شماست. ADR-0001 «کلاس Hetzner/Contabo» را **به‌عنوان
    مثال** نام برده، نه توصیهٔ خرید.

- [ ] **دامنه** — *الزامی*
  - چرا: تلگرام برای Mini App و webhook حتماً **HTTPS روی دامنهٔ عمومی** می‌خواهد.
  - حداقل: یک دامنه با امکان ساخت زیردامنه.
  - ذخیره کنید: نام دامنه، دسترسی پنل DNS.

- [ ] **دسترسی به ارائه‌دهندهٔ DNS** — *الزامی*
  - چرا: باید رکورد `A` بسازید و بعداً شاید تغییر دهید.

- [ ] **ربات تلگرام و توکن آن** — *الزامی* — `NEEDS SECRET`
  - چرا: کل هویت کاربران از تلگرام می‌آید.
  - از `@BotFather`. **توکن یعنی کنترل کامل ربات.**
  - ذخیره کنید: توکن (در مدیر رمز، نه در git)، نام کاربری ربات.
  - ⛔ هرگز در هیچ فایل tracked نگذارید. `.gitignore` خط ۱: `.env*`.

- [ ] **کانال تلگرام** — *اختیاری*
  - چرا: انتشار فعالیت‌های VIP و نردبان‌شده (M14).
  - اگر ندارید `TELEGRAM_CHANNEL_ID` را خالی بگذارید؛ کد آن را optional می‌داند.

- [ ] **ایمیل برای گواهی TLS** — *الزامی*
  - چرا: Let's Encrypt برای هشدار انقضا می‌فرستد.
  - یک ایمیل که واقعاً می‌خوانید.

- [ ] **فضای پشتیبان خارج از سرور** — *الزامی پیش از باز کردن به کاربران واقعی*
  - چرا: پشتیبانی که روی همان دیسک است، از خرابی همان دیسک محافظت نمی‌کند.
  - حداقل: هر فضای S3-مانند یا یک سرور دوم با `rsync`.
  - `NEEDS DECISION`.

- [ ] **سرویس مانیتورینگ** — *توصیه‌شده*
  - چرا: بدون آن، از قطعی وقتی خبردار می‌شوید که کاربری بگوید.
  - ساده‌ترین شروع: یک uptime-checker رایگان روی `https://app.example.com/health`.

- [ ] **سرویس رهگیری خطا (Sentry و مانند آن)** — *اختیاری، بعد از آزمایش اول*
  - ⚠️ در حال حاضر **هیچ ادغام Sentry در کد نیست**. اضافه کردنش کار جدید است.

- [ ] **PostgreSQL یا Redis مدیریت‌شده** — *اختیاری*
  - برای آزمایش اول لازم نیست. Compose موجود کافی است.

---

## ۴. دامنه و DNS

فرض این فایل: دامنهٔ نمونهٔ `example.com`. **جای آن دامنهٔ خودتان را بگذارید.**

- [ ] دامنه را انتخاب کنید. `NEEDS DECISION`
- [ ] این رکوردها را بسازید:

| نام | نوع | مقدار | برای چه |
|---|---|---|---|
| `app` | `A` | IPv4 سرور | مینی‌اپ + `/api/v1` + وب‌هوک |
| `admin` | `A` | IPv4 سرور | پنل مدیریت + `/admin/v1` |
| `app` | `AAAA` | IPv6 سرور | فقط اگر سرور IPv6 دارد — *اختیاری* |
| `admin` | `AAAA` | IPv6 سرور | *اختیاری* |

- [ ] `CNAME` **لازم نیست** مگر بخواهید `admin` را به `app` اشاره دهید — که توصیه نمی‌شود، چون
      باید مبدأهای جدا بمانند.
- [ ] `TTL` را برای اولین استقرار روی ۳۰۰ ثانیه بگذارید تا تغییر IP سریع پخش شود.

**بررسی پخش‌شدن DNS:**

```bash
dig +short app.example.com
dig +short admin.example.com
nslookup app.example.com
```

- [ ] تا وقتی هر دو دستور IP سرور شما را برنگردانده‌اند، سراغ certbot نروید.

**اگر IP سرور عوض شد:** رکوردهای `A` را به‌روزرسانی کنید، منتظر پخش بمانید، سپس گواهی را دوباره
بگیرید و **وب‌هوک تلگرام را دوباره ثبت کنید** (بخش ۱۴).

> ⚠️ **پراکسی ارائه‌دهندهٔ DNS (مثل ابر نارنجی Cloudflare):** `NEEDS VERIFICATION`.
> نه کد و نه مستندات پروژه چیزی دربارهٔ سازگاری آن نمی‌گویند. برای اولین استقرار **پراکسی را خاموش
> بگذارید** (DNS only) تا یک متغیر کمتر داشته باشید. اگر بعداً روشن کردید، حتماً وب‌هوک را دوباره
> بررسی کنید و مطمئن شوید IP واقعی کاربر از هدرها به API می‌رسد — سقف تعداد درخواست برای کاربر
> ناشناس بر پایهٔ IP است.

---

## ۵. آماده‌سازی سرور

### ۵.۱ اتصال و کاربر استقرار

- [ ] با SSH وصل شوید:
  ```bash
  ssh root@<SERVER_IP>
  ```
- [ ] کاربر غیر-root بسازید:
  ```bash
  adduser deploy
  usermod -aG sudo deploy
  ```
- [ ] کلید SSH خودتان را برای او نصب کنید (روی **رایانهٔ خودتان** اجرا کنید):
  ```bash
  ssh-copy-id deploy@<SERVER_IP>
  ```
- [ ] ورود با کلید را تست کنید **قبل از** بستن ورود با رمز:
  ```bash
  ssh deploy@<SERVER_IP>
  ```
- [ ] ورود با رمز و ورود مستقیم root را ببندید — در `/etc/ssh/sshd_config`:
  ```conf
  PasswordAuthentication no
  PermitRootLogin no
  ```
  ```bash
  sudo systemctl reload ssh
  ```
  > ⚠️ **جلسهٔ SSH فعلی را نبندید** تا در یک ترمینال دیگر ورود تازه را امتحان کنید.

### ۵.۲ فایروال

- [ ] فقط سه پورت باز باشد:
  ```bash
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw enable
  sudo ufw status verbose
  ```
- [ ] ⛔ **هرگز** پورت‌های `3000`، `5173`، `5174`، `55432`، `56379` را باز نکنید.
- [ ] بررسی کنید چیزی روی رابط عمومی گوش نمی‌دهد:
  ```bash
  sudo ss -ltnp
  ```
  همه باید `127.0.0.1:` باشند به‌جز nginx روی `0.0.0.0:80` و `0.0.0.0:443`.

### ۵.۳ نصب ابزارها

- [ ] بسته‌های پایه:
  ```bash
  sudo apt update && sudo apt upgrade -y
  sudo apt install -y git curl ca-certificates gnupg ufw nginx postgresql-client-16
  ```
  > `postgresql-client-16` برای `pg_dump` و `pg_restore` روی خود میزبان — کاربردی هنگام بازیابی.
- [ ] Docker و Compose (روش رسمی Docker):
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker deploy
  # از سیستم خارج و دوباره وارد شوید تا عضویت گروه اعمال شود
  docker --version
  docker compose version
  ```
- [ ] Node.js **≥ 22.12** — `package.json` این را در `engines` الزام کرده:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
  node --version      # باید v22.12 یا بالاتر باشد
  ```
- [ ] pnpm **10.30.0** — `packageManager` در `package.json` دقیقاً همین را می‌گوید:
  ```bash
  sudo corepack enable
  corepack prepare pnpm@10.30.0 --activate
  pnpm --version      # باید 10.30.0 باشد
  ```

### ۵.۴ زمان و به‌روزرسانی

- [ ] ساعت سرور را **UTC** بگذارید. ذخیره‌سازی همیشه UTC است (ADR-0008) و منطقهٔ زمانی کسب‌وکار
      در لایهٔ برنامه با `APP_TIMEZONE` اعمال می‌شود:
  ```bash
  sudo timedatectl set-timezone UTC
  timedatectl status
  ```
- [ ] همگام‌سازی زمان روشن باشد — **مهم است**، چون TOTP ورود مدیر به ساعت درست وابسته است:
  ```bash
  timedatectl show --property=NTPSynchronized
  ```
- [ ] به‌روزرسانی امنیتی خودکار — *توصیه‌شده*:
  ```bash
  sudo apt install -y unattended-upgrades
  sudo dpkg-reconfigure --priority=low unattended-upgrades
  ```

### ۵.۵ گرفتن کد

- [ ] پوشهٔ استقرار:
  ```bash
  sudo mkdir -p /srv/payetam
  sudo chown deploy:deploy /srv/payetam
  ```
- [ ] مخزن را clone کنید. `NEEDS DECISION` — آدرس مخزن شما:
  ```bash
  git clone <YOUR_REPO_URL> /srv/payetam
  cd /srv/payetam
  ```
- [ ] **کدام نسخه مستقر شود؟** `NEEDS DECISION`. پیش‌فرض امن برای آزمایش اول: **یک تگ**.
  ```bash
  git fetch --tags
  git checkout v0.1.0-trial       # یا هر تگی که ساخته‌اید
  git status --short              # باید خالی باشد
  git rev-parse HEAD              # این هش را در دفترچهٔ استقرار بنویسید
  ```
  > **هرگز کد commit‌نشده مستقر نکنید.** اگر `git status --short` روی سرور چیزی نشان داد، یعنی کسی
  > مستقیماً روی سرور ویرایش کرده و نسخهٔ در حال اجرا در هیچ‌جا ثبت نشده است.

---

## ۶. متغیرهای محیطی تولید

### ۶.۱ قواعد کلی

- فایل روی سرور: `/srv/payetam/.env` — **همان محلی که `.env.example` را کپی می‌کنید.**
  `apps/api/package.json` و `apps/worker/package.json` هر دو `--env-file=../../.env` را می‌خوانند،
  پس مسیر ثابت است.
- [ ] دسترسی فایل را قفل کنید:
  ```bash
  chmod 600 /srv/payetam/.env
  chown deploy:deploy /srv/payetam/.env
  ls -l /srv/payetam/.env    # باید -rw------- باشد
  ```
- ⛔ `.env` در `.gitignore` است. **هرگز آن را commit نکنید و مقادیر آن را در چت، ایمیل یا issue
  نگذارید.**
- `packages/config/src/env.ts` هنگام بوت اعتبارسنجی می‌کند و **اگر متغیری غایب یا بدشکل باشد،
  فرایند اصلاً بالا نمی‌آید** و همهٔ مشکلات را یکجا گزارش می‌دهد.

### ۶.۲ جدول کامل متغیرها

| متغیر | الزامی در تولید | چه چیزی را کنترل می‌کند | مقدار تولید | چطور بسازید |
|---|---|---|---|---|
| `NODE_ENV` | ✅ | حالت اجرا | `production` | — |
| `LOG_LEVEL` | — | حجم لاگ | `info` | پیش‌فرض `info` |
| `API_PORT` | — | پورت API | `3000` | پیش‌فرض |
| `PUBLIC_API_URL` | — | مبدأ عمومی API | `https://app.example.com` | ⚠️ اعتبارسنجی می‌شود ولی **هیچ کدی امروز آن را نمی‌خواند**؛ درست پرش کنید برای آینده |
| `DATABASE_URL` | ✅ | اتصال Postgres | `postgresql://payetam:<PW>@127.0.0.1:55432/payetam?schema=public` | `NEEDS SECRET` — رمز را بسازید |
| `TEST_DATABASE_URL` | ⛔ | فقط تست | **در تولید اصلاً نگذارید** | — |
| `REDIS_URL` | ✅ | اتصال Redis | `redis://127.0.0.1:56379` | — |
| `QUEUE_PREFIX` | — | فضای نام BullMQ | `payetam:prod` | ⚠️ **حتماً از `payetam:dev` جدا کنید** |
| `APP_TIMEZONE` | — | مرزهای سیاست و نمایش | `Asia/Tehran` | ذخیره همیشه UTC است |
| `APP_LOCALE` | — | زبان | `fa-IR` | — |
| `TELEGRAM_BOT_TOKEN` | ✅ | کنترل کامل ربات | از BotFather | `NEEDS SECRET` |
| `TELEGRAM_BOT_USERNAME` | — | لینک عمیق در کانال و دکمه‌ها | نام کاربری ربات، **بدون `@`** | اگر خالی باشد کد `payetam_bot` را فرض می‌کند — یعنی لینک‌های اشتباه |
| `TELEGRAM_MODE` | ✅ | webhook یا polling | `webhook` | ⛔ `polling` در تولید **رد می‌شود** |
| `TELEGRAM_WEBHOOK_SECRET_PATH` | ✅ | بخش مخفی مسیر وب‌هوک | ۴۸ نویسهٔ هگز | `openssl rand -hex 24` |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | ✅ | هدر مخفی تلگرام | ۶۴ نویسهٔ هگز | `openssl rand -hex 32` |
| `TELEGRAM_CHANNEL_ID` | — | کانال انتشار | `-100…` یا `@channelname` | اگر کانال ندارید خالی |
| `CHAT_ENCRYPTION_KEY` | ✅ | AES-256-GCM پیام‌ها و TOTP مدیران | base64 دقیقاً ۳۲ بایت | `openssl rand -base64 32` |
| `PII_HASH_PEPPER` | ✅ | HMAC آدرس IP | base64 دقیقاً ۳۲ بایت | `openssl rand -base64 32` |
| `JWT_ACCESS_SECRET` | ✅ | توکن دسترسی مینی‌اپ | ≥ ۳۲ نویسه | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | ✅ | توکن تازه‌سازی | ≥ ۳۲ نویسه، **متفاوت با بالایی** | `openssl rand -base64 48` |
| `JWT_ACCESS_TTL` | — | عمر توکن دسترسی | `15m` | — |
| `JWT_REFRESH_TTL` | — | عمر توکن تازه‌سازی | `7d` | — |
| `STORAGE_DRIVER` | — | محل فایل‌ها | `local` | هیچ مسیر آپلودی امروز فعال نیست |
| `STORAGE_LOCAL_PATH` | — | مسیر آپلود | `./uploads` | استفاده نمی‌شود |
| `MAX_UPLOAD_BYTES` | — | سقف آپلود | `5242880` | استفاده نمی‌شود |
| `ALLOW_PROD_SEED` | ✅ | ریل ایمنی seed | `0` | ⛔ اگر در تولید `1` باشد، **فرایند بالا نمی‌آید** |

**متغیرهایی که در کد وجود ندارند و نباید اضافه کنید:** `CORS_ORIGIN`، `SESSION_SECRET`،
`CSRF_SECRET`، `COOKIE_DOMAIN`، `TRUST_PROXY`، `SENTRY_DSN`، `BACKUP_*` در `.env`.
- **CSRF** توکن تصادفی در Redis است، نه یک راز پیکربندی.
- **کوکی** در `apps/api/src/admin/admin.controller.ts` سخت‌کد شده:
  `httpOnly: true, secure: true, sameSite: 'lax', path: '/admin', maxAge: 12h`. دامنه‌ای تنظیم
  نمی‌شود، پس کوکی host-only است — یعنی روی `admin.example.com` می‌ماند و به جای دیگری نشت نمی‌کند.
- **پشتیبان‌گیری** با `PAYETAM_BACKUP_DIR` و `PAYETAM_BACKUP_RETAIN_DAYS` تنظیم می‌شود که در
  محیط سرویس cron داده می‌شوند، نه در `.env` برنامه.

### ۶.۳ ساخت فایل

- [ ] از الگو کپی بگیرید و همه را دستی پر کنید:
  ```bash
  cd /srv/payetam
  cp .env.example .env
  chmod 600 .env
  nano .env
  ```
- [ ] رازها را یکجا بسازید و **در مدیر رمز ذخیره کنید** (خروجی را در تاریخچهٔ شل نگه ندارید):
  ```bash
  openssl rand -hex 24      # TELEGRAM_WEBHOOK_SECRET_PATH
  openssl rand -hex 32      # TELEGRAM_WEBHOOK_SECRET_TOKEN
  openssl rand -base64 32   # CHAT_ENCRYPTION_KEY
  openssl rand -base64 32   # PII_HASH_PEPPER
  openssl rand -base64 48   # JWT_ACCESS_SECRET
  openssl rand -base64 48   # JWT_REFRESH_SECRET
  openssl rand -base64 24   # رمز پایگاه داده
  ```
- [ ] خط `TEST_DATABASE_URL` را **حذف یا کامنت** کنید.

### ۶.۴ چرخش رازها — و کدام‌ها خطرناک‌اند

| متغیر | اثر تغییر بعد از وجود داده |
|---|---|
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | ✅ بی‌خطر. همهٔ کاربران از حساب خارج می‌شوند و مینی‌اپ خودکار دوباره وارد می‌شود |
| `TELEGRAM_WEBHOOK_SECRET_PATH` / `_TOKEN` | ✅ بی‌خطر، **ولی باید فوراً وب‌هوک را دوباره ثبت کنید** وگرنه ربات کر می‌شود |
| `TELEGRAM_BOT_TOKEN` | ⚠️ ربات عوض می‌شود؛ کاربران فعلی به ربات قبلی وصل‌اند |
| `CHAT_ENCRYPTION_KEY` | ⛔ **بسیار خطرناک.** همهٔ پیام‌های گفت‌وگو و همهٔ رازهای TOTP مدیران با این کلید رمزنگاری شده‌اند. تغییر بدون job بازرمزنگاری یعنی **هیچ مدیری نمی‌تواند وارد شود و هیچ پیامی خوانده نمی‌شود** |
| `PII_HASH_PEPPER` | ⚠️ هش‌های IP قدیمی دیگر با جدیدها قابل مقایسه نیستند. داده از دست نمی‌رود ولی ارتباط تاریخی می‌شکند |
| `DATABASE_URL` (رمز) | ✅ بی‌خطر اگر همزمان در Postgres هم عوض شود |
| `QUEUE_PREFIX` | ⚠️ کارهای در صف رها می‌شوند. outbox در Postgres است پس چیزی گم نمی‌شود، ولی تحویل تأخیر می‌خورد |

---

## ۷. Docker Compose در تولید

### ۷.۱ وضعیت فعلی

`docker-compose.yml` موجود **فقط دو سرویس دارد** و برای لوکال نوشته شده:

| سرویس | image | پورت | volume | healthcheck | restart |
|---|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `127.0.0.1:55432:5432` | `postgres-data` | `pg_isready` | `unless-stopped` |
| `redis` | `redis:7-alpine` | `127.0.0.1:56379:6379` | `redis-data` | `redis-cli ping` | `unless-stopped` |

نکات مثبتی که همین حالا درست‌اند و باید حفظ شوند:

- هر دو پورت به `127.0.0.1` بسته شده‌اند — از بیرون سرور در دسترس نیستند. ✅
- Redis با `--appendonly yes --appendfsync everysec` اجرا می‌شود، پس کارهای BullMQ از restart جان
  سالم به در می‌برند. ✅
- Postgres با `TZ=UTC` و `PGTZ=UTC`. ✅
- هر دو `restart: unless-stopped`. ✅

### ۷.۲ آنچه باید برای تولید تغییر دهید

- [ ] ⛔ **رمز `CHANGE_ME_LOCAL_ONLY` را عوض کنید.** `NEEDS SECRET`
      این تنها تغییر **الزامی** در فایل Compose است.
- [ ] لاگ‌های پرحرف Postgres را کم کنید. خطوط `log_min_duration_statement=200` و `log_lock_waits=on`
      عمداً برای توسعه‌اند («far too chatty for production» — کامنت خود فایل).
- [ ] سقف چرخش لاگ داکر بگذارید تا دیسک پر نشود — *توصیه‌شده*.
- [ ] `NEEDS DECISION`: بهترین کار این است که **فایل Compose موجود را دست نزنید** و یک فایل
      `docker-compose.prod.yml` جدا بسازید که فقط همین دو مورد را override کند. این کار در این TODO
      انجام **نشده** است، چون دستور کار گفته فقط TODO بنویس.

نمونهٔ چیزی که باید بسازید (فقط برای مرجع — **این را کورکورانه کپی نکنید**):

```yaml
# docker-compose.prod.yml — override روی docker-compose.yml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set it}
    command:
      - postgres
      - -c
      - log_statement=none
      - -c
      - log_min_duration_statement=2000
    logging:
      driver: json-file
      options: { max-size: '10m', max-file: '5' }
  redis:
    logging:
      driver: json-file
      options: { max-size: '10m', max-file: '5' }
```

### ۷.۳ دستورها

```bash
cd /srv/payetam
docker compose -f docker-compose.yml -f docker-compose.prod.yml config     # اعتبارسنجی
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f postgres
```

- [ ] تا وقتی هر دو `healthy` نشده‌اند، جلو نروید:
  ```bash
  docker compose ps
  ```

### ۷.۴ API و Worker با systemd

چون Dockerfile نداریم، هر دو برنامه را با systemd اجرا می‌کنیم.

- [ ] یک بار وابستگی‌ها را نصب و کد را build کنید:
  ```bash
  cd /srv/payetam
  pnpm install --frozen-lockfile
  pnpm db:generate
  pnpm build              # tsc -b و سپس build هر دو SPA
  ```
  > `pnpm build` هم `apps/api/dist` و `apps/worker/dist` را می‌سازد و هم
  > `apps/miniapp/dist` و `apps/admin/dist` را.

- [ ] `/etc/systemd/system/payetam-api.service`:
  ```ini
  [Unit]
  Description=PayeTam API
  After=network-online.target docker.service
  Wants=network-online.target

  [Service]
  Type=simple
  User=deploy
  WorkingDirectory=/srv/payetam/apps/api
  ExecStart=/usr/bin/node --env-file=/srv/payetam/.env dist/main.js
  Restart=always
  RestartSec=5
  # SIGTERM: Nest با enableShutdownHooks اتصال‌ها را می‌بندد و درخواست‌های
  # در جریان را تمام می‌کند (apps/api/src/main.ts)
  KillSignal=SIGTERM
  TimeoutStopSec=30
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  ```

- [ ] `/etc/systemd/system/payetam-worker.service` — همان، با
      `WorkingDirectory=/srv/payetam/apps/worker` و `Description=PayeTam Worker`.

- [ ] فعال‌سازی:
  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now payetam-api payetam-worker
  sudo systemctl status payetam-api payetam-worker
  ```

- [ ] لاگ‌ها:
  ```bash
  journalctl -u payetam-api -f
  journalctl -u payetam-worker -f
  ```

> ⛔ **هرگز دو نمونهٔ Worker اجرا نکنید.** صف `telegram-send` یک محدودکنندهٔ نرخ سراسری دارد
> (`QUEUE_CONCURRENCY` در `packages/platform/src/queue/queues.ts`)؛ دو Worker یعنی دو برابر نرخ و
> ریسک بلاک شدن ربات.

> ⛔ **`pnpm dev`، `make dev`، `tsx` و vite dev server در تولید اجرا نمی‌شوند.** ADR-0013 صریح است:
> esbuild متادیتای decorator را تولید نمی‌کند و تزریق وابستگی بی‌صدا `undefined` می‌شود.

---

## ۸. nginx و HTTPS

### ۸.۱ فایل‌های ثابت

- [ ] خروجی build را در جای قابل‌سرو بگذارید:
  ```bash
  sudo mkdir -p /srv/www/miniapp /srv/www/admin
  sudo rsync -a --delete /srv/payetam/apps/miniapp/dist/ /srv/www/miniapp/
  sudo rsync -a --delete /srv/payetam/apps/admin/dist/  /srv/www/admin/
  sudo chown -R www-data:www-data /srv/www
  ```

### ۸.۲ پیکربندی nginx — مینی‌اپ

`/etc/nginx/sites-available/app.example.com`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name app.example.com;
    # certbot این بلوک را برای ریدایرکت به HTTPS بازنویسی می‌کند
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name app.example.com;

    # certbot این چهار خط را خودش پر می‌کند
    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # بدنهٔ درخواست‌ها کوچک است؛ سقف پایین یعنی سطح حملهٔ کمتر
    client_max_body_size 2m;

    # ── API مینی‌اپ ────────────────────────────────────────────────
    # باید هم‌مبدأ باشد: کلاینت مسیر نسبی /api/v1 را صدا می‌زند
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # ── وب‌هوک تلگرام ─────────────────────────────────────────────
    # مسیر واقعی از apps/api/src/telegram/webhook.controller.ts:
    #   @Controller('telegram') + @Post('webhook/:secretPath')
    location /telegram/webhook/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # هدر مخفی تلگرام باید دست‌نخورده برسد — nginx به‌صورت پیش‌فرض
        # هدرهای با خط تیره را عبور می‌دهد، پس کاری لازم نیست
    }

    # ── بررسی سلامت، برای مانیتورینگ بیرونی ───────────────────────
    location = /health { proxy_pass http://127.0.0.1:3000/health; }

    # ⛔ /metrics را عمداً پراکسی نمی‌کنیم. کنترلر خودش هر تماس خارج از
    # شبکهٔ خصوصی را 404 می‌کند، ولی باز نکردنش یک لایهٔ کمتر است.

    # ── فایل‌های مینی‌اپ ──────────────────────────────────────────
    root /srv/www/miniapp;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;    # مسیریابی history-mode
    }

    location /assets/ {
        root /srv/www/miniapp;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

> ⚠️ **CSP برای مینی‌اپ:** `apps/miniapp/index.html` اسکریپت
> `https://telegram.org/js/telegram-web-app.js` را بارگذاری می‌کند. اگر هدر
> `Content-Security-Policy` اضافه کردید، حتماً `script-src` را طوری بنویسید که آن یک مبدأ مجاز باشد،
> وگرنه مینی‌اپ داخل تلگرام اصلاً بالا نمی‌آید. برای آزمایش اول **CSP اضافه نکنید** — API خودش روی
> پاسخ‌های JSON یک CSP سخت‌گیرانه می‌گذارد و آن کافی است.

> ⚠️ **`X-Frame-Options` روی مینی‌اپ نگذارید.** تلگرام مینی‌اپ را داخل WebView خودش باز می‌کند.

### ۸.۳ پیکربندی nginx — پنل مدیریت

`/etc/nginx/sites-available/admin.example.com`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name admin.example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name admin.example.com;

    ssl_certificate     /etc/letsencrypt/live/admin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.example.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 1m;

    # ── محدودسازی شبکه (R9) — اکیداً توصیه می‌شود ──────────────────
    # allow 203.0.113.7;      # IP ثابت دفتر
    # allow 198.51.100.0/24;  # رنج VPN
    # deny all;

    # ── API پنل ───────────────────────────────────────────────────
    # باید هم‌مبدأ باشد: کوکی نشست path=/admin دارد و API هیچ هدر CORS
    # نمی‌فرستد، پس مبدأ متفاوت یعنی نشست همیشه منقضی
    location /admin/v1/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;   # ساخت دسته‌ای تا ۱۰۰۰ کد کمی طول می‌کشد

        # کوکی و هدر CSRF دست‌نخورده عبور می‌کنند. هیچ proxy_cookie_path
        # لازم نیست، چون مسیر /admin روی همین میزبان همان است که کوکی
        # برایش صادر شده.
    }

    # ── فایل‌های پنل ──────────────────────────────────────────────
    root /srv/www/admin;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
    }

    location /assets/ {
        root /srv/www/admin;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

> **چرا میزبان جدا و نه `app.example.com/admin`؟** چون `apps/admin/vite.config.ts` مقدار `base`
> ندارد و دارایی‌ها با `/assets/...` ارجاع می‌شوند. سرو کردن روی زیرمسیر بدون تغییر `base`
> صفحهٔ سفید می‌دهد. بخش ۲ توضیح کامل دارد.

### ۸.۴ فعال‌سازی و TLS

- [ ] فعال کردن سایت‌ها و تست پیکربندی:
  ```bash
  sudo ln -s /etc/nginx/sites-available/app.example.com   /etc/nginx/sites-enabled/
  sudo ln -s /etc/nginx/sites-available/admin.example.com /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t          # ⛔ تا وقتی این سبز نشده reload نکنید
  sudo systemctl reload nginx
  ```
- [ ] گواهی Let's Encrypt:
  ```bash
  sudo apt install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d app.example.com -d admin.example.com \
       --email <YOUR_EMAIL> --agree-tos --no-eff-email
  ```
- [ ] تمدید خودکار را تست کنید:
  ```bash
  sudo certbot renew --dry-run
  systemctl list-timers | grep certbot
  ```

### ۸.۵ محافظت از پنل مدیریت — R9

> **این تنها بلاکر امنیتی است که با کد حل نمی‌شود.** `docs/threat-model.md` R9:
> پنل فقط با ورود محافظت می‌شود؛ نه تونل می‌شود، نه `allowedHosts` دارد، `noindex` هست —
> **هیچ‌کدام کنترل شبکه نیستند.**

`NEEDS DECISION` — یکی را انتخاب کنید:

- [ ] **الف) محدودسازی IP در nginx** — ساده‌ترین. بلوک `allow`/`deny` بالا را باز کنید.
      مناسب اگر IP ثابت دارید.
- [ ] **ب) VPN** (WireGuard/Tailscale) و bind پنل روی رابط VPN. امن‌ترین.
- [ ] **ج) احراز هویت پایهٔ HTTP روی nginx** به‌عنوان لایهٔ دوم *علاوه بر* ورود پنل.
      ضعیف‌ترین گزینه ولی از هیچ بهتر است.

**پیش‌فرض توصیه‌شده برای آزمایش اول: گزینهٔ الف.** اگر IP ثابت ندارید، گزینهٔ ب.

- [ ] بررسی کنید `/metrics` از بیرون در دسترس نیست:
  ```bash
  curl -I https://app.example.com/metrics     # باید 404 یا 301 بدهد، نه متریک
  ```

---

## ۹. پایگاه داده و مهاجرت‌ها

- [ ] Postgres باید بالا و `healthy` باشد (بخش ۷.۳).
- [ ] `DATABASE_URL` را در `.env` با **رمز قوی** پر کنید و همان رمز را در Compose بگذارید.
- [ ] دسترسی فقط از `127.0.0.1` — همین حالا در Compose درست است. تغییرش ندهید.
- [ ] کلاینت Prisma را بسازید (تولید نمی‌شود و در git نیست):
  ```bash
  cd /srv/payetam
  pnpm db:generate
  ```
- [ ] **پیش از هر مهاجرت، پشتیبان بگیرید** (بخش ۱۷).
- [ ] مهاجرت‌ها را اعمال کنید:
  ```bash
  pnpm db:migrate:deploy
  ```
  > ⛔ **`pnpm db:migrate` را در تولید اجرا نکنید.** آن `prisma migrate dev` است که مهاجرت
  > *می‌سازد* و می‌تواند دیتابیس را reset کند. تولید فقط `deploy` است — همان چیزی که
  > `.github/workflows/ci.yml` هم استفاده می‌کند.
- [ ] وضعیت را بررسی کنید:
  ```bash
  docker compose exec -T postgres psql -U payetam -d payetam -c '\dt' | head -30
  docker compose exec -T postgres psql -U payetam -d payetam \
    -c 'select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 5;'
  ```
  باید **۱۸ ردیف** ببینید و آخری `00000000000019_referral_rejection` باشد.
  > ۱۸ و نه ۱۹: شماره‌ها تا ۰۰۱۹ می‌روند ولی **۰۰۱۰ عمداً وجود ندارد** — در M9 با ۰۰۰۹ ادغام شد.
  > این یک خطا نیست و دنبال مهاجرت گم‌شده نگردید.

- [ ] سلامت پایگاه داده:
  ```bash
  curl -s http://127.0.0.1:3000/ready
  # {"ready":true,"checks":{"database":"up","redis":"up"}}
  ```

### ⛔ هشدار حیاتی دربارهٔ تست‌ها

> **تست‌های یکپارچگی پیش از هر تست همهٔ جدول‌ها را `TRUNCATE` می‌کنند**
> (`test/integration/db.ts`). اگر `TEST_DATABASE_URL` تنظیم نباشد، به `DATABASE_URL` برمی‌گردند —
> یعنی **پایگاه دادهٔ تولید شما را خالی می‌کنند.**
>
> - [ ] ⛔ **هرگز `pnpm test`، `pnpm test:integration`، `make test`، `make test-int` یا `make check`
>   را روی سرور تولید اجرا نکنید.**
> - [ ] در `.env` تولید هیچ `TEST_DATABASE_URL` نگذارید.
> - تست‌ها جای خودشان است: رایانهٔ توسعه و CI.

### بازگشت به عقب

- [ ] Prisma مهاجرت معکوس ندارد. برنامهٔ بازگشت = **بازیابی از پشتیبان** (بخش ۱۷).
- [ ] هر مهاجرت دست‌نویس است و در `packages/db/prisma/migrations/` قابل خواندن؛ پیش از اعمال
      روی تولید یک بار بخوانیدش.

### محدودیت اتصال

- `packages/db` از `@prisma/adapter-pg` استفاده می‌کند. اندازهٔ pool در تولید صریحاً تنظیم نشده و
  پیش‌فرض درایور اعمال می‌شود. `NEEDS VERIFICATION` — با یک API و یک Worker روی یک VPS مشکلی نیست،
  ولی اگر بعداً نمونه اضافه کردید، `max_connections` پیش‌فرض Postgres (۱۰۰) را زیر نظر بگیرید:
  ```bash
  docker compose exec -T postgres psql -U payetam -d payetam \
    -c 'select count(*) from pg_stat_activity;'
  ```

---

## ۱۰. Redis و Worker

- [ ] `REDIS_URL=redis://127.0.0.1:56379` — بدون رمز، چون فقط روی loopback گوش می‌دهد.
      `NEEDS DECISION`: اگر بعداً Redis را در شبکهٔ داخلی گذاشتید، `requirepass` اضافه کنید.
- [ ] پایداری AOF همین حالا روشن است (`--appendonly yes --appendfsync everysec`). ✅
- [ ] `QUEUE_PREFIX=payetam:prod` — ⚠️ اگر با محیط دیگری یکی باشد، Worker آن محیط کارهای شما را
      برمی‌دارد.
- [ ] چهار صف وجود دارد (`packages/platform/src/queue/queues.ts`):
      `telegram-send`، `domain-events`، `scheduled`، `moderation`.
- [ ] Worker را اجرا و فعال کنید (بخش ۷.۴).
- [ ] تأیید کنید کار می‌کند — خط راه‌اندازی را ببینید:
  ```bash
  journalctl -u payetam-worker | grep -i "Worker started"
  ```
- [ ] عمق صف‌ها را از متریک ببینید (فقط از خود سرور):
  ```bash
  curl -s http://127.0.0.1:3000/metrics | grep payetam_queue_depth
  ```
- [ ] کارهای شکست‌خورده در جدول `job_failure` ثبت می‌شوند:
  ```bash
  docker compose exec -T postgres psql -U payetam -d payetam \
    -c 'select queue, job_name, count(*) from job_failure group by 1,2 order by 3 desc limit 10;'
  ```
- [ ] **بعد از restart چه می‌شود؟** هیچ اعلانی گم نمی‌شود: رویدادها در `outbox_event` داخل Postgres
      نوشته شده‌اند و رله در راه‌اندازی بعدی آن‌ها را برمی‌دارد (ADR-0005). یک جاروب پشتیبان
      هر پنج دقیقه هم هست.
- [ ] ⛔ **فقط یک Worker.** با `systemctl status payetam-worker` مطمئن شوید یکی بیشتر نیست.

---

## ۱۱. داده‌های پایه و seed

`tools/seed-guard.ts` یک ریل ایمنی مشترک دارد: در تولید هر seed **هم** `ALLOW_PROD_SEED=1` می‌خواهد،
**هم** تأیید تایپ‌شدهٔ نام پایگاه داده در ترمینال تعاملی، **و** یک ردیف `audit_log` می‌نویسد.
استثنا فقط `seed:rbac` است که `unattended` علامت خورده چون باید در هر استقرار اجرا شود.

| دستور | در تولید؟ | چرا |
|---|---|---|
| `pnpm seed:rbac` | ✅ **الزامی، در هر استقرار** | نقش‌ها و ۱۷ مجوز را از فهرست کد می‌نویسد. idempotent |
| `pnpm seed:policies` | ✅ الزامی یک بار | متن قوانین و حریم خصوصی؛ بدون آن onboarding کار نمی‌کند |
| `pnpm seed:catalog` | ✅ الزامی یک بار | شهر، منطقه، دسته‌بندی، علاقه‌مندی |
| `pnpm seed:blacklist` | ✅ الزامی یک بار | واژگان ممنوع برای بررسی خودکار |
| `pnpm seed:settings` | ✅ توصیه‌شده | ~۵۰ عدد سیاست را قابل دیدن می‌کند. **create-only** — مقدار تنظیم‌شده را بازنویسی نمی‌کند |
| `pnpm seed:events` | ⚠️ فقط اگر عمداً بخواهید | رویدادهای تیم مؤسس. در تولید میزبان‌های واقعی از `FOUNDING_TEAM_TELEGRAM_IDS` می‌خواهد |
| `make seed-gift-codes-dev` | ⛔ **هرگز** | کد هدیه یعنی سکه. تحت هر `NODE_ENV` جز `development`/`test` **رد می‌شود** و راه دور زدن ندارد |

- [ ] ترتیب اجرا در اولین استقرار:
  ```bash
  cd /srv/payetam
  pnpm seed:rbac                      # بدون تأیید تعاملی اجرا می‌شود
  ALLOW_PROD_SEED=1 pnpm seed:policies   # نام دیتابیس را تایپ می‌کند
  ALLOW_PROD_SEED=1 pnpm seed:catalog
  ALLOW_PROD_SEED=1 pnpm seed:blacklist
  ALLOW_PROD_SEED=1 pnpm seed:settings
  ```
  > ⚠️ `ALLOW_PROD_SEED=1` را **فقط برای همان دستور** بگذارید، نه در `.env`. اگر در `.env` بماند،
  > دفعهٔ بعد **API اصلاً بالا نمی‌آید** — `packages/config/src/env.ts` این ترکیب را رد می‌کند.

- [ ] نتیجه را بررسی کنید:
  ```bash
  docker compose exec -T postgres psql -U payetam -d payetam -tAc \
    "select (select count(*) from role) roles, (select count(*) from permission) perms,
            (select count(*) from city) cities, (select count(*) from policy_version) policies;"
  ```
  انتظار: `4 | 17 | ≥1 | ≥2`.
  > اگر تعداد مجوزها کمتر از ۱۷ بود، `pnpm seed:rbac` را دوباره اجرا کنید. **این دقیقاً همان
  > اشتباهی است که در همین ماشین توسعه پیدا شد** — پایگاه داده دو مجوز عقب بود.

- [ ] **کدهای هدیهٔ واقعی** را فقط از **پنل مدیریت** بسازید (بخش ۱۲ و `docs/admin-panel.md` §۴).
      ⛔ هیچ کد باارزشی را در git نگذارید.

---

## ۱۲. حساب مدیر و پنل

### ۱۲.۱ ساخت اولین حساب

> **ثبت‌نام خودکار وجود ندارد و قرار هم نیست باشد.** `admin_user` هیچ کلید خارجی به `user` ندارد و
> همین جدایی، کنترل امنیتی است (ADR-0010).

- [ ] `pnpm seed:rbac` را اجرا کرده باشید (بخش ۱۱).
- [ ] یک اسکریپت موقت بنویسید که `AdminAccessService.createAdmin` را صدا بزند. `docs/admin-panel.md`
      §۱ همین را می‌گوید. اسکریپت باید `apps/api/dist/app.module.js` را بارگذاری کند و بعد:
      `createAdmin({ email, password, displayName, roles: [ROLE_KEYS.SUPER_ADMIN] })`.
- [ ] رمز عبور: **دست‌کم ۱۲ نویسه** (`adminLoginRequest` همین را الزام کرده). `NEEDS SECRET` —
      از مدیر رمز بگیرید، نه از ذهنتان.
- [ ] خروجی `totpSecret` را **همان لحظه** در اپلیکیشن احراز هویت (Google Authenticator، Aegis، …)
      ثبت کنید.
  > ⛔ **این راز فقط یک بار برگردانده می‌شود.** در پایگاه داده رمزنگاری‌شده ذخیره می‌شود و هیچ
  > اندپوینتی آن را دوباره نمی‌دهد. گم شدنش یعنی حساب از دست رفته.
- [ ] ⛔ اسکریپت موقت را **پاک کنید** و مطمئن شوید در tarball یا git نمانده.

### ۱۲.۲ ورود و آزمون

- [ ] `https://admin.example.com` را باز کنید. باید صفحهٔ ورود فارسی ببینید.
- [ ] ایمیل + رمز + کد شش‌رقمی. **هر سه، همیشه.**
- [ ] ورود موفق ⇒ باید داشبورد را ببینید با عددهای واقعی و وضعیت سبز پایگاه داده و Redis.
- [ ] **آزمون کوکی:** صفحه را با `F5` تازه کنید. باید همچنان وارد بمانید و نوار زرد
      «نشست فقط خواندنی» **ظاهر نشود**.
  > اگر بعد از refresh بیرون انداخته شدید یا نوار زرد آمد، یعنی کوکی `Secure` نمی‌رسد —
  > تقریباً همیشه به‌خاطر HTTP به‌جای HTTPS، یا مبدأ متفاوت.
- [ ] **آزمون CSRF:** از ترمینال سرور:
  ```bash
  # ورود و ذخیرهٔ کوکی
  curl -s -c /tmp/a.jar -X POST https://admin.example.com/admin/v1/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"<ADMIN_EMAIL>","password":"<PASSWORD>","totpCode":"<CODE>"}' > /tmp/login.json
  # تغییر بدون هدر CSRF — باید رد شود
  curl -s -b /tmp/a.jar -X POST https://admin.example.com/admin/v1/settings/economy.boost_coins \
    -H 'content-type: application/json' -d '{"value":40,"reason":"csrf check"}'
  # انتظار: {"error":{"code":"FORBIDDEN",...,"details":{"reason":"csrf"}}}
  rm -f /tmp/a.jar /tmp/login.json
  ```
  > ⛔ بلافاصله فایل‌های موقت را پاک کنید — کوکی نشست داخلشان است.

### ۱۲.۳ نقش‌ها و حساب دوم

نقش‌ها از `packages/domain/src/adminaccess/permissions.ts`:

| نقش | مجوزها |
|---|---|
| `SUPER_ADMIN` | همهٔ ۱۷ مجوز |
| `MODERATOR` | داشبورد، خواندن و مسدودسازی کاربر، بررسی فعالیت، گزارش‌ها، واژگان ممنوع، دفتر، گفت‌وگو، معرفی دوستان، رخدادها |
| `SUPPORT` | داشبورد، خواندن کاربر، گزارش‌ها، دفتر |
| `ANALYST` | فقط داشبورد |

- [ ] **حساب دوم اضطراری بسازید** — *الزامی پیش از باز کردن به کاربران واقعی*.
      اگر گوشیِ حاوی TOTP گم شود، بدون حساب دوم راه ورودی نمی‌ماند.
- [ ] تغییر نقش «چهار چشم» است: یک مدیر درخواست می‌دهد و **مدیر دیگری** تأیید می‌کند
      (`POST /admin/v1/roles/requests` و `.../approve`). ⚠️ این هنوز صفحه ندارد و فقط از API
      قابل انجام است (`docs/admin-panel.md` §۶).
- [ ] غیرفعال کردن یک حساب: `admin_user.status` را به `SUSPENDED` یا `DISABLED` تغییر دهید.
      `NEEDS VERIFICATION` — اندپوینتی برای آن نیست؛ فعلاً `UPDATE` مستقیم در پایگاه داده.

---

## ۱۳. راه‌اندازی ربات تلگرام

- [ ] در `@BotFather` ربات بسازید یا انتخاب کنید: `/newbot`.
- [ ] توکن را در `TELEGRAM_BOT_TOKEN` بگذارید. `NEEDS SECRET`
- [ ] نام کاربری ربات را در `TELEGRAM_BOT_USERNAME` بگذارید — **بدون `@`**.
  > اگر خالی بماند، `apps/worker/src/telegram/telegram.client.ts` مقدار `payetam_bot` را فرض می‌کند
  > و همهٔ لینک‌های عمیق در کانال و دکمه‌ها به ربات اشتباهی می‌روند.
- [ ] `TELEGRAM_MODE=webhook`.
- [ ] در BotFather آدرس مینی‌اپ را ثبت کنید:
  - `/newapp` یا `/myapps` ⇒ Web App URL = `https://app.example.com`
  - `/mybots` ⇒ Bot Settings ⇒ Menu Button ⇒ `https://app.example.com`
- [ ] `/setdomain` را روی `app.example.com` بگذارید.
- [ ] توضیحات و عکس ربات را تنظیم کنید — *اختیاری ولی برای اعتماد کاربر مفید*.

> ⛔ **تونل سریع `cloudflared` برای تولید نیست.** `make tunnel` هر بار نام میزبان تازه می‌گیرد و
> `make webhook` فقط با همان کار می‌کند. در تولید دامنهٔ ثابت دارید و مسیر بخش ۱۴ را می‌روید.

---

## ۱۴. وب‌هوک تلگرام در تولید

### مسیر واقعی

از `apps/api/src/telegram/webhook.controller.ts`:
`@Controller('telegram')` + `@Post('webhook/:secretPath')`

```text
https://app.example.com/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET_PATH>
```

- [ ] پیش از هر کاری مطمئن شوید مسیر از اینترنت عمومی جواب می‌دهد:
  ```bash
  curl -sS https://app.example.com/health
  ```
  > **این مهم است:** تلگرام هنگام ثبت، خودش نام میزبان را resolve می‌کند و **یک `setWebhook`
  > ناموفق، وب‌هوک قبلی را پاک می‌کند.** `tools/devstack.sh` دقیقاً به همین دلیل اول تونل را
  > اثبات می‌کند و بعد سراغ تلگرام می‌رود.

- [ ] ثبت وب‌هوک (روی سرور، تا توکن از تاریخچهٔ شل رایانهٔ شما بیرون بماند):
  ```bash
  cd /srv/payetam
  BOT="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env | tail -1)"
  P="$(sed -n 's/^TELEGRAM_WEBHOOK_SECRET_PATH=//p' .env | tail -1)"
  S="$(sed -n 's/^TELEGRAM_WEBHOOK_SECRET_TOKEN=//p' .env | tail -1)"

  curl -sS "https://api.telegram.org/bot${BOT}/setWebhook" \
    --data-urlencode "url=https://app.example.com/telegram/webhook/${P}" \
    --data-urlencode "secret_token=${S}" \
    --data-urlencode 'allowed_updates=["message","edited_message","callback_query","my_chat_member"]'

  unset BOT P S
  ```
  > فهرست `allowed_updates` دقیقاً همان چیزی است که `packages/telegram` می‌فهمد. هر چیز دیگری
  > در ورود دور ریخته می‌شود، پس مشترک نشدنش یک رفت‌وبرگشت کمتر است.

- [ ] بررسی کنید:
  ```bash
  BOT="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env | tail -1)"
  curl -sS "https://api.telegram.org/bot${BOT}/getWebhookInfo"
  unset BOT
  ```
  چه چیزی را نگاه کنید:

  | فیلد | مقدار سالم |
  |---|---|
  | `url` | باید دقیقاً دامنهٔ تولید شما باشد |
  | `pending_update_count` | `0` یا عددی که دارد کم می‌شود |
  | `last_error_message` | نباید وجود داشته باشد |
  | `has_custom_certificate` | `false` |

  > ⚠️ **این دقیقاً همان چیزی است که روی این ماشین توسعه غلط پیدا شد:** وب‌هوک به تونل قدیمی
  > اشاره می‌کرد، `last_error_message: "Wrong response from the webhook: 530"` و ۷ به‌روزرسانی
  > معلق. اگر چنین چیزی دیدید، `setWebhook` را دوباره اجرا کنید.

- [ ] **بازیابی از وب‌هوک کهنه:** فقط `setWebhook` را با آدرس درست دوباره بزنید. به‌روزرسانی‌های
      معلق تلگرام (تا ۲۴ ساعت) تحویل داده می‌شوند.
- [ ] **حذف وب‌هوک** (فقط اگر واقعاً می‌خواهید ربات کر شود):
  ```bash
  curl -sS "https://api.telegram.org/bot${BOT}/deleteWebhook" \
    --data-urlencode 'drop_pending_updates=false'
  ```
- [ ] ⛔ `make webhook` را روی سرور اجرا نکنید — آن دستور به فایل `.dev/state/tunnel-api.url` نگاه
      می‌کند و در تولید وجود ندارد؛ با پیام خطا متوقف می‌شود.
- [ ] **بازگشت به نسخهٔ قبلی API:** وب‌هوک نیازی به تغییر ندارد. آدرس ثابت است؛ فقط سرویس را به
      نسخهٔ قبلی برگردانید (بخش ۱۹).

---

## ۱۵. کانال تلگرام

*این بخش فقط اگر انتشار در کانال می‌خواهید.* اگر نه، `TELEGRAM_CHANNEL_ID` را خالی بگذارید و رد شوید.

- [ ] کانال بسازید یا انتخاب کنید.
- [ ] ربات را **مدیر** کانال کنید با این دسترسی‌ها:
  - [ ] `Post Messages` — الزامی
  - [ ] `Delete Messages` — الزامی برای takedown هنگام لغو یا پنهان شدن فعالیت
- [ ] شناسه را در `TELEGRAM_CHANNEL_ID` بگذارید:
  - کانال عمومی: `@channelname`
  - کانال خصوصی: `-100…` (عدد کامل با پیشوند `-100`)
- [ ] کلید `channel.enabled` در `app_setting` را از پنل مدیریت (صفحهٔ تنظیمات، گروه «کانال تلگرام»)
      بررسی کنید. مقدار `1` یعنی روشن.
- [ ] آزمون: یک فعالیت را VIP یا نردبان کنید و لاگ Worker را ببینید:
  ```bash
  journalctl -u payetam-worker -f | grep -i channel
  ```
- [ ] اگر شکست خورد، `apps/worker/src/queues/processors.service.ts` پیام راهنما می‌دهد:
      *«Check that TELEGRAM_CHANNEL_ID is set and the bot is an administrator of that channel.»*
- [ ] **بازگشت امن:** `channel.enabled` را از تنظیمات روی `0` بگذارید. بقیهٔ محصول دست‌نخورده
      کار می‌کند.

---

## ۱۶. چک‌لیست امنیت

| # | مورد | سطح | چطور |
|---|---|---|---|
| ۱ | ورود SSH فقط با کلید | **الزامی** | بخش ۵.۱ |
| ۲ | ورود root مستقیم بسته | **الزامی** | `PermitRootLogin no` |
| ۳ | فایروال فقط ۲۲/۸۰/۴۴۳ | **الزامی** | `ufw status verbose` |
| ۴ | Postgres و Redis فقط روی loopback | **الزامی** | `sudo ss -ltnp` |
| ۵ | HTTPS روی هر دو دامنه | **الزامی** | certbot |
| ۶ | تمدید خودکار گواهی | **الزامی** | `certbot renew --dry-run` |
| ۷ | `.env` با `chmod 600` | **الزامی** | `ls -l .env` |
| ۸ | رمز Postgres عوض شده | **الزامی** | ⛔ `CHANGE_ME_LOCAL_ONLY` نماند |
| ۹ | `ALLOW_PROD_SEED=0` | **الزامی** | وگرنه API بالا نمی‌آید |
| ۱۰ | `TEST_DATABASE_URL` در تولید نیست | **الزامی** | جلوی TRUNCATE تولید را می‌گیرد |
| ۱۱ | کوکی مدیر: `HttpOnly`+`Secure`+`Lax` | **الزامی** | ✅ در کد سخت‌کد شده |
| ۱۲ | CSRF روی هر تغییر | **الزامی** | ✅ در کد؛ با بخش ۱۲.۲ آزمون کنید |
| ۱۳ | RBAC در لایهٔ سرویس | **الزامی** | ✅ ۳۵ عملیات در ماتریس |
| ۱۴ | سقف تعداد درخواست | **الزامی** | ✅ در کد. کد هدیه ۱۰/ساعت |
| ۱۵ | محدودسازی شبکه روی پنل (R9) | **الزامی** | بخش ۸.۵ |
| ۱۶ | `/metrics` از بیرون بسته | **الزامی** | ✅ کنترلر ۴۰۴ می‌دهد + پراکسی نشده |
| ۱۷ | توکن ربات فقط در `.env` | **الزامی** | ⛔ در git، چت یا issue نه |
| ۱۸ | پاک‌سازی لاگ‌ها | **الزامی** | ✅ pino با allowlist redaction (T2.7) |
| ۱۹ | رمزنگاری پشتیبان | **الزامی پیش از کاربر واقعی** | بخش ۱۷ — `T7.1` هنوز ⏳ |
| ۲۰ | پشتیبان خارج از سرور | **الزامی پیش از کاربر واقعی** | بخش ۱۷ |
| ۲۱ | حساب مدیر دوم | **الزامی پیش از کاربر واقعی** | بخش ۱۲.۳ |
| ۲۲ | مالک برای R1–R10 | **الزامی پیش از کاربر واقعی** | `docs/threat-model.md` §۴ |
| ۲۳ | بررسی حقوقی ۷ پرسش | **الزامی پیش از کاربر واقعی** | `docs/threat-model.md` §۵ |
| ۲۴ | به‌روزرسانی امنیتی خودکار | توصیه‌شده | `unattended-upgrades` |
| ۲۵ | به‌روزرسانی image داکر | توصیه‌شده | `docker compose pull && up -d` |
| ۲۶ | مانیتورینگ فعالیت مشکوک | توصیه‌شده | بخش ۱۸ |
| ۲۷ | حداقل دسترسی برای کارمندان | توصیه‌شده | `ANALYST` یا `SUPPORT` بدهید، نه `SUPER_ADMIN` |
| ۲۸ | اسکن اسرار در CI | اختیاری | `T7.3` ⏳ |
| ۲۹ | CDN یا WAF | اختیاری | `T6.6` — در MVP نیست |
| ۳۰ | Sentry | اختیاری | در کد نیست |

---

## ۱۷. پشتیبان‌گیری و بازیابی

### ۱۷.۱ چه چیزی باید پشتیبان‌گیری شود

| مورد | ضروری؟ | چطور |
|---|---|---|
| پایگاه دادهٔ PostgreSQL | ✅ **حیاتی** | `tools/backup.sh` |
| فایل `.env` | ✅ **حیاتی** | ⚠️ **جداگانه و رمزنگاری‌شده**، در مدیر رمز. بدون `CHAT_ENCRYPTION_KEY` پیام‌ها و ورود مدیران غیرقابل بازیابی‌اند |
| آرشیو WAL | ✅ توصیهٔ قوی | `docs/runbook-backup-restore.md` §«Configuring WAL archiving» |
| Redis | — | لازم نیست. صف‌ها از outbox در Postgres بازسازی می‌شوند (ADR-0005) |
| کد | — | در git است |

### ۱۷.۲ راه‌اندازی پشتیبان‌گیری شبانه

اسکریپت `tools/backup.sh` آماده و تست‌شده است:

- `pg_dump -Fc --compress=9 --no-owner --no-privileges`
- بعد از dump با `pg_restore --list` **می‌خواندش** تا فایل قطع‌شده را همان‌جا بگیرد
- اگر حجم فایل غیرمنطقی کوچک بود، چرخش نسخه‌های قدیمی را انجام نمی‌دهد
- `set -o pipefail` دارد — دقیقاً برای اینکه `pg_dump | gzip` موفقِ دروغین ندهد

- [ ] یک cron شبانه بسازید. `NEEDS DECISION` — ساعت اجرا؛ پیش‌فرض ۰۲:۰۰ تهران = ۲۲:۳۰ UTC:
  ```bash
  sudo crontab -e
  ```
  ```cron
  30 22 * * * cd /srv/payetam && \
    DATABASE_URL="postgresql://payetam:<PW>@127.0.0.1:55432/payetam" \
    PAYETAM_BACKUP_DIR=/var/backups/payetam \
    PAYETAM_BACKUP_RETAIN_DAYS=14 \
    bash tools/backup.sh >> /var/log/payetam-backup.log 2>&1
  ```
  > ⚠️ رمز در crontab یعنی رمز روی دیسک. بهتر: در یک فایل با `chmod 600` بگذارید و
  > `set -a; . /etc/payetam-backup.env; set +a` کنید.

- [ ] رمزنگاری پیش از انتقال — `T7.1` هنوز ⏳ است، پس **خودتان باید انجام دهید**:
  ```bash
  gpg --symmetric --cipher-algo AES256 /var/backups/payetam/<file>.dump
  ```
- [ ] انتقال خارج از سرور — `NEEDS DECISION`:
  ```bash
  rsync -a /var/backups/payetam/*.dump.gpg <BACKUP_HOST>:/backups/payetam/
  ```
- [ ] نگه‌داری: پیش‌فرض ۱۴ روز روی سرور. خارج از سرور ۳۰ تا ۹۰ روز — `NEEDS DECISION`.
- [ ] دسترسی: فقط کاربر استقرار و مقصد پشتیبان. ⛔ **هرگز در فضای عمومی وب.**

### ۱۷.۳ آرشیو WAL

`docs/runbook-backup-restore.md` پیکربندی کامل را دارد. خلاصه:

```conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f'
archive_timeout = 300
```

- [ ] ⚠️ **آرشیو نباید روی دیسک همان پایگاه داده بماند.** با همان زمان‌بندی dump، آن را هم
      خارج از سرور `rsync` کنید.

### ۱۷.۴ رویهٔ بازیابی — ساده

اگر همه‌چیز از دست رفت:

1. [ ] سرور تازه بسازید و بخش‌های ۵ تا ۷ را اجرا کنید.
2. [ ] `.env` را از مدیر رمز بازیابی کنید. ⚠️ **`CHAT_ENCRYPTION_KEY` باید دقیقاً همان قبلی باشد.**
3. [ ] Postgres را بالا بیاورید (خالی).
4. [ ] آخرین dump را برگردانید:
   ```bash
   docker cp <file>.dump payetam-postgres:/tmp/restore.dump
   docker compose exec -T postgres pg_restore \
     --dbname="postgresql://payetam:<PW>@localhost:5432/payetam" \
     --clean --if-exists --no-owner --no-privileges -j 4 /tmp/restore.dump
   ```
5. [ ] بررسی صحت:
   ```bash
   docker compose exec -T postgres psql -U payetam -d payetam -tAc \
     "select (select count(*) from \"user\") users, (select count(*) from event) events,
             (select count(*) from coin_ledger) ledger;"
   ```
6. [ ] سرویس‌ها را بالا بیاورید و `/ready` را بررسی کنید.
7. [ ] **تطبیق دفتر سکه** را از پنل اجرا کنید (صفحهٔ دفتر سکه ⇒ «تطبیق موجودی‌ها با دفتر»).
      انتظار: صفر مغایرت.
8. [ ] وب‌هوک را دوباره ثبت کنید (بخش ۱۴).

### ۱۷.۵ تمرین بازیابی

- [ ] یک بار **پیش از باز کردن به کاربران واقعی** تمرین کنید و **زمانش را یادداشت کنید**:
  ```bash
  make restore-rehearsal
  ```
  > ⚠️ `make restore-rehearsal` برای ماشین توسعه نوشته شده (اسکریپت را داخل کانتینر کپی می‌کند).
  > روی تولید، رویهٔ دستی بخش ۱۷.۴ را روی یک **دیتابیس موقت** اجرا کنید، نه روی تولید.
  > `NEEDS VERIFICATION` — عدد ثبت‌شده در runbook ‏(۲ ثانیه برای ۱۴۴ کیلوبایت) در مقیاس توسعه است.

- [ ] ⛔ **پیش از هر مهاجرت، dump تازه بگیرید.** برنامهٔ بازگشت Prisma وجود ندارد.

---

## ۱۸. مانیتورینگ، لاگ و هشدار

### ۱۸.۱ چه چیزی را نگاه کنیم

| مورد | چطور | هشدار لازم است؟ |
|---|---|---|
| سلامت API | `curl https://app.example.com/health` | ✅ **الزامی** |
| آمادگی API | `curl http://127.0.0.1:3000/ready` | ✅ **الزامی** |
| در دسترس بودن پنل | `curl -I https://admin.example.com` | توصیه‌شده |
| زنده بودن Worker | `systemctl is-active payetam-worker` | ✅ **الزامی** |
| عمق صف | `curl -s http://127.0.0.1:3000/metrics \| grep queue_depth` | توصیه‌شده |
| کارهای شکست‌خورده | جدول `job_failure` | توصیه‌شده |
| سلامت Postgres | `docker compose ps` + `/ready` | ✅ **الزامی** |
| سلامت Redis | `/ready` | ✅ **الزامی** |
| فضای دیسک | `df -h` | ✅ **الزامی** |
| حافظه و CPU | `free -h`, `top` | توصیه‌شده |
| انقضای TLS | `certbot certificates` | ✅ **الزامی** |
| خطای وب‌هوک | `getWebhookInfo` ⇒ `last_error_message` | ✅ **الزامی** |
| شکست انتشار کانال | `journalctl -u payetam-worker \| grep channel` | توصیه‌شده |
| سوءاستفاده از کد هدیه | داشبورد پنل ⇒ «تلاش ناموفق ۲۴ ساعت» | توصیه‌شده |
| نشانهٔ تقلب معرفی | پنل ⇒ معرفی دوستان ⇒ «فقط نشانه‌دارها» | توصیه‌شده |
| عبور از سقف درخواست | `payetam_rate_limited_total` + `audit_log` با `ratelimit.exceeded` | توصیه‌شده |
| موفقیت پشتیبان | `/var/log/payetam-backup.log` | ✅ **الزامی** |

### ۱۸.۲ لاگ‌ها

```bash
journalctl -u payetam-api -f              # API
journalctl -u payetam-worker -f           # Worker
docker compose logs -f postgres redis     # پایگاه داده و Redis
sudo tail -f /var/log/nginx/error.log     # nginx
sudo tail -f /var/log/payetam-backup.log  # پشتیبان
```

- [ ] `LOG_LEVEL=info` در تولید. `debug` هم پرحجم است و هم بیشتر از لازم می‌گوید.
- [ ] لاگ‌ها با pino و allowlist پاک‌سازی می‌شوند (T2.7) — شناسهٔ تلگرام و شماره در لاگ نمی‌آید. ✅

### ۱۸.۳ حداقل هشدار پیش از کاربر واقعی

- [ ] یک uptime-checker روی `https://app.example.com/health`، هر ۵ دقیقه، با هشدار ایمیل یا تلگرام.
- [ ] یک cron روزانه که `df -h` و `getWebhookInfo` را بررسی کند و در صورت مشکل خبر دهد.
      `NEEDS DECISION` — نحوهٔ خبر دادن با شماست.

---

## ۱۹. رویهٔ استقرار و به‌روزرسانی

### اولین استقرار

- [ ] ۱. بخش‌های ۳ تا ۸ کامل شده باشند.
- [ ] ۲. `pnpm install --frozen-lockfile`
- [ ] ۳. `pnpm db:generate`
- [ ] ۴. `pnpm build`
- [ ] ۵. `pnpm db:migrate:deploy`
- [ ] ۶. seedهای بخش ۱۱
- [ ] ۷. `sudo systemctl enable --now payetam-api payetam-worker`
- [ ] ۸. `rsync` فایل‌های ثابت (بخش ۸.۱)
- [ ] ۹. `sudo nginx -t && sudo systemctl reload nginx`
- [ ] ۱۰. ثبت وب‌هوک (بخش ۱۴)
- [ ] ۱۱. ساخت حساب مدیر (بخش ۱۲)
- [ ] ۱۲. آزمون‌های پذیرش بخش ۲۰

### به‌روزرسانی بعدی

| گام | دستور | خطرناک؟ |
|---|---|---|
| ۱. تست محلی | `make check` روی **رایانهٔ خودتان** | ✅ امن — ⛔ روی سرور نه |
| ۲. تگ بزنید | `git tag v0.1.1 && git push --tags` | ✅ امن |
| ۳. **پشتیبان بگیرید** | `bash tools/backup.sh` | ✅ امن — **رد نکنید** |
| ۴. کد را بگیرید | `git fetch --tags && git checkout v0.1.1` | ✅ امن |
| ۵. وابستگی‌ها | `pnpm install --frozen-lockfile` | ✅ امن |
| ۶. کلاینت Prisma | `pnpm db:generate` | ✅ امن |
| ۷. build | `pnpm build` | ✅ امن |
| ۸. **مهاجرت** | `pnpm db:migrate:deploy` | ⚠️ **برگشت‌ناپذیر** |
| ۹. راه‌اندازی مجدد | `sudo systemctl restart payetam-api payetam-worker` | ⚠️ چند ثانیه قطعی |
| ۱۰. فایل‌های ثابت | `rsync` (بخش ۸.۱) | ✅ امن |
| ۱۱. بررسی | `/health` و `/ready` | ✅ امن |
| ۱۲. لاگ | `journalctl -u payetam-api -n 100` | ✅ امن |
| ۱۳. وب‌هوک | `getWebhookInfo` | ✅ امن |

- [ ] **کاهش قطعی:** اول Worker را restart کنید و بعد API. کارهای در صف صبر می‌کنند؛ درخواست‌های
      HTTP نه.
- [ ] **بازگشت به عقب:**
  ```bash
  git checkout <PREVIOUS_TAG>
  pnpm install --frozen-lockfile && pnpm db:generate && pnpm build
  sudo systemctl restart payetam-api payetam-worker
  # فایل‌های ثابت را دوباره rsync کنید
  ```
  > ⚠️ **اگر مهاجرت اجرا شده بود، بازگشت کد کافی نیست.** طرح پایگاه داده جلوتر می‌ماند و کد قدیمی
  > ممکن است با آن کار نکند. آن‌وقت باید از پشتیبان گام ۳ بازیابی کنید.

---

## ۲۰. آزمون‌های پذیرش دستی

برای هر مورد: **پیش‌نیاز ⇒ کار ⇒ انتظار ⇒ نتیجهٔ واقعی ⇒ ✅/❌**.
⛔ در «شواهد» هیچ توکن، رمز، کد هدیهٔ زنده یا شناسهٔ تلگرام ننویسید. اسکرین‌شات را سانسور کنید.

### ۲۰.۱ زیرساخت

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 1 | `ssh deploy@<IP>` | ورود با کلید، بدون رمز | ______ | [ ] |
| 2 | `dig +short app.example.com` | IP سرور | ______ | [ ] |
| 3 | `curl -I https://app.example.com` | `200`، گواهی معتبر | ______ | [ ] |
| 4 | `curl -I https://admin.example.com` | `200` (یا `403` اگر IP محدود شده) | ______ | [ ] |
| 5 | `curl -s https://app.example.com/health` | `{"status":"ok",...}` | ______ | [ ] |
| 6 | `curl -s http://127.0.0.1:3000/ready` | `database:"up"`, `redis:"up"` | ______ | [ ] |
| 7 | `curl -I https://app.example.com/metrics` | **نه** خروجی متریک | ______ | [ ] |
| 8 | `docker compose ps` | هر دو `healthy` | ______ | [ ] |
| 9 | `systemctl is-active payetam-api payetam-worker` | هر دو `active` | ______ | [ ] |
| 10 | `sudo ss -ltnp` | فقط ۸۰/۴۴۳ عمومی | ______ | [ ] |
| 11 | مینی‌اپ را در مرورگر باز کنید | صفحه بالا می‌آید (API خطای احراز هویت می‌دهد — طبیعی) | ______ | [ ] |
| 12 | پنل را باز کنید | صفحهٔ ورود فارسی | ______ | [ ] |

### ۲۰.۲ احراز هویت

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 13 | در تلگرام `/start` بزنید | پیام خوشامد | ______ | [ ] |
| 14 | مینی‌اپ را از دکمهٔ منو باز کنید | صفحهٔ قوانین | ______ | [ ] |
| 15 | قوانین را بپذیرید | به پروفایل می‌رود | ______ | [ ] |
| 16 | پروفایل را کامل کنید | ۵۰ سکه در کیف پول | ______ | [ ] |
| 17 | دوباره پروفایل را ذخیره کنید | ⛔ **سکهٔ دوم داده نشود** | ______ | [ ] |
| 18 | ورود مدیر | داشبورد با عددهای واقعی | ______ | [ ] |
| 19 | `F5` در پنل | همچنان وارد، بدون نوار زرد | ______ | [ ] |
| 20 | تغییر بدون هدر CSRF (بخش ۱۲.۲) | `FORBIDDEN` با `reason: csrf` | ______ | [ ] |
| 21 | با حساب `ANALYST` وارد شوید | فقط یک لینک در منو | ______ | [ ] |
| 22 | با `ANALYST` آدرس `/users` را دستی بزنید | صفحهٔ «دسترسی ندارید» با نام مجوز | ______ | [ ] |

### ۲۰.۳ فعالیت‌ها

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 23 | فعالیت تمیز بسازید | منتشر می‌شود | ______ | [ ] |
| 24 | فعالیت با واژهٔ ممنوع بسازید | `CONTENT_BLOCKED` یا صف بررسی | ______ | [ ] |
| 25 | در کشف جست‌وجو کنید | فعالیت دیده می‌شود | ______ | [ ] |
| 26 | با «ي» عربی جست‌وجو کنید | همان نتیجه (ADR-0012) | ______ | [ ] |
| 27 | فیلتر شهر/دسته | نتیجهٔ درست | ______ | [ ] |
| 28 | صفحهٔ فعالیت | امتیاز اعتماد میزبان یا «تازه‌وارد» | ______ | [ ] |

### ۲۰.۴ درخواست شرکت

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 29 | با حساب دوم درخواست بدهید | `PENDING` + گفت‌وگو ساخته می‌شود | ______ | [ ] |
| 30 | صف میزبان | نام و امتیاز اعتماد درخواست‌دهنده | ______ | [ ] |
| 31 | میزبان از دکمهٔ اعلان بپذیرد | پذیرفته شد، ظرفیت +۱ | ______ | [ ] |
| 32 | درخواست دیگری را رد کنید | رد شد، اعلان می‌رسد | ______ | [ ] |
| 33 | بیش از ظرفیت درخواست بدهید | `WAITLISTED` با رتبه | ______ | [ ] |
| 34 | یک نفر لغو کند | نفر بعدی از لیست انتظار ارتقا می‌یابد | ______ | [ ] |

### ۲۰.۵ گفت‌وگو

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 35 | گفت‌وگو از لحظهٔ درخواست هست | بله، پیش از پذیرش | ______ | [ ] |
| 36 | ۵ پیام رد و بدل کنید | همه می‌رسند | ______ | [ ] |
| 37 | عنوان گفت‌وگو | «نام — عنوان فعالیت» | ______ | [ ] |
| 38 | با Reply جواب بدهید | به گفت‌وگوی درست می‌رود | ______ | [ ] |
| 39 | شمارهٔ تماس بفرستید | ⛔ **«حذف شد» جایگزین شود** | ______ | [ ] |
| 40 | `@username` بفرستید | ⛔ **«حذف شد»** | ______ | [ ] |
| 41 | «اشتراک اطلاعات تماس» بزنید | تأیید دو مرحله‌ای می‌خواهد | ______ | [ ] |
| 42 | بعد از تأیید، شماره بفرستید | حالا می‌رسد | ______ | [ ] |
| 43 | متن حریم خصوصی در «گفت‌وگوها» | سه شناسهٔ پنهان + آنچه دیده می‌شود | ______ | [ ] |
| 44 | ربات را بلاک کنید و پیام بفرستید | Worker `BOT_BLOCKED` ثبت می‌کند، خطا نمی‌دهد | ______ | [ ] |

### ۲۰.۶ اقتصاد

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 45 | کیف پول | موجودی + تاریخچه | ______ | [ ] |
| 46 | کد هدیهٔ معتبر | سکه اضافه، یک ردیف دفتر | ______ | [ ] |
| 47 | همان کد را دوباره | `GIFT_CODE_ALREADY_REDEEMED` | ______ | [ ] |
| 48 | کد نامعتبر | `GIFT_CODE_INVALID` | ______ | [ ] |
| 49 | کد منقضی | `GIFT_CODE_EXPIRED` | ______ | [ ] |
| 50 | کد غیرفعال‌شده از پنل | `GIFT_CODE_INVALID` | ______ | [ ] |
| 51 | کدی که ظرفیتش پر شده | `GIFT_CODE_EXHAUSTED` | ______ | [ ] |
| 52 | ۱۱ بار پشت هم کد اشتباه | بار یازدهم `RATE_LIMITED` | ______ | [ ] |
| 53 | کمپین دسته‌ای در پنل بسازید | کدها **یک بار** نمایش داده می‌شوند | ______ | [ ] |
| 54 | فهرست کدها | ⛔ **هیچ کد کاملی دیده نشود** | ______ | [ ] |
| 55 | تحلیل یک کد | دریافت، افراد یکتا، سکه، تلاش ناموفق | ______ | [ ] |
| 56 | کد را از ۵۰ به ۸۰ تغییر دهید | دریافت‌های قدیمی همچنان ۵۰ | ______ | [ ] |
| 57 | کد دعوت بگیرید | ۸ نویسه، بدون `0/O/1/I/L` | ______ | [ ] |
| 58 | با حساب دوم کد را ثبت کنید | `PENDING`، بدون پاداش | ______ | [ ] |
| 59 | حساب دوم در فعالیتی حاضر شود | پاداش ۳۰/۱۰ واریز | ______ | [ ] |
| 60 | حضور را دوباره settle کنید | ⛔ **پاداش دوم نه** | ______ | [ ] |
| 61 | یک معرفی را از پنل رد کنید | «رد شده»، بدون پاداش | ______ | [ ] |
| 62 | معرفی رد شده را برگردانید | `PENDING`، **بدون پرداخت** | ______ | [ ] |

### ۲۰.۷ پنل مدیریت

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 63 | داشبورد | همهٔ عددها + سلامت سبز | ______ | [ ] |
| 64 | جست‌وجوی کاربر با نام | پیدا می‌شود | ______ | [ ] |
| 65 | جست‌وجو با شناسهٔ عمومی | پیدا می‌شود | ______ | [ ] |
| 66 | پروندهٔ کاربر | ⛔ **هیچ شناسهٔ تلگرام یا شماره‌ای نباشد** | ______ | [ ] |
| 67 | کاربری با شماره در «دربارهٔ من» | «حذف شد» + شمارندهٔ پنهان‌سازی | ______ | [ ] |
| 68 | فعالیت را پنهان کنید | از کشف حذف می‌شود، در رخدادها ثبت | ______ | [ ] |
| 69 | فعالیت لغوشده را منتشر کنید | `INVALID_STATE_TRANSITION` | ______ | [ ] |
| 70 | گزارش تخلف را ببندید | بسته، در رخدادها ثبت | ______ | [ ] |
| 71 | همان گزارش را دوباره ببندید | تعارض، تصمیم اول محفوظ | ______ | [ ] |
| 72 | پروندهٔ بررسی را تصمیم بگیرید | گزارش‌های مرتبط هم بسته | ______ | [ ] |
| 73 | جست‌وجوی دفتر سکه | ردیف‌ها + خالص فیلتر | ______ | [ ] |
| 74 | «تطبیق موجودی‌ها با دفتر» | ⛔ **صفر مغایرت** | ______ | [ ] |
| 75 | اصلاح دستی سکه با دلیل | قبل ⇒ بعد، ردیف تازه در دفتر | ______ | [ ] |
| 76 | همان اصلاح را دوباره بفرستید | ⛔ **دو بار اعمال نشود** (کلید یکتا) | ______ | [ ] |
| 77 | گزارش رخدادها با فیلتر `giftcode.` | فقط رخدادهای کد هدیه | ______ | [ ] |
| 78 | جزئیات یک رخداد | قبل/بعد؛ هیچ کد یا رازی نباشد | ______ | [ ] |
| 79 | یک تنظیم را تغییر دهید | «تغییر داده‌شده»، در رخدادها ثبت | ______ | [ ] |
| 80 | با `SUPPORT` صفحهٔ کدهای هدیه | «دسترسی ندارید» | ______ | [ ] |

### ۲۰.۸ تلگرام

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 81 | `getWebhookInfo` | آدرس تولید، بدون خطا، معلق ۰ | ______ | [ ] |
| 82 | دکمهٔ منو | مینی‌اپ باز می‌شود | ______ | [ ] |
| 83 | اعلان درخواست تازه | می‌رسد، ظرف چند ثانیه | ______ | [ ] |
| 84 | دکمهٔ پذیرش در اعلان | کار می‌کند | ______ | [ ] |
| 85 | انتشار کانال (اگر فعال) | پست با لینک درست ربات | ______ | [ ] |
| 86 | لغو فعالیت VIP | پست کانال حذف می‌شود | ______ | [ ] |

### ۲۰.۹ گیت حریم خصوصی B4 — دستی

`docs/b4-privacy-gate.md` §۵ رویهٔ کامل را دارد. خلاصه:

| # | کار | انتظار | نتیجه | ✅ |
|---|---|---|---|---|
| 87 | با دو گوشی واقعی ۵ پیام رد و بدل کنید | همه می‌رسند | ______ | [ ] |
| 88 | منوی هر پیام را باز کنید | ⛔ **«Forwarded from» نباشد** | ______ | [ ] |
| 89 | روی نام فرستنده در سربرگ بزنید | ⛔ **به پروفایل نرود** | ______ | [ ] |
| 90 | لینکی بفرستید | ⛔ **پیش‌نمایش لینک باز نشود** | ______ | [ ] |
| 91 | با «text_mention» نام کسی را ذکر کنید | همهٔ entityها حذف شده | ______ | [ ] |
| 92 | لاگ Worker را grep کنید | ⛔ **هیچ شناسهٔ تلگرام، شماره یا `@username`** | ______ | [ ] |

---

## ۲۱. ماتریس آمادگی تولید

| مورد | وضعیت | لازم پیش از استقرار؟ | چطور بررسی شود | شواهد | مالک | یادداشت |
|---|---|---|---|---|---|---|
| کد برنامه | `DONE` | ✅ | `make check` | ۱۸۹۷ تست سبز | — | ✅ تأییدشده |
| نوع‌ها، لینت، قالب | `DONE` | ✅ | `pnpm typecheck && pnpm lint && pnpm format:check` | همه exit 0 | — | ✅ |
| build تولید | `DONE` | ✅ | `pnpm build` | exit 0، هر ۴ خروجی | — | ✅ |
| مهاجرت‌ها | `DONE` | ✅ | `_prisma_migrations` | ۱۸ مهاجرت (۰۰۱۰ عمداً نیست) | — | ✅ |
| اجرای محلی | `DONE` | — | `make dev` + `/ready` | همه سبز | — | ✅ |
| گیت حریم خصوصی (خودکار) | `DONE` | ✅ | `privacy-gate.int.test.ts` | ۲۰ ادعا سبز | — | ✅ |
| گیت حریم خصوصی (زنده) | `BLOCKED` | ✅ **پیش از کاربر واقعی** | `b4-privacy-gate.md` §۵ | ______ | `NEEDS DECISION` | دو حساب واقعی لازم است |
| Dockerfile برای API/Worker | `NOT REQUIRED` | — | — | — | — | systemd جایگزین است |
| Compose تولید | `NEEDS DECISION` | ✅ | `docker compose config` | ______ | ______ | فقط override رمز و لاگ |
| پیکربندی nginx | `BLOCKED` | ✅ | `sudo nginx -t` | ______ | ______ | **وجود ندارد — بخش ۸** |
| گواهی TLS | `BLOCKED` | ✅ | `certbot certificates` | ______ | ______ | نیازمند دامنه |
| دامنه و DNS | `BLOCKED` | ✅ | `dig +short` | ______ | ______ | `NEEDS DECISION` |
| متغیرهای محیطی تولید | `BLOCKED` | ✅ | API بالا می‌آید | ______ | ______ | `NEEDS SECRET` × ۷ |
| رمز Postgres | `BLOCKED` | ✅ | ورود موفق | ______ | ______ | ⛔ `CHANGE_ME_LOCAL_ONLY` |
| فایروال | `READY TO VERIFY` | ✅ | `ufw status` | ______ | ______ | بخش ۵.۲ |
| سخت‌سازی SSH | `READY TO VERIFY` | ✅ | ورود تازه | ______ | ______ | بخش ۵.۱ |
| نشست و CSRF | `DONE` | ✅ | آزمون ۲۰ | تست‌شده لوکال | — | ✅ روی HTTPS واقعی تکرار شود |
| RBAC | `DONE` | ✅ | ماتریس RBAC | ۳۵ عملیات | — | ✅ |
| حساب مدیر اول | `BLOCKED` | ✅ | ورود موفق | ______ | ______ | بخش ۱۲ |
| حساب مدیر دوم | `BLOCKED` | ✅ **پیش از کاربر واقعی** | ورود موفق | ______ | ______ | ریسک گم شدن TOTP |
| محدودسازی شبکهٔ پنل (R9) | `BLOCKED` | ✅ **پیش از کاربر واقعی** | `curl` از IP خارجی | ______ | ______ | بخش ۸.۵ |
| ربات و توکن | `BLOCKED` | ✅ | `getMe` | ______ | ______ | `NEEDS SECRET` |
| وب‌هوک تولید | `BLOCKED` | ✅ | `getWebhookInfo` | ______ | ______ | نیازمند دامنه |
| Mini App در BotFather | `BLOCKED` | ✅ | باز شدن از منو | ______ | ______ | نیازمند دامنه |
| کانال تلگرام | `NEEDS DECISION` | — | آزمون ۸۵ | ______ | ______ | اختیاری |
| seed داده‌های پایه | `READY TO VERIFY` | ✅ | شمارش جدول‌ها | ______ | ______ | بخش ۱۱ |
| پشتیبان‌گیری شبانه | `BLOCKED` | ✅ **پیش از کاربر واقعی** | `/var/log/payetam-backup.log` | ______ | ______ | cron لازم است |
| رمزنگاری پشتیبان | `BLOCKED` | ✅ **پیش از کاربر واقعی** | فایل `.gpg` | ______ | ______ | `T7.1` ⏳ |
| پشتیبان خارج از سرور | `BLOCKED` | ✅ **پیش از کاربر واقعی** | فهرست مقصد | ______ | ______ | `NEEDS DECISION` |
| آرشیو WAL | `RECOMMENDED` | — | فایل‌های آرشیو | ______ | ______ | runbook §WAL |
| تمرین بازیابی | `BLOCKED` | ✅ **پیش از کاربر واقعی** | زمان ثبت‌شده | ______ | ______ | مقیاس تولید |
| برنامهٔ بازگشت | `READY TO VERIFY` | ✅ | یک بار تمرین | ______ | ______ | بخش ۱۹ |
| مانیتورینگ سلامت | `BLOCKED` | ✅ **پیش از کاربر واقعی** | هشدار آزمایشی | ______ | ______ | بخش ۱۸.۳ |
| هشدار فضای دیسک | `RECOMMENDED` | — | `df -h` | ______ | ______ | — |
| متریک | `DONE` | — | `curl` لوکال | ✅ ۴۰۴ از بیرون | — | ✅ |
| رهگیری خطا (Sentry) | `NOT REQUIRED` | — | — | — | — | در کد نیست |
| مالک برای R1–R10 | `BLOCKED` | ✅ **پیش از کاربر واقعی** | `threat-model.md` §۴ | ______ | `NEEDS DECISION` | قدیمی‌ترین مورد باز |
| بررسی حقوقی (۷ پرسش) | `BLOCKED` | ✅ **پیش از کاربر واقعی** | `threat-model.md` §۵ | ______ | `NEEDS DECISION` | مهندسی نیست |
| سخت‌سازی آپلود (`T5.4`) | `NOT REQUIRED` | — | — | — | — | مسیر آپلودی فعال نیست |
| CDN/WAF (`T6.6`) | `NOT REQUIRED` | — | — | — | — | خارج از MVP |
| اسکن اسرار CI (`T7.3`) | `RECOMMENDED` | — | لاگ CI | ______ | ______ | — |
| افراز `chat_message` | `NOT REQUIRED` | — | — | — | — | بعد از آزمایش |

---

## ۲۲. تصمیم نهایی

```text
Local run readiness:                READY
Initial production trial readiness: NOT READY
Telegram testing readiness:         NOT READY
Production readiness:               NOT READY
```

### `Local run readiness: READY`

`make dev` کل استک را بالا می‌آورد؛ `/health` و `/ready` سبزند؛ مینی‌اپ روی ۵۱۷۳ و پنل روی ۵۱۷۴
پاسخ می‌دهند؛ ۱۸۹۷ تست سبز است. **این تنها موردی است که همین حالا آماده است.**

### `Initial production trial readiness: NOT READY`

بلاکرها — همه **زیرساخت و پیکربندی‌اند، نه کد**:

1. **هیچ پیکربندی nginx در مخزن نیست.** ⇒ بخش ۸ را اجرا کنید.
2. **هیچ Dockerfile یا Compose تولید نیست.** ⇒ بخش ۷.۴ (systemd) یا خودتان image بسازید.
3. **سرور، دامنه و DNS تهیه نشده.** ⇒ بخش‌های ۳ تا ۵.
4. **`.env` تولید ساخته نشده** و ۷ راز باید تولید شود. ⇒ بخش ۶.
5. **رمز Postgres هنوز `CHANGE_ME_LOCAL_ONLY` است.** ⇒ بخش ۷.۲.
6. **گواهی TLS گرفته نشده.** ⇒ بخش ۸.۴.
7. **هیچ حساب مدیری وجود ندارد.** ⇒ بخش ۱۲.

### `Telegram testing readiness: NOT READY`

1. **وب‌هوک تولید ثبت نشده** — نیازمند دامنه و TLS. ⇒ بخش ۱۴.
2. **آدرس Mini App در BotFather تنظیم نشده.** ⇒ بخش ۱۳.
3. **`TELEGRAM_BOT_USERNAME` باید پر شود**، وگرنه لینک‌های عمیق به ربات اشتباه می‌روند.
4. ⚠️ در محیط توسعهٔ فعلی، وب‌هوک به یک **تونل کهنه** اشاره می‌کند
   (`last_error_message: "Wrong response from the webhook: 530"`، ۷ به‌روزرسانی معلق). این ربطی به
   تولید ندارد ولی نشان می‌دهد چرا آزمون ۸۱ در فهرست است.

### `Production readiness: NOT READY`

علاوه بر همهٔ موارد بالا:

1. **محدودسازی شبکه روی پنل مدیریت (R9).** ⇒ بخش ۸.۵.
2. **حساب مدیر دوم** برای وقتی TOTP گم شود. ⇒ بخش ۱۲.۳.
3. **پشتیبان‌گیری شبانه + رمزنگاری + انتقال خارج از سرور.** ⇒ بخش ۱۷.
4. **تمرین بازیابی در مقیاس واقعی**، با زمان ثبت‌شده. ⇒ بخش ۱۷.۵.
5. **مانیتورینگ و هشدار.** ⇒ بخش ۱۸.۳.
6. **مالک برای R1 تا R10.** ⇒ `docs/threat-model.md` §۴.
7. **پاسخ به ۷ پرسش حقوقی.** ⇒ `docs/threat-model.md` §۵ — مهندسی نیست.
8. **ضبط زندهٔ حریم خصوصی از دو حساب واقعی.** ⇒ `docs/b4-privacy-gate.md` §۵.
9. **آزمون‌های پذیرش بخش ۲۰** روی خود سرور تولید.

### تفکیک آمادگی — چون «تست‌ها سبزند» به معنی «آمادهٔ تولید» نیست

| بُعد | وضعیت | توضیح |
|---|---|---|
| آمادگی کد | ✅ **آماده** | ۱۸۹۷ تست، هر دو بلاکر M19 بسته |
| آمادگی زیرساخت | ⛔ **آماده نیست** | سرور، nginx، TLS، systemd — هیچ‌کدام وجود ندارد |
| آمادگی پیکربندی | ⛔ **آماده نیست** | `.env` تولید و رازها ساخته نشده |
| آمادگی امنیت | ⛔ **آماده نیست** | R9، پشتیبان رمزنگاری‌شده، مالک ریسک‌ها |
| آمادگی عملیاتی | ⛔ **آماده نیست** | پشتیبان، مانیتورینگ، تمرین بازیابی |
| آمادگی پذیرش دستی | ⛔ **انجام نشده** | ۹۲ آزمون بخش ۲۰ |

> **خلاصهٔ صادقانه:** کد این محصول آمادهٔ یک آزمایش واقعی است. آنچه نیست، *بسته‌بندی استقرار* آن
> است — و آن، یک بار کار دستی است که بخش‌های ۵ تا ۸ همین فایل قدم‌به‌قدم توضیح می‌دهند.
> هیچ‌کدام از این بلاکرها نیازمند نوشتن کد برنامه نیست.

---

## ۲۳. یادداشت پایانی

- این فایل **commit نشده** و نباید بشود. با `git status --short` به‌صورت `??` دیده می‌شود.
- هیچ رمز، توکن، کلید یا مقدار واقعی در آن نیست و نباید اضافه شود.
- هر دستور از خود مخزن استخراج شده. هر جا مطمئن نبودم با `NEEDS DECISION`،
  `NEEDS SECRET` یا `NEEDS VERIFICATION` علامت زده‌ام.
- برای جزئیات بیشتر: `README.md`، `docs/admin-panel.md`، `docs/b4-privacy-gate.md`،
  `docs/runbook-backup-restore.md`، `docs/threat-model.md`، `docs/launch-readiness.md`.
