<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { APP_VERSION, fetchServerVersion, isStaleBundle } from '@/version';

/**
 * Which release the user is looking at (M22 phase 10).
 *
 * Small, muted, and at the bottom of the home screen — the placement a version
 * string has everywhere, because the only person who goes looking for it is
 * someone who has been asked. That is the whole of its job: "what does the bottom
 * of your screen say" has to have an answer before a bug report can be matched to
 * a build.
 *
 * The second line is the one that earns its keep. A Telegram WebView caches the
 * bundle and reopens it without asking, so a user can sit on the previous release
 * for days after a deploy — and every attempt to reproduce what they are seeing
 * fails against the current one. When the server reports a different release we
 * say so, once, in a sentence that tells them what to do about it.
 *
 * It never blocks and never errors: `fetchServerVersion()` swallows its failures
 * and returns null, which renders as the bundle version alone.
 */
const serverVersion = ref<string | null>(null);
const stale = ref(false);

onMounted(async () => {
  serverVersion.value = await fetchServerVersion();
  stale.value = isStaleBundle(serverVersion.value);
});
</script>

<template>
  <footer class="flex flex-col gap-1 pb-2 text-center text-xs text-tg-hint">
    <p>
      <!-- `bdi`, or `dir="rtl"` renders `v0.3.0` with its segments reversed. -->
      نسخهٔ <bdi>{{ APP_VERSION }}</bdi>
    </p>
    <p v-if="stale">
      نسخهٔ تازه‌تری منتشر شده است. برای دریافت آن، برنامه را ببندید و دوباره باز کنید.
    </p>
  </footer>
</template>
