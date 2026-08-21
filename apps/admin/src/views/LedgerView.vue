<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type {
  AdminLedgerEntryView,
  AdminLedgerResponse,
  ReconciliationResponse,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import { formatDateTime, formatNumber, formatSigned } from '@/format/fa';

/**
 * The coin ledger, and the invariant behind it (ADR-0007).
 *
 * This is what makes "where did my coins go?" answerable by somebody other than
 * the person asking — which is the whole reason `SUPPORT` holds `ledger.read`
 * and deliberately does **not** hold `coin.adjust`: reading the ledger is how a
 * support conversation is resolved, and moving a balance is not a support action.
 *
 * **There is nothing to edit here and no button to add one.** `coin_ledger`
 * carries a `BEFORE UPDATE OR DELETE` trigger, so there is no writing path to
 * expose — corrections are new `REVERSAL` rows pointing at the original, which
 * appear in this list like anything else.
 *
 * The net is summed over the **whole filter** rather than the page, because
 * "what did this campaign cost us?" is a question about every matching row.
 *
 * Reconciliation asks ADR-0007's invariant of the live database:
 * `balance = SUM(coin_ledger.amount)`, per account. `reconciliation.int.test.ts`
 * asserts it on every commit against a database a test built; this is the version
 * that matters at three in the morning, and it names the accounts that disagree
 * rather than answering with a boolean nobody can act on.
 */
const LIMIT = 50;

const route = useRoute();

const rows = ref<AdminLedgerEntryView[]>([]);
const total = ref(0);
const net = ref(0);
const offset = ref(0);
const userPublicId = ref(
  typeof route.query.userPublicId === 'string' ? route.query.userPublicId : '',
);
const type = ref('');
const refType = ref('');
const from = ref('');
const to = ref('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);

const reconciliation = ref<ReconciliationResponse | null>(null);
const reconciling = ref(false);
const reconcileError = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

function toIso(day: string, endOfDay = false): string | undefined {
  if (day === '') return undefined;
  return new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<AdminLedgerResponse>('/ledger', {
      query: {
        userPublicId: userPublicId.value.trim(),
        type: type.value,
        refType: refType.value.trim(),
        from: toIso(from.value),
        to: toIso(to.value, true),
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.entries;
    total.value = page.total;
    net.value = page.net;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'دفتر سکه بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

async function reconcile(): Promise<void> {
  reconciling.value = true;
  reconcileError.value = null;
  try {
    reconciliation.value = await request<ReconciliationResponse>('/ledger/reconcile');
  } catch (cause) {
    reconcileError.value = messageOf(cause, 'تطبیق انجام نشد.');
  } finally {
    reconciling.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([userPublicId, type, refType, from, to], () => {
  offset.value = 0;
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});
watch(offset, () => void load());

/** Persian for every ledger type (glossary §1, plan §11.2). */
const TYPES: Record<string, string> = {
  ONBOARDING_REWARD: 'پاداش تکمیل پروفایل',
  REFERRAL_REWARD: 'پاداش معرفی دوستان',
  REVIEW_REWARD: 'پاداش ثبت بازخورد',
  GIFT_CODE_REDEEM: 'دریافت کد هدیه',
  BOOST_SPEND: 'ارتقای نمایش',
  VIP_SPEND: 'نمایش ویژه',
  CANCELLATION_PENALTY: 'جریمهٔ لغو',
  NO_SHOW_PENALTY: 'جریمهٔ عدم حضور',
  HOST_CANCELLATION_REFUND: 'بازپرداخت لغو میزبان',
  ADMIN_ADJUSTMENT: 'اصلاح دستی مدیر',
  REVERSAL: 'برگشت تراکنش',
};

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="flex min-w-64 flex-1 flex-col gap-1">
        <span class="text-sm text-ink-soft">شناسهٔ عمومی کاربر</span>
        <input
          v-model="userPublicId"
          type="search"
          dir="ltr"
          class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">نوع تراکنش</span>
        <select v-model="type" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option value="">همه</option>
          <option v-for="(label, key) in TYPES" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">منبع</span>
        <input
          v-model="refType"
          type="search"
          dir="ltr"
          placeholder="gift_code، referral، event"
          class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">از تاریخ</span>
        <input
          v-model="from"
          type="date"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">تا تاریخ</span>
        <input
          v-model="to"
          type="date"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>
    </form>

    <section
      class="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface px-4 py-3"
    >
      <p class="text-sm">
        خالص این فیلتر:
        <bdi class="font-bold tabular-nums" :class="net < 0 ? 'text-danger' : 'text-good'">
          {{ formatSigned(net) }}
        </bdi>
        سکه در <bdi class="tabular-nums">{{ formatNumber(total) }}</bdi> تراکنش
      </p>

      <button
        type="button"
        class="ms-auto min-h-9 rounded-lg border border-line px-3 text-sm"
        :disabled="reconciling"
        @click="reconcile"
      >
        {{ reconciling ? 'در حال تطبیق…' : 'تطبیق موجودی‌ها با دفتر' }}
      </button>
    </section>

    <p
      v-if="reconcileError"
      class="rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger"
      role="alert"
    >
      {{ reconcileError }}
    </p>

    <section
      v-if="reconciliation"
      class="rounded-xl border p-4"
      :class="
        reconciliation.drifted.length === 0
          ? 'border-good bg-good-soft'
          : 'border-danger bg-danger-soft'
      "
      role="status"
    >
      <p v-if="reconciliation.drifted.length === 0" class="text-sm text-good">
        هر <bdi class="tabular-nums">{{ formatNumber(reconciliation.accounts) }}</bdi> حساب با
        دفترشان می‌خوانند.
      </p>
      <div v-else class="text-sm text-danger">
        <p class="font-bold">
          <bdi>{{ formatNumber(reconciliation.drifted.length) }}</bdi>
          حساب با دفترشان نمی‌خوانند. این یک رخداد است، نه یک هشدار.
        </p>
        <ul class="mt-2 flex flex-col gap-1 font-mono text-xs">
          <li v-for="row in reconciliation.drifted" :key="row.userPublicId">
            <bdi>{{ row.userPublicId }}</bdi> — موجودی <bdi>{{ row.balance }}</bdi
            >، دفتر <bdi>{{ row.ledger }}</bdi>
          </li>
        </ul>
      </div>
    </section>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="تراکنشی با این فیلترها نیست."
      @retry="load"
    >
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[56rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">کاربر</th>
              <th class="px-4 py-3 text-start font-medium">مبلغ</th>
              <th class="px-4 py-3 text-start font-medium">موجودی پس از آن</th>
              <th class="px-4 py-3 text-start font-medium">نوع</th>
              <th class="px-4 py-3 text-start font-medium">عامل</th>
              <th class="px-4 py-3 text-start font-medium">زمان</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, index) in rows"
              :key="`${entry.userPublicId}-${entry.createdAt}-${String(index)}`"
              class="border-b border-line last:border-0"
            >
              <td class="px-4 py-3">
                <RouterLink
                  :to="{ name: 'user-detail', params: { publicId: entry.userPublicId } }"
                  class="text-brand"
                >
                  <bdi class="font-mono text-xs">{{ entry.userPublicId }}</bdi>
                </RouterLink>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi class="font-bold" :class="entry.amount < 0 ? 'text-danger' : 'text-good'">
                  {{ formatSigned(entry.amount) }}
                </bdi>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(entry.balanceAfter) }}</bdi>
              </td>
              <td class="px-4 py-3">
                {{ TYPES[entry.type] ?? entry.type }}
                <span v-if="entry.refType" class="block text-xs text-ink-faint">
                  منبع: <bdi class="font-mono">{{ entry.refType }}</bdi>
                </span>
              </td>
              <td class="px-4 py-3 text-ink-soft">
                <bdi class="font-mono text-xs">{{ entry.actorType }}</bdi>
                <span class="block text-xs text-ink-faint">
                  <bdi class="font-mono">{{ entry.reasonCode }}</bdi>
                </span>
              </td>
              <td class="px-4 py-3 text-ink-soft">{{ formatDateTime(entry.createdAt) }}</td>
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

    <p class="text-xs leading-relaxed text-ink-faint">
      این دفتر فقط افزودنی است و هیچ مسیری برای ویرایش یا حذف ردیف‌هایش وجود ندارد — اصلاح، یک ردیف
      تازه از نوع «برگشت تراکنش» است که به ردیف اصلی اشاره می‌کند.
    </p>
  </div>
</template>
