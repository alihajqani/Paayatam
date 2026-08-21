<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type {
  AdminReportListResponse,
  AdminReportView,
  ReportReason,
  ReportStatusView,
  ReportTargetType,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatRelative } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * The report queue.
 *
 * **Oldest first**, from the server — a queue nobody works from the bottom.
 *
 * Two things are deliberately absent, and both are absent from the API rather
 * than hidden here. There is no *claim* or *assign*: `moderation_case` carries an
 * `assigned_admin_id` and nothing writes it, so a button would be a feature the
 * backend does not have. And there is no *escalate*: `decideCase` takes
 * `APPROVED` or `REJECTED`, and `ESCALATED` is a status the automation sets.
 * Both are recorded in `docs/admin-panel.md` as known gaps rather than invented
 * here.
 *
 * Deciding a report closes the complaint. Acting on what it is *about* — hiding
 * the event, banning the account — is a separate act on a separate screen, which
 * is also how the permissions are split: `SUPPORT` holds `report.review` and
 * neither `event.moderate` nor `user.ban`.
 */
const LIMIT = 25;

const session = useSessionStore();

const rows = ref<AdminReportView[]>([]);
const total = ref(0);
const offset = ref(0);
const status = ref<ReportStatusView | ''>('OPEN');
const targetType = ref<ReportTargetType | ''>('');
const from = ref('');
const to = ref('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

/** `2026-08-21` from a date input → an ISO instant the API accepts. */
function toIso(day: string, endOfDay = false): string | undefined {
  if (day === '') return undefined;
  return new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<AdminReportListResponse>('/reports', {
      query: {
        status: status.value,
        targetType: targetType.value,
        from: toIso(from.value),
        to: toIso(to.value, true),
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.reports;
    total.value = page.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست گزارش‌ها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

watch([status, targetType, from, to], () => {
  offset.value = 0;
  void load();
});
watch(offset, () => void load());

// ── Deciding ────────────────────────────────────────────────────────────────

const pending = ref<{ report: AdminReportView; decision: 'ACTIONED' | 'DISMISSED' } | null>(null);
const acting = ref(false);
const actionError = ref<string | null>(null);

async function decide(note: string): Promise<void> {
  if (pending.value === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<void>(`/reports/${pending.value.report.publicId}/decide`, {
      method: 'POST',
      body: { status: pending.value.decision, note },
    });
    notice.value = 'گزارش بسته شد و تصمیم در گزارش رخدادها ثبت شد.';
    pending.value = null;
    await load();
  } catch (cause) {
    // `INVALID_STATE_TRANSITION` here means a colleague answered it first, which
    // is the normal case when two people work one queue — the server's sentence
    // says so and the list refreshes underneath.
    actionError.value = messageOf(cause, 'ثبت تصمیم انجام نشد.');
  } finally {
    acting.value = false;
  }
}

const REASONS: Record<ReportReason, string> = {
  SPAM: 'تبلیغ یا هرزنامه',
  HARASSMENT: 'آزار و توهین',
  INAPPROPRIATE: 'محتوای نامناسب',
  SCAM: 'کلاهبرداری',
  IMPERSONATION: 'جعل هویت',
  SAFETY: 'نگرانی ایمنی',
  OTHER: 'موارد دیگر',
};

const TARGETS: Record<ReportTargetType, string> = {
  EVENT: 'فعالیت',
  USER: 'کاربر',
  MESSAGE: 'گفت‌وگو',
  REVIEW: 'بازخورد',
};

/**
 * How urgent this looks, from the reason alone.
 *
 * The API has no severity column and this does not invent one — it is a *display*
 * ordering hint drawn from `ReportReason`, and it changes the colour of a pill and
 * nothing else. A safety report and a spam report are the same row to the
 * database and are not the same row to a person reading forty of them.
 */
function severity(reason: ReportReason): 'danger' | 'warn' | 'neutral' {
  if (reason === 'SAFETY' || reason === 'HARASSMENT' || reason === 'SCAM') return 'danger';
  if (reason === 'IMPERSONATION' || reason === 'INAPPROPRIATE') return 'warn';
  return 'neutral';
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
          <option value="OPEN">باز</option>
          <option value="ACTIONED">اقدام شد</option>
          <option value="DISMISSED">رد شد</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">نوع مورد</span>
        <select v-model="targetType" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option value="">همه</option>
          <option v-for="(label, key) in TARGETS" :key="key" :value="key">{{ label }}</option>
        </select>
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

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="گزارشی با این فیلترها نیست. صف خالی است."
      @retry="load"
    >
      <ul class="flex flex-col gap-3">
        <li
          v-for="report in rows"
          :key="report.publicId"
          class="rounded-xl border border-line bg-surface p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <StatusPill :value="REASONS[report.reason]" :tone="severity(report.reason)" />
                <span class="text-sm text-ink-soft">
                  دربارهٔ {{ TARGETS[report.targetType] }}
                </span>
                <StatusPill :value="report.status" />
                <span class="text-xs text-ink-faint">
                  {{ formatRelative(report.createdAt) }}
                </span>
              </div>

              <p v-if="report.description" class="mt-2 text-sm leading-relaxed">
                {{ report.description }}
              </p>
              <p v-else class="mt-2 text-sm text-ink-faint">بدون توضیح.</p>

              <p class="mt-2 text-xs text-ink-faint">
                شناسهٔ مورد: <bdi class="font-mono">{{ report.targetId }}</bdi>
                <template v-if="report.moderationCaseId">
                  · پروندهٔ بررسی:
                  <bdi class="font-mono">{{ report.moderationCaseId }}</bdi>
                </template>
              </p>
              <!--
                The reporter, as a public id and never to the reported party
                (§7). It is here because a moderator has to be able to see a
                pattern — the same account reporting a rival ten times is the
                brigading T6.2 exists for.
              -->
              <p class="mt-1 text-xs text-ink-faint">
                گزارش‌دهنده:
                <RouterLink
                  v-if="session.can('user.read')"
                  :to="{ name: 'user-detail', params: { publicId: report.reporterPublicId } }"
                  class="text-brand"
                >
                  <bdi class="font-mono">{{ report.reporterPublicId }}</bdi>
                </RouterLink>
                <bdi v-else class="font-mono">{{ report.reporterPublicId }}</bdi>
              </p>
            </div>

            <div v-if="report.status === 'OPEN'" class="flex shrink-0 gap-2">
              <button
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="pending = { report, decision: 'DISMISSED' }"
              >
                رد گزارش
              </button>
              <button
                type="button"
                class="min-h-9 rounded-lg border border-danger px-3 text-sm text-danger disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="pending = { report, decision: 'ACTIONED' }"
              >
                اقدام شد
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
    :title="pending?.decision === 'ACTIONED' ? 'ثبت اقدام روی گزارش' : 'رد کردن گزارش'"
    :body="
      pending?.decision === 'ACTIONED'
        ? 'گزارش بسته می‌شود. اقدام روی خودِ مورد — پنهان کردن فعالیت یا محدود کردن حساب — کار جداگانه‌ای در صفحهٔ مربوط به آن است.'
        : 'گزارش بدون اقدام بسته می‌شود. گزارش‌دهنده از این تصمیم باخبر نمی‌شود.'
    "
    :confirm-label="pending?.decision === 'ACTIONED' ? 'اقدام شد' : 'رد گزارش'"
    :tone="pending?.decision === 'ACTIONED' ? 'danger' : 'default'"
    reason-label="یادداشت تصمیم (در گزارش رخدادها ثبت می‌شود)"
    :reason-min-length="3"
    :busy="acting"
    :error="actionError"
    @cancel="pending = null"
    @confirm="decide"
  />
</template>
