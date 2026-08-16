<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Where onboarding lands.
 *
 * Discovery, activities and chat arrive in M4–M8. Until then this confirms the
 * profile was saved and shows the balance — including the welcome coins, which
 * is the only visible proof the reward landed.
 */
const route = useRoute();
const session = useSessionStore();

const profile = computed(() => session.me?.profile ?? null);
const balance = computed(() => session.me?.coins.balance ?? 0);
const justRewarded = computed(() => route.query['welcome'] === '1');
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
      <h2 class="text-sm text-tg-subtitle">پروفایل</h2>
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

    <p class="text-sm text-tg-hint">
      ساخت و جست‌وجوی فعالیت‌ها به‌زودی در همین صفحه در دسترس قرار می‌گیرد.
    </p>
  </main>
</template>
