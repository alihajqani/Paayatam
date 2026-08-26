<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MembershipStateResponse } from '@payetam/shared';
import { ApiError, request } from '@/api/client';
import { haptic } from '@/telegram/webapp';

/**
 * "Join the channel first" — the user's side of the requirement (M22 phase 6).
 *
 * ── It never blocks anything by itself ───────────────────────────────────────
 *
 * The gate is the server's: `ChannelMembershipService.assertAllowed` runs inside
 * the service that owns each protected operation, so a client that skipped this
 * banner still gets `CHANNEL_MEMBERSHIP_REQUIRED`. This exists so the user is
 * told *before* they fill in a form, not instead of the check.
 *
 * ── Five states, five sentences ──────────────────────────────────────────────
 *
 * Three of the outcomes are **not the user's fault** — the channel is
 * misconfigured, the bot cannot see the member list, or Telegram did not answer —
 * and in all three the product lets them through. Showing «عضو نیستید» in those
 * cases would ask somebody to fix a problem they cannot see and do not have.
 */
const props = defineProps<{
  /** Rendered only when this action is gated. Omit to ask about the requirement as a whole. */
  action?: 'EVENT_CREATE' | 'EVENT_JOIN' | 'EVENT_CHANNEL_SEND' | 'EVENT_INVITE';
}>();

const state = ref<MembershipStateResponse | null>(null);
const checking = ref(false);
const error = ref<string | null>(null);

/** Only `NOT_MEMBER` is a wall. Everything else either passes or is advisory. */
const blocking = computed(
  () => state.value !== null && state.value.required && !state.value.allowed,
);

/** Something is wrong with the configuration, and it is not the user's problem. */
const degraded = computed(
  () =>
    state.value !== null &&
    state.value.required &&
    ['CHAT_UNAVAILABLE', 'BOT_CANNOT_VERIFY', 'UNKNOWN'].includes(state.value.status),
);

const relevant = computed(() => {
  if (state.value === null || !state.value.required) return false;
  if (props.action === undefined) return true;
  return state.value.requiredActions.includes(props.action);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    state.value = await request<MembershipStateResponse>('/me/channel-membership');
  } catch (cause) {
    // A failure here must not stop the screen it is embedded in. The server-side
    // gate is the control; this is the explanation.
    error.value = cause instanceof ApiError ? cause.messageFa : null;
  }
}

/** Asks Telegram again, now — the server clears its cached answer first. */
async function recheck(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  error.value = null;
  try {
    state.value = await request<MembershipStateResponse>('/me/channel-membership/check', {
      method: 'POST',
    });
    haptic(state.value.allowed ? 'success' : 'error');
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'بررسی انجام نشد.';
  } finally {
    checking.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section
    v-if="relevant && (blocking || degraded)"
    class="flex flex-col gap-2 rounded-xl p-4 text-sm"
    :class="blocking ? 'bg-tg-secondary-bg ring-1 ring-tg-destructive' : 'bg-tg-secondary-bg'"
    role="status"
  >
    <template v-if="blocking">
      <h3 class="font-medium">برای ادامه، در کانال پایه‌تَم عضو شوید</h3>
      <p class="text-tg-hint">
        رویدادها در کانال پایه‌تَم منتشر می‌شوند. پس از عضویت، دکمهٔ «بررسی دوباره» را بزنید.
      </p>

      <div class="flex flex-wrap gap-2">
        <!--
          `rel="noopener noreferrer"` because this leaves the Mini App. The URL
          itself is validated server-side and rebuilt as `https://t.me/…`, so it
          cannot be an arbitrary host however it was configured.
        -->
        <a
          v-if="state?.joinUrl"
          :href="state.joinUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="flex min-h-11 items-center rounded-xl bg-tg-button px-4 text-tg-button-text"
        >
          عضویت در کانال
        </a>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-tg-bg px-4 disabled:opacity-50"
          :disabled="checking"
          @click="recheck"
        >
          {{ checking ? 'در حال بررسی…' : 'بررسی دوباره' }}
        </button>
      </div>

      <p v-if="state?.joinUrl === null" class="text-tg-destructive">
        پیوند کانال هنوز تنظیم نشده است. لطفاً کمی بعد دوباره تلاش کنید.
      </p>
    </template>

    <!--
      The three "not your fault" outcomes. The product has already let the user
      through, so this says what happened and asks nothing of them.
    -->
    <template v-else-if="degraded">
      <p class="text-tg-hint">
        <template v-if="state?.status === 'BOT_CANNOT_VERIFY'">
          در حال حاضر امکان بررسی عضویت کانال وجود ندارد، بنابراین ادامه می‌دهید.
        </template>
        <template v-else-if="state?.status === 'CHAT_UNAVAILABLE'">
          کانال در دسترس نیست، بنابراین این مرحله فعلاً نادیده گرفته می‌شود.
        </template>
        <template v-else>
          ارتباط با تلگرام برای بررسی عضویت برقرار نشد، بنابراین ادامه می‌دهید.
        </template>
      </p>
    </template>

    <p v-if="error" class="text-tg-destructive">{{ error }}</p>
  </section>
</template>
