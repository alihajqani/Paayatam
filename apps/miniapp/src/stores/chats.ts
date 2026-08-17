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

  function remember(updated: ChatSummaryView): void {
    chats.value = chats.value.map((chat) => (chat.publicId === updated.publicId ? updated : chat));
  }

  /**
   * Consent to exchange contact details in this conversation (criterion 6).
   *
   * It reveals nothing by itself, and that is the part a UI must not overstate: the
   * platform holds no phone number and will not surrender a Telegram username. What
   * changes is that the caller's *own* messages stop being masked, so they can send
   * their details themselves. The disclosure stays the user's act, which is what
   * ADR-0009 requires of it — and why this needs a screen with a confirmation rather
   * than a one-tap button.
   */
  async function shareContact(publicId: string): Promise<ChatSummaryView> {
    const updated = await request<ChatSummaryView>(`/chats/${publicId}/share-contact`, {
      method: 'POST',
    });
    remember(updated);
    return updated;
  }

  /** Either party ends it. Neither needs the other's agreement. */
  async function close(publicId: string, reason?: string): Promise<ChatSummaryView> {
    const updated = await request<ChatSummaryView>(`/chats/${publicId}/close`, {
      method: 'POST',
      ...(reason ? { body: { reason } } : {}),
    });
    remember(updated);
    return updated;
  }

  return { chats, loading, unreadTotal, open, load, forEvent, shareContact, close };
});
