<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type {
  GiftCodeAnalyticsResponse,
  GiftCodeRedemptionsResponse,
  GiftCodeView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatDateTime, formatNumber, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * One campaign's report, and the two things that can be done to it.
 *
 * **Every number comes from a durable row**, not from the Prometheus counter:
 * `payetam_gift_code_redemptions_total` resets on deploy, is per-replica, and
 * carries no time, which makes it right for an alert and wrong for a report
 * somebody signs. Successful redemptions and coins come from
 * `gift_code_redemption`; refusals come from `audit_log` (ADR-0016 §5).
 *
 * **Editing changes the future and cannot touch the past.** That is structural
 * rather than a rule anybody follows — the redemption row snapshots what was
 * granted and `coin_ledger` is append-only under a trigger — and the redemption
 * table below is where it becomes visible: retune a code from 50 to 80 and the
 * old rows still say 50. The page says so beside the field, because a
 * discrepancy an operator cannot explain becomes a support ticket and then a bug
 * report.
 */
const route = useRoute();
const session = useSessionStore();

const REDEMPTION_LIMIT = 25;

const report = ref<GiftCodeAnalyticsResponse | null>(null);
const redemptions = ref<GiftCodeRedemptionsResponse | null>(null);
const redemptionOffset = ref(0);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const publicId = computed(() => String(route.params.publicId));
const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  return report.value === null ? ('loading' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    const [analytics, page] = await Promise.all([
      request<GiftCodeAnalyticsResponse>(`/gift-codes/${publicId.value}/analytics`),
      request<GiftCodeRedemptionsResponse>(`/gift-codes/${publicId.value}/redemptions`, {
        query: { limit: REDEMPTION_LIMIT, offset: redemptionOffset.value },
      }),
    ]);
    report.value = analytics;
    redemptions.value = page;
  } catch (cause) {
    error.value = messageOf(cause, 'گزارش این کد بارگذاری نشد.');
  }
}

async function loadRedemptions(offset: number): Promise<void> {
  redemptionOffset.value = offset;
  try {
    redemptions.value = await request<GiftCodeRedemptionsResponse>(
      `/gift-codes/${publicId.value}/redemptions`,
      { query: { limit: REDEMPTION_LIMIT, offset } },
    );
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست دریافت‌ها بارگذاری نشد.');
  }
}

// ── The kill switch ─────────────────────────────────────────────────────────

const confirmingDisable = ref(false);
const acting = ref(false);
const actionError = ref<string | null>(null);

async function setActive(isActive: boolean): Promise<void> {
  acting.value = true;
  actionError.value = null;
  try {
    await request<GiftCodeView>(`/gift-codes/${publicId.value}/active`, {
      method: 'POST',
      body: { isActive },
    });
    confirmingDisable.value = false;
    notice.value = isActive
      ? 'کد دوباره فعال شد.'
      : 'کد غیرفعال شد. دریافت‌های انجام‌شده و سکه‌های اعطاشده دست‌نخورده می‌مانند.';
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'تغییر وضعیت کد انجام نشد.');
  } finally {
    acting.value = false;
  }
}

// ── Retuning ────────────────────────────────────────────────────────────────

const editing = ref(false);
const edit = ref({ coins: 0, maxRedemptions: '', expiresAt: '', campaign: '', note: '' });
const savingError = ref<string | null>(null);
const saving = ref(false);

function openEditor(): void {
  const current = report.value?.giftCode;
  if (!current) return;
  edit.value = {
    coins: current.coins,
    maxRedemptions: current.maxRedemptions === null ? '' : String(current.maxRedemptions),
    expiresAt: current.expiresAt === null ? '' : current.expiresAt.slice(0, 10),
    campaign: current.campaign ?? '',
    note: current.note ?? '',
  };
  editing.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  savingError.value = null;
  try {
    await request<GiftCodeView>(`/gift-codes/${publicId.value}`, {
      method: 'PATCH',
      body: {
        coins: Number(edit.value.coins),
        maxRedemptions: edit.value.maxRedemptions === '' ? null : Number(edit.value.maxRedemptions),
        expiresAt:
          edit.value.expiresAt === ''
            ? null
            : new Date(`${edit.value.expiresAt}T23:59:59.999Z`).toISOString(),
        campaign: edit.value.campaign.trim() === '' ? null : edit.value.campaign.trim(),
        note: edit.value.note.trim() === '' ? null : edit.value.note.trim(),
      },
    });
    editing.value = false;
    notice.value =
      'تنظیمات کد به‌روزرسانی شد. این تغییر فقط روی دریافت‌های بعدی اثر دارد؛ دریافت‌های گذشته و ردیف‌های دفتر سکه تغییر نمی‌کنند.';
    await load();
  } catch (cause) {
    savingError.value = messageOf(cause, 'ذخیرهٔ تنظیمات انجام نشد.');
  } finally {
    saving.value = false;
  }
}

/** The refusal reasons, in Persian. Keys are the service's own labels. */
const FAILURE_LABELS: Record<string, string> = {
  invalid: 'کد نامعتبر یا غیرفعال',
  expired: 'خارج از بازهٔ زمانی',
  already_redeemed: 'قبلاً استفاده شده',
  exhausted: 'ظرفیت تکمیل',
  error: 'خطای دیگر',
  unknown: 'نامشخص',
};

/** The tallest bar, so the trend has a scale without a charting library. */
const peak = computed(() =>
  Math.max(1, ...(report.value?.trend ?? []).map((point) => point.redemptions)),
);

onMounted(load);
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="5" @retry="load">
    <div v-if="report" class="flex flex-col gap-5">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3">
            <h1 class="text-xl font-bold">
              <bdi class="font-mono">{{ report.giftCode.codeMasked }}</bdi>
            </h1>
            <StatusPill :value="report.giftCode.state" />
          </div>
          <p class="mt-1 text-sm text-ink-soft">
            {{ report.giftCode.campaign ?? 'بدون کمپین' }}
            <template v-if="report.giftCode.note"> · {{ report.giftCode.note }}</template>
          </p>
          <!--
            The masked form is all the panel has. The plaintext was returned once,
            by the call that created it, and nothing in the product returns it
            again — which is what makes a stolen session unable to spend it.
          -->
          <p class="mt-1 text-xs text-ink-faint">
            کد کامل فقط هنگام ساخت نمایش داده شده و دیگر قابل بازیابی نیست.
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          <RouterLink
            :to="{ name: 'gift-codes' }"
            class="min-h-10 rounded-lg border border-line px-3 text-sm leading-10"
          >
            بازگشت
          </RouterLink>
          <button
            v-if="session.canMutate"
            type="button"
            class="min-h-10 rounded-lg border border-line px-3 text-sm"
            @click="openEditor"
          >
            ویرایش تنظیمات
          </button>
          <button
            v-if="session.canMutate && report.giftCode.isActive"
            type="button"
            class="min-h-10 rounded-lg border border-danger px-3 text-sm text-danger"
            @click="confirmingDisable = true"
          >
            غیرفعال کردن
          </button>
          <button
            v-else-if="session.canMutate"
            type="button"
            class="min-h-10 rounded-lg border border-line px-3 text-sm"
            :disabled="acting"
            @click="setActive(true)"
          >
            فعال کردن دوباره
          </button>
        </div>
      </header>

      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>
      <p
        v-if="actionError"
        class="rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger"
        role="alert"
      >
        {{ actionError }}
      </p>

      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">دریافت‌های موفق</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(report.successfulRedemptions) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(report.uniqueUsers) }}</bdi> فرد یکتا
          </p>
        </article>
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">سکهٔ اعطاشده</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(report.coinsGranted) }}</bdi>
          </p>
          <!-- Summed from the snapshot on each redemption, not from the current
               configuration — which is why this can disagree with `coins`. -->
          <p class="mt-1 text-xs text-ink-faint">جمع مبلغ ثبت‌شده روی هر دریافت</p>
        </article>
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">ظرفیت باقی‌مانده</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi v-if="report.giftCode.remainingRedemptions !== null">
              {{ formatNumber(report.giftCode.remainingRedemptions) }}
            </bdi>
            <span v-else class="text-ink-faint">بی‌سقف</span>
          </p>
        </article>
        <article
          class="rounded-xl border p-4"
          :class="
            report.failedAttempts > 50 ? 'border-warn bg-warn-soft' : 'border-line bg-surface'
          "
        >
          <p class="text-sm text-ink-soft">تلاش‌های ناموفق</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(report.failedAttempts) }}</bdi>
          </p>
          <ul class="mt-1 text-xs text-ink-faint">
            <li v-for="(count, reason) in report.failuresByReason" :key="reason">
              {{ FAILURE_LABELS[reason] ?? reason }}:
              <bdi>{{ formatNumber(count) }}</bdi>
            </li>
          </ul>
        </article>
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <article class="rounded-xl border border-line bg-surface p-4 lg:col-span-2">
          <h2 class="text-sm font-semibold">روند دریافت</h2>
          <!--
            Bars from a `div` each, not a charting library: this is one series of
            at most a few dozen days, and the alternative is a dependency the Mini
            App's bundle budget argument would also refuse.
          -->
          <div v-if="report.trend.length > 0" class="mt-4 flex h-32 items-end gap-1">
            <div
              v-for="point in report.trend"
              :key="point.day"
              class="flex-1 rounded-t bg-brand"
              :style="{ height: `${String(Math.round((point.redemptions / peak) * 100))}%` }"
              :title="`${point.day}: ${String(point.redemptions)}`"
            ></div>
          </div>
          <p v-else class="mt-3 text-sm text-ink-faint">هنوز دریافتی ثبت نشده است.</p>
          <p v-if="report.trend.length > 0" class="mt-2 text-xs text-ink-faint">
            از {{ formatDate(report.firstRedeemedAt) }} تا {{ formatDate(report.lastRedeemedAt) }}
          </p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">تنظیمات فعلی</h2>
          <dl class="mt-3 flex flex-col gap-2 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">سکه برای دریافت بعدی</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(report.giftCode.coins) }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">سقف هر نفر</dt>
              <dd>
                <bdi>{{ toPersianDigits(report.giftCode.perUserLimit) }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">شروع</dt>
              <dd>{{ formatDate(report.giftCode.startsAt) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">انقضا</dt>
              <dd>{{ formatDate(report.giftCode.expiresAt) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">ساخته‌شده</dt>
              <dd>{{ formatDate(report.giftCode.createdAt) }}</dd>
            </div>
          </dl>
          <p
            v-if="report.giftCode.perUserLimit > 1"
            class="mt-3 rounded-lg bg-warn-soft p-2 text-xs text-warn"
          >
            این کد از پیش از محدودیت «یک بار برای هر نفر» ساخته شده و سقف بالاتری دارد. تاریخچه‌اش
            دست‌نخورده می‌ماند؛ کدهای تازه دیگر نمی‌توانند چنین سقفی داشته باشند.
          </p>
        </article>
      </section>

      <section v-if="redemptions" class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold">دریافت‌ها</h2>
        <!--
          The immutability, made visible. `coins` here is what was granted at the
          time; the configuration above is what the *next* one will grant, and the
          two disagreeing after a retune is correct.
        -->
        <p class="text-xs text-ink-faint">
          مبلغ هر ردیف همان چیزی است که در همان لحظه اعطا شده. تغییر تنظیمات کد این ردیف‌ها و
          ردیف‌های دفتر سکه را عوض نمی‌کند.
        </p>

        <div
          v-if="redemptions.redemptions.length > 0"
          class="overflow-x-auto rounded-xl border border-line bg-surface"
        >
          <table class="w-full min-w-[40rem] text-sm">
            <thead class="border-b border-line text-ink-soft">
              <tr>
                <th class="px-4 py-2 text-start font-medium">کاربر</th>
                <th class="px-4 py-2 text-start font-medium">نوبت</th>
                <th class="px-4 py-2 text-start font-medium">سکهٔ اعطاشده</th>
                <th class="px-4 py-2 text-start font-medium">زمان</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in redemptions.redemptions"
                :key="`${row.userPublicId}-${String(row.seq)}`"
                class="border-b border-line last:border-0"
              >
                <td class="px-4 py-2">
                  <RouterLink
                    v-if="session.can('user.read')"
                    :to="{ name: 'user-detail', params: { publicId: row.userPublicId } }"
                    class="text-brand"
                  >
                    <bdi class="font-mono text-xs">{{ row.userPublicId }}</bdi>
                  </RouterLink>
                  <bdi v-else class="font-mono text-xs">{{ row.userPublicId }}</bdi>
                </td>
                <td class="px-4 py-2 tabular-nums">
                  <bdi>{{ toPersianDigits(row.seq) }}</bdi>
                </td>
                <td class="px-4 py-2 tabular-nums">
                  <bdi>{{ formatNumber(row.coins) }}</bdi>
                </td>
                <td class="px-4 py-2 text-ink-soft">{{ formatDateTime(row.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-else
          class="rounded-xl border border-dashed border-line py-8 text-center text-sm text-ink-soft"
        >
          هنوز کسی این کد را دریافت نکرده است.
        </p>

        <PagerBar
          v-if="redemptions.total > REDEMPTION_LIMIT"
          :total="redemptions.total"
          :limit="REDEMPTION_LIMIT"
          :offset="redemptionOffset"
          @move="loadRedemptions"
        />
      </section>

      <!-- ── The editor ─────────────────────────────────────────────────── -->
      <section v-if="editing" class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">ویرایش تنظیمات</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          این تغییرات فقط روی دریافت‌های بعدی اثر دارند. مبلغی که تا امروز اعطا شده روی هر ردیف
          دریافت ثبت شده و دفتر سکه هم فقط افزودنی است — پس عوض کردن این اعداد تاریخچه را بازنویسی
          نمی‌کند و نباید انتظار داشته باشید که بکند.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">سکه</span>
            <input
              v-model.number="edit.coins"
              type="number"
              min="1"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">سقف کل (خالی = بی‌نهایت)</span>
            <input
              v-model="edit.maxRedemptions"
              type="number"
              :min="report.giftCode.redeemedCount"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">انقضا</span>
            <input
              v-model="edit.expiresAt"
              type="date"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">کمپین</span>
            <input
              v-model="edit.campaign"
              type="text"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">یادداشت</span>
            <input
              v-model="edit.note"
              type="text"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
        </div>

        <p v-if="savingError" class="mt-3 text-sm text-danger" role="alert">{{ savingError }}</p>

        <div class="mt-4 flex gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? 'در حال ذخیره…' : 'ذخیره' }}
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm"
            @click="editing = false"
          >
            انصراف
          </button>
        </div>
      </section>
    </div>
  </StateBlock>

  <ConfirmDialog
    :open="confirmingDisable"
    title="غیرفعال کردن این کد"
    body="از این لحظه هیچ دریافت تازه‌ای پذیرفته نمی‌شود. دریافت‌های انجام‌شده و سکه‌هایی که اعطا شده‌اند دست‌نخورده می‌مانند — پس گرفتن سکه کار جداگانه و آگاهانه‌ای است."
    confirm-label="غیرفعال کن"
    tone="danger"
    :busy="acting"
    :error="actionError"
    @cancel="confirmingDisable = false"
    @confirm="setActive(false)"
  />
</template>
