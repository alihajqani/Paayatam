<script setup lang="ts">
import { RouterView } from 'vue-router';
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
    <RouterView />
  </div>
</template>
