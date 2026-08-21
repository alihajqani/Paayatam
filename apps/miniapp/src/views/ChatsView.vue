<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import ReportDialog from '@/components/ReportDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import {
  CHAT_NAME_DISCLOSURE_FA,
  CHAT_PRIVACY_SUMMARY_FA,
  CONTACT_SHARE_CONFIRM_FA,
} from '@/copy/privacy';
import { formatRelative } from '@/format/datetime';
import { toPersianDigits } from '@/format/fa';
import { haptic, webApp } from '@/telegram/webapp';
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
const actionError = ref<string | null>(null);
/** Which chat is mid-confirmation. Contact sharing is never one tap (criterion 6). */
const confirmingShare = ref<string | null>(null);
const confirmingClose = ref<string | null>(null);
const reporting = ref<string | null>(null);

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

/**
 * Consent to exchange contact details.
 *
 * The confirmation is the feature, not politeness: ADR-0009 requires the disclosure
 * to be the user's own act, and a callback button would reduce «مطمئنید؟» to a single
 * tap made by accident. What it actually does is narrow — it stops masking the
 * caller's *own* messages — and the copy says so, because a user who believes the
 * platform just handed over their number would be wrong in a way that matters.
 */
async function confirmShare(publicId: string): Promise<void> {
  actionError.value = null;
  try {
    await chats.shareContact(publicId);
    haptic('success');
    confirmingShare.value = null;
  } catch (cause) {
    haptic('error');
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'ثبت رضایت انجام نشد.';
  }
}

async function confirmClose(publicId: string): Promise<void> {
  actionError.value = null;
  try {
    await chats.close(publicId);
    haptic('success');
    confirmingClose.value = null;
  } catch (cause) {
    haptic('error');
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'بستن گفت‌وگو انجام نشد.';
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

    <!--
      The standing disclosure, and it is deliberately longer than the sentence it
      replaced. The old one promised that identities stay hidden «تا زمانی که
      خودشان نخواهند» — true of contact details, and false about display names
      since M6, actively misleading since ADR-0014 titled a conversation with the
      counterpart's name. The text lives in `@/copy/privacy` so a test can hold it
      to what the product actually does.
    -->
    <p class="text-sm leading-relaxed text-tg-hint">{{ CHAT_PRIVACY_SUMMARY_FA }}</p>

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

      <p v-if="actionError" class="text-tg-destructive">{{ actionError }}</p>

      <ul class="flex flex-col gap-3">
        <li
          v-for="chat in chats.chats"
          :key="chat.publicId"
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
        >
          <!--
            «who — which event», which is the title of the conversation (ADR-0014).

            The event title alone was ambiguous in the direction that mattered: a
            host with two events had two conversations headed by two different
            titles and two counterparts both called «میهمان ۱», and nothing on the
            row said which person was which. `counterpartName` falls back to the
            alias in the domain, so this is never empty and never invents a name.
          -->
          <div class="flex items-start justify-between gap-2">
            <h2 class="flex-1 font-medium leading-snug">
              {{ chat.counterpartName }} — {{ chat.eventTitle }}
            </h2>
            <span
              v-if="chat.unreadCount > 0"
              class="shrink-0 rounded-full bg-tg-button px-2 py-0.5 text-xs text-tg-button-text"
            >
              {{ toPersianDigits(chat.unreadCount) }} تازه
            </span>
          </div>

          <p class="text-sm text-tg-subtitle">
            {{ chat.counterpartAlias }} ·
            {{ chat.role === 'HOST' ? 'شما میزبانید' : 'شما میهمانید' }}
          </p>
          <!-- Said once per row, next to the name it is about (ADR-0014). -->
          <p class="text-xs text-tg-hint">{{ CHAT_NAME_DISCLOSURE_FA }}</p>
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
            <button
              v-if="!chat.contactShared && chat.status === 'OPEN'"
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              @click="confirmingShare = chat.publicId"
            >
              اشتراک اطلاعات تماس
            </button>
            <button
              v-if="chat.status === 'OPEN'"
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              @click="confirmingClose = chat.publicId"
            >
              بستن گفت‌وگو
            </button>
            <button
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm text-tg-destructive"
              @click="reporting = chat.publicId"
            >
              گزارش
            </button>
          </div>

          <!-- Criterion 6: explicit confirmation, and an honest account of it. -->
          <div
            v-if="confirmingShare === chat.publicId"
            class="flex flex-col gap-2 rounded-xl bg-tg-bg p-3"
          >
            <p class="text-sm font-medium">اطلاعات تماس خود را به اشتراک می‌گذارید؟</p>
            <p class="text-sm leading-relaxed text-tg-hint">{{ CONTACT_SHARE_CONFIRM_FA }}</p>
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-11 flex-1 rounded-xl bg-tg-button text-sm text-tg-button-text"
                @click="confirmShare(chat.publicId)"
              >
                بله، مطمئنم
              </button>
              <button
                type="button"
                class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
                @click="confirmingShare = null"
              >
                انصراف
              </button>
            </div>
          </div>

          <div
            v-if="confirmingClose === chat.publicId"
            class="flex flex-col gap-2 rounded-xl bg-tg-bg p-3"
          >
            <p class="text-sm font-medium">این گفت‌وگو بسته شود؟</p>
            <p class="text-sm text-tg-hint">
              پس از بستن، هیچ‌کدام از دو طرف نمی‌توانید پیام تازه‌ای بفرستید.
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-11 flex-1 rounded-xl bg-tg-destructive text-sm text-tg-button-text"
                @click="confirmClose(chat.publicId)"
              >
                بستن گفت‌وگو
              </button>
              <button
                type="button"
                class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
                @click="confirmingClose = null"
              >
                انصراف
              </button>
            </div>
          </div>

          <ReportDialog
            v-if="reporting === chat.publicId"
            target="MESSAGE"
            :public-id="chat.publicId"
            @close="reporting = null"
          />
        </li>
      </ul>
    </StateBlock>
  </main>
</template>
