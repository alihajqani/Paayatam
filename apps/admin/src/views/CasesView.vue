<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type {
  ModerationCaseDetail,
  ModerationCaseStatus,
  ModerationCaseView,
  ModerationQueueResponse,
} from '@payetam/shared';
import { RouterLink } from 'vue-router';
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
 *
 * ── What this screen was, and what was wrong with it (v0.7.0) ────────────────
 *
 * A row said «دربارهٔ فعالیت · رسیدن به آستانهٔ گزارش · ۳ گزارش» and printed an
 * internal id, beside two buttons that decide the case. So a moderator was being
 * asked to judge content they could not see, on complaints they could not read,
 * about an account they could not identify — with no way to say "I am working
 * this one" and no way to send it to somebody senior short of deciding it.
 *
 * «باز کردن» now fetches the case: the activity's own title, description and
 * current status, who owns it, every complaint with its reason and the words the
 * reporter wrote, and how many blacklist terms fired. The actions under it are
 * the four a queue actually needs — claim, escalate, and the two decisions —
 * plus links to the two screens where acting on the *subject* lives, because
 * hiding an activity and banning an account are different permissions and belong
 * behind their own confirmations.
 *
 * **Who reported is not here and never will be.** The complaints arrive without
 * their authors: an admin who bans a host must not be able to hand them a list of
 * names, and a reporting system whose use has a personal cost stops being used at
 * the moment it matters.
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

// ── Acting on one ───────────────────────────────────────────────────────────

const acting = ref(false);
const actionError = ref<string | null>(null);

// ── One case, opened ────────────────────────────────────────────────────────

const opened = ref<ModerationCaseDetail | null>(null);
const openingId = ref<string | null>(null);
const openError = ref<string | null>(null);

async function open(entry: ModerationCaseView): Promise<void> {
  if (opened.value?.id === entry.id) {
    opened.value = null;
    return;
  }
  openingId.value = entry.id;
  openError.value = null;
  try {
    opened.value = await request<ModerationCaseDetail>(`/moderation/cases/${entry.id}`);
  } catch (cause) {
    openError.value = messageOf(cause, 'پرونده بارگذاری نشد.');
  } finally {
    openingId.value = null;
  }
}

/**
 * Claim, hand back, or send up.
 *
 * `assigned_admin_id` and `ESCALATED` have existed since M12 with nothing writing
 * either, so two people working one queue had no way to say «این با من است».
 */
async function triage(id: string, action: 'CLAIM' | 'RELEASE' | 'ESCALATE'): Promise<void> {
  acting.value = true;
  actionError.value = null;
  try {
    await request<void>(`/moderation/cases/${id}/triage`, { method: 'POST', body: { action } });
    notice.value =
      action === 'CLAIM'
        ? 'پرونده به شما سپرده شد.'
        : action === 'RELEASE'
          ? 'پرونده آزاد شد.'
          : 'پرونده ارجاع داده شد.';
    await load();
    if (opened.value?.id === id) opened.value = await request(`/moderation/cases/${id}`);
  } catch (cause) {
    actionError.value = messageOf(cause, 'تغییر وضعیت انجام نشد.');
  } finally {
    acting.value = false;
  }
}

const REASONS: Record<string, string> = {
  SPAM: 'تبلیغ یا هرزنامه',
  HARASSMENT: 'آزار و توهین',
  INAPPROPRIATE: 'محتوای نامناسب',
  SCAM: 'کلاهبرداری',
  SAFETY: 'نگرانی برای ایمنی',
  IMPERSONATION: 'جعل هویت',
  OTHER: 'سایر',
};

const EVENT_STATUS: Record<string, string> = {
  DRAFT: 'پیش‌نویس',
  PENDING_MODERATION: 'در انتظار بررسی',
  PUBLISHED: 'منتشرشده',
  HIDDEN: 'پنهان‌شده',
  REJECTED: 'تأیید نشده',
  CANCELLED_BY_HOST: 'لغو شده',
  ONGOING: 'در حال برگزاری',
  COMPLETED: 'برگزار شده',
  EXPIRED: 'منقضی',
  DELETED: 'حذف‌شده',
};

const pending = ref<{
  entry: ModerationCaseView;
  decision: 'APPROVED' | 'REJECTED';
} | null>(null);
const falsePositive = ref(false);

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
    opened.value = null;
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
            </div>

            <div class="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-sm"
                :disabled="openingId === entry.id"
                @click="open(entry)"
              >
                {{ opened?.id === entry.id ? 'بستن' : 'باز کردن' }}
              </button>
              <template v-if="['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(entry.status)">
                <button
                  type="button"
                  class="min-h-9 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                  :disabled="!session.canMutate || acting"
                  @click="triage(entry.id, entry.status === 'OPEN' ? 'CLAIM' : 'RELEASE')"
                >
                  {{ entry.status === 'OPEN' ? 'بررسی می‌کنم' : 'آزاد کردن' }}
                </button>
                <button
                  v-if="entry.status !== 'ESCALATED'"
                  type="button"
                  class="min-h-9 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                  :disabled="!session.canMutate || acting"
                  @click="triage(entry.id, 'ESCALATE')"
                >
                  ارجاع به سرپرست
                </button>
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
              </template>
            </div>
          </div>

          <!--
            The case itself, which is what a decision is actually made from.
            Everything here is the moderator's to read *except* who reported —
            the complaints arrive without their authors, and they must.
          -->
          <div
            v-if="opened?.id === entry.id"
            class="mt-4 flex flex-col gap-3 rounded-lg bg-surface-sunken p-4 text-sm"
          >
            <div v-if="opened.eventTitle !== null" class="flex flex-col gap-1">
              <p class="font-medium">{{ opened.eventTitle }}</p>
              <p class="whitespace-pre-line text-ink-soft">{{ opened.eventDescription }}</p>
              <p class="text-xs text-ink-faint">
                وضعیت فعلی فعالیت:
                {{ EVENT_STATUS[opened.eventStatus ?? ''] ?? opened.eventStatus }}
              </p>
            </div>

            <p v-if="opened.ownerDisplayName !== null" class="text-ink-soft">
              صاحب مورد: {{ opened.ownerDisplayName }}
            </p>

            <p v-if="opened.matchedTermCount > 0" class="text-ink-soft">
              تشخیص خودکار: <bdi>{{ toPersianDigits(opened.matchedTermCount) }}</bdi> واژهٔ
              فهرست‌شده
            </p>

            <div v-if="opened.reports.length > 0" class="flex flex-col gap-2">
              <p class="font-medium">گزارش‌ها</p>
              <ul class="flex flex-col gap-2">
                <li
                  v-for="report in opened.reports"
                  :key="report.publicId"
                  class="rounded-lg border border-line bg-surface p-3"
                >
                  <p class="text-xs text-ink-faint">
                    {{ REASONS[report.reason] ?? report.reason }} ·
                    {{ formatRelative(report.createdAt) }}
                  </p>
                  <p v-if="report.description" class="mt-1 whitespace-pre-line">
                    {{ report.description }}
                  </p>
                  <p v-else class="mt-1 text-ink-faint">بدون توضیح</p>
                </li>
              </ul>
              <!--
                Stated rather than merely absent: an operator who cannot see a
                name should know it was withheld on purpose, not assume the data
                failed to load.
              -->
              <p class="text-xs text-ink-faint">
                نام گزارش‌دهندگان عمداً نشان داده نمی‌شود.
              </p>
            </div>

            <p v-if="opened.decisionNote" class="text-ink-soft">
              یادداشت تصمیم: {{ opened.decisionNote }}
            </p>

            <!--
              Acting on the *subject* is a different permission and a different
              confirmation, so it lives on its own screen rather than behind a
              button here.
            -->
            <div class="flex flex-wrap gap-3 text-sm">
              <RouterLink
                v-if="opened.eventPublicId !== null"
                :to="{ name: 'events', query: { q: opened.eventTitle ?? '' } }"
                class="underline"
              >
                رفتن به فعالیت
              </RouterLink>
              <RouterLink
                v-if="opened.ownerUserPublicId !== null"
                :to="{ name: 'user-detail', params: { publicId: opened.ownerUserPublicId } }"
                class="underline"
              >
                رفتن به حساب کاربر
              </RouterLink>
            </div>
          </div>

          <p v-if="openError && openingId === null" class="mt-2 text-sm text-danger">
            {{ openError }}
          </p>
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
