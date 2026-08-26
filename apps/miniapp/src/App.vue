<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import AppHeader from '@/components/AppHeader.vue';
import { showsHomeButton } from '@/router';
import { useSessionStore } from '@/stores/session';

const route = useRoute();
const session = useSessionStore();

/**
 * The header is drawn only where `/home` is somewhere to go (M22 phase 10).
 *
 * The rule itself lives in `router.ts` beside `stepFor`, which decides the same
 * thing for the guard — a header link the guard would bounce is a control that
 * visibly does nothing, and the only way to guarantee it cannot happen is for
 * both to read one function.
 *
 * `session.ready` is this file's own condition rather than that function's: it is
 * about whether the shell has anything to render yet, not about where the user
 * belongs.
 */
const showHeader = computed(
  () =>
    session.ready &&
    showsHomeButton(
      route.name === undefined || route.name === null ? undefined : String(route.name),
      session.onboardingState,
      session.pendingPolicies.length,
    ),
);
</script>

<template>
  <!--
    `viewportStableHeight` would be more precise inside Telegram, but `100dvh`
    tracks the same thing in every client and needs no event listener. The inline
    padding is the safe-area inset for a notched device.
  -->
  <div
    class="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-tg-bg px-4"
    :style="{
      paddingInlineStart: 'max(1rem, env(safe-area-inset-right))',
      paddingInlineEnd: 'max(1rem, env(safe-area-inset-left))',
      paddingTop: 'max(1rem, env(safe-area-inset-top))',
    }"
  >
    <AppHeader v-if="showHeader" />
    <RouterView />
  </div>
</template>
