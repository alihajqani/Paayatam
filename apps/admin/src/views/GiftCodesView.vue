<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  bulkCreateGiftCodesRequest,
  createGiftCodeRequest,
  type BulkCreateGiftCodesResponse,
  type CampaignListResponse,
  type CampaignSummaryView,
  type CreateGiftCodeResponse,
  type GiftCodeListResponse,
  type GiftCodeView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatNumber, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Campaigns: mint them, watch them drain, stop them.
 *
 * **The list never shows a code.** Every row is `NOWR••••4F2Z`, addressed by
 * `publicId`, because a gift code is a bearer secret — whoever holds the string
 * gets the coins — and a list that echoed live codes would turn one stolen admin
 * cookie into the entire promotional budget (ADR-0016).
 *
 * Finding a specific one is still possible and is deliberately shaped: the code
 * filter is **exact**, normalized server-side. An operator holding a code a user
 * quoted at them finds its row; an operator holding nothing cannot enumerate.
 *
 * A bulk mint is the one place plaintext appears, once, in a panel that then
 * cannot get it back. The warning comes from the API rather than being written
 * here, so no surface can show the list without the sentence that explains it.
 */
const LIMIT = 25;

const session = useSessionStore();

// ── The kill switch, from the list ──────────────────────────────────────────

/** The code whose disable dialog is open, or null. */
const pendingDisable = ref<GiftCodeView | null>(null);
/** The public id being written, so every button on the table disables at once. */
const toggling = ref<string | null>(null);

/**
 * Turn one code on or off.
 *
 * `POST /gift-codes/:publicId/active` is the same endpoint the detail page has
 * always called — this adds a second caller, not a second rule. Addressed by
 * `publicId` rather than by the code itself, for the reason `gift_code.public_id`
 * exists at all (ADR-0016): a code in a URL is a live secret in every access log
 * between here and the database.
 */
async function setActive(code: GiftCodeView, isActive: boolean): Promise<void> {
  if (toggling.value !== null) return;
  toggling.value = code.publicId;
  error.value = null;

  try {
    await request<GiftCodeView>(`/gift-codes/${encodeURIComponent(code.publicId)}/active`, {
      method: 'POST',
      body: { isActive },
    });
    notice.value = isActive
      ? 'کد دوباره فعال شد.'
      : 'کد غیرفعال شد. دریافت‌های انجام‌شده و سکه‌های اعطاشده دست‌نخورده می‌مانند.';
    pendingDisable.value = null;
    await load();
  } catch (cause) {
    error.value = messageOf(cause, 'تغییر وضعیت کد انجام نشد.');
  } finally {
    toggling.value = null;
  }
}

const rows = ref<GiftCodeView[]>([]);
const total = ref(0);
const offset = ref(0);
const campaignFilter = ref('');
const codeFilter = ref('');
const activeFilter = ref<'' | 'true' | 'false'>('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const campaigns = ref<CampaignSummaryView[]>([]);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [page, roll] = await Promise.all([
      request<GiftCodeListResponse>('/gift-codes', {
        query: {
          campaign: campaignFilter.value.trim(),
          code: codeFilter.value.trim(),
          isActive: activeFilter.value,
          limit: LIMIT,
          offset: offset.value,
        },
      }),
      // The roll-up is one grouped query on the server, not a fetch per code —
      // and it is loaded beside the list rather than on its own tab so an
      // operator sees "how is the campaign doing" without a second click.
      request<CampaignListResponse>('/gift-codes/campaigns'),
    ]);
    rows.value = page.codes;
    total.value = page.total;
    campaigns.value = roll.campaigns;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست کدهای هدیه بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([campaignFilter, codeFilter, activeFilter], () => {
  offset.value = 0;
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});
watch(offset, () => void load());

// ── Minting one ─────────────────────────────────────────────────────────────

const single = ref({
  code: '',
  coins: 50,
  maxRedemptions: '',
  expiresAt: '',
  campaign: '',
  note: '',
});
const singleError = ref<string | null>(null);
const singleBusy = ref(false);
/** The plaintext, shown once — safe here only because the operator typed it. */
const singleCreated = ref<CreateGiftCodeResponse | null>(null);

const singleValid = computed(
  () =>
    createGiftCodeRequest.safeParse({
      code: single.value.code,
      coins: single.value.coins,
      perUserLimit: 1,
      ...(single.value.maxRedemptions === ''
        ? {}
        : { maxRedemptions: Number(single.value.maxRedemptions) }),
      ...(single.value.expiresAt === ''
        ? {}
        : { expiresAt: new Date(single.value.expiresAt).toISOString() }),
      ...(single.value.campaign === '' ? {} : { campaign: single.value.campaign }),
      ...(single.value.note === '' ? {} : { note: single.value.note }),
    }).success,
);

async function createSingle(): Promise<void> {
  if (!singleValid.value || singleBusy.value) return;
  singleBusy.value = true;
  singleError.value = null;
  try {
    singleCreated.value = await request<CreateGiftCodeResponse>('/gift-codes', {
      method: 'POST',
      body: {
        code: single.value.code.trim(),
        coins: Number(single.value.coins),
        perUserLimit: 1,
        maxRedemptions:
          single.value.maxRedemptions === '' ? null : Number(single.value.maxRedemptions),
        expiresAt:
          single.value.expiresAt === '' ? null : new Date(single.value.expiresAt).toISOString(),
        campaign: single.value.campaign.trim() === '' ? null : single.value.campaign.trim(),
        note: single.value.note.trim() === '' ? null : single.value.note.trim(),
      },
    });
    single.value.code = '';
    await load();
  } catch (cause) {
    singleError.value = messageOf(cause, 'ساخت کد انجام نشد.');
  } finally {
    singleBusy.value = false;
  }
}

// ── Minting a batch ─────────────────────────────────────────────────────────

const batch = ref({
  count: 100,
  coins: 50,
  prefix: '',
  length: 12,
  expiresAt: '',
  campaign: '',
  note: '',
  isActive: true,
});
const batchError = ref<string | null>(null);
const batchBusy = ref(false);
/**
 * The one time these strings exist outside the database.
 *
 * Nothing in the product returns them again — that is the property that makes
 * bulk minting safe to expose at all — so this block stays on screen until the
 * operator dismisses it, and dismissing it says so.
 */
const batchCreated = ref<BulkCreateGiftCodesResponse | null>(null);

const batchValid = computed(
  () =>
    bulkCreateGiftCodesRequest.safeParse({
      count: Number(batch.value.count),
      coins: Number(batch.value.coins),
      length: Number(batch.value.length),
      perUserLimit: 1,
      isActive: batch.value.isActive,
      ...(batch.value.prefix === '' ? {} : { prefix: batch.value.prefix }),
      ...(batch.value.expiresAt === ''
        ? {}
        : { expiresAt: new Date(batch.value.expiresAt).toISOString() }),
      ...(batch.value.campaign === '' ? {} : { campaign: batch.value.campaign }),
      ...(batch.value.note === '' ? {} : { note: batch.value.note }),
    }).success,
);

async function createBatch(): Promise<void> {
  if (!batchValid.value || batchBusy.value) return;
  batchBusy.value = true;
  batchError.value = null;
  try {
    batchCreated.value = await request<BulkCreateGiftCodesResponse>('/gift-codes/batch', {
      method: 'POST',
      body: {
        count: Number(batch.value.count),
        coins: Number(batch.value.coins),
        length: Number(batch.value.length),
        perUserLimit: 1,
        isActive: batch.value.isActive,
        prefix: batch.value.prefix.trim() === '' ? null : batch.value.prefix.trim(),
        expiresAt:
          batch.value.expiresAt === '' ? null : new Date(batch.value.expiresAt).toISOString(),
        campaign: batch.value.campaign.trim() === '' ? null : batch.value.campaign.trim(),
        note: batch.value.note.trim() === '' ? null : batch.value.note.trim(),
      },
    });
    await load();
  } catch (cause) {
    batchError.value = messageOf(cause, 'ساخت دسته انجام نشد.');
  } finally {
    batchBusy.value = false;
  }
}

/**
 * Hand the batch to the operator as a file.
 *
 * A `Blob` built in the tab from what is already on screen — nothing is fetched
 * and nothing is uploaded, so the codes do not travel anywhere they have not
 * already been. Plain text, one per line, because whatever consumes them next is
 * a mail merge or a spreadsheet.
 */
function downloadBatch(): void {
  if (batchCreated.value === null) return;
  const blob = new Blob([`${batchCreated.value.codes.join('\n')}\n`], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `payetam-gift-codes-${batchCreated.value.batchId}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- ── The one-time batch, above everything, until it is dismissed ──── -->
    <section
      v-if="batchCreated"
      class="rounded-xl border-2 border-warn bg-warn-soft p-4"
      role="alert"
    >
      <h2 class="font-bold text-warn">
        <bdi>{{ formatNumber(batchCreated.codes.length) }}</bdi> کد ساخته شد
      </h2>
      <p class="mt-2 text-sm leading-relaxed">{{ batchCreated.warningFa }}</p>
      <p class="mt-1 text-xs text-ink-faint">
        شناسهٔ دسته: <bdi class="font-mono">{{ batchCreated.batchId }}</bdi>
        <template v-if="batchCreated.campaign"> · کمپین: {{ batchCreated.campaign }}</template>
      </p>

      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink"
          @click="downloadBatch"
        >
          دریافت فایل کدها
        </button>
        <button
          type="button"
          class="min-h-10 rounded-lg border border-line px-4 text-sm"
          @click="batchCreated = null"
        >
          ذخیره کردم، ببند
        </button>
      </div>

      <textarea
        class="mt-3 h-40 w-full rounded-lg border border-line bg-surface p-2 font-mono text-xs"
        dir="ltr"
        readonly
        :value="batchCreated.codes.join('\n')"
      ></textarea>
    </section>

    <!-- ── Campaign roll-up ──────────────────────────────────────────────── -->
    <section
      v-if="campaigns.length > 0"
      class="overflow-x-auto rounded-xl border border-line bg-surface"
    >
      <h2 class="border-b border-line px-4 py-3 text-sm font-semibold">کمپین‌ها</h2>
      <table class="w-full min-w-[48rem] text-sm">
        <thead class="border-b border-line text-ink-soft">
          <tr>
            <th class="px-4 py-2 text-start font-medium">کمپین</th>
            <th class="px-4 py-2 text-start font-medium">کدها</th>
            <th class="px-4 py-2 text-start font-medium">دریافت‌ها</th>
            <th class="px-4 py-2 text-start font-medium">افراد یکتا</th>
            <th class="px-4 py-2 text-start font-medium">سکهٔ اعطاشده</th>
            <th class="px-4 py-2 text-start font-medium">آخرین دریافت</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in campaigns"
            :key="row.campaign"
            class="border-b border-line last:border-0"
          >
            <td class="px-4 py-2 font-medium">{{ row.campaign }}</td>
            <td class="px-4 py-2 tabular-nums">
              <bdi>{{ formatNumber(row.activeCodes) }}</bdi> فعال از
              <bdi>{{ formatNumber(row.codes) }}</bdi>
            </td>
            <td class="px-4 py-2 tabular-nums">
              <bdi>{{ formatNumber(row.redemptions) }}</bdi>
            </td>
            <td class="px-4 py-2 tabular-nums">
              <bdi>{{ formatNumber(row.uniqueUsers) }}</bdi>
            </td>
            <td class="px-4 py-2 tabular-nums">
              <bdi>{{ formatNumber(row.coinsGranted) }}</bdi>
            </td>
            <td class="px-4 py-2 text-ink-soft">{{ formatDate(row.lastRedeemedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Minting ───────────────────────────────────────────────────────── -->
    <section class="grid gap-4 lg:grid-cols-2">
      <form
        class="rounded-xl border border-line bg-surface p-4"
        novalidate
        @submit.prevent="createSingle"
      >
        <h2 class="text-sm font-semibold">ساخت یک کد</h2>
        <p class="mt-1 text-xs text-ink-faint">
          کدی که خودتان انتخاب می‌کنید — برای یک جبران یا یک همکاری مشخص.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">کد</span>
            <input
              v-model="single.code"
              type="text"
              dir="ltr"
              placeholder="NOWRUZ1405"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">سکه</span>
            <input
              v-model.number="single.coins"
              type="number"
              min="1"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">سقف کل دریافت (خالی = بی‌نهایت)</span>
            <input
              v-model="single.maxRedemptions"
              type="number"
              min="1"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">تاریخ انقضا</span>
            <input
              v-model="single.expiresAt"
              type="date"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">کمپین</span>
            <input
              v-model="single.campaign"
              type="text"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">یادداشت</span>
            <input
              v-model="single.note"
              type="text"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
        </div>

        <!--
          Not a field. `perUserLimit` is capped at 1 for anything created from
          now on (ADR-0016), so showing an input that only accepts one value
          would be a control that does nothing.
        -->
        <p class="mt-3 text-xs text-ink-faint">
          سقف هر نفر: <bdi>۱</bdi> — هر کد فقط یک بار برای هر حساب. کمپین با دو عدد محدود می‌شود و
          شل کردن دومی هر دو را بی‌اثر می‌کند.
        </p>

        <p v-if="singleError" class="mt-3 text-sm text-danger" role="alert">{{ singleError }}</p>
        <p
          v-if="singleCreated"
          class="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good"
          role="status"
        >
          ساخته شد: <bdi class="font-mono">{{ singleCreated.code }}</bdi>
        </p>

        <button
          type="submit"
          class="mt-4 min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
          :disabled="!singleValid || singleBusy || !session.canMutate"
        >
          {{ singleBusy ? 'در حال ساخت…' : 'ساخت کد' }}
        </button>
      </form>

      <form
        class="rounded-xl border border-line bg-surface p-4"
        novalidate
        @submit.prevent="createBatch"
      >
        <h2 class="text-sm font-semibold">ساخت دسته‌ای</h2>
        <p class="mt-1 text-xs text-ink-faint">
          کدها روی سرور و با مولد امن ساخته می‌شوند و فقط یک بار نمایش داده می‌شوند.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">تعداد</span>
            <input
              v-model.number="batch.count"
              type="number"
              min="1"
              max="1000"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">سکه</span>
            <input
              v-model.number="batch.coins"
              type="number"
              min="1"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">پیشوند (اختیاری)</span>
            <input
              v-model="batch.prefix"
              type="text"
              dir="ltr"
              placeholder="NOWRUZ"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">طول بخش تصادفی</span>
            <input
              v-model.number="batch.length"
              type="number"
              min="6"
              max="24"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">تاریخ انقضا</span>
            <input
              v-model="batch.expiresAt"
              type="date"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">کمپین</span>
            <input
              v-model="batch.campaign"
              type="text"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
        </div>

        <label class="mt-3 flex items-center gap-2 text-sm">
          <input v-model="batch.isActive" type="checkbox" class="size-4" />
          از همین حالا فعال باشد
        </label>

        <p class="mt-2 text-xs text-ink-faint">
          پیشوند می‌تواند یک واژه باشد، اما رقم‌های <bdi>۰</bdi> و <bdi>۱</bdi> پذیرفته نمی‌شوند:
          واژه خودش را اصلاح می‌کند و رقم تنها این کار را نمی‌کند.
        </p>

        <p v-if="batchError" class="mt-3 text-sm text-danger" role="alert">{{ batchError }}</p>

        <button
          type="submit"
          class="mt-4 min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
          :disabled="!batchValid || batchBusy || !session.canMutate"
        >
          {{ batchBusy ? 'در حال ساخت…' : 'ساخت دسته' }}
        </button>
      </form>
    </section>

    <!-- ── The list ──────────────────────────────────────────────────────── -->
    <section class="flex flex-col gap-3">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">کمپین</span>
          <input
            v-model="campaignFilter"
            type="search"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">یافتن یک کد مشخص</span>
          <input
            v-model="codeFilter"
            type="search"
            dir="ltr"
            placeholder="کد کامل"
            class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">وضعیت</span>
          <select
            v-model="activeFilter"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          >
            <option value="">همه</option>
            <option value="true">فعال</option>
            <option value="false">غیرفعال</option>
          </select>
        </label>
        <p class="text-xs text-ink-faint">
          جست‌وجوی کد فقط با کد کامل کار می‌کند — عمداً، تا کسی نتواند کدهای یک کمپین را فهرست کند.
        </p>
      </form>

      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <StateBlock
        :state="state"
        :error-text="error"
        empty-text="کد هدیه‌ای با این فیلترها نیست."
        @retry="load"
      >
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="w-full min-w-[56rem] text-sm">
            <thead class="border-b border-line text-ink-soft">
              <tr>
                <th class="px-4 py-3 text-start font-medium">کد</th>
                <th class="px-4 py-3 text-start font-medium">کمپین</th>
                <th class="px-4 py-3 text-start font-medium">سکه</th>
                <th class="px-4 py-3 text-start font-medium">دریافت‌ها</th>
                <th class="px-4 py-3 text-start font-medium">وضعیت</th>
                <th class="px-4 py-3 text-start font-medium">انقضا</th>
                <th class="px-4 py-3 text-start font-medium"><span class="sr-only">گزارش</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="code in rows"
                :key="code.publicId"
                class="border-b border-line last:border-0"
              >
                <td class="px-4 py-3">
                  <bdi class="font-mono">{{ code.codeMasked }}</bdi>
                  <span v-if="code.batchId" class="block text-xs text-ink-faint">دسته‌ای</span>
                </td>
                <td class="px-4 py-3">{{ code.campaign ?? '—' }}</td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(code.coins) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(code.redeemedCount) }}</bdi>
                  <template v-if="code.maxRedemptions !== null">
                    از <bdi>{{ formatNumber(code.maxRedemptions) }}</bdi>
                  </template>
                  <span v-else class="text-ink-faint"> (بی‌سقف)</span>
                </td>
                <td class="px-4 py-3"><StatusPill :value="code.state" /></td>
                <td class="px-4 py-3 text-ink-soft">{{ formatDate(code.expiresAt) }}</td>
                <td class="px-4 py-3 text-end">
                  <div class="flex items-center justify-end gap-3">
                    <!--
                      The kill switch, on the list rather than only on the detail
                      page. It has lived on `GiftCodeDetailView` since M19, which
                      meant switching off a leaked code was: find it, open it,
                      scroll, confirm — repeated per code, in an incident, with
                      the last one staying live longest. An operator looking at
                      the list of live codes is exactly the person who needs it.
                    -->
                    <button
                      v-if="session.canMutate && code.isActive"
                      type="button"
                      class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                      :disabled="toggling !== null"
                      @click="pendingDisable = code"
                    >
                      غیرفعال کردن
                    </button>
                    <button
                      v-else-if="session.canMutate && !code.isActive"
                      type="button"
                      class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                      :disabled="toggling !== null"
                      @click="setActive(code, true)"
                    >
                      فعال کردن
                    </button>
                    <RouterLink
                      :to="{ name: 'gift-code-detail', params: { publicId: code.publicId } }"
                      class="text-brand"
                    >
                      گزارش
                    </RouterLink>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <PagerBar
          :total="total"
          :limit="LIMIT"
          :offset="offset"
          :loading="loading"
          @move="offset = $event"
        />
      </StateBlock>
      <p class="text-xs text-ink-faint">
        سقف هر دستهٔ ساخت <bdi>{{ toPersianDigits(1000) }}</bdi> کد است و در تنظیمات قابل تغییر است.
      </p>
    </section>

    <!--
      Disabling is confirmed; re-enabling is not.
      One of the two directions makes a live code unusable for everybody holding
      it, and the other undoes that. Asking twice about the reversible half would
      teach people to click through the dialog that matters.
    -->
    <ConfirmDialog
      :open="pendingDisable !== null"
      title="غیرفعال کردن این کد"
      body="از این پس هیچ‌کس نمی‌تواند این کد را استفاده کند. دریافت‌های انجام‌شده و سکه‌های اعطاشده دست‌نخورده می‌مانند و می‌توانید بعداً دوباره فعالش کنید."
      confirm-label="غیرفعال کن"
      :busy="toggling !== null"
      @cancel="pendingDisable = null"
      @confirm="pendingDisable && setActive(pendingDisable, false)"
    />
  </div>
</template>
