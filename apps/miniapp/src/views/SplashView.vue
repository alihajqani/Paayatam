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
    // `session.onboardingState`, not `session.me`: a NEW user has no `me` yet,
    // because `/me` is behind the terms gate — and `stepFor(undefined)` routes back
    // to this very screen, which is a silent hang rather than an error.
    await router.replace(stepFor(session.onboardingState, session.pendingPolicies.length));
  } catch (cause) {
    error.value =
      cause instanceof ApiError ? cause.messageFa : 'ورود انجام نشد. لطفاً دوباره تلاش کنید.';
  }
}

onMounted(start);
</script>

<template>
  <main class="flex flex-1 flex-col items-center justify-center gap-6 text-center">
    <!--
      The mark on its own, on the one screen with nothing else on it (M22 phase
      10). `alt=""` because the name is the `h1` directly below it.

      The halo is a blurred sibling rather than part of the artwork. The asset is
      transparent precisely so it can sit on a theme nobody has seen; a glow baked
      into it would be a background it carries into all of them.
    -->
    <div class="relative flex items-center justify-center">
      <div
        class="brand-rule absolute size-32 rounded-full opacity-15 blur-2xl"
        role="presentation"
      ></div>
      <img
        src="/brand/mark-256.webp"
        alt=""
        aria-hidden="true"
        width="88"
        height="88"
        decoding="async"
        fetchpriority="high"
        class="relative size-22"
      />
    </div>

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
