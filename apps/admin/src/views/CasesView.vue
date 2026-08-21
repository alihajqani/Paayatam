<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type {
  ModerationCaseStatus,
  ModerationCaseView,
  ModerationQueueResponse,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatRelative, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * The moderation queue — the *cases*, as opposed to the individual reports.
 *
 * A case is what the automation opens: three distinct reporters, or a blacklist
 * match. Deciding one is the decision that matters, because it closes every
 * report attached to it **and**, for an event, restores or keeps hiding the
 * subject in the same transaction.
 *
 * `falsePositive` is on the form and is not decoration: ADR-0012's tuning depends
 * on it. A moderator dismissing an auto-blacklist case is saying the scanner was
 * wrong, and unless that is countable the blacklist can only ever get more
 * aggressive.
 *
 * The list is `take: 100` server-side and oldest-first, and has no pager for that
 * reason: a backlog past a hundred open cases is an incident rather than a page-2
 * problem, and the dashboard is where that shows up.
 */
const session = useSessionStore();

const rows = ref<ModerationCaseView[]>([]);
const status = ref<ModerationCaseStatus | ''>('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<ModerationQueueResponse>('/moderation/cases', {
      query: { status: status.value },
    });
    rows.value = page.cases;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'صف بررسی بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

watch(status, () => void load());

const pending = ref<{
  entry: ModerationCaseView;
  decision: 'APPROVED' | 'REJECTED';
} | null>(null);
const falsePositive = ref(false);
const acting = ref(false);
const actionError = ref<string | null>(null);

async function decide(note: string): Promise<void> {
  if (pending.value === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<void>(`/moderation/cases/${pending.value.entry.id}/decide`, {
      method: 'POST',
      body: {
        decision: pending.value.decision,
        note,
        // Only meaningful on a dismissal, and only for a case the automation
        // opened: "the scanner was wrong" is not a thing to say about three
        // people who complained.
        ...(pending.value.decision === 'APPROVED' && pending.value.entry.trigger !== 'MANUAL'
          ? { falsePositive: falsePositive.value }
          : {}),
      },
    });
    notice.value = 'پرونده بسته شد. گزارش‌های مرتبط هم بسته شدند.';
    pending.value = null;
    falsePositive.value = false;
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'ثبت تصمیم انجام نشد.');
  } finally {
    acting.value = false;
  }
}

const SUBJECTS: Record<string, string> = {
  EVENT: 'فعالیت',
  USER: 'کاربر',
  MESSAGE: 'گفت‌وگو',
  REVIEW: 'بازخورد',
};

const TRIGGERS: Record<string, string> = {
  AUTO_BLACKLIST: 'تشخیص خودکار واژگان',
  REPORT_THRESHOLD: 'رسیدن به آستانهٔ گزارش',
  MANUAL: 'ثبت دستی',
};

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">وضعیت پرونده</span>
        <select v-model="status" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option value="">باز و در حال بررسی</option>
          <option value="OPEN">باز</option>
          <option value="IN_REVIEW">در حال بررسی</option>
          <option value="ESCALATED">ارجاع شده</option>
          <option value="APPROVED">تأیید شده</option>
          <option value="REJECTED">تأیید نشده</option>
        </select>
      </label>
      <button
        type="button"
        class="min-h-10 rounded-lg border border-line px-4 text-sm"
        :disabled="loading"
        @click="load"
      >
        به‌روزرسانی
      </button>
    </div>

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="پروندهٔ بازی نیست. صف بررسی خالی است."
      @retry="load"
    >
      <ul class="flex flex-col gap-3">
        <li
          v-for="entry in rows"
          :key="entry.id"
          class="rounded-xl border border-line bg-surface p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <StatusPill :value="entry.status" />
                <span class="text-sm"
                  >دربارهٔ {{ SUBJECTS[entry.subjectType] ?? entry.subjectType }}</span
                >
                <span class="text-xs text-ink-faint">{{ formatRelative(entry.createdAt) }}</span>
              </div>
              <p class="mt-2 text-sm text-ink-soft">
                علت باز شدن: {{ TRIGGERS[entry.trigger] ?? entry.trigger }}
                <template v-if="entry.reportCount > 0">
                  · <bdi>{{ toPersianDigits(entry.reportCount) }}</bdi> گزارش
                </template>
              </p>
              <p class="mt-1 text-xs text-ink-faint">
                شناسهٔ مورد: <bdi class="font-mono">{{ entry.subjectId }}</bdi>
              </p>
            </div>

            <div
              v-if="['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(entry.status)"
              class="flex shrink-0 gap-2"
            >
              <button
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="pending = { entry, decision: 'APPROVED' }"
              >
                ایرادی ندارد
              </button>
              <button
                type="button"
                class="min-h-9 rounded-lg border border-danger px-3 text-sm text-danger disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="pending = { entry, decision: 'REJECTED' }"
              >
                تأیید نمی‌شود
              </button>
            </div>
          </div>
        </li>
      </ul>
    </StateBlock>
  </div>

  <ConfirmDialog
    :open="pending !== null"
    :title="pending?.decision === 'APPROVED' ? 'بستن پرونده بدون اقدام' : 'تأیید نکردن مورد'"
    :body="
      pending?.decision === 'APPROVED'
        ? 'اگر مورد یک فعالیت پنهان‌شده باشد، دوباره منتشر می‌شود. همهٔ گزارش‌های این پرونده بسته می‌شوند.'
        : 'مورد پنهان می‌ماند و گزارش‌های این پرونده «اقدام شد» علامت می‌خورند.'
    "
    :confirm-label="pending?.decision === 'APPROVED' ? 'ایرادی ندارد' : 'تأیید نمی‌شود'"
    :tone="pending?.decision === 'APPROVED' ? 'default' : 'danger'"
    reason-label="یادداشت تصمیم (الزامی — پروندهٔ بسته باید توضیح داشته باشد)"
    :reason-min-length="3"
    :busy="acting"
    :error="actionError"
    @cancel="
      pending = null;
      falsePositive = false;
    "
    @confirm="decide"
  >
  </ConfirmDialog>

  <!--
    Outside the dialog's own fields because it is a *classification*, not a
    reason: it says the scanner was wrong, which is what turns ADR-0012's
    false-positive rate into a number instead of an impression.
  -->
  <div
    v-if="pending?.decision === 'APPROVED' && pending.entry.trigger !== 'MANUAL'"
    class="fixed inset-x-0 bottom-6 z-50 mx-auto w-full max-w-md px-4"
  >
    <label
      class="flex items-center gap-2 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm shadow-lg"
    >
      <input v-model="falsePositive" type="checkbox" class="size-4" />
      تشخیص خودکار اشتباه بود (برای سنجش دقت فهرست واژگان ثبت می‌شود)
    </label>
  </div>
</template>
