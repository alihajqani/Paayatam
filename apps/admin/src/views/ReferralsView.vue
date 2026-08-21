<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type {
  ReferralListResponse,
  ReferralRejectionReasonView,
  ReferralReviewView,
  ReferralStatusView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDateTime } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * The fraud queue T6 has been writing signals into since M9.
 *
 * Velocity was recorded *for admin review* and there was no admin surface to
 * review it from, and no state to move a referral into — `REJECTED` was an enum
 * value nothing wrote. This is the other half.
 *
 * **Nothing on this screen can pay anybody.** Rejecting withholds a reward that
 * has not been earned; reinstating restores the chance to earn one, and the
 * attendance condition is still checked by `ReferralService`. That is why
 * `referral.manage` can be held by `MODERATOR` while `coin.adjust` stays with
 * `SUPER_ADMIN` alone — and why there is no button from `REJECTED` straight to
 * `QUALIFIED`.
 *
 * A referral that has already **paid** cannot be rejected at all: two ledger rows
 * say it did, the ledger is append-only, and a status contradicting them would be
 * a record disagreeing with itself. The server refuses it; the panel does not
 * offer it.
 *
 * Two people, both as public ids and neither by name. Reviewing a referral for
 * fraud is a question about behaviour — how many, how fast — and a display name
 * answers none of it while putting two profiles on a screen with no reason for
 * them.
 */
const LIMIT = 25;

const session = useSessionStore();

const rows = ref<ReferralReviewView[]>([]);
const total = ref(0);
const offset = ref(0);
const status = ref<ReferralStatusView | ''>('');
const flagged = ref<'' | 'true'>('');
const referrer = ref('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const expanded = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<ReferralListResponse>('/referrals', {
      query: {
        status: status.value,
        flagged: flagged.value,
        referrerPublicId: referrer.value.trim(),
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.referrals;
    total.value = page.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست معرفی‌ها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([status, flagged, referrer], () => {
  offset.value = 0;
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});
watch(offset, () => void load());

// ── Deciding ────────────────────────────────────────────────────────────────

const REASONS: Record<ReferralRejectionReasonView, string> = {
  SELF_REFERRAL: 'معرفی خود',
  DUPLICATE: 'معرفی تکراری',
  INVALID_CODE: 'کد نامعتبر یا حساب مسدود',
  FRAUD: 'سوءاستفادهٔ تأییدشده',
  INELIGIBLE: 'شرط واجد شرایط شدن هرگز محقق نمی‌شود',
  ADMIN_DECISION: 'تصمیم مدیر',
};

const pending = ref<{ entry: ReferralReviewView; kind: 'reject' | 'reinstate' } | null>(null);
const reason = ref<ReferralRejectionReasonView>('FRAUD');
const acting = ref(false);
const actionError = ref<string | null>(null);

async function decide(note: string): Promise<void> {
  if (pending.value === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    if (pending.value.kind === 'reject') {
      await request<ReferralReviewView>(`/referrals/${pending.value.entry.id}/reject`, {
        method: 'POST',
        body: { reason: reason.value, note },
      });
      notice.value = 'معرفی رد شد. هیچ پاداشی برای آن ثبت نمی‌شود.';
    } else {
      await request<ReferralReviewView>(`/referrals/${pending.value.entry.id}/reinstate`, {
        method: 'POST',
        body: { note },
      });
      notice.value =
        'معرفی به حالت «در انتظار» بازگشت. این کار پاداشی پرداخت نمی‌کند — شرط حضور در یک فعالیت همچنان باید محقق شود.';
    }
    pending.value = null;
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'ثبت تصمیم انجام نشد.');
  } finally {
    acting.value = false;
  }
}

/** The fraud signals, as readable lines rather than a JSON dump. */
function signalLines(signals: unknown): string[] {
  if (typeof signals !== 'object' || signals === null) return [];
  return Object.entries(signals as Record<string, unknown>).map(
    ([key, value]) => `${key}: ${String(value)}`,
  );
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">وضعیت</span>
        <select v-model="status" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option value="">همه</option>
          <option value="PENDING">در انتظار</option>
          <option value="QUALIFIED">واجد شرایط</option>
          <option value="REJECTED">رد شده</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">نشانه‌دار</span>
        <select v-model="flagged" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option value="">همه</option>
          <option value="true">فقط نشانه‌دارها</option>
        </select>
      </label>
      <label class="flex min-w-64 flex-1 flex-col gap-1">
        <span class="text-sm text-ink-soft">شناسهٔ عمومی معرف</span>
        <input
          v-model="referrer"
          type="search"
          dir="ltr"
          placeholder="برای دیدن همهٔ دعوت‌های یک حساب"
          class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
    </form>

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="معرفی‌ای با این فیلترها نیست."
      @retry="load"
    >
      <ul class="flex flex-col gap-3">
        <li
          v-for="entry in rows"
          :key="entry.id"
          class="rounded-xl border bg-surface p-4"
          :class="entry.flagged ? 'border-warn' : 'border-line'"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <StatusPill :value="entry.status" />
                <span
                  v-if="entry.flagged"
                  class="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
                >
                  نشانهٔ سوءاستفاده
                </span>
                <span class="text-xs text-ink-faint">{{ formatDateTime(entry.createdAt) }}</span>
              </div>

              <p class="mt-2 text-sm">
                معرف:
                <RouterLink
                  v-if="session.can('user.read')"
                  :to="{ name: 'user-detail', params: { publicId: entry.referrerPublicId } }"
                  class="text-brand"
                >
                  <bdi class="font-mono text-xs">{{ entry.referrerPublicId }}</bdi>
                </RouterLink>
                <bdi v-else class="font-mono text-xs">{{ entry.referrerPublicId }}</bdi>
              </p>
              <p class="text-sm">
                معرفی‌شده:
                <RouterLink
                  v-if="session.can('user.read')"
                  :to="{ name: 'user-detail', params: { publicId: entry.referredPublicId } }"
                  class="text-brand"
                >
                  <bdi class="font-mono text-xs">{{ entry.referredPublicId }}</bdi>
                </RouterLink>
                <bdi v-else class="font-mono text-xs">{{ entry.referredPublicId }}</bdi>
              </p>

              <p v-if="entry.status === 'QUALIFIED'" class="mt-2 text-xs text-good">
                پاداش پرداخت شده است ({{ formatDateTime(entry.qualifiedAt) }}). این وضعیت نهایی است
                — دو ردیف دفتر سکه پشت آن هستند و دفتر فقط افزودنی است.
              </p>
              <p v-if="entry.status === 'REJECTED'" class="mt-2 text-xs text-danger">
                رد شده در {{ formatDateTime(entry.rejectedAt) }}
                <template v-if="entry.rejectionReason">
                  · {{ REASONS[entry.rejectionReason] }}
                </template>
              </p>

              <button
                v-if="entry.flagged || entry.reviewNote"
                type="button"
                class="mt-2 text-xs text-brand"
                @click="expanded = expanded === entry.id ? null : entry.id"
              >
                {{ expanded === entry.id ? 'بستن جزئیات' : 'جزئیات بررسی' }}
              </button>

              <div
                v-if="expanded === entry.id"
                class="mt-2 rounded-lg bg-surface-sunken p-3 text-xs"
              >
                <!--
                  Internal only, and it stays that way: naming the signal that
                  fired to the person it fired on is telling a farmer what to
                  change (T6). Nothing a user can reach carries any of this.
                -->
                <p class="text-ink-faint">
                  این اطلاعات فقط برای تیم است و به کاربر نشان داده نمی‌شود.
                </p>
                <ul v-if="entry.flagged" class="mt-1 flex flex-col gap-0.5 font-mono">
                  <li v-for="line in signalLines(entry.fraudSignals)" :key="line">
                    <bdi>{{ line }}</bdi>
                  </li>
                </ul>
                <p v-if="entry.reviewNote" class="mt-2">یادداشت: {{ entry.reviewNote }}</p>
              </div>
            </div>

            <div class="flex shrink-0 gap-2">
              <button
                v-if="entry.status === 'PENDING'"
                type="button"
                class="min-h-9 rounded-lg border border-danger px-3 text-sm text-danger disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="
                  pending = { entry, kind: 'reject' };
                  reason = 'FRAUD';
                "
              >
                رد کردن
              </button>
              <button
                v-if="entry.status === 'REJECTED'"
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="pending = { entry, kind: 'reinstate' }"
              >
                بازگرداندن به انتظار
              </button>
            </div>
          </div>
        </li>
      </ul>

      <PagerBar
        :total="total"
        :limit="LIMIT"
        :offset="offset"
        :loading="loading"
        @move="offset = $event"
      />
    </StateBlock>
  </div>

  <ConfirmDialog
    :open="pending !== null"
    :title="pending?.kind === 'reject' ? 'رد کردن این معرفی' : 'بازگرداندن به حالت انتظار'"
    :body="
      pending?.kind === 'reject'
        ? 'پاداشی برای این معرفی ثبت نمی‌شود، حتی اگر کاربر بعداً در فعالیتی حاضر شود. این تصمیم برگشت‌پذیر است.'
        : 'معرفی دوباره «در انتظار» می‌شود. این کار به‌تنهایی پاداشی پرداخت نمی‌کند؛ شرط حضور در یک فعالیت همچنان بررسی می‌شود.'
    "
    :confirm-label="pending?.kind === 'reject' ? 'رد کن' : 'بازگردان'"
    :tone="pending?.kind === 'reject' ? 'danger' : 'default'"
    reason-label="یادداشت داخلی (الزامی — به کاربر نشان داده نمی‌شود)"
    :busy="acting"
    :error="actionError"
    @cancel="pending = null"
    @confirm="decide"
  />

  <!--
    The reason code, beside the dialog rather than inside it: the dialog's own
    field is free text for the next moderator, and this is the countable half —
    «چند معرفی را برای سرعت غیرعادی رد می‌کنیم؟» is a question only a code can
    answer.
  -->
  <div
    v-if="pending?.kind === 'reject'"
    class="fixed inset-x-0 bottom-6 z-50 mx-auto w-full max-w-md px-4"
  >
    <label
      class="flex items-center gap-2 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm shadow-lg"
    >
      <span class="shrink-0 text-ink-soft">دلیل:</span>
      <select v-model="reason" class="min-h-9 flex-1 rounded-lg border border-line bg-surface px-2">
        <option v-for="(label, key) in REASONS" :key="key" :value="key">{{ label }}</option>
      </select>
    </label>
  </div>
</template>
