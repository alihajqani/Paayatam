<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  PERMISSIONS,
  type DirectPartyView,
  type DirectThreadListResponse,
  type DirectThreadResponse,
  type DirectThreadSummaryView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatDateTime, formatNumber, formatRelative } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Direct messages, read as conversations (ADR-0020).
 *
 * ── What a conversation is here ─────────────────────────────────────────────
 *
 * Every message between the same two accounts about the same activity, oldest
 * first — whoever wrote first. There is no thread row; the API names one by the
 * activity and the two people, and so does this screen.
 *
 * ── The list is not the read ────────────────────────────────────────────────
 *
 * The list shows who wrote to whom and when, and never a word of it. Opening a
 * conversation decrypts it, and **the server writes an audit row for every
 * opening**. The screen says so where the button is, because somebody browsing
 * should know that looking is recorded before they look.
 *
 * ── Plain text only ─────────────────────────────────────────────────────────
 *
 * Every body is a stranger's words, rendered with `{{ }}` and `whitespace-pre-wrap`,
 * never `v-html` (CI refuses the latter anywhere in this app).
 */
const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const PAGE_SIZE = 30;

const threads = ref<DirectThreadSummaryView[]>([]);
const total = ref(0);
const offset = ref(0);
const loaded = ref(false);
const error = ref<string | null>(null);

/** Only conversations this user is one side of, from `?userPublicId=`. */
const userFilter = ref(
  typeof route.query.userPublicId === 'string' ? route.query.userPublicId : '',
);
const typedFilter = ref(userFilter.value);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return threads.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset.value) });
    if (userFilter.value !== '') params.set('userPublicId', userFilter.value);
    const response = await request<DirectThreadListResponse>(`/directs?${params.toString()}`);
    threads.value = response.threads;
    total.value = response.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست گفتگوها بارگذاری نشد.');
  }
}

function applyFilter(): void {
  const value = typedFilter.value.trim();
  offset.value = 0;
  userFilter.value = value;
  void router.replace({ query: value === '' ? {} : { userPublicId: value } });
}

watch([userFilter, offset], () => void load());

const hasPrevious = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + PAGE_SIZE < total.value);

// ── One conversation ────────────────────────────────────────────────────────

const open = ref<DirectThreadResponse | null>(null);
const openKey = ref<string | null>(null);
const opening = ref(false);
const openError = ref<string | null>(null);

function keyOf(thread: DirectThreadSummaryView): string {
  return `${thread.eventPublicId}:${thread.participants[0].publicId}:${thread.participants[1].publicId}`;
}

async function openThread(thread: DirectThreadSummaryView): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  openError.value = null;
  openKey.value = keyOf(thread);
  try {
    const params = new URLSearchParams({
      eventPublicId: thread.eventPublicId,
      userPublicId: thread.participants[0].publicId,
      otherUserPublicId: thread.participants[1].publicId,
    });
    open.value = await request<DirectThreadResponse>(`/directs/thread?${params.toString()}`);
  } catch (cause) {
    open.value = null;
    openError.value = messageOf(cause, 'این گفتگو باز نشد.');
  } finally {
    opening.value = false;
  }
}

function nameOf(publicId: string): string {
  const party = open.value?.participants.find((candidate) => candidate.publicId === publicId);
  return party?.displayName ?? '—';
}

function roleOf(party: DirectPartyView): string {
  return party.isHost ? 'میزبان' : 'کاربر';
}

/** The host on one side and the other person on the other, as a chat reads. */
function isHostMessage(senderPublicId: string): boolean {
  return (
    open.value?.participants.some((party) => party.publicId === senderPublicId && party.isHost) ??
    false
  );
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
      <p>
        پیام‌های مستقیمی که کاربران دربارهٔ یک رویداد برای هم فرستاده‌اند، به شکل گفتگو. هر گفتگو
        همهٔ پیام‌های میان دو نفر دربارهٔ یک رویداد است.
      </p>
      <p class="mt-2 text-ink-soft">
        پیام‌ها ۱۸۰ روز پس از ارسال پاک می‌شوند. فهرست فقط نشان می‌دهد چه کسی با چه کسی و کِی حرف
        زده است؛ <strong>باز کردن هر گفتگو در گزارش رخدادها با نام شما ثبت می‌شود.</strong>
      </p>
    </section>

    <form class="flex flex-wrap items-end gap-2 text-sm" @submit.prevent="applyFilter">
      <label class="flex flex-col gap-1">
        <span class="text-ink-soft">فقط گفتگوهای یک کاربر (شناسهٔ عمومی)</span>
        <input
          v-model="typedFilter"
          type="text"
          dir="ltr"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          class="min-h-10 w-80 max-w-full rounded-lg border border-line bg-surface px-3 font-mono text-xs"
        />
      </label>
      <button type="submit" class="min-h-10 rounded-lg border border-line px-3">اعمال</button>
      <span class="text-xs text-ink-faint">
        مجموع گفتگوها: <bdi>{{ formatNumber(total) }}</bdi>
      </span>
    </form>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <StateBlock
        :state="state"
        :error-text="error"
        empty-text="گفتگویی پیدا نشد."
        :rows="6"
        @retry="load"
      >
        <div class="flex flex-col gap-2">
          <button
            v-for="thread in threads"
            :key="keyOf(thread)"
            type="button"
            class="rounded-xl border bg-surface p-3 text-start text-sm"
            :class="openKey === keyOf(thread) ? 'border-brand' : 'border-line'"
            :disabled="opening"
            @click="openThread(thread)"
          >
            <p class="font-medium">{{ thread.eventTitle }}</p>
            <p class="mt-1 text-ink-soft">
              {{ thread.participants[0].displayName }}
              <span class="text-xs text-ink-faint">({{ roleOf(thread.participants[0]) }})</span>
              ↔
              {{ thread.participants[1].displayName }}
              <span class="text-xs text-ink-faint">({{ roleOf(thread.participants[1]) }})</span>
            </p>
            <p class="mt-1 text-xs text-ink-faint">
              <bdi>{{ formatNumber(thread.messageCount) }}</bdi> پیام · آخرین:
              {{ formatRelative(thread.lastMessageAt) }}
            </p>
          </button>

          <div class="flex items-center justify-between pt-2 text-sm">
            <button
              type="button"
              class="min-h-9 rounded-lg border border-line px-3 disabled:opacity-40"
              :disabled="!hasPrevious"
              @click="offset = Math.max(offset - PAGE_SIZE, 0)"
            >
              قبلی
            </button>
            <button
              type="button"
              class="min-h-9 rounded-lg border border-line px-3 disabled:opacity-40"
              :disabled="!hasNext"
              @click="offset = offset + PAGE_SIZE"
            >
              بعدی
            </button>
          </div>
        </div>
      </StateBlock>

      <section class="rounded-xl border border-line bg-surface p-4" aria-live="polite">
        <p v-if="openError" class="text-sm text-danger" role="alert">{{ openError }}</p>
        <p v-else-if="open === null" class="text-sm text-ink-soft">
          {{ opening ? 'در حال باز کردن…' : 'یک گفتگو را از فهرست انتخاب کنید.' }}
        </p>

        <template v-else>
          <header class="border-b border-line pb-3">
            <p class="font-medium">{{ open.eventTitle }}</p>
            <p class="mt-1 flex flex-wrap gap-3 text-xs text-ink-soft">
              <span v-for="party in open.participants" :key="party.publicId">
                {{ party.displayName }} ({{ roleOf(party) }})
                <RouterLink
                  v-if="session.can(PERMISSIONS.USER_READ)"
                  :to="{ name: 'user-detail', params: { publicId: party.publicId } }"
                  class="text-brand"
                >
                  پرونده
                </RouterLink>
              </span>
            </p>
            <p
              v-for="blocker in open.blockedBy"
              :key="blocker"
              class="mt-2 rounded-lg bg-warn-soft px-3 py-1 text-xs text-warn"
            >
              {{ nameOf(blocker) }} طرف مقابل را مسدود کرده است.
            </p>
          </header>

          <ol class="mt-3 flex flex-col gap-2">
            <li
              v-for="message in open.messages"
              :key="message.publicId"
              class="flex"
              :class="isHostMessage(message.senderPublicId) ? 'justify-start' : 'justify-end'"
            >
              <div
                class="max-w-[85%] rounded-xl px-3 py-2 text-sm"
                :class="
                  isHostMessage(message.senderPublicId)
                    ? 'bg-brand-soft'
                    : 'border border-line bg-surface-sunken'
                "
              >
                <p class="text-xs font-medium text-ink-soft">
                  {{ nameOf(message.senderPublicId) }}
                  <span v-if="message.isReply" class="text-ink-faint">· پاسخ</span>
                </p>
                <p class="mt-1 leading-relaxed whitespace-pre-wrap break-words">
                  {{ message.body }}
                </p>
                <p class="mt-1 text-[11px] text-ink-faint">
                  {{ formatDateTime(message.createdAt) }}
                  <span v-if="message.seenAt"> · دیده شد</span>
                </p>
              </div>
            </li>
          </ol>
        </template>
      </section>
    </div>
  </div>
</template>
