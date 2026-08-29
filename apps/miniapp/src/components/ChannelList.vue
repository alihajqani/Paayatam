<script setup lang="ts">
import type { ChannelMembershipView } from '@payetam/shared';
import { toPersianDigits } from '@/format/fa';

/**
 * The channels a user has to join, in the order they were told to join them.
 *
 * One component rather than two copies, because the same list appears on the
 * blocking screen and inside `ChannelGate`'s banner — and a list that disagreed
 * with itself across two screens is worse than no list.
 *
 * **The order is the server's.** `required_channel.sort_order` is what the
 * operator set in the panel, the API preserves it, and nothing here sorts: the
 * order of joining is a product decision, and re-sorting by status would move a
 * row out from under somebody's thumb the moment they joined it.
 *
 * The link is safe to render: it was validated and rebuilt server-side as
 * `https://t.me/…`, so it cannot be an arbitrary host however it was typed.
 * `rel="noopener noreferrer"` because it leaves the Mini App.
 */
defineProps<{
  channels: ChannelMembershipView[];
  /** Numbers the rows. Off inside a banner, on when the list *is* the screen. */
  numbered?: boolean;
}>();
</script>

<template>
  <ol class="flex flex-col gap-2">
    <li
      v-for="(channel, index) in channels"
      :key="channel.id"
      class="flex items-center gap-3 rounded-xl bg-tg-bg p-3"
    >
      <span
        v-if="numbered"
        class="flex size-7 shrink-0 items-center justify-center rounded-full text-sm"
        :class="channel.allowed ? 'bg-tg-accent text-tg-button-text' : 'bg-tg-secondary-bg'"
        aria-hidden="true"
      >
        {{ channel.allowed ? '✓' : toPersianDigits(index + 1) }}
      </span>

      <span class="flex-1 text-sm font-medium">{{ channel.title }}</span>

      <!--
        Joined channels keep their row rather than disappearing: the list is a
        checklist, and a row vanishing as you tap it is how somebody loses their
        place in a list of four.
      -->
      <span v-if="channel.allowed" class="shrink-0 text-sm text-tg-accent">عضو هستید</span>

      <a
        v-else-if="channel.joinUrl"
        :href="channel.joinUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="flex min-h-10 shrink-0 items-center rounded-xl bg-tg-button px-4 text-sm text-tg-button-text"
      >
        عضویت
      </a>

      <span v-else class="shrink-0 text-sm text-tg-destructive">پیوند تنظیم نشده</span>
    </li>
  </ol>
</template>
