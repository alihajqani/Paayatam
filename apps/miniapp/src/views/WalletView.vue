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
const claiming = ref(false);
const copied = ref(false);
const tab = ref<'coins' | 'trust' | 'invite'>('coins');

/** The gift-code form, kept separate from the invite one: two codes, two outcomes. */
const giftCode = ref('');
const giftError = ref<string | null>(null);
const giftSuccess = ref<string | null>(null);
const redeeming = ref(false);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (economy.loading && economy.coins === null) return 'loading' as const;
  return 'ready' as const;
});

const COIN_REASON_FA: Record<string, string> = {
  ONBOARDING_REWARD: 'هدیهٔ خوش‌آمد',
  REFERRAL_REWARD: 'پاداش دعوت',
  REVIEW_REWARD: 'پاداش نظر',
  GIFT_CODE_REDEEM: 'کد هدیه',
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

  claiming.value = true;
  try {
    const result = await economy.claimReferral(code.value.trim());
    haptic('success');
    // What the server said is pending, not a number this screen decided. Once the
    // claim settles immediately — the caller had already attended something —
    // `pendingCoins` is zero and the sentence says so instead of promising coins.
    claimed.value =
      result.status === 'QUALIFIED'
        ? 'کد پذیرفته شد و پاداش شما همین حالا واریز شد.'
        : `کد پذیرفته شد. ${formatCoins(result.pendingCoins)} پس از نخستین حضور شما آزاد می‌شود.`;
    code.value = '';
  } catch (cause) {
    haptic('error');
    claimError.value = cause instanceof ApiError ? cause.messageFa : 'ثبت کد دعوت انجام نشد.';
  } finally {
    claiming.value = false;
  }
}

/**
 * Redeems a gift code.
 *
 * Every refusal the server can give — unknown, expired, already used, exhausted —
 * arrives as its own `code` with its own Persian sentence from the shared error
 * catalogue, so this handler renders `messageFa` rather than deciding what went
 * wrong. The generic fallback exists for the network failure, which is the one
 * case the server never got to answer.
 */
async function redeem(): Promise<void> {
  giftError.value = null;
  giftSuccess.value = null;
  if (giftCode.value.trim() === '') {
    giftError.value = 'کد هدیه را وارد کنید.';
    return;
  }

  redeeming.value = true;
  try {
    const result = await economy.redeemGiftCode(giftCode.value.trim());
    haptic('success');
    // Both numbers are the server's: what was granted, and the balance it left.
    giftSuccess.value = `${formatCoins(result.coins)} به حساب شما اضافه شد. موجودی: ${formatCoins(result.balance)}`;
    giftCode.value = '';
  } catch (cause) {
    haptic('error');
    giftError.value = cause instanceof ApiError ? cause.messageFa : 'ثبت کد هدیه انجام نشد.';
  } finally {
    redeeming.value = false;
  }
}

/**
 * Hands the invite code to whatever the platform offers.
 *
 * `navigator.share` inside Telegram's WebView where it exists, the clipboard
 * otherwise, and a `<p class="select-all">` underneath either way — a code the
 * user can always select by hand is the fallback that needs no permission and
 * cannot fail.
 */
async function shareCode(): Promise<void> {
  const value = economy.referral?.code;
  if (!value) return;

  const text = `با این کد در پایه‌تَم عضو شو و هر دو سکه بگیریم: ${value}`;
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(value);
    copied.value = true;
    haptic('success');
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // A dismissed share sheet and a denied clipboard are both "the user did not
    // get the code this way", and neither is an error worth a red sentence: the
    // code is on screen and selectable.
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
          <p class="text-lg font-medium" aria-live="polite">
            {{ formatCoins(economy.coins?.balance ?? 0) }}
          </p>
        </div>

        <!--
          Redeeming a gift code (M18).

          Nothing here knows what a code is worth: the amount comes back in the
          response and is rendered from it, so a campaign retuned in the database
          needs no deploy. Four distinct refusals reach this form — unknown,
          expired, already used, exhausted — each with its own Persian sentence
          from the shared catalogue.
        -->
        <form
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
          @submit.prevent="redeem"
        >
          <h2 class="text-sm text-tg-subtitle">کد هدیه دارید؟</h2>
          <input
            v-model="giftCode"
            type="text"
            maxlength="32"
            autocapitalize="characters"
            autocomplete="off"
            placeholder="کد را وارد کنید"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
            :disabled="redeeming"
          />
          <p v-if="giftError" class="text-sm text-tg-destructive" aria-live="assertive">
            {{ giftError }}
          </p>
          <p v-if="giftSuccess" class="text-sm text-tg-accent" aria-live="polite">
            {{ giftSuccess }}
          </p>
          <button
            type="submit"
            class="min-h-11 rounded-xl bg-tg-button text-sm text-tg-button-text disabled:opacity-50"
            :disabled="redeeming || giftCode.trim() === ''"
          >
            {{ redeeming ? 'در حال بررسی…' : 'دریافت سکه' }}
          </button>
        </form>

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
          <!--
            `select-all` so the code can always be taken by hand, whatever the
            share sheet and the clipboard permission do. It is the fallback that
            cannot fail.
          -->
          <p class="select-all text-lg font-medium tracking-wider">
            {{ economy.referral?.code ?? '—' }}
          </p>
          <button
            type="button"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm text-tg-link disabled:opacity-50"
            :disabled="!economy.referral?.code"
            @click="shareCode"
          >
            {{ copied ? 'کپی شد ✓' : 'هم‌رسانی یا کپی کد' }}
          </button>
          <p class="text-sm text-tg-hint">
            وقتی کسی با کد شما عضو شود و در نخستین رویدادش شرکت کند، هر دوی شما سکه می‌گیرید.
          </p>
        </div>

        <!--
          Where the referral actually stands (M18).

          Three numbers rather than one, because "two people used my code and
          nothing arrived" is the question this screen exists to answer: how many
          claimed it, how many of those have attended, and what has been paid.
          `coinsEarned` counts both halves — the coins earned as a referrer and the
          ones earned for having been referred.
        -->
        <div class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4">
          <h2 class="text-sm text-tg-subtitle">وضعیت دعوت‌ها</h2>
          <dl class="flex flex-col gap-1 text-sm">
            <div class="flex items-baseline justify-between gap-2">
              <dt class="text-tg-hint">استفاده‌کننده از کد شما</dt>
              <dd>{{ toPersianDigits(economy.referral?.invited ?? 0) }} نفر</dd>
            </div>
            <div class="flex items-baseline justify-between gap-2">
              <dt class="text-tg-hint">پاداش‌گرفته (پس از حضور)</dt>
              <dd>{{ toPersianDigits(economy.referral?.qualified ?? 0) }} نفر</dd>
            </div>
            <div class="flex items-baseline justify-between gap-2">
              <dt class="text-tg-hint">سکهٔ دریافتی از دعوت</dt>
              <dd>{{ formatCoins(economy.referral?.coinsEarned ?? 0) }}</dd>
            </div>
          </dl>
          <p v-if="(economy.referral?.invited ?? 0) === 0" class="text-xs text-tg-hint">
            هنوز کسی از کد شما استفاده نکرده است.
          </p>
          <p v-else-if="(economy.referral?.qualified ?? 0) === 0" class="text-xs text-tg-hint">
            پاداش پس از نخستین حضور دعوت‌شده در یک رویداد آزاد می‌شود.
          </p>
        </div>

        <!--
          Claiming somebody else's code. Hidden once the caller already has a
          referrer: `referred_user_id` is UNIQUE, so a second claim can only ever
          be refused, and offering a form that cannot succeed is worse than
          explaining why.
        -->
        <div
          v-if="economy.referral && economy.referral.referredBy"
          class="flex flex-col gap-1 rounded-2xl bg-tg-secondary-bg p-4"
        >
          <h2 class="text-sm text-tg-subtitle">کد دعوت شما ثبت شده است</h2>
          <!--
            Three states, because `REJECTED` became reachable in M19. Before it
            did, «در انتظار» was true of everything that was not qualified; a
            refused referral now renders as refused instead of as waiting for an
            event that will never pay.

            No reason is shown, and that is deliberate: why a referral was refused
            lives on the admin surface, because naming the signal that fired to
            the person it fired on tells a farmer what to change (T6).
          -->
          <p class="text-sm text-tg-hint">
            <template v-if="economy.referral.referredBy.status === 'QUALIFIED'">
              پاداش دعوت شما واریز شده است.
            </template>
            <template v-else-if="economy.referral.referredBy.status === 'REJECTED'">
              این دعوت تأیید نشد و پاداشی برای آن ثبت نمی‌شود. اگر فکر می‌کنید اشتباهی رخ داده، با
              پشتیبانی تماس بگیرید.
            </template>
            <template v-else>
              پس از نخستین حضور شما در یک رویداد، پاداش دعوت واریز می‌شود.
            </template>
          </p>
        </div>

        <form
          v-else
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
          @submit.prevent="claim"
        >
          <h2 class="text-sm text-tg-subtitle">کد دعوت دارید؟</h2>
          <input
            v-model="code"
            type="text"
            maxlength="32"
            autocapitalize="characters"
            autocomplete="off"
            placeholder="کد را وارد کنید"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
            :disabled="claiming"
          />
          <p v-if="claimError" class="text-sm text-tg-destructive" aria-live="assertive">
            {{ claimError }}
          </p>
          <p v-if="claimed" class="text-sm text-tg-accent" aria-live="polite">{{ claimed }}</p>
          <button
            type="submit"
            class="min-h-11 rounded-xl bg-tg-button text-sm text-tg-button-text disabled:opacity-50"
            :disabled="claiming || code.trim() === ''"
          >
            {{ claiming ? 'در حال بررسی…' : 'ثبت کد' }}
          </button>
        </form>
      </section>
    </StateBlock>
  </main>
</template>
