<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { stepFor } from '@/router';
import { isAvailable } from '@/telegram/webapp';

/**
 * Signs in and routes to whichever onboarding step the user is on.
 *
 * Has an explicit error state with a retry, like every other screen — the first
 * request of the session runs on a cold mobile connection and is the one most
 * likely to fail (ADR-0003).
 */
const router = useRouter();
const session = useSessionStore();

const error = ref<string | null>(null);

async function start(): Promise<void> {
  error.value = null;

  if (!isAvailable) {
    error.value = 'برای استفاده از پایه‌تَم، برنامه را از داخل تلگرام باز کنید.';
    return;
  }

  try {
    await session.signIn();
    await router.replace(stepFor(session.me?.onboardingState));
  } catch (cause) {
    error.value =
      cause instanceof ApiError ? cause.messageFa : 'ورود انجام نشد. لطفاً دوباره تلاش کنید.';
  }
}

onMounted(start);
</script>

<template>
  <main class="flex flex-1 flex-col items-center justify-center gap-6 text-center">
    <h1 class="text-2xl font-bold">پایه‌تَم</h1>

    <template v-if="error">
      <p class="text-tg-hint">{{ error }}</p>
      <button
        type="button"
        class="min-h-11 rounded-xl bg-tg-button px-6 text-tg-button-text"
        @click="start"
      >
        تلاش دوباره
      </button>
    </template>

    <p v-else class="text-tg-hint">در حال ورود…</p>
  </main>
</template>
