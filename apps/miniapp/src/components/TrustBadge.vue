<script setup lang="ts">
import { computed } from 'vue';
import { toPersianDigits } from '@/format/fa';
import { isKnownTrustScore } from '@/format/trust';

/**
 * Somebody else's Trust Score, in one place (M18).
 *
 * It renders on two screens that are otherwise unrelated — the host on an event
 * page, the requester in a host's queue — and the *fallback* is the reason this is
 * a component rather than two spans. `null` does not mean zero: `trust_score` is
 * written lazily by the first movement, so a brand-new account genuinely has no
 * row, and rendering that as «۰ از ۱۰۰» would show the worst possible reputation
 * to somebody who has done nothing wrong. Copied into two views, that distinction
 * is one refactor away from being lost in one of them.
 *
 * The number is never computed here and never defaulted here. It arrives from the
 * server or it is null, and out-of-range values — which the contract already
 * refuses, and which a stale cached bundle could still be holding — are treated as
 * unknown rather than clamped into something plausible.
 *
 * **Deliberately not a colour scale.** Plan §12 resolves "Trust Score in ranking"
 * against "no unfair discrimination" by keeping trust a tenth of the ranking
 * signal; painting a 43 red would undo that in the interface, where it counts for
 * far more than a tenth.
 */
const props = withDefaults(
  defineProps<{
    /** 0–100, or null when this account has never been judged. */
    score: number | null;
    /** Prefix, so the badge reads «امتیاز اعتماد میزبان» or «امتیاز اعتماد». */
    label?: string;
  }>(),
  { label: 'امتیاز اعتماد' },
);

/** Present *and* plausible. Anything else reads as unknown, never as a number. */
const known = computed(() => isKnownTrustScore(props.score));
</script>

<template>
  <span
    class="inline-flex max-w-full flex-wrap items-baseline gap-1 rounded-full bg-tg-bg px-2 py-0.5 text-xs"
    :class="known ? '' : 'text-tg-hint'"
  >
    <span class="text-tg-subtitle">{{ label }}</span>
    <template v-if="known">
      <b class="font-medium">{{ toPersianDigits(score!) }}</b>
      <span class="text-tg-hint">از ۱۰۰</span>
    </template>
    <!--
      The honest fallback. «تازه‌وارد» says what is actually true — nobody has
      judged this account yet — where «۰» would say something false about them.
    -->
    <span v-else>تازه‌وارد</span>
  </span>
</template>
