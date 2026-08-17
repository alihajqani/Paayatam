<script setup lang="ts">
/**
 * The three states every screen that fetches something has to render, in one
 * place: loading, empty, and failed-with-a-retry.
 *
 * They are one component because they are mutually exclusive and were otherwise
 * going to be copied into six views — and the copy that gets forgotten is always
 * the error state, which is the one a user on a mobile network actually meets
 * (ADR-0003).
 *
 * The skeleton is deliberately not a spinner: a shape that resembles the content
 * about to arrive reads as progress rather than as a stall, which matters when the
 * connection makes it take seconds.
 */
withDefaults(
  defineProps<{
    state: 'loading' | 'empty' | 'error' | 'ready';
    /** Shown for `empty`. */
    emptyText?: string;
    /** Shown for `error`; already a Persian sentence from the error catalogue. */
    errorText?: string | null;
    /** How many skeleton rows to draw while loading. */
    rows?: number;
  }>(),
  { emptyText: 'چیزی برای نمایش نیست.', errorText: null, rows: 3 },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="state === 'loading'" class="flex flex-col gap-3" aria-busy="true" aria-live="polite">
    <span class="sr-only">در حال بارگذاری…</span>
    <div
      v-for="row in rows"
      :key="row"
      class="animate-pulse rounded-2xl bg-tg-secondary-bg"
      :style="{ height: '5.5rem' }"
    ></div>
  </div>

  <div v-else-if="state === 'error'" class="flex flex-col items-start gap-3 py-6">
    <p class="text-tg-destructive">{{ errorText ?? 'بارگذاری انجام نشد.' }}</p>
    <button type="button" class="min-h-11 text-tg-link" @click="$emit('retry')">تلاش دوباره</button>
  </div>

  <div v-else-if="state === 'empty'" class="flex flex-col items-center gap-2 py-10 text-center">
    <p class="text-tg-hint">{{ emptyText }}</p>
    <slot name="empty-action"></slot>
  </div>

  <slot v-else></slot>
</template>
