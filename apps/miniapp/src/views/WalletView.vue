<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatRelative } from '@/format/datetime';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useEconomyStore } from '@/stores/economy';

/**
 * Coins, Trust Score and invitations (M9).
 *
 * **The ledgers are the screen, not the totals.** ADR-0007 makes both append-only
 * precisely so "where did my coins go?" and "why did my score drop?" have answers,
 * and a balance shown without its history throws that away. The reason codes are
 * stable and machine-readable; the Persian is rendered here.
 *
 * `requestedDelta` is worth its own line: it is what turns "my score did not move"
 * into an explanation, because it says the policy asked for more than the bounds
 * allowed.
 */
const router = useRouter();
const economy = useEconomyStore();

const error = ref<string | null>(null);
const code = ref('');
const claimError = ref<string | null>(null);
const claimed = ref<string | null>(null);
const tab = ref<'coins' | 'trust' | 'invite'>('coins');

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (economy.loading && economy.coins === null) return 'loading' as const;
  return 'ready' as const;
});

const COIN_REASON_FA: Record<string, string> = {
  ONBOARDING_REWARD: 'هدیهٔ خوش‌آمد',
  REFERRAL_REWARD: 'پاداش دعوت',
  REVIEW_REWARD: 'پاداش نظر',
  BOOST_SPEND: 'برجسته‌کردن رویداد',
  VIP_SPEND: 'رویداد ویژه',
  CANCELLATION_PENALTY: 'جریمهٔ لغو',
  NO_SHOW_PENALTY: 'جریمهٔ غیبت',
  HOST_CANCELLATION_REFUND: 'بازگشت به‌دلیل لغو میزبان',
  ADMIN_ADJUSTMENT: 'اصلاح توسط پشتیبانی',
  REVERSAL: 'برگشت تراکنش',
};

const TRUST_REASON_FA: Record<string, string> = {
  INITIAL: 'امتیاز آغازین',
  PROFILE_COMPLETE: 'تکمیل پروفایل',
  ATTENDANCE: 'حضور در رویداد',
  REVIEW: 'نظر دریافتی',
  CANCELLATION: 'لغو',
  NO_SHOW: 'غیبت',
  MODERATION: 'تصمیم بررسی',
  REHABILITATION: 'بازیابی تدریجی',
  ADMIN_ADJUSTMENT: 'اصلاح توسط پشتیبانی',
  REVERSAL: 'برگشت',
};

async function load(): Promise<void> {
  error.value = null;
  try {
    await economy.load();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'اطلاعات حساب بارگذاری نشد.';
  }
}

async function claim(): Promise<void> {
  claimError.value = null;
  claimed.value = null;
  if (code.value.trim() === '') {
    claimError.value = 'کد دعوت را وارد کنید.';
    return;
  }

  try {
    const result = await economy.claimReferral(code.value.trim());
    haptic('success');
    claimed.value = `کد پذیرفته شد. ${formatCoins(result.pendingCoins)} پس از نخستین حضور شما آزاد می‌شود.`;
    code.value = '';
  } catch (cause) {
    haptic('error');
    claimError.value = cause instanceof ApiError ? cause.messageFa : 'ثبت کد دعوت انجام نشد.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">حساب من</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.push('/home')">
        خانه
      </button>
    </header>

    <StateBlock :state="state" :error-text="error" :rows="4" @retry="load">
      <div class="flex gap-2" role="tablist">
        <button
          v-for="option in [
            { value: 'coins', label: 'سکه‌ها' },
            { value: 'trust', label: 'اعتماد' },
            { value: 'invite', label: 'دعوت' },
          ]"
          :key="option.value"
          type="button"
          role="tab"
          :aria-selected="tab === option.value"
          class="min-h-11 flex-1 rounded-xl text-sm"
          :class="tab === option.value ? 'bg-tg-button text-tg-button-text' : 'bg-tg-secondary-bg'"
          @click="tab = option.value as 'coins' | 'trust' | 'invite'"
        >
          {{ option.label }}
        </button>
      </div>

      <!-- Coins -->
      <section v-if="tab === 'coins'" class="flex flex-col gap-3">
        <div class="rounded-2xl bg-tg-secondary-bg p-4">
          <h2 class="text-sm text-tg-subtitle">موجودی</h2>
          <p class="text-lg font-medium">{{ formatCoins(economy.coins?.balance ?? 0) }}</p>
        </div>

        <p v-if="(economy.coins?.entries.length ?? 0) === 0" class="text-tg-hint">
          هنوز تراکنشی ندارید.
        </p>

        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="(entry, index) in economy.coins?.entries"
            :key="`${entry.createdAt}-${index}`"
            class="flex items-baseline justify-between gap-2 rounded-xl bg-tg-secondary-bg p-3"
          >
            <div class="flex flex-col">
              <span class="text-sm">{{ COIN_REASON_FA[entry.type] ?? entry.reasonCode }}</span>
              <span class="text-xs text-tg-hint">{{ formatRelative(entry.createdAt) }}</span>
            </div>
            <div class="flex flex-col items-end">
              <span
                class="text-sm font-medium"
                :class="entry.amount >= 0 ? 'text-tg-accent' : 'text-tg-destructive'"
              >
                {{ entry.amount >= 0 ? '+' : '−' }}{{ toPersianDigits(Math.abs(entry.amount)) }}
              </span>
              <span class="text-xs text-tg-hint">
                مانده {{ toPersianDigits(entry.balanceAfter) }}
              </span>
            </div>
          </li>
        </ul>
      </section>

      <!-- Trust -->
      <section v-else-if="tab === 'trust'" class="flex flex-col gap-3">
        <div class="rounded-2xl bg-tg-secondary-bg p-4">
          <h2 class="text-sm text-tg-subtitle">امتیاز اعتماد</h2>
          <p class="text-lg font-medium">{{ toPersianDigits(economy.trust?.score ?? 0) }} از ۱۰۰</p>
        </div>

        <p v-if="(economy.trust?.entries.length ?? 0) === 0" class="text-tg-hint">
          هنوز تغییری در امتیاز شما ثبت نشده است.
        </p>

        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="(entry, index) in economy.trust?.entries"
            :key="`${entry.createdAt}-${index}`"
            class="flex flex-col gap-1 rounded-xl bg-tg-secondary-bg p-3"
          >
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-sm">{{ TRUST_REASON_FA[entry.type] ?? entry.reasonCode }}</span>
              <span
                class="text-sm font-medium"
                :class="entry.delta >= 0 ? 'text-tg-accent' : 'text-tg-destructive'"
              >
                {{ entry.delta >= 0 ? '+' : '−' }}{{ toPersianDigits(Math.abs(entry.delta)) }}
              </span>
            </div>
            <span class="text-xs text-tg-hint">
              {{ toPersianDigits(entry.scoreBefore) }} ← {{ toPersianDigits(entry.scoreAfter) }} ·
              {{ formatRelative(entry.createdAt) }}
            </span>
            <!-- What the policy asked for, when the bounds ate some of it. -->
            <span
              v-if="entry.requestedDelta !== null && entry.requestedDelta !== entry.delta"
              class="text-xs text-tg-hint"
            >
              محاسبه {{ toPersianDigits(Math.abs(entry.requestedDelta)) }} بود؛ امتیاز به سقف یا کف
              رسیده بود.
            </span>
          </li>
        </ul>
      </section>

      <!-- Invite -->
      <section v-else class="flex flex-col gap-3">
        <div class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4">
          <h2 class="text-sm text-tg-subtitle">کد دعوت شما</h2>
          <p class="select-all text-lg font-medium tracking-wider">
            {{ economy.referral?.code ?? '—' }}
          </p>
          <p class="text-sm text-tg-hint">
            {{ toPersianDigits(economy.referral?.invited ?? 0) }} نفر از کد شما استفاده کرده‌اند.
          </p>
        </div>

        <div class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4">
          <h2 class="text-sm text-tg-subtitle">کد دعوت دارید؟</h2>
          <input
            v-model="code"
            type="text"
            maxlength="40"
            placeholder="کد را وارد کنید"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
          />
          <p v-if="claimError" class="text-sm text-tg-destructive">{{ claimError }}</p>
          <p v-if="claimed" class="text-sm">{{ claimed }}</p>
          <button
            type="button"
            class="min-h-11 rounded-xl bg-tg-button text-sm text-tg-button-text"
            @click="claim"
          >
            ثبت کد
          </button>
        </div>
      </section>
    </StateBlock>
  </main>
</template>
