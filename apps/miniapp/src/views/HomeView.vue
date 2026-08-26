<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppVersion from '@/components/AppVersion.vue';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { useChatsStore } from '@/stores/chats';
import { useReviewsStore } from '@/stores/reviews';
import { useSessionStore } from '@/stores/session';

/**
 * Where onboarding lands, and where the product starts.
 *
 * It confirms the profile was saved and shows the balance — including the welcome
 * coins, which is the only visible proof the reward landed — and then gets out of the
 * way: the five things a user can do are one tap each.
 */
const route = useRoute();
const session = useSessionStore();
const chats = useChatsStore();
const reviews = useReviewsStore();

const profile = computed(() => session.me?.profile ?? null);
const balance = computed(() => session.me?.coins.balance ?? 0);
const justRewarded = computed(() => route.query['welcome'] === '1');

onMounted(() => {
  // Only to put counts on two rows. A failure here must not take the home screen
  // down with it, so both are deliberately swallowed.
  void chats.load().catch(() => undefined);
  void reviews.loadPending().catch(() => undefined);
});
</script>

<template>
  <main class="flex flex-1 flex-col gap-5 py-6">
    <h1 class="text-xl font-bold">
      {{ profile ? `${profile.displayName} عزیز، خوش آمدید` : 'خوش آمدید' }}
    </h1>

    <p v-if="justRewarded" class="rounded-xl bg-tg-secondary-bg p-4">
      پروفایل شما کامل شد و {{ formatCoins(balance) }} به حساب شما اضافه شد.
    </p>

    <section class="rounded-xl bg-tg-secondary-bg p-4">
      <h2 class="text-sm text-tg-subtitle">موجودی</h2>
      <p class="text-lg font-medium">{{ formatCoins(balance) }}</p>
    </section>

    <section v-if="profile" class="flex flex-col gap-2 rounded-xl bg-tg-secondary-bg p-4">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-sm text-tg-subtitle">پروفایل</h2>
        <RouterLink to="/profile/edit" class="min-h-11 py-2 text-sm text-tg-link"
          >ویرایش</RouterLink
        >
      </div>
      <p>
        {{ profile.city.nameFa
        }}<template v-if="profile.district"> — {{ profile.district.nameFa }}</template>
      </p>
      <p v-if="profile.birthYear" class="text-sm text-tg-hint">
        سال تولد: {{ toPersianDigits(profile.birthYear - 621) }}
      </p>
      <ul class="flex flex-wrap gap-2">
        <li
          v-for="interest in profile.interests"
          :key="interest.id"
          class="rounded-full bg-tg-bg px-3 py-1 text-sm"
        >
          {{ interest.nameFa }}
        </li>
      </ul>
    </section>

    <nav class="flex flex-col gap-2">
      <RouterLink
        to="/discover"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-secondary-bg px-4 py-3"
      >
        <span class="font-medium">گشتن در رویدادها</span>
        <span class="text-tg-hint">›</span>
      </RouterLink>

      <RouterLink
        to="/events/new"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-button px-4 py-3 text-tg-button-text"
      >
        <span class="font-medium">ساخت رویداد</span>
        <span>›</span>
      </RouterLink>

      <RouterLink
        to="/my-requests"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-secondary-bg px-4 py-3"
      >
        <span class="font-medium">درخواست‌های من</span>
        <span class="text-tg-hint">›</span>
      </RouterLink>

      <RouterLink
        to="/my-events"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-secondary-bg px-4 py-3"
      >
        <span class="font-medium">رویدادهای من</span>
        <span class="text-tg-hint">›</span>
      </RouterLink>

      <RouterLink
        to="/chats"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-secondary-bg px-4 py-3"
      >
        <span class="font-medium">گفت‌وگوها</span>
        <span
          v-if="chats.unreadTotal > 0"
          class="rounded-full bg-tg-button px-2 py-0.5 text-xs text-tg-button-text"
        >
          {{ toPersianDigits(chats.unreadTotal) }}
        </span>
        <span v-else class="text-tg-hint">›</span>
      </RouterLink>

      <RouterLink
        to="/reviews"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-secondary-bg px-4 py-3"
      >
        <span class="font-medium">نظرها</span>
        <span
          v-if="reviews.pending.length > 0"
          class="rounded-full bg-tg-button px-2 py-0.5 text-xs text-tg-button-text"
        >
          {{ toPersianDigits(reviews.pending.length) }}
        </span>
        <span v-else class="text-tg-hint">›</span>
      </RouterLink>

      <RouterLink
        to="/wallet"
        class="flex min-h-11 items-center justify-between rounded-xl bg-tg-secondary-bg px-4 py-3"
      >
        <span class="font-medium">سکه‌ها، اعتماد و دعوت</span>
        <span class="text-tg-hint">›</span>
      </RouterLink>
    </nav>

    <!--
      Bottom of the home screen, which is where a version string lives in every
      app the user already has. `mt-auto` so it sits at the foot of a short
      viewport rather than floating under the last button.
    -->
    <AppVersion class="mt-auto" />
  </main>
</template>
