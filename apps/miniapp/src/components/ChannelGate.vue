<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { GatedActionView } from '@payetam/shared';
import { ApiError } from '@/api/client';
import ChannelList from '@/components/ChannelList.vue';
import { haptic } from '@/telegram/webapp';
import { useMembershipStore } from '@/stores/membership';

/**
 * "Join the channels first" — the user's side of the requirement, per operation.
 *
 * ── It never blocks anything by itself ───────────────────────────────────────
 *
 * The gate is the server's: `ChannelMembershipService.assertAllowed` runs inside
 * the service that owns each protected operation, so a client that skipped this
 * banner still gets `CHANNEL_MEMBERSHIP_REQUIRED`. This exists so the user is
 * told *before* they fill in a form, not instead of the check.
 *
 * The app-wide version of the same requirement is `/join-channels`, which is a
 * screen rather than a banner — a banner on a page full of other things to tap is
 * not a block. This component stays for the four per-operation actions, where the
 * rest of the screen is still legitimately usable.
 *
 * ── Five states, five sentences ──────────────────────────────────────────────
 *
 * Three of the outcomes are **not the user's fault** — a channel is misconfigured,
 * the bot cannot see a member list, or Telegram did not answer — and in all three
 * the product lets them through. Showing «عضو نیستید» in those cases would ask
 * somebody to fix a problem they cannot see and do not have.
 *
 * ── Several channels ─────────────────────────────────────────────────────────
 *
 * The banner lists every channel still outstanding, in the operator's order,
 * because "join the channel" is not an instruction somebody can follow when there
 * are three and they have joined one.
 */
const props = defineProps<{
  /** Rendered only when this action is gated. Omit to ask about the requirement as a whole. */
  action?: GatedActionView;
}>();

const membership = useMembershipStore();

const error = ref<string | null>(null);

const state = computed(() => membership.state);

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
  // The store swallows its own failures and holds the answer for every component
  // on the screen, so two gates mounting together is one request.
  await membership.load();
}

/** Asks Telegram again, now — the server clears its cached answer for every channel. */
async function recheck(): Promise<void> {
  if (membership.checking) return;
  error.value = null;
  try {
    const next = await membership.recheck();
    haptic(next.allowed ? 'success' : 'error');
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'بررسی انجام نشد.';
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
      <h3 class="font-medium">برای ادامه، عضو کانال‌های زیر شوید</h3>
      <p class="text-tg-hint">
        عضویت در همهٔ کانال‌ها لازم است. پس از عضویت، دکمهٔ «بررسی دوباره» را بزنید.
      </p>

      <ChannelList :channels="membership.outstanding" />

      <button
        type="button"
        class="min-h-11 self-start rounded-xl bg-tg-bg px-4 disabled:opacity-50"
        :disabled="membership.checking"
        @click="recheck"
      >
        {{ membership.checking ? 'در حال بررسی…' : 'بررسی دوباره' }}
      </button>

      <p v-if="membership.outstanding.some((c) => c.joinUrl === null)" class="text-tg-destructive">
        پیوند یکی از کانال‌ها هنوز تنظیم نشده است. لطفاً کمی بعد دوباره تلاش کنید.
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
