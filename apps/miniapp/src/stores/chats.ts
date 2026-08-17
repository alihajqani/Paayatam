import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ChatSummaryView, MyChatsResponse } from '@payetam/shared';
import { request } from '@/api/client';

/**
 * The conversations a user is in — a list, and only a list.
 *
 * **The bot is the chat surface, by design.** The relay, the aliases, the entity
 * stripping, the contact masking and the host's decision all live in Telegram
 * already (M8 + the bot's inbound half), and `packages/domain` is the single code
 * path behind them. A second composer here would be a second surface for one
 * conversation, which is two places for a message to half-arrive.
 *
 * So this screen answers "which conversations do I have, and is anything waiting?"
 * and then hands the user back to Telegram, where the messages are.
 */
export const useChatsStore = defineStore('chats', () => {
  const chats = ref<ChatSummaryView[]>([]);
  const loading = ref(false);

  const unreadTotal = computed(() =>
    chats.value.reduce((total, chat) => total + chat.unreadCount, 0),
  );

  const open = computed(() => chats.value.filter((chat) => chat.status === 'OPEN'));

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const response = await request<MyChatsResponse>('/chats');
      chats.value = response.chats;
    } finally {
      loading.value = false;
    }
  }

  function forEvent(eventPublicId: string): ChatSummaryView | null {
    return chats.value.find((chat) => chat.eventPublicId === eventPublicId) ?? null;
  }

  return { chats, loading, unreadTotal, open, load, forEvent };
});
