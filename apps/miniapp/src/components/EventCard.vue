<script setup lang="ts">
import { computed } from 'vue';
import type { DiscoveredEventView } from '@payetam/shared';
import { formatEventDate, formatEventTime, formatRelative } from '@/format/datetime';
import { formatToman, toPersianDigits } from '@/format/fa';

/**
 * One event in a list.
 *
 * Shows what somebody decides on: when, where, how full, what it costs. The host
 * appears as a display name — never anything Telegram-shaped, which is invariant 7
 * and what the CI leak scan asserts on the endpoint feeding this.
 */
const props = defineProps<{ event: DiscoveredEventView }>();

const cost = computed(() => {
  const { costType, costAmount, costNote } = props.event;
  if (costType === 'FREE') return 'رایگان';
  if (costType === 'SPLIT') return costNote ?? 'دنگی';
  if (costAmount === null) return costNote ?? '—';
  const amount = formatToman(costAmount);
  return costType === 'APPROX' ? `حدود ${amount}` : amount;
});

const place = computed(() =>
  props.event.district
    ? `${props.event.city.nameFa}، ${props.event.district.nameFa}`
    : props.event.city.nameFa,
);

const full = computed(() => props.event.remainingCapacity <= 0);
</script>

<template>
  <article
    class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4 text-start"
    :class="full ? 'opacity-70' : ''"
  >
    <div class="flex items-start justify-between gap-2">
      <h3 class="flex-1 font-medium leading-snug">{{ event.title }}</h3>
    </div>

    <p class="text-sm text-tg-subtitle">
      {{ formatEventDate(event.startsAt) }} · {{ formatEventTime(event.startsAt) }}
      <span class="text-tg-hint">({{ formatRelative(event.startsAt) }})</span>
    </p>

    <p class="text-sm text-tg-hint">
      {{ place }} · {{ event.customCategoryLabel ?? event.category.nameFa }}
    </p>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span>{{ cost }}</span>
      <span v-if="full" class="text-tg-destructive">تکمیل — با نوبت انتظار</span>
      <span v-else class="text-tg-hint">
        {{ toPersianDigits(event.remainingCapacity) }} جای خالی از
        {{ toPersianDigits(event.capacity) }}
      </span>
      <span v-if="event.genderPreference === 'FEMALE_ONLY'" class="text-tg-hint">فقط خانم‌ها</span>
      <span v-else-if="event.genderPreference === 'MALE_ONLY'" class="text-tg-hint"
        >فقط آقایان</span
      >
    </div>

    <p class="text-xs text-tg-hint">میزبان: {{ event.host.displayName }}</p>
  </article>
</template>
