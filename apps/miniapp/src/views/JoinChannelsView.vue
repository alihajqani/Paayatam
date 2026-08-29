<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import ChannelList from '@/components/ChannelList.vue';
import { haptic } from '@/telegram/webapp';
import { useMembershipStore } from '@/stores/membership';

/**
 * "Join these channels first" — the screen the whole Mini App sits behind
 * (v0.3.1, report 3).
 *
 * ── Why a screen and not a banner ────────────────────────────────────────────
 *
 * `ChannelGate` puts a banner above the two forms it guards, which is right when
 * the requirement covers one operation. It is not enough when the requirement is
 * `APP_ACCESS` — "block them in the mini-app" — because a banner on a screen full
 * of other things to tap is not a block. The router sends every navigation here
 * while any required channel is outstanding, and this screen offers exactly two
 * actions: join, and check again.
 *
 * ── It never blocks anything by itself ───────────────────────────────────────
 *
 * A client that skipped this is still refused every gated *operation* by the
 * service that owns it. What this adds is that the user is stopped before they
 * fill in a form, and stopped somewhere with buttons rather than a sentence.
 *
 * ── The re-check is the whole interaction ────────────────────────────────────
 *
 * Telegram gives the Mini App no event for "the user joined a channel", so
 * «بررسی دوباره» is the only way to find out — and the server clears its cached
 * answer for every channel before asking, so pressing it means "ask Telegram
 * now" rather than "read the same answer again". On success the router takes
 * over: the guard re-runs and lets the user through to wherever they were going.
 */
const router = useRouter();
const membership = useMembershipStore();

const error = ref<string | null>(null);
/** Set when a re-check ran and the user is still short. Not shown before that. */
const stillShort = ref(false);

const channels = computed(() => membership.state?.channels ?? []);
const remaining = computed(() => membership.outstanding.length);

async function load(): Promise<void> {
  error.value = null;
  await membership.load();
}

async function recheck(): Promise<void> {
  if (membership.checking) return;
  error.value = null;
  stillShort.value = false;

  try {
    const next = await membership.recheck();
    haptic(next.allowed ? 'success' : 'error');
    if (next.allowed) {
      // The guard decides where; `/home` is simply the request, and it will be
      // redirected if the user owes something else — the terms, say.
      await router.replace('/home');
      return;
    }
    stillShort.value = true;
  } catch (cause) {
    haptic('error');
    error.value = cause instanceof ApiError ? cause.messageFa : 'بررسی انجام نشد.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-6">
    <h1 class="text-xl font-bold">برای ادامه، عضو کانال‌ها شوید</h1>

    <p class="text-sm leading-7 text-tg-subtitle">
      پایه‌تَم فعالیت‌ها را در این کانال‌ها منتشر می‌کند. برای استفاده از برنامه باید عضو
      <b>همهٔ</b> آن‌ها باشید. روی «عضویت» بزنید، و پس از عضویت در همه، «بررسی دوباره» را لمس کنید.
    </p>

    <div v-if="!membership.loaded" class="flex flex-col gap-2" aria-hidden="true">
      <div v-for="n in 3" :key="n" class="h-12 rounded-xl bg-tg-secondary-bg"></div>
    </div>

    <template v-else-if="channels.length > 0">
      <ChannelList :channels="channels" numbered />

      <p v-if="stillShort" class="text-sm text-tg-destructive" role="alert">
        هنوز عضو {{ remaining }} کانال نشده‌اید. اگر همین حالا عضو شده‌اید، چند لحظه صبر کنید و
        دوباره بررسی کنید.
      </p>
    </template>

    <!--
      No channel in the list, on a screen reached because the gate said the user
      is blocked. Unreachable in practice — the gate needs at least one active
      channel to block anybody — and still worth a sentence rather than an empty
      screen with a button on it.
    -->
    <p v-else class="text-sm text-tg-hint">
      فهرست کانال‌ها در دسترس نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.
    </p>

    <p v-if="error" class="text-sm text-tg-destructive" role="alert">{{ error }}</p>

    <div class="flex-1"></div>

    <button
      type="button"
      class="min-h-12 rounded-xl bg-tg-button text-tg-button-text disabled:opacity-50"
      :disabled="membership.checking"
      @click="recheck"
    >
      {{ membership.checking ? 'در حال بررسی…' : 'بررسی دوباره' }}
    </button>
  </main>
</template>
