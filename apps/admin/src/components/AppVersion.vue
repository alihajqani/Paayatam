<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { APP_VERSION, fetchServerVersion, isServerAhead } from '@/version';

/**
 * The release line at the foot of the sidebar (M22 phase 10).
 *
 * Two numbers, because they are two facts and they come apart during exactly the
 * minutes an operator is most likely to look: nginx serves the new bundle as soon
 * as its container is up, while the API is behind its own start-up and its own
 * migration step. See `@/version` for the whole of it.
 *
 * When they differ the second line says so plainly rather than colouring the
 * first one red — a version mismatch mid-deploy is expected, not an incident, and
 * a panel that cries wolf during every rollout is a panel nobody reads.
 */
const serverVersion = ref<string | null>(null);
const mismatch = ref(false);

onMounted(async () => {
  serverVersion.value = await fetchServerVersion();
  mismatch.value = isServerAhead(serverVersion.value);
});
</script>

<template>
  <!--
    `hidden lg:flex` lives here rather than on the caller: `hidden` and `flex`
    are both display utilities, and which one wins when both are on an element
    is decided by their order in the stylesheet, not by the order they are
    written. Keeping the pair together on one element is what makes it legible.
  -->
  <div class="hidden flex-col gap-0.5 px-4 py-3 text-xs text-ink-faint lg:flex">
    <!-- `bdi` on every version string: a Latin tag inside RTL text renders with
         its segments reversed without it (see `styles/main.css`). -->
    <p>
      پنل <bdi>{{ APP_VERSION }}</bdi>
      <template v-if="serverVersion">
        · سرور <bdi>{{ serverVersion }}</bdi>
      </template>
    </p>
    <p v-if="mismatch">نسخهٔ پنل و سرور یکی نیست. اگر استقرار در جریان است، صفحه را تازه کنید.</p>
  </div>
</template>
