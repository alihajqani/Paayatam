<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EventView } from '@payetam/shared';
import { ApiError } from '@/api/client';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';
import { useSessionStore } from '@/stores/session';

/**
 * Buying a placement in the VIP channel (M9, M14).
 *
 * **Two different purchases, and the difference is the whole point of this screen.**
 * A boost is a *window* — the event is posted to the channel and ranked higher in
 * discovery for a configured number of hours, and then it is not. VIP is a
 * *standing*: the event carries the badge and its channel post for good. Somebody who
 * thinks they are renting when they are buying, or the reverse, has been misled by
 * their own software, so both prices, both durations and the permanence of VIP are on
 * screen before anything is charged.
 *
 * **The prices come from the server.** `economy.boost_coins`, `economy.vip_coins` and
 * `economy.boost_duration_hours` are `app_setting` rows an admin can change at
 * runtime; the catalog carries their current values. Nothing here is hardcoded, so a
 * price change reaches the confirmation the next time a client loads the catalog.
 *
 * **Insufficient balance is answered before the request, not after it.** The server
 * still refuses with `INSUFFICIENT_COINS` — that check is the real one and is not
 * weakened by this — but discovering it by being refused is a worse experience than
 * seeing the button disabled with the reason next to it.
 */
const props = defineProps<{ event: EventView }>();
const emit = defineEmits<{ done: []; dismiss: [] }>();

const events = useEventsStore();
const session = useSessionStore();

type Kind = 'BOOST' | 'VIP';

const kind = ref<Kind>('BOOST');
const error = ref<string | null>(null);
const inFlight = ref(false);
const purchased = ref(false);

const pricing = computed(() => session.catalog?.promotion ?? null);
const balance = computed(() => session.me?.coins.balance ?? 0);

const cost = computed(() => {
  if (pricing.value === null) return null;
  return kind.value === 'VIP' ? pricing.value.vipCoins : pricing.value.boostCoins;
});

const affordable = computed(() => cost.value !== null && balance.value >= cost.value);

/** VIP is bought once; offering it again would sell somebody what they already own. */
const vipAvailable = computed(() => !props.event.isVip);

async function load(): Promise<void> {
  error.value = null;
  try {
    // The catalog carries the prices and is cached in the session store; `/me` is
    // what makes the balance current after an earlier purchase.
    if (session.catalog === null) await session.loadCatalog();
    await session.refreshMe();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'اطلاعات خرید بارگذاری نشد.';
  }
}

async function confirm(): Promise<void> {
  if (!affordable.value || inFlight.value) return;
  error.value = null;
  inFlight.value = true;

  try {
    // The store sends an `Idempotency-Key`, so a retry over a dropped connection is
    // recognised as the same purchase rather than charged twice.
    await events.boost(props.event.publicId, kind.value);
    // The balance moved; the ledger is the source of truth for it.
    await session.refreshMe().catch(() => undefined);
    haptic('success');
    purchased.value = true;
    emit('done');
  } catch (cause) {
    haptic('error');
    error.value = cause instanceof ApiError ? cause.messageFa : 'خرید انجام نشد. دوباره تلاش کنید.';
  } finally {
    inFlight.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-3 rounded-2xl bg-tg-bg p-4">
    <!-- After the purchase: what was bought, and an honest account of what happens next. -->
    <template v-if="purchased">
      <p class="font-medium">خرید شما ثبت شد. 🎉</p>
      <p class="text-sm text-tg-hint">
        انتشار در کانال ویژه توسط سرویس پس‌زمینه انجام می‌شود و ممکن است چند دقیقه طول بکشد. وضعیت
        آن را در همین صفحه می‌بینید.
      </p>
      <button type="button" class="min-h-11 self-start text-tg-link" @click="emit('dismiss')">
        بستن
      </button>
    </template>

    <template v-else>
      <div>
        <h3 class="font-medium">معرفی رویداد در کانال ویژه</h3>
        <p class="text-sm text-tg-hint">
          رویداد شما در کانال ویژهٔ پایه‌تَم برای مخاطبان بیشتری منتشر می‌شود.
        </p>
      </div>

      <p v-if="pricing === null" class="text-sm text-tg-hint">در حال دریافت قیمت‌ها…</p>

      <template v-else>
        <!-- The choice, with the difference stated rather than implied. -->
        <div class="flex flex-col gap-2">
          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl p-3 text-start"
            :class="kind === 'BOOST' ? 'bg-tg-button text-tg-button-text' : 'bg-tg-secondary-bg'"
            :aria-pressed="kind === 'BOOST'"
            @click="kind = 'BOOST'"
          >
            <span class="flex items-baseline justify-between gap-2">
              <span class="font-medium">برجسته‌سازی</span>
              <span class="text-sm">{{ formatCoins(pricing.boostCoins) }}</span>
            </span>
            <span class="text-xs opacity-90">
              به مدت {{ toPersianDigits(pricing.boostDurationHours) }} ساعت در کانال ویژه منتشر
              می‌شود و در فهرست رویدادها بالاتر دیده می‌شود. پس از پایان این مدت، رویداد به حالت
              عادی برمی‌گردد.
            </span>
          </button>

          <button
            v-if="vipAvailable"
            type="button"
            class="flex flex-col gap-1 rounded-xl p-3 text-start"
            :class="kind === 'VIP' ? 'bg-tg-button text-tg-button-text' : 'bg-tg-secondary-bg'"
            :aria-pressed="kind === 'VIP'"
            @click="kind = 'VIP'"
          >
            <span class="flex items-baseline justify-between gap-2">
              <span class="font-medium">ویژه (دائمی)</span>
              <span class="text-sm">{{ formatCoins(pricing.vipCoins) }}</span>
            </span>
            <span class="text-xs opacity-90">
              رویداد نشان «ویژه» می‌گیرد و در کانال ویژه منتشر می‌شود. این وضعیت
              <b>همیشگی</b> است، تاریخ پایان ندارد و بازگشت‌پذیر نیست.
            </span>
          </button>
          <p v-else class="text-xs text-tg-hint">این رویداد از پیش «ویژه» است.</p>
        </div>

        <div class="flex items-baseline justify-between gap-2 text-sm">
          <span class="text-tg-subtitle">موجودی شما</span>
          <span :class="affordable ? '' : 'text-tg-destructive'">{{ formatCoins(balance) }}</span>
        </div>

        <p v-if="!affordable && cost !== null" class="text-sm text-tg-destructive">
          برای این خرید {{ formatCoins(cost) }} لازم است و موجودی شما کافی نیست.
        </p>

        <p v-if="error" class="text-sm text-tg-destructive">{{ error }}</p>

        <div class="flex gap-2">
          <button
            type="button"
            class="min-h-11 flex-1 rounded-xl bg-tg-button text-sm text-tg-button-text disabled:opacity-50"
            :disabled="!affordable || inFlight"
            @click="confirm"
          >
            {{
              inFlight ? 'در حال ثبت…' : cost !== null ? `پرداخت ${formatCoins(cost)}` : 'پرداخت'
            }}
          </button>
          <button
            type="button"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
            @click="emit('dismiss')"
          >
            بعداً
          </button>
        </div>
      </template>
    </template>
  </div>
</template>
