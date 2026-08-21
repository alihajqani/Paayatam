<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber, toPersianDigits } from '@/format/fa';

/**
 * Offset paging over a bounded list.
 *
 * Offsets rather than keyset, and deliberately: the Mini App's discovery uses a
 * cursor because it is an infinite feed a stranger scrolls, and every admin list
 * is a *bounded* result somebody jumps around in — "page 4 of 12" is the shape of
 * the question here, and a cursor cannot answer it.
 *
 * The total comes from the API on every page for the same reason: without it,
 * "is that all of them?" is unanswerable, which is the question an operator asks
 * before they stop looking.
 */
const props = defineProps<{ total: number; limit: number; offset: number; loading?: boolean }>();
const emit = defineEmits<{ move: [offset: number] }>();

const page = computed(() => Math.floor(props.offset / props.limit) + 1);
const pages = computed(() => Math.max(Math.ceil(props.total / props.limit), 1));
const first = computed(() => (props.total === 0 ? 0 : props.offset + 1));
const last = computed(() => Math.min(props.offset + props.limit, props.total));
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 pt-3 text-sm text-ink-soft">
    <p>
      <bdi>{{ formatNumber(first) }}</bdi>
      تا
      <bdi>{{ formatNumber(last) }}</bdi>
      از
      <bdi>{{ formatNumber(total) }}</bdi>
    </p>

    <div class="flex items-center gap-2">
      <button
        type="button"
        class="min-h-9 rounded-lg border border-line px-3 disabled:opacity-40"
        :disabled="offset <= 0 || loading"
        @click="emit('move', Math.max(offset - limit, 0))"
      >
        قبلی
      </button>
      <span class="tabular-nums">
        صفحهٔ <bdi>{{ toPersianDigits(page) }}</bdi> از <bdi>{{ toPersianDigits(pages) }}</bdi>
      </span>
      <button
        type="button"
        class="min-h-9 rounded-lg border border-line px-3 disabled:opacity-40"
        :disabled="offset + limit >= total || loading"
        @click="emit('move', offset + limit)"
      >
        بعدی
      </button>
    </div>
  </div>
</template>
