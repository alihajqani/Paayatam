<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatRelative } from '@/format/datetime';
import { toPersianDigits } from '@/format/fa';
import { webApp } from '@/telegram/webapp';
import { useChatsStore } from '@/stores/chats';

/**
 * Which conversations exist, and whether anything is waiting.
 *
 * **Deliberately not a chat client.** The messages live in Telegram: the relay, the
 * aliases, the entity stripping and the contact masking are all the bot's, over the
 * same domain services (M8). Putting a composer here would mean one conversation with
 * two surfaces, and a message that half-arrives in the wrong one.
 *
 * So this lists, and then hands the user back to Telegram — which is what closing the
 * Mini App does, since it returns to the chat the app was opened from.
 */
const router = useRouter();
const chats = useChatsStore();

const error = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (chats.loading && chats.chats.length === 0) return 'loading' as const;
  if (chats.chats.length === 0) return 'empty' as const;
  return 'ready' as const;
});

const STATUS_FA: Record<string, string> = {
  OPEN: 'باز',
  CLOSED: 'بسته‌شده',
  EXPIRED: 'منقضی',
};

async function load(): Promise<void> {
  error.value = null;
  try {
    await chats.load();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'گفت‌وگوها بارگذاری نشد.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">گفت‌وگوها</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.push('/home')">
        خانه
      </button>
    </header>

    <p class="text-sm text-tg-hint">
      پیام‌ها در گفت‌وگو با ربات رد و بدل می‌شوند و هویت دو طرف تا زمانی که خودشان نخواهند پنهان
      می‌ماند.
    </p>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="هنوز گفت‌وگویی ندارید. با درخواست پیوستن به یک رویداد، گفت‌وگو آغاز می‌شود."
      @retry="load"
    >
      <template #empty-action>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-tg-button px-4 text-tg-button-text"
          @click="router.push('/discover')"
        >
          دیدن رویدادها
        </button>
      </template>

      <ul class="flex flex-col gap-3">
        <li
          v-for="chat in chats.chats"
          :key="chat.publicId"
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
        >
          <div class="flex items-start justify-between gap-2">
            <h2 class="flex-1 font-medium leading-snug">{{ chat.eventTitle }}</h2>
            <span
              v-if="chat.unreadCount > 0"
              class="rounded-full bg-tg-button px-2 py-0.5 text-xs text-tg-button-text"
            >
              {{ toPersianDigits(chat.unreadCount) }} تازه
            </span>
          </div>

          <p class="text-sm text-tg-subtitle">
            {{ chat.counterpartAlias }} ·
            {{ chat.role === 'HOST' ? 'شما میزبانید' : 'شما میهمانید' }}
          </p>
          <p class="text-xs text-tg-hint">
            {{ STATUS_FA[chat.status] ?? chat.status }}
            <template v-if="chat.lastMessageAt">
              · آخرین پیام {{ formatRelative(chat.lastMessageAt) }}
            </template>
          </p>
          <p
            v-if="chat.contactShared || chat.counterpartContactShared"
            class="text-xs text-tg-hint"
          >
            <template v-if="chat.contactShared && chat.counterpartContactShared">
              اطلاعات تماس دو طرف به اشتراک گذاشته شده است.
            </template>
            <template v-else-if="chat.contactShared">شما اطلاعات تماس خود را داده‌اید.</template>
            <template v-else>طرف مقابل اطلاعات تماس خود را داده است.</template>
          </p>

          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm text-tg-link"
              @click="webApp?.close()"
            >
              ادامه در تلگرام
            </button>
            <button
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              @click="router.push(`/events/${chat.eventPublicId}`)"
            >
              رویداد
            </button>
          </div>
        </li>
      </ul>
    </StateBlock>
  </main>
</template>
