<script setup lang="ts">
import { RouterLink } from 'vue-router';

/**
 * The mark, the name, and the way back to `/home` (M22 phase 10).
 *
 * It is one element doing two jobs, and that is deliberate. The product now has
 * ten screens and several of them are two taps deep — an event opened from
 * discovery, a chat opened from a request — so "get me back to the start" had no
 * answer except Telegram's own back button, which walks the history one step at a
 * time and lands somewhere different depending on how you arrived. A logo that is
 * also the way home is the convention every app on the user's phone already
 * taught them, so it needs no affordance of its own.
 *
 * ── Why it does not render during onboarding ─────────────────────────────────
 *
 * `App.vue` keeps it off the splash, the terms and the profile step. Until the
 * profile is complete there *is* no home to go to — the router would bounce the
 * tap straight back to the screen it came from — and a header on a funnel screen
 * is a distraction from the one thing the screen is asking for.
 *
 * ── The mark ─────────────────────────────────────────────────────────────────
 *
 * `alt=""` and `aria-hidden`: the link's accessible name is the wordmark beside
 * it, and a screen reader announcing "پایه‌تَم پایه‌تَم" is worse than silence.
 * Width and height are set so the row does not reflow when the image lands, which
 * on the connections this app is built for is not the same instant as the text.
 */
</script>

<template>
  <header class="-mx-4 mb-1 px-4">
    <RouterLink
      to="/home"
      class="flex min-h-11 w-fit items-center gap-2 py-2"
      aria-label="خانهٔ پایه‌تَم"
    >
      <img
        src="/brand/mark-96.webp"
        alt=""
        aria-hidden="true"
        width="32"
        height="32"
        decoding="async"
        class="size-8 shrink-0"
      />
      <span class="text-base font-bold">پایه‌تَم</span>
    </RouterLink>

    <!--
      The six ribbon colours as a hairline. Decoration and nothing else: it
      carries no information, so it is the one place a fixed brand colour cannot
      collide with a theme it has never seen (see `styles/main.css`).
    -->
    <div class="brand-rule h-0.5 rounded-full opacity-80" role="presentation"></div>
  </header>
</template>
