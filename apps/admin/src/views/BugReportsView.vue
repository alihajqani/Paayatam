<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { BugReportListResponse, BugReportStatusView, BugReportView } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDateTime, formatNumber, formatRelative } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * What users say is broken (v0.6.5).
 *
 * ── Why this is not the report queue ────────────────────────────────────────
 *
 * `ReportsView` is moderation: every row is about a person or something they
 * posted, deciding one closes a complaint about somebody, and enough of them
 * hide the thing they name. None of that applies to «دکمه کار نمی‌کند». The two
 * screens look alike because both are queues; they share no table, no threshold
 * and no lifecycle, and `BugReportService` argues the case at length.
 *
 * ── Why the screenshots are not rendered ────────────────────────────────────
 *
 * They cannot be. A Telegram `file_id` is a handle scoped to the bot token — not
 * a URL — so `<img src>` would resolve to nothing, and the alternative is
 * proxying every image through the API with an auth check, a cache and a
 * bandwidth question, for pictures a moderator will open a handful of a day. The
 * count is shown and the ids are copyable; opening one is `getFile` from the bot,
 * which is where the token already lives.
 *
 * ── Why the note is not a reply ─────────────────────────────────────────────
 *
 * The reporter never sees it. A channel back to them would need a tone, a
 * sender, and somebody answerable for what it says; a triage note needs none of
 * those. Writing to a reporter is a deliberate act on the messaging screen.
 */
const session = useSessionStore();

const rows = ref<BugReportView[]>([]);
const total = ref(0);
const status = ref<BugReportStatusView | ''>('OPEN');
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

const STATUS_LABELS: Record<BugReportStatusView, string> = {
  OPEN: 'باز',
  ACKNOWLEDGED: 'در دست بررسی',
  RESOLVED: 'حل شد',
  DISMISSED: 'رد شد',
};

async function load(): Promise<void> {
  error.value = null;
  try {
    const query = status.value === '' ? '' : `?status=${status.value}`;
    const response = await request<BugReportListResponse>(`/bug-reports${query}`);
    rows.value = response.reports;
    total.value = response.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'گزارش‌های مشکل بارگذاری نشد.');
  }
}

watch(status, () => void load());

// ── Deciding one ────────────────────────────────────────────────────────────

const acting = ref<string | null>(null);
const note = ref<Record<string, string>>({});

async function decide(report: BugReportView, next: BugReportStatusView): Promise<void> {
  if (acting.value !== null) return;
  acting.value = report.publicId;
  error.value = null;

  const typed = note.value[report.publicId]?.trim() ?? '';
  try {
    await request<BugReportView>(`/bug-reports/${encodeURIComponent(report.publicId)}`, {
      method: 'POST',
      body: { status: next, ...(typed === '' ? {} : { note: typed }) },
    });
    notice.value = `گزارش به «${STATUS_LABELS[next]}» تغییر کرد.`;
    await load();
  } catch (cause) {
    error.value = messageOf(cause, 'ثبت تغییر انجام نشد.');
  } finally {
    acting.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
      <p>
        آنچه کاربران دربارهٔ خودِ محصول گزارش کرده‌اند — نه گزارش تخلف. هر گزارش نسخهٔ ربات را در
        زمان ثبت همراه دارد، چون نخستین چیزی است که برای بازتولید مشکل لازم است.
      </p>
      <p class="mt-2 text-ink-soft">
        تصویرها روی سرورهای تلگرام می‌مانند و اینجا فقط شناسهٔ آن‌ها نگه‌داری می‌شود؛ باز کردنشان از
        طریق ربات انجام می‌شود. یادداشت شما فقط برای تیم است و به گزارش‌دهنده نشان داده نمی‌شود.
      </p>
    </section>

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <label class="flex items-center gap-2 text-sm">
      <span class="text-ink-soft">وضعیت:</span>
      <select v-model="status" class="min-h-10 rounded-lg border border-line bg-surface px-3">
        <option value="OPEN">باز</option>
        <option value="ACKNOWLEDGED">در دست بررسی</option>
        <option value="RESOLVED">حل شد</option>
        <option value="DISMISSED">رد شد</option>
        <option value="">همه</option>
      </select>
      <span class="text-xs text-ink-faint">
        مجموع: <bdi>{{ formatNumber(total) }}</bdi>
      </span>
    </label>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="گزارشی با این وضعیت ثبت نشده است."
      :rows="4"
      @retry="load"
    >
      <div class="flex flex-col gap-3">
        <article
          v-for="report in rows"
          :key="report.publicId"
          class="rounded-xl border border-line bg-surface p-4"
        >
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              <StatusPill :value="report.status" />
              <span>{{ formatRelative(report.createdAt) }}</span>
              <span v-if="report.appVersion">
                نسخه: <bdi class="font-mono">{{ report.appVersion }}</bdi>
              </span>
              <RouterLink
                v-if="session.can('user.read')"
                :to="{ name: 'user-detail', params: { publicId: report.userPublicId } }"
                class="underline"
              >
                پروندهٔ گزارش‌دهنده
              </RouterLink>
            </div>
            <span
              v-if="report.screenshotFileIds.length > 0"
              class="rounded-full bg-surface-sunken px-2 py-0.5 text-xs"
            >
              🖼 <bdi>{{ formatNumber(report.screenshotFileIds.length) }}</bdi> تصویر
            </span>
          </header>

          <!--
            Plain text, never `v-html`. This is free text a user typed, and the
            same rule the legal documents follow applies for the same reason.
          -->
          <p class="mt-3 text-sm leading-relaxed whitespace-pre-wrap">{{ report.description }}</p>

          <details v-if="report.screenshotFileIds.length > 0" class="mt-2">
            <summary class="cursor-pointer text-xs text-ink-soft">شناسهٔ تصویرها</summary>
            <ul class="mt-2 flex flex-col gap-1">
              <li
                v-for="fileId in report.screenshotFileIds"
                :key="fileId"
                class="rounded bg-surface-sunken px-2 py-1 font-mono text-xs break-all"
              >
                <bdi>{{ fileId }}</bdi>
              </li>
            </ul>
          </details>

          <p v-if="report.adminNote" class="mt-2 text-sm text-ink-soft">
            یادداشت تیم: {{ report.adminNote }}
          </p>
          <p v-if="report.handledAt" class="mt-1 text-xs text-ink-faint">
            رسیدگی: {{ formatDateTime(report.handledAt) }}
          </p>

          <div v-if="session.canMutate" class="mt-3 flex flex-col gap-2">
            <input
              v-model="note[report.publicId]"
              type="text"
              maxlength="2000"
              placeholder="یادداشت داخلی (اختیاری)"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm"
            />
            <div class="flex flex-wrap gap-2">
              <button
                v-for="next in ['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED', 'OPEN'] as const"
                :key="next"
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                :disabled="acting !== null || report.status === next"
                @click="decide(report, next)"
              >
                {{ STATUS_LABELS[next] }}
              </button>
            </div>
          </div>
        </article>
      </div>
    </StateBlock>
  </div>
</template>
