<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { PERMISSIONS } from '@payetam/shared';
import type { EconomyMetricView, EconomyReportResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatNumber, toPersianDigits } from '@/format/fa';
import { ledgerTypeLabel } from '@/format/ledger';
import { useSessionStore } from '@/stores/session';

/**
 * Is the coin economy a sink or a spring? (docs/coin-economy-plan.md §12)
 *
 * ── Why this page exists ────────────────────────────────────────────────────
 *
 * The plan lists seven numbers to look at every month and the product could
 * produce none of them. Every one is a query somebody would have had to write by
 * hand against production, which in practice means nobody ever looked — and the
 * fault the whole rebalance was built to fix (joining cost five, reviewing paid
 * ten, so every attendance made a user richer) had been live for months without
 * anything on any screen saying so.
 *
 * ── Why each card carries its own target and advice ─────────────────────────
 *
 * Because four of these seven are **not** "higher is better", and two of them are
 * two-sided. «میانهٔ روز تا اولین خرید» being low is bad. «نرخ نشت» being high is
 * bad. A dashboard of bare percentages would need the reader to hold the plan in
 * their head, and a number nobody can interpret is a number nobody acts on.
 *
 * The thresholds are decided in the service and arrive as a status and a sentence
 * — deliberately, so the screen cannot disagree with the report about what
 * "good" means, and so a threshold is changed in one place with a commit behind
 * it rather than by whoever edits a Vue file.
 *
 * ── Read-only ───────────────────────────────────────────────────────────────
 *
 * There is no control on this page and there should not be. Every lever that
 * could move any of these numbers is a row in `app_setting` with a screen, a
 * reason field and an audit trail already attached to it, and the cards link
 * there for sessions that hold `settings.manage`.
 */
const session = useSessionStore();

const report = ref<EconomyReportResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (report.value === null) return 'loading' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    report.value = await request<EconomyReportResponse>('/economy');
  } catch (cause) {
    error.value = messageOf(cause, 'گزارش اقتصاد بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

const STATUS_LABELS: Record<string, string> = {
  good: 'سالم',
  warn: 'مراقب باش',
  bad: 'خارج از هدف',
  unknown: 'داده کافی نیست',
};

/**
 * The card's colours, by status.
 *
 * `unknown` is deliberately neutral rather than green: an empty database has a
 * leak rate of *unanswerable*, not of zero, and a page that painted "no data" the
 * same colour as "healthy" would report perfect health on no evidence.
 */
const STATUS_CLASSES: Record<string, string> = {
  good: 'border-good/40 bg-good-soft/30',
  warn: 'border-warn/40 bg-warn-soft/30',
  bad: 'border-danger/40 bg-danger-soft/30',
  unknown: 'border-line bg-surface',
};

const STATUS_PILL_CLASSES: Record<string, string> = {
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-danger-soft text-danger',
  unknown: 'bg-neutral-soft text-ink-soft',
};

/**
 * One decimal for anything fractional; whole numbers stay whole.
 *
 * `toFixed` always produces the decimal — «۳۰٫۰ روز» — so the trailing zero is
 * trimmed after rounding rather than before. And the separator is `٫` (U+066B),
 * not a full stop: `toPersianDigits` converts digits and leaves punctuation, so a
 * Persian number with a Latin point in the middle of it is what you get if
 * nobody does this, the same way `formatNumber` swaps the thousands comma.
 */
function formatDecimal(value: number, places: number): string {
  const rounded = value.toFixed(places).replace(/\.0+$/, '');
  return toPersianDigits(rounded).replace('.', '٫');
}

function metricValue(metric: EconomyMetricView): string {
  if (metric.value === null) return '—';
  switch (metric.kind) {
    case 'ratio':
      return `${toPersianDigits(Math.round(metric.value * 100))}٪`;
    case 'days':
      return `${formatDecimal(metric.value, 1)} روز`;
    case 'perDay':
      return `${formatDecimal(metric.value, 1)} در روز`;
    case 'coins':
      return `${formatNumber(metric.value)} سکه`;
    default:
      return formatNumber(metric.value);
  }
}

/**
 * How many rows the number was computed from.
 *
 * On the card rather than hidden, because a 100% conversion rate from three
 * eligible users and one from three thousand are the same figure and completely
 * different facts. The early months of this product will produce a great many of
 * the first kind.
 */
function metricSample(metric: EconomyMetricView): string {
  if (metric.key === 'top_earner') return '';
  return `از ${formatNumber(metric.sample)} داده`;
}

/** The governing metric, pulled out because the plan says it overrides the rest. */
const fillRate = computed(
  () => report.value?.metrics.find((metric) => metric.key === 'fill_rate') ?? null,
);

const supplyRows = computed(() => {
  const supply = report.value?.supply;
  if (supply === undefined) return [];
  return [
    { label: 'موجودی کاربران، همین حالا', value: supply.held, hint: 'مجموع همهٔ کیف‌پول‌ها' },
    { label: 'سکهٔ رایگانِ داده‌شده', value: supply.grantedFree, hint: 'هدیه، پاداش، کد هدیه' },
    { label: 'سکهٔ فروخته‌شده', value: supply.purchased, hint: 'تعدیل ادمین با دلیل «sale:»' },
    { label: 'سکهٔ سوخته (خالص)', value: supply.burned, hint: 'خرج، منهای بازگشت‌ها' },
    { label: 'بازگشت‌ها', value: supply.refunded, hint: 'سپرده، لغو میزبان، برگشت تراکنش' },
  ];
});

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
      <p>
        هفت معیاری که باید ماهانه ببینید، روی داده‌های زنده. هر کارت می‌گوید عدد چیست، هدفش چقدر
        است، و اگر بیرون از هدف بود چه کاری درست است.
      </p>
      <p v-if="report" class="mt-2 text-ink-soft">
        پنجرهٔ محاسبه: <bdi>{{ toPersianDigits(report.windowDays) }}</bdi> روز گذشته. «میانهٔ روز تا
        اولین خرید» و «تبدیل ۳ رویداد به خرید» از کل تاریخ حساب می‌شوند، نه از این پنجره.
      </p>
    </section>

    <StateBlock :state="state" :error-text="error" :rows="6" @retry="load">
      <div v-if="report" class="flex flex-col gap-5">
        <!--
          The governing rule, above everything else and only when it is being
          broken. The plan is explicit that below 60% fill no revenue optimisation
          is allowed at all, and a warning that sat in a card among six others
          would be read as one opinion among six.
        -->
        <section
          v-if="fillRate && (fillRate.status === 'bad' || fillRate.status === 'warn')"
          class="rounded-xl border border-danger/40 bg-danger-soft/30 p-4 text-sm leading-relaxed"
          role="alert"
        >
          <h2 class="font-bold">نرخ پرشدن زیر هدف است — بهینه‌سازی درآمد را متوقف کنید</h2>
          <p class="mt-2">
            تا وقتی فعالیت‌ها پر نمی‌شوند، مسئله قیمت نیست؛ کمبود عرضه است. هر سکه‌ای که در این
            وضعیت از بازار بگیرید، از نقدینگی همان بازار گرفته‌اید. کاری که درست است: هزینهٔ درخواست
            شرکت را موقتاً پایین بیاورید و همهٔ انرژی را روی ساختن فعالیت بگذارید.
          </p>
        </section>

        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <article
            v-for="metric in report.metrics"
            :key="metric.key"
            class="flex flex-col rounded-xl border p-4"
            :class="STATUS_CLASSES[metric.status]"
          >
            <header class="flex items-start justify-between gap-2">
              <h2 class="text-sm font-semibold">{{ metric.label }}</h2>
              <span
                class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                :class="STATUS_PILL_CLASSES[metric.status]"
              >
                {{ STATUS_LABELS[metric.status] }}
              </span>
            </header>

            <p class="mt-3 text-3xl font-bold tabular-nums">
              <bdi>{{ metricValue(metric) }}</bdi>
            </p>
            <p class="mt-1 text-xs text-ink-faint">
              هدف: {{ metric.target }}
              <span v-if="metricSample(metric)"> · {{ metricSample(metric) }}</span>
            </p>

            <p class="mt-3 text-xs leading-relaxed text-ink-soft">{{ metric.meaning }}</p>

            <!--
              Only when it is not healthy. Advice under a green number is noise,
              and noise under six green numbers is what teaches somebody to stop
              reading the page.
            -->
            <p
              v-if="metric.status !== 'good'"
              class="mt-3 border-t border-line pt-3 text-xs leading-relaxed"
            >
              <span class="font-semibold">چه کار کنم: </span>{{ metric.advice }}
            </p>
          </article>
        </div>

        <div class="grid gap-5 lg:grid-cols-2">
          <section class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">درآمد فروش سکه</h2>
            <p class="mt-1 text-xs text-ink-faint">
              فروش یعنی تعدیل ادمینی که دلیلش با «sale:» شروع می‌شود. هدیه و جبران خسارت هرگز نباید
              این پیشوند را بگیرند، وگرنه این عدد دروغ می‌گوید.
            </p>
            <dl class="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div class="rounded-lg bg-surface-sunken p-3">
                <dt class="text-xs text-ink-faint">سکهٔ فروخته‌شده</dt>
                <dd class="mt-1 font-bold tabular-nums">
                  <bdi>{{ formatNumber(report.revenue.coinsSold) }}</bdi>
                </dd>
              </div>
              <div class="rounded-lg bg-surface-sunken p-3">
                <dt class="text-xs text-ink-faint">تعداد تراکنش</dt>
                <dd class="mt-1 font-bold tabular-nums">
                  <bdi>{{ formatNumber(report.revenue.transactions) }}</bdi>
                </dd>
              </div>
              <div class="col-span-2 rounded-lg bg-surface-sunken p-3">
                <dt class="text-xs text-ink-faint">
                  معادل تومانی، با قیمت مرجع
                  <bdi>{{ formatNumber(report.revenue.referencePrice) }}</bdi> تومان
                </dt>
                <dd class="mt-1 text-xl font-bold tabular-nums">
                  <bdi>{{ formatNumber(report.revenue.toman) }}</bdi>
                  <span class="ms-1 text-sm font-normal text-ink-soft">تومان</span>
                </dd>
              </div>
            </dl>
            <p class="mt-3 text-xs text-ink-faint">
              نرخ تبدیل در لحظهٔ خواندن اعمال می‌شود؛ تغییر قیمت مرجع، تاریخِ همین صفحه را هم
              بازقیمت‌گذاری می‌کند.
            </p>
          </section>

          <section class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">سکه کجاست</h2>
            <table class="mt-3 w-full text-sm">
              <tbody>
                <tr
                  v-for="row in supplyRows"
                  :key="row.label"
                  class="border-b border-line last:border-0"
                >
                  <td class="py-2">
                    <span>{{ row.label }}</span>
                    <p class="text-xs text-ink-faint">{{ row.hint }}</p>
                  </td>
                  <td class="py-2 text-end font-bold tabular-nums">
                    <bdi>{{ formatNumber(row.value) }}</bdi>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <div class="grid gap-5 lg:grid-cols-2">
          <section class="overflow-x-auto rounded-xl border border-line bg-surface">
            <h2 class="border-b border-line px-4 py-3 text-sm font-semibold">
              سکه از کجا آمد ({{ toPersianDigits(report.windowDays) }} روز)
            </h2>
            <table class="w-full text-sm">
              <tbody>
                <tr
                  v-for="row in report.sources"
                  :key="row.type"
                  class="border-b border-line last:border-0"
                >
                  <td class="px-4 py-2">{{ ledgerTypeLabel(row.type) }}</td>
                  <td class="px-4 py-2 text-xs text-ink-faint tabular-nums">
                    <bdi>{{ formatNumber(row.entries) }}</bdi> ردیف
                  </td>
                  <td class="px-4 py-2 text-end font-bold tabular-nums">
                    <bdi>{{ formatNumber(row.coins) }}</bdi>
                  </td>
                </tr>
                <tr v-if="report.sources.length === 0">
                  <td class="px-4 py-3 text-ink-faint" colspan="3">در این بازه چیزی ثبت نشده.</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="overflow-x-auto rounded-xl border border-line bg-surface">
            <h2 class="border-b border-line px-4 py-3 text-sm font-semibold">
              سکه کجا سوخت ({{ toPersianDigits(report.windowDays) }} روز)
            </h2>
            <table class="w-full text-sm">
              <tbody>
                <tr
                  v-for="row in report.sinks"
                  :key="row.type"
                  class="border-b border-line last:border-0"
                >
                  <td class="px-4 py-2">{{ ledgerTypeLabel(row.type) }}</td>
                  <td class="px-4 py-2 text-xs text-ink-faint tabular-nums">
                    <bdi>{{ formatNumber(row.entries) }}</bdi> ردیف
                  </td>
                  <td class="px-4 py-2 text-end font-bold tabular-nums">
                    <bdi>{{ formatNumber(row.coins) }}</bdi>
                  </td>
                </tr>
                <tr v-if="report.sinks.length === 0">
                  <td class="px-4 py-3 text-ink-faint" colspan="3">در این بازه چیزی ثبت نشده.</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
          <p>
            هیچ‌کدام از این اعداد از همین صفحه تغییر نمی‌کنند. هر اهرمی که می‌تواند آن‌ها را جابه‌جا
            کند یک تنظیم است، با دلیل و رد حسابرسی.
          </p>
          <p class="mt-2">
            <RouterLink
              v-if="session.can(PERMISSIONS.SETTINGS_MANAGE)"
              :to="{ name: 'settings' }"
              class="text-brand"
            >
              رفتن به تنظیمات
            </RouterLink>
            <span v-else class="text-ink-faint">
              تغییر تنظیمات به دسترسی «مدیریت تنظیمات» نیاز دارد.
            </span>
          </p>
        </section>

        <p class="text-xs text-ink-faint">
          <button
            type="button"
            class="text-brand disabled:opacity-40"
            :disabled="loading"
            @click="load"
          >
            {{ loading ? 'در حال به‌روزرسانی…' : 'به‌روزرسانی' }}
          </button>
        </p>
      </div>
    </StateBlock>
  </div>
</template>
