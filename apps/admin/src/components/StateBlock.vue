<script setup lang="ts">
/**
 * Loading, empty, and failed-with-a-retry, in one place.
 *
 * The Mini App has the same component for the same reason (ADR-0003): they are
 * mutually exclusive states that were otherwise going to be copied into every
 * screen, and the copy that gets forgotten is always the error state. This one
 * draws table-shaped skeletons rather than card-shaped ones, because that is what
 * is about to arrive.
 */
withDefaults(
  defineProps<{
    state: 'loading' | 'empty' | 'error' | 'ready';
    emptyText?: string;
    /** Already a Persian sentence from the error catalogue. */
    errorText?: string | null;
    rows?: number;
  }>(),
  { emptyText: 'چیزی برای نمایش نیست.', errorText: null, rows: 6 },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="state === 'loading'" class="flex flex-col gap-2" aria-busy="true" aria-live="polite">
    <span class="sr-only">در حال بارگذاری…</span>
    <div v-for="row in rows" :key="row" class="h-11 animate-pulse rounded-lg bg-neutral-soft"></div>
  </div>

  <div
    v-else-if="state === 'error'"
    class="flex flex-col items-start gap-3 rounded-xl border border-line bg-danger-soft p-6"
    role="alert"
  >
    <p class="text-danger">{{ errorText ?? 'بارگذاری انجام نشد.' }}</p>
    <button
      type="button"
      class="min-h-9 rounded-lg border border-line-strong px-3 text-sm"
      @click="$emit('retry')"
    >
      تلاش دوباره
    </button>
  </div>

  <div
    v-else-if="state === 'empty'"
    class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-12 text-center"
  >
    <p class="text-ink-soft">{{ emptyText }}</p>
    <slot name="empty-action"></slot>
  </div>

  <slot v-else></slot>
</template>
