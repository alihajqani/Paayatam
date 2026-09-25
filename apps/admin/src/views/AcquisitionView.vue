<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  ACQUISITION_SOURCE_FA,
  CAMPAIGN_START_PREFIX,
  CAMPAIGN_TAG_MAX_LENGTH,
  UNATTRIBUTED_FA,
  normalizeCampaignTag,
} from '@payetam/shared';
import type { AcquisitionReportResponse, AcquisitionRow } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatDate, formatNumber, toPersianDigits } from '@/format/fa';

/**
 * Where users come from (migration 0061).
 *
 * ── Why this page exists ────────────────────────────────────────────────────
 *
 * An ad on Telegram is paid for per view, and until this page the only way to
 * compare two of them was to run them one after the other and read the daily
 * sign-up count. Every account now records the link that created it, and this
 * page shows, per link, how many of those people stayed long enough to matter.
 *
 * ── Why the link builder is here and not a list of campaigns ────────────────
 *
 * A campaign is nothing more than a tag in a `?start=` link: no row is created
 * until somebody taps it, so there is nothing to register and nothing to audit.
 * The builder exists so the tag is always written the way the bot reads it — the
 * report files a link without the `src_` prefix under «لینک ناشناخته», and a tag
 * the builder produced cannot end up there.
 *
 * ── Read-only ───────────────────────────────────────────────────────────────
 *
 * Nothing on this page writes. The builder runs in the browser.
 */

const WINDOWS: Array<{ days: number | null; label: string }> = [
  { days: 7, label: '۷ روز' },
  { days: 30, label: '۳۰ روز' },
  { days: 90, label: '۹۰ روز' },
  { days: null, label: 'همه' },
];

const windowDays = ref<number | null>(30);
const report = ref<AcquisitionReportResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (report.value === null) return 'loading' as const;
  if (report.value.totals.users === 0) return 'empty' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const query = windowDays.value === null ? '' : `?days=${windowDays.value}`;
    report.value = await request<AcquisitionReportResponse>(`/acquisition${query}`);
  } catch (cause) {
    error.value = messageOf(cause, 'گزارش منابع ورود بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

watch(windowDays, load);

// ── The link builder ────────────────────────────────────────────────────────

const tag = ref('');
const copied = ref(false);

const normalizedTag = computed(() => normalizeCampaignTag(tag.value));

const campaignLink = computed(() => {
  if (report.value === null || normalizedTag.value === null) return null;
  return `https://t.me/${report.value.botUsername}?start=${CAMPAIGN_START_PREFIX}${normalizedTag.value}`;
});

watch(tag, () => {
  copied.value = false;
});

async function copyLink(): Promise<void> {
  if (campaignLink.value === null) return;
  try {
    await navigator.clipboard.writeText(campaignLink.value);
    copied.value = true;
  } catch {
    // A browser that refuses the clipboard still shows the link to select by hand.
    copied.value = false;
  }
}

// ── The table ───────────────────────────────────────────────────────────────

const STEPS: Array<{ key: keyof AcquisitionRow & string; label: string; hint: string }> = [
  { key: 'termsAccepted', label: 'قوانین', hint: 'قوانین را پذیرفته‌اند' },
  { key: 'profileComplete', label: 'پروفایل', hint: 'پروفایل را کامل کرده‌اند' },
  { key: 'requested', label: 'درخواست', hint: 'دست‌کم یک درخواست شرکت داده‌اند' },
  { key: 'attended', label: 'حضور', hint: 'دست‌کم در یک رویداد حاضر شده‌اند' },
  { key: 'hosted', label: 'میزبانی', hint: 'دست‌کم یک رویداد ساخته‌اند' },
  { key: 'botBlocked', label: 'بلاک', hint: 'ربات را بلاک کرده‌اند' },
];

function sourceLabel(row: AcquisitionRow): string {
  return row.source === null ? UNATTRIBUTED_FA : ACQUISITION_SOURCE_FA[row.source];
}

function count(row: AcquisitionRow, key: string): number {
  const value = row[key as keyof AcquisitionRow];
  return typeof value === 'number' ? value : 0;
}

/** A share of the row's own sign-ups, which is what makes two rows comparable. */
function share(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${toPersianDigits(Math.round((part / whole) * 100))}٪`;
}

const totalsRow = computed<AcquisitionRow | null>(() =>
  report.value === null ? null : { ...report.value.totals, source: null, ref: null },
);

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
      <p>
        هر کاربر، همان لحظه‌ای که ربات را برای اولین بار باز می‌کند، با لینکی که از آن آمده ثبت
        می‌شود. برای هر تبلیغ یک تگ جدا بسازید تا اینجا جدا شمرده شود. ستون‌ها نشان می‌دهند از
        آدم‌هایی که با هر لینک آمدند، چند نفر ماندند.
      </p>
      <p v-if="report" class="mt-2 text-ink-soft">
        <template v-if="report.trackingSince">
          ثبت منبع از <bdi>{{ formatDate(report.trackingSince) }}</bdi> شروع شده؛ کاربرانی که پیش از
          آن آمده‌اند در ردیف «{{ UNATTRIBUTED_FA }}» هستند.
        </template>
        <template v-else>هنوز هیچ کاربری با ثبت منبع وارد نشده است.</template>
      </p>
    </section>

    <section class="rounded-xl border border-line bg-surface p-4">
      <h2 class="text-sm font-semibold">ساخت لینک تبلیغ</h2>
      <p class="mt-1 text-sm text-ink-soft">
        یک نام کوتاه انگلیسی برای تبلیغ بنویسید، مثلاً <bdi class="font-mono">tgads_anon1</bdi>.
        حروف کوچک و بزرگ یکی حساب می‌شوند.
      </p>
      <label class="mt-3 flex flex-col gap-1">
        <span class="text-sm text-ink-soft">تگ کمپین</span>
        <input
          v-model="tag"
          type="text"
          dir="ltr"
          :maxlength="CAMPAIGN_TAG_MAX_LENGTH"
          placeholder="tgads_anon1"
          class="min-h-10 max-w-md rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
      <p v-if="tag !== '' && normalizedTag === null" class="mt-2 text-sm text-danger" role="alert">
        فقط حروف انگلیسی، عدد، «_» و «-» پذیرفته می‌شود، حداکثر
        <bdi>{{ toPersianDigits(CAMPAIGN_TAG_MAX_LENGTH) }}</bdi> نویسه.
      </p>
      <div v-if="campaignLink" class="mt-3 flex flex-wrap items-center gap-3">
        <bdi class="break-all rounded-lg bg-neutral-soft px-3 py-2 font-mono text-sm" dir="ltr">
          {{ campaignLink }}
        </bdi>
        <button
          type="button"
          class="min-h-9 rounded-full border border-line px-3 text-sm"
          @click="copyLink"
        >
          {{ copied ? 'کپی شد' : 'کپی لینک' }}
        </button>
      </div>
    </section>

    <div class="flex flex-wrap gap-2" role="group" aria-label="بازهٔ زمانی">
      <button
        v-for="option in WINDOWS"
        :key="option.label"
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

    <StateBlock
      :state="state"
      :error-text="error"
      :rows="6"
      empty-text="در این بازه کاربری وارد نشده است."
      @retry="load"
    >
      <div v-if="report && totalsRow" class="flex flex-col gap-3">
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="w-full min-w-[56rem] text-sm">
            <thead class="border-b border-line text-ink-soft">
              <tr>
                <th class="px-4 py-3 text-start font-medium">منبع</th>
                <th class="px-4 py-3 text-start font-medium">ورود</th>
                <th
                  v-for="step in STEPS"
                  :key="step.key"
                  class="px-4 py-3 text-start font-medium"
                  :title="step.hint"
                >
                  {{ step.label }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in report.rows"
                :key="`${row.source ?? 'none'}:${row.ref ?? ''}`"
                class="border-b border-line"
              >
                <td class="px-4 py-3">
                  <div class="font-medium">{{ sourceLabel(row) }}</div>
                  <bdi v-if="row.ref" class="font-mono text-xs text-ink-soft" dir="ltr">
                    {{ row.ref }}
                  </bdi>
                  <div v-if="row.source === 'OTHER'" class="text-xs text-ink-faint">
                    بدون پیشوند <bdi class="font-mono">src_</bdi>؛ احتمالاً لینک تبلیغ اشتباه ساخته
                    شده است.
                  </div>
                </td>
                <td class="px-4 py-3 font-medium tabular-nums">
                  <bdi>{{ formatNumber(row.users) }}</bdi>
                </td>
                <td v-for="step in STEPS" :key="step.key" class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(count(row, step.key)) }}</bdi>
                  <span class="ms-1 text-xs text-ink-soft">
                    <bdi>{{ share(count(row, step.key), row.users) }}</bdi>
                  </span>
                </td>
              </tr>
            </tbody>
            <tfoot class="bg-neutral-soft/40">
              <tr>
                <td class="px-4 py-3 font-semibold">همه</td>
                <td class="px-4 py-3 font-semibold tabular-nums">
                  <bdi>{{ formatNumber(totalsRow.users) }}</bdi>
                </td>
                <td v-for="step in STEPS" :key="step.key" class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(count(totalsRow, step.key)) }}</bdi>
                  <span class="ms-1 text-xs text-ink-soft">
                    <bdi>{{ share(count(totalsRow, step.key), totalsRow.users) }}</bdi>
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="report.omittedRows > 0" class="text-xs text-ink-soft">
          <bdi>{{ formatNumber(report.omittedRows) }}</bdi> ردیف کوچک‌تر نشان داده نشده، ولی در ردیف
          «همه» شمرده شده است.
        </p>
        <p class="text-xs text-ink-faint">
          درصدها نسبت به ورودِ همان ردیف است. برای مقایسهٔ دو تبلیغ، ستون «پروفایل» مهم‌تر از «ورود»
          است: بدون پروفایل کامل، کسی نمی‌تواند در رویدادی شرکت کند.
        </p>
      </div>
    </StateBlock>
  </div>
</template>
