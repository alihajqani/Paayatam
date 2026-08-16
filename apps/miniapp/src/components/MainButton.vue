<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { webApp } from '@/telegram/webapp';

/**
 * The primary action of a screen.
 *
 * Inside Telegram this is the client's own `MainButton` — pinned above the
 * keyboard, styled by the user's theme, exactly where a Telegram user expects
 * the primary action to be. Rendering our own button there would look like a
 * website in a WebView, which ADR-0003 explicitly rules out.
 *
 * Outside Telegram it falls back to an in-page button. Not a convenience: a
 * developer opening `localhost:5173` in Chrome would otherwise have no way to
 * submit anything.
 */
const props = withDefaults(defineProps<{ text: string; disabled?: boolean; loading?: boolean }>(), {
  disabled: false,
  loading: false,
});

const emit = defineEmits<{ click: [] }>();

function handleClick(): void {
  if (props.disabled || props.loading) return;
  emit('click');
}

function sync(): void {
  const button = webApp?.MainButton;
  if (!button) return;

  button.setText(props.text);
  if (props.disabled) button.disable();
  else button.enable();
  // `true` keeps the button active under the spinner, so the disabled state
  // above stays the single source of truth for whether a tap does anything.
  if (props.loading) button.showProgress(true);
  else button.hideProgress();
  button.show();
}

onMounted(() => {
  webApp?.MainButton.onClick(handleClick);
  sync();
});

onBeforeUnmount(() => {
  webApp?.MainButton.offClick(handleClick);
  webApp?.MainButton.hide();
});

watch(() => [props.text, props.disabled, props.loading], sync);
</script>

<template>
  <!--
    Only rendered outside Telegram. `min-height` is the 44px touch-target floor;
    the safe-area inset keeps it clear of a home indicator.
  -->
  <div
    v-if="!webApp"
    class="sticky bottom-0 bg-tg-bg pt-3"
    :style="{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }"
  >
    <button
      type="button"
      class="min-h-11 w-full rounded-xl bg-tg-button px-4 text-base font-medium text-tg-button-text transition-opacity disabled:opacity-50"
      :disabled="disabled || loading"
      @click="handleClick"
    >
      {{ loading ? 'در حال ارسال…' : text }}
    </button>
  </div>
</template>
