<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { AdminEventListResponse, AdminEventStatus, AdminEventView } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDateTime, formatNumber, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Events, and the two things a moderator does to one.
 *
 * Search runs against `title_normalized` — the column the ADR-0012 pipeline
 * wrote and the column discovery searches — so «بازي» finds «بازی» here exactly
 * as it does for a user.
 *
 * **Hide and restore go through `assertEventTransition`.** That is what keeps
 * this from being a back door around the lifecycle: an event the host has already
 * cancelled is not resurrected by a moderator who agrees with a complaint about
 * it, and the refusal arrives as «این عملیات در وضعیت فعلی امکان‌پذیر نیست»
 * rather than as a silent no-op. The panel offers the actions anyway and lets the
 * server decide, because computing the transition table on the client would be a
 * second copy of it.
 */
const LIMIT = 25;

const session = useSessionStore();

const rows = ref<AdminEventView[]>([]);
const total = ref(0);
const offset = ref(0);
const query = ref('');
const status = ref<AdminEventStatus | ''>('');
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
    const page = await request<AdminEventListResponse>('/events', {
      query: {
        query: query.value.trim(),
        status: status.value,
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.events;
    total.value = page.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست فعالیت‌ها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([query, status], () => {
  offset.value = 0;
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});
watch(offset, () => void load());

// ── Moderating ──────────────────────────────────────────────────────────────

type Action = 'HIDE' | 'PUBLISH' | 'REJECT';

const ACTIONS: Record<Action, { label: string; body: string; tone: 'danger' | 'default' }> = {
  HIDE: {
    label: 'پنهان کردن',
    body: 'فعالیت از فهرست‌ها برداشته می‌شود. درخواست‌ها و گفت‌وگوهای موجود دست‌نخورده می‌مانند و این کار برگشت‌پذیر است.',
    tone: 'danger',
  },
  PUBLISH: {
    label: 'بازگرداندن به انتشار',
    body: 'فعالیت دوباره در فهرست‌ها دیده می‌شود.',
    tone: 'default',
  },
  REJECT: {
    label: 'تأیید نکردن',
    body: 'فعالیت تأیید نشده علامت می‌خورد و منتشر نمی‌شود.',
    tone: 'danger',
  },
};

const pending = ref<{ event: AdminEventView; action: Action } | null>(null);
const acting = ref(false);
const actionError = ref<string | null>(null);

async function moderate(reason: string): Promise<void> {
  if (pending.value === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<{ status: string }>(`/events/${pending.value.event.publicId}/moderate`, {
      method: 'POST',
      body: { action: pending.value.action, reason },
    });
    notice.value = 'وضعیت فعالیت تغییر کرد و در گزارش رخدادها ثبت شد.';
    pending.value = null;
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'تغییر وضعیت فعالیت انجام نشد.');
  } finally {
    acting.value = false;
  }
}

const STATUSES: Array<{ value: AdminEventStatus | ''; label: string }> = [
  { value: '', label: 'همه' },
  { value: 'PUBLISHED', label: 'منتشر شده' },
  { value: 'PENDING_MODERATION', label: 'در انتظار بررسی' },
  { value: 'HIDDEN', label: 'پنهان شده' },
  { value: 'REJECTED', label: 'تأیید نشده' },
  { value: 'ONGOING', label: 'در حال برگزاری' },
  { value: 'COMPLETED', label: 'برگزار شده' },
  { value: 'CANCELLED_BY_HOST', label: 'لغو شده توسط میزبان' },
  { value: 'EXPIRED', label: 'منقضی شده' },
];

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="flex min-w-64 flex-1 flex-col gap-1">
        <span class="text-sm text-ink-soft">جست‌وجو در عنوان</span>
        <input
          v-model="query"
          type="search"
          placeholder="مثلاً بازی رومیزی"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">وضعیت</span>
        <select v-model="status" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option v-for="option in STATUSES" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button
        type="submit"
        class="min-h-10 rounded-lg border border-line px-4 text-sm"
        :disabled="loading"
      >
        {{ loading ? 'در حال جست‌وجو…' : 'جست‌وجو' }}
      </button>
    </form>

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="فعالیتی با این مشخصات پیدا نشد."
      @retry="load"
    >
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[64rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">عنوان</th>
              <th class="px-4 py-3 text-start font-medium">میزبان</th>
              <th class="px-4 py-3 text-start font-medium">وضعیت</th>
              <th class="px-4 py-3 text-start font-medium">ظرفیت</th>
              <th class="px-4 py-3 text-start font-medium">درخواست‌ها</th>
              <th class="px-4 py-3 text-start font-medium">گزارش‌ها</th>
              <th class="px-4 py-3 text-start font-medium">زمان برگزاری</th>
              <th class="px-4 py-3 text-start font-medium"><span class="sr-only">اقدام</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="event in rows"
              :key="event.publicId"
              class="border-b border-line last:border-0"
            >
              <td class="px-4 py-3">
                <span class="font-medium">{{ event.title }}</span>
                <span class="block text-xs text-ink-faint">{{ event.cityNameFa }}</span>
              </td>
              <td class="px-4 py-3">
                <RouterLink
                  v-if="session.can('user.read')"
                  :to="{ name: 'user-detail', params: { publicId: event.hostPublicId } }"
                  class="text-brand"
                >
                  {{ event.hostDisplayName ?? 'بدون نام' }}
                </RouterLink>
                <span v-else>{{ event.hostDisplayName ?? 'بدون نام' }}</span>
              </td>
              <td class="px-4 py-3">
                <StatusPill :value="event.status" />
                <span class="mt-1 block text-xs text-ink-faint">
                  بررسی: {{ event.moderationStatus }}
                </span>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ toPersianDigits(event.acceptedCount) }}</bdi> از
                <bdi>{{ toPersianDigits(event.capacity) }}</bdi>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(event.requestCount) }}</bdi>
              </td>
              <td class="px-4 py-3">
                <span
                  v-if="event.reportCount > 0"
                  class="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
                >
                  <bdi>{{ toPersianDigits(event.reportCount) }}</bdi> باز
                </span>
                <span v-else class="text-ink-faint">—</span>
              </td>
              <td class="px-4 py-3 text-ink-soft">{{ formatDateTime(event.startsAt) }}</td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-2">
                  <button
                    v-for="action in ['HIDE', 'PUBLISH'] as Action[]"
                    :key="action"
                    type="button"
                    class="min-h-9 rounded-lg border border-line px-2 text-xs disabled:opacity-40"
                    :disabled="!session.canMutate"
                    @click="pending = { event, action }"
                  >
                    {{ ACTIONS[action].label }}
                  </button>
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
  </div>

  <ConfirmDialog
    :open="pending !== null"
    :title="pending ? `${ACTIONS[pending.action].label}: ${pending.event.title}` : ''"
    :body="pending ? ACTIONS[pending.action].body : ''"
    :confirm-label="pending ? ACTIONS[pending.action].label : 'تأیید'"
    :tone="pending ? ACTIONS[pending.action].tone : 'default'"
    reason-label="دلیل این تصمیم (در گزارش رخدادها ثبت می‌شود)"
    :busy="acting"
    :error="actionError"
    @cancel="pending = null"
    @confirm="moderate"
  />
</template>
