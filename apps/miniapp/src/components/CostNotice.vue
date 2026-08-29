<script setup lang="ts">
import { computed } from 'vue';
import { formatCoins } from '@/format/fa';

/**
 * What a paid action costs, and whether the user can afford it (M22 phase 5).
 *
 * One component rather than the same three lines on four screens, because the
 * rule it encodes is a product rule and not a layout: **the price and the balance
 * are shown together, before the button, every time.** A screen that shows only
 * the price makes "سکهٔ کافی ندارید" arrive as a surprise after the tap.
 *
 * Both numbers come from the server — `catalog.promotion` for the price and
 * `/me` for the balance — so neither is a guess a stale bundle could get wrong.
 * Nothing here is optimistic: the parent re-reads the balance after a successful
 * charge rather than subtracting locally, because a subtraction that survives a
 * failed request is a number the user will act on and the server will not honour.
 */
const props = defineProps<{
  /** What the action costs right now. Zero renders as free. */
  cost: number;
  /** The signed-in user's balance, or null while it is still loading. */
  balance: number | null;
  /** Overrides the default «هزینهٔ این کار». */
  label?: string;
}>();

const affordable = computed(() => props.balance === null || props.balance >= props.cost);
</script>

<template>
  <!--
    `role="status"` rather than `alert`: this is standing information a user
    reads before deciding, not an interruption. The shortfall line below is the
    part that changes, and it is inside the same live region so a screen reader
    announces it when the balance loads.
  -->
  <section
    class="flex flex-col gap-1 rounded-xl px-4 py-3 text-sm"
    :class="affordable ? 'bg-tg-secondary-bg' : 'bg-tg-secondary-bg ring-1 ring-tg-destructive'"
    role="status"
  >
    <p v-if="cost === 0" class="font-medium">{{ label ?? 'هزینهٔ این کار' }}: رایگان</p>
    <p v-else class="font-medium">{{ label ?? 'هزینهٔ این کار' }}: {{ formatCoins(cost) }}</p>

    <p v-if="balance === null" class="text-tg-hint">در حال خواندن موجودی…</p>
    <p v-else class="text-tg-hint">موجودی شما: {{ formatCoins(balance) }}</p>

    <p v-if="!affordable" class="text-tg-destructive">
      برای انجام این کار
      {{ formatCoins(cost - (balance ?? 0)) }}
      کم دارید.
    </p>
  </section>
</template>
