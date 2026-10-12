<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  ERROR_MESSAGES_FA,
  INTERACTION_KIND_FA,
  INTERACTION_MAX_WINDOW_DAYS,
  INTERACTION_OUTCOME_FA,
  INTERACTION_SESSION_GAP_MINUTES,
  interactionActionLabel,
} from '@payetam/shared';
import type {
  InteractionActionsResponse,
  InteractionLinkRow,
  InteractionLinksResponse,
  InteractionOverviewResponse,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatDate, formatNumber, toPersianDigits } from '@/format/fa';

/**
 * What people do in the bot (migration 0065).
 *
 * ── Why this page exists ────────────────────────────────────────────────────
 *
 * «منابع ورود» says which link created an account and how far that account
 * got. It cannot say whether anybody presses anything after the welcome, which
 * buttons they press, or what refused them — and those are the questions an
 * operator brings when the sign-up numbers look fine and the product does not.
 *
 * ── Three tabs, each fetched when it is opened ──────────────────────────────
 *
 * The overview is seven statements, one of them a window function over every
 * row in the window. Loading all three reports to show one would triple that
 * for no reason, so a tab asks for its own data the first time it is shown and
 * again when the window has changed since.
 *
 * ── Read-only ───────────────────────────────────────────────────────────────
 *
 * Nothing on this page writes. The rows are written by the bot.
 */

type Tab = 'overview' | 'links' | 'actions';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'نمای کلی' },
  { key: 'links', label: 'لینک‌ها' },
  { key: 'actions', label: 'دکمه‌ها و دستورها' },
];

/** No «همه»: rows older than the retention period are gone, not merely hidden. */
const WINDOWS: Array<{ days: number; label: string }> = [
  { days: 7, label: '۷ روز' },
  { days: 30, label: '۳۰ روز' },
  { days: 90, label: '۹۰ روز' },
  {
    days: INTERACTION_MAX_WINDOW_DAYS,
    label: `${toPersianDigits(INTERACTION_MAX_WINDOW_DAYS)} روز`,
  },
];

const tab = ref<Tab>('overview');
const windowDays = ref(30);

/** One report, and the window it was fetched for — which is how a stale one is known. */
interface Slot<T> {
  data: T | null;
  days: number | null;
  error: string | null;
}

const slots = reactive({
  overview: { data: null, days: null, error: null } as Slot<InteractionOverviewResponse>,
  links: { data: null, days: null, error: null } as Slot<InteractionLinksResponse>,
  actions: { data: null, days: null, error: null } as Slot<InteractionActionsResponse>,
});

const ERRORS: Record<Tab, string> = {
  overview: 'نمای کلی رفتار کاربران بارگذاری نشد.',
  links: 'گزارش لینک‌ها بارگذاری نشد.',
  actions: 'گزارش دکمه‌ها و دستورها بارگذاری نشد.',
};

async function load(which: Tab): Promise<void> {
  const days = windowDays.value;
  const slot = slots[which];
  slot.error = null;
  try {
    const data = await request(`/interactions/${which}?days=${days}`);
    // A window chosen while this was in flight has its own request on the way;
    // writing this answer under it would show last window's numbers as this one's.
    if (days !== windowDays.value) return;
    (slot as Slot<unknown>).data = data;
    slot.days = days;
  } catch (cause) {
    if (days === windowDays.value) slot.error = messageOf(cause, ERRORS[which]);
  }
}

function ensure(which: Tab): void {
  if (slots[which].days !== windowDays.value) void load(which);
}

watch([tab, windowDays], () => ensure(tab.value));
onMounted(() => ensure('overview'));

function stateOf(which: Tab, isEmpty: boolean): 'loading' | 'empty' | 'error' | 'ready' {
  const slot = slots[which];
  if (slot.error !== null) return 'error';
  if (slot.data === null || slot.days !== windowDays.value) return 'loading';
  return isEmpty ? 'empty' : 'ready';
}

// ── Overview ────────────────────────────────────────────────────────────────

const overview = computed(() => slots.overview.data);

const overviewState = computed(() =>
  stateOf('overview', (overview.value?.totals.interactions ?? 0) === 0),
);

/** Different sentences: "nothing yet" is a fact about the release, the other about the window. */
const overviewEmptyText = computed(() =>
  overview.value?.trackingSince === null
    ? 'هنوز چیزی ثبت نشده است. ثبت از اولین پیامی شروع می‌شود که پس از انتشار این نسخه به ربات برسد.'
    : 'در این بازه چیزی ثبت نشده است.',
);

function share(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${toPersianDigits(Math.round((part / whole) * 100))}٪`;
}

/** `۳٫۷` — one decimal, with the Persian decimal mark rather than a Latin dot. */
function formatDecimal(value: number): string {
  return toPersianDigits(value.toFixed(1)).replace('.', '٫');
}

/** A bar's width against the largest value in its own list. */
function barWidth(value: number, values: number[]): string {
  const largest = Math.max(0, ...values);
  return largest === 0 ? '0%' : `${Math.max(2, Math.round((value / largest) * 100))}%`;
}

const outcomeTotal = computed(() =>
  (overview.value?.byOutcome ?? []).reduce((sum, row) => sum + row.interactions, 0),
);

const dayValues = computed(() => (overview.value?.byDay ?? []).map((row) => row.interactions));
const hourValues = computed(() => (overview.value?.byHour ?? []).map((row) => row.interactions));

/**
 * A Tehran calendar day as the API sends it, made into a moment the formatter
 * will read back as that same day: noon there, with Tehran's own offset.
 */
function dayLabel(day: string): string {
  return formatDate(`${day}T12:00:00+03:30`);
}

// ── Links ───────────────────────────────────────────────────────────────────

const links = computed(() => slots.links.data);
const linksState = computed(() => stateOf('links', (links.value?.rows.length ?? 0) === 0));

/** What the link points at: an event's title, else the tag or id it carried. */
function linkTarget(row: InteractionLinkRow): { text: string; mono: boolean } | null {
  if (row.title !== null) return { text: row.title, mono: false };
  if (row.ref !== null) return { text: row.ref, mono: true };
  return null;
}

// ── Buttons and commands ────────────────────────────────────────────────────

const actions = computed(() => slots.actions.data);
const actionsState = computed(() => stateOf('actions', (actions.value?.rows.length ?? 0) === 0));

/**
 * The sentence the person was sent, which is what tells an operator what to
 * fix. A code this build has no sentence for is shown as the code.
 */
function refusalText(code: string): string {
  return (ERROR_MESSAGES_FA as Record<string, string>)[code] ?? code;
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
      <p>
        هر پیام، دستور یا دکمه‌ای که در ربات زده می‌شود اینجا شمرده می‌شود: چه چیزی زده شد، ربات چه
        جوابی داد و کاربر روی کدام صفحه ماند. متن پیام‌ها ذخیره نمی‌شود و حساب مدیران در هیچ‌کدام از
        عددها نیست.
      </p>
      <p v-if="overview?.trackingSince" class="mt-2 text-ink-soft">
        ثبت رفتار از <bdi>{{ formatDate(overview.trackingSince) }}</bdi> شروع شده است و هر ردیف
        <bdi>{{ toPersianDigits(INTERACTION_MAX_WINDOW_DAYS) }}</bdi> روز نگه داشته می‌شود.
      </p>
      <p class="mt-2 text-xs text-ink-faint">
        تلگرام این‌ها را به ربات خبر نمی‌دهد و در هیچ گزارشی نیستند: باز کردن لینک بدون زدن «Start»،
        دکمه‌هایی که به بیرون از ربات می‌روند (عضویت در کانال، اشتراک‌گذاری) و خوانده‌شدن پیام.
      </p>
    </section>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap gap-2" role="tablist" aria-label="گزارش">
        <button
          v-for="option in TABS"
          :key="option.key"
          type="button"
          role="tab"
          class="min-h-9 rounded-full border px-3 text-sm"
          :class="tab === option.key ? 'border-brand bg-brand-soft text-brand' : 'border-line'"
          :aria-selected="tab === option.key"
          @click="tab = option.key"
        >
          {{ option.label }}
        </button>
      </div>

      <div class="flex flex-wrap gap-2" role="group" aria-label="بازهٔ زمانی">
        <button
          v-for="option in WINDOWS"
          :key="option.days"
          type="button"
          class="min-h-9 rounded-full border px-3 text-sm"
          :class="
            windowDays === option.days ? 'border-brand bg-brand-soft text-brand' : 'border-line'
          "
          :aria-pressed="windowDays === option.days"
          @click="windowDays = option.days"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <!-- ── Overview ─────────────────────────────────────────────────────── -->
    <StateBlock
      v-if="tab === 'overview'"
      :state="overviewState"
      :error-text="slots.overview.error"
      :rows="6"
      :empty-text="overviewEmptyText"
      @retry="load('overview')"
    >
      <div v-if="overview" class="flex flex-col gap-4" data-testid="overview">
        <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <article class="rounded-xl border border-line bg-surface p-4">
            <p class="text-sm text-ink-soft">افراد فعال</p>
            <p class="mt-1 text-xl font-bold tabular-nums">
              <bdi>{{ formatNumber(overview.totals.activeUsers) }}</bdi>
            </p>
            <p class="mt-1 text-xs text-ink-faint">دست‌کم یک کار در ربات انجام داده‌اند.</p>
          </article>
          <article class="rounded-xl border border-line bg-surface p-4">
            <p class="text-sm text-ink-soft">بازدیدها</p>
            <p class="mt-1 text-xl font-bold tabular-nums">
              <bdi>{{ formatNumber(overview.totals.sessions) }}</bdi>
            </p>
            <p class="mt-1 text-xs text-ink-faint">
              هر بازدید، کارهای پشت‌سرهم یک نفر است تا وقتی بیش از
              <bdi>{{ toPersianDigits(INTERACTION_SESSION_GAP_MINUTES) }}</bdi> دقیقه فاصله بیفتد.
            </p>
          </article>
          <article class="rounded-xl border border-line bg-surface p-4">
            <p class="text-sm text-ink-soft">قدم در هر بازدید</p>
            <p class="mt-1 text-xl font-bold tabular-nums">
              <bdi>{{ formatDecimal(overview.totals.stepsPerSession) }}</bdi>
            </p>
            <p class="mt-1 text-xs text-ink-faint">
              نزدیک به یک یعنی می‌آیند و می‌روند؛ بیشتر یعنی در ربات می‌چرخند.
            </p>
          </article>
          <article class="rounded-xl border border-line bg-surface p-4">
            <p class="text-sm text-ink-soft">کل تعامل‌ها</p>
            <p class="mt-1 text-xl font-bold tabular-nums">
              <bdi>{{ formatNumber(overview.totals.interactions) }}</bdi>
            </p>
            <p class="mt-1 text-xs text-ink-faint">هر پیام، دستور و دکمه یک تعامل است.</p>
          </article>
          <article class="rounded-xl border border-line bg-surface p-4">
            <p class="text-sm text-ink-soft">حساب‌های جدید</p>
            <p class="mt-1 text-xl font-bold tabular-nums">
              <bdi>{{ formatNumber(overview.totals.newAccounts) }}</bdi>
            </p>
            <p class="mt-1 text-xs text-ink-faint">
              در این بازه برای اولین بار ربات را باز کرده‌اند.
            </p>
          </article>
          <article class="rounded-xl border border-line bg-surface p-4">
            <p class="text-sm text-ink-soft">بعد از شروع هیچ کاری نکردند</p>
            <p class="mt-1 text-xl font-bold tabular-nums">
              <bdi>{{ formatNumber(overview.totals.newAccountsSilent) }}</bdi>
              <span class="ms-2 text-sm font-normal text-ink-soft">
                <bdi>{{
                  share(overview.totals.newAccountsSilent, overview.totals.newAccounts)
                }}</bdi>
                از حساب‌های جدید
              </span>
            </p>
            <p class="mt-1 text-xs text-ink-faint">
              ربات را باز کرده‌اند و هیچ دکمه یا دستوری نزده‌اند، تا همین امروز.
            </p>
          </article>
        </section>

        <section class="grid gap-4 lg:grid-cols-2">
          <article class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">ربات چه جوابی داد</h2>
            <ul class="mt-3 flex flex-col gap-2 text-sm">
              <li
                v-for="row in overview.byOutcome"
                :key="row.outcome"
                class="flex items-baseline justify-between gap-3"
                data-testid="outcome-row"
              >
                <span>{{ INTERACTION_OUTCOME_FA[row.outcome] }}</span>
                <span class="tabular-nums">
                  <bdi>{{ formatNumber(row.interactions) }}</bdi>
                  <span class="ms-1 text-xs text-ink-soft">
                    <bdi>{{ share(row.interactions, outcomeTotal) }}</bdi>
                  </span>
                </span>
              </li>
            </ul>
          </article>

          <article class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">با چه چیزی</h2>
            <table class="mt-3 w-full text-sm">
              <thead class="text-ink-soft">
                <tr>
                  <th class="pb-2 text-start font-medium">نوع</th>
                  <th class="pb-2 text-start font-medium">تعداد</th>
                  <th class="pb-2 text-start font-medium">نفر</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in overview.byKind" :key="row.kind" class="border-t border-line">
                  <td class="py-2">{{ INTERACTION_KIND_FA[row.kind] }}</td>
                  <td class="py-2 tabular-nums">
                    <bdi>{{ formatNumber(row.interactions) }}</bdi>
                  </td>
                  <td class="py-2 tabular-nums">
                    <bdi>{{ formatNumber(row.users) }}</bdi>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </section>

        <section class="grid gap-4 lg:grid-cols-2">
          <article class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">روز به روز</h2>
            <ul class="mt-3 flex flex-col gap-2 text-sm">
              <li v-for="row in overview.byDay" :key="row.day">
                <div class="flex items-baseline justify-between gap-3">
                  <bdi>{{ dayLabel(row.day) }}</bdi>
                  <span class="tabular-nums text-ink-soft">
                    <bdi>{{ formatNumber(row.interactions) }}</bdi> تعامل،
                    <bdi>{{ formatNumber(row.activeUsers) }}</bdi> نفر
                  </span>
                </div>
                <div class="mt-1 h-1.5 rounded-full bg-neutral-soft">
                  <div
                    class="h-1.5 rounded-full bg-brand"
                    :style="{ width: barWidth(row.interactions, dayValues) }"
                  />
                </div>
              </li>
            </ul>
          </article>

          <article class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">ساعت‌های روز، به وقت تهران</h2>
            <ul class="mt-3 flex flex-col gap-2 text-sm">
              <li v-for="row in overview.byHour" :key="row.hour">
                <div class="flex items-baseline justify-between gap-3">
                  <span
                    >ساعت <bdi class="tabular-nums">{{ toPersianDigits(row.hour) }}</bdi></span
                  >
                  <bdi class="tabular-nums text-ink-soft">{{ formatNumber(row.interactions) }}</bdi>
                </div>
                <div class="mt-1 h-1.5 rounded-full bg-neutral-soft">
                  <div
                    class="h-1.5 rounded-full bg-brand"
                    :style="{ width: barWidth(row.interactions, hourValues) }"
                  />
                </div>
              </li>
            </ul>
          </article>
        </section>
      </div>
    </StateBlock>

    <!-- ── Links ────────────────────────────────────────────────────────── -->
    <StateBlock
      v-else-if="tab === 'links'"
      :state="linksState"
      :error-text="slots.links.error"
      :rows="6"
      empty-text="در این بازه کسی با /start وارد ربات نشده است."
      @retry="load('links')"
    >
      <div v-if="links" class="flex flex-col gap-3" data-testid="links">
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="w-full min-w-[44rem] text-sm">
            <thead class="border-b border-line text-ink-soft">
              <tr>
                <th class="px-4 py-3 text-start font-medium">لینک</th>
                <th class="px-4 py-3 text-start font-medium" title="هر بار که لینک دنبال شده است">
                  دفعات
                </th>
                <th class="px-4 py-3 text-start font-medium">نفر</th>
                <th
                  class="px-4 py-3 text-start font-medium"
                  title="حساب‌هایی که همین لینک ساخته است"
                >
                  حساب جدید
                </th>
                <th
                  class="px-4 py-3 text-start font-medium"
                  title="کسانی که از قبل حساب داشتند و لینک را دنبال کردند"
                >
                  عضو قبلی
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in links.rows"
                :key="`${row.action}:${row.ref ?? ''}`"
                class="border-b border-line"
              >
                <td class="px-4 py-3">
                  <div class="font-medium">{{ interactionActionLabel(row.action) }}</div>
                  <template v-if="linkTarget(row)">
                    <bdi
                      v-if="linkTarget(row)?.mono"
                      class="font-mono text-xs text-ink-soft"
                      dir="ltr"
                    >
                      {{ linkTarget(row)?.text }}
                    </bdi>
                    <div v-else class="text-xs text-ink-soft">{{ linkTarget(row)?.text }}</div>
                  </template>
                </td>
                <td class="px-4 py-3 font-medium tabular-nums">
                  <bdi>{{ formatNumber(row.taps) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.users) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.newAccounts) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.returningUsers) }}</bdi>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="links.omittedRows > 0" class="text-xs text-ink-soft">
          <bdi>{{ formatNumber(links.omittedRows) }}</bdi> لینک کم‌استفاده‌تر نشان داده نشده است.
        </p>
        <p class="text-xs text-ink-faint">
          «منابع ورود» فقط حسابی را می‌شمارد که یک لینک ساخته است. اینجا هر بار دنبال‌شدن لینک شمرده
          می‌شود، از جمله وقتی عضو قبلی روی پست کانال می‌زند. لینک دعوت دوستان یک ردیف است، چون کد
          دعوت نام یک نفر را دارد و نگه داشته نمی‌شود.
        </p>
      </div>
    </StateBlock>

    <!-- ── Buttons and commands ─────────────────────────────────────────── -->
    <StateBlock
      v-else
      :state="actionsState"
      :error-text="slots.actions.error"
      :rows="8"
      empty-text="در این بازه چیزی زده نشده است."
      @retry="load('actions')"
    >
      <div v-if="actions" class="flex flex-col gap-3" data-testid="actions">
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="w-full min-w-[60rem] text-sm">
            <thead class="border-b border-line text-ink-soft">
              <tr>
                <th class="px-4 py-3 text-start font-medium">چه چیزی</th>
                <th class="px-4 py-3 text-start font-medium">تعداد</th>
                <th class="px-4 py-3 text-start font-medium">نفر</th>
                <th class="px-4 py-3 text-start font-medium">رد شد</th>
                <th
                  class="px-4 py-3 text-start font-medium"
                  title="کاربر هنوز ثبت‌نامش را تمام نکرده بود"
                >
                  پشت ثبت‌نام
                </th>
                <th class="px-4 py-3 text-start font-medium" title="دکمه‌ای که دیگر کار نمی‌کند">
                  ازکارافتاده
                </th>
                <th class="px-4 py-3 text-start font-medium" title="خطای خود ربات">خطا</th>
                <th class="px-4 py-3 text-start font-medium" title="میانگین زمان پاسخ ربات">
                  پاسخ (میلی‌ثانیه)
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in actions.rows"
                :key="`${row.kind}:${row.action}`"
                class="border-b border-line align-top"
              >
                <td class="px-4 py-3">
                  <div class="font-medium">{{ interactionActionLabel(row.action) }}</div>
                  <div class="text-xs text-ink-faint">
                    {{ INTERACTION_KIND_FA[row.kind] }}
                    <bdi
                      v-if="interactionActionLabel(row.action) !== row.action"
                      class="ms-1 font-mono"
                      dir="ltr"
                      >{{ row.action }}</bdi
                    >
                  </div>
                </td>
                <td class="px-4 py-3 font-medium tabular-nums">
                  <bdi>{{ formatNumber(row.count) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.users) }}</bdi>
                </td>
                <td class="px-4 py-3">
                  <span class="tabular-nums">
                    <bdi>{{ formatNumber(row.refused) }}</bdi>
                    <span v-if="row.refused > 0" class="ms-1 text-xs text-ink-soft">
                      <bdi>{{ share(row.refused, row.count) }}</bdi>
                    </span>
                  </span>
                  <div v-if="row.topRefusal" class="mt-1 max-w-xs text-xs text-ink-soft">
                    بیشتر با این پیام: «{{ refusalText(row.topRefusal) }}»
                  </div>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.gated) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.stale) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums" :class="row.failed > 0 ? 'text-danger' : ''">
                  <bdi>{{ formatNumber(row.failed) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(row.averageMs) }}</bdi>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="actions.omittedRows > 0" class="text-xs text-ink-soft">
          <bdi>{{ formatNumber(actions.omittedRows) }}</bdi> مورد کم‌استفاده‌تر نشان داده نشده است.
        </p>
        <p class="text-xs text-ink-faint">
          درصد «رد شد» نسبت به تعداد همان ردیف است. ردیفی که فقط نام انگلیسی دارد، دکمه‌ای است که
          هنوز برایش نام فارسی نوشته نشده است.
        </p>
      </div>
    </StateBlock>
  </div>
</template>
