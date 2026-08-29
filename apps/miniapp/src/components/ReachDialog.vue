<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EventView, InvitePreviewResponse } from '@payetam/shared';
import { ApiError, newIdempotencyKey } from '@/api/client';
import CostNotice from '@/components/CostNotice.vue';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';
import { useSessionStore } from '@/stores/session';

/**
 * Publishing an event: the only two ways, and both of them (report 5).
 *
 * ── Why this is now the whole of it ──────────────────────────────────────────
 *
 * There used to be a second dialog selling «برجسته‌سازی» and «ویژه (دائمی)» —
 * a window near the top of discovery, and a permanent badge — both described as
 * placements in a «کانال ویژه». This deployment has **one** channel, so that
 * screen offered a paid choice between two things that were the same thing, in a
 * place that does not exist. It is gone from the product; the endpoints behind it
 * are untouched, so an event that already carries a badge keeps it.
 *
 * What is left is what the host actually decides between: fifteen coins to put
 * the event in the channel, or ten to send it to the twenty people most likely to
 * come. Two options, two prices, one screen.
 *
 * The invitation half needs a step the channel half has no equivalent of: a
 * preview that says how many people would actually receive it before anybody is
 * charged.
 *
 * ── Nothing here can charge by accident ──────────────────────────────────────
 *
 * The preview is a `GET` and the server method behind it has no write path at
 * all. The purchase is a second, separate request, and its idempotency key is
 * minted **when this dialog opens** — not per click — so a double tap is one
 * purchase.
 *
 * ── What the invitation is honest about ──────────────────────────────────────
 *
 * The cost is the same whether twenty people qualify or three, and the screen
 * says so before the button. Zero qualifying people costs nothing and the button
 * is not offered at all. Both of those are stated rather than discovered.
 */
const props = defineProps<{ event: EventView }>();
const emit = defineEmits<{ done: []; dismiss: [] }>();

const events = useEventsStore();
const session = useSessionStore();

type Mode = 'channel' | 'invite';

const mode = ref<Mode>('channel');
const error = ref<string | null>(null);
const inFlight = ref(false);
const outcome = ref<string | null>(null);

const preview = ref<InvitePreviewResponse | null>(null);
const previewing = ref(false);

/** One key for one intention, held for as long as this dialog is open. */
const inviteKey = ref(newIdempotencyKey());

const pricing = computed(() => session.catalog?.promotion ?? null);
const balance = computed(() => session.me?.coins.balance ?? null);

const cost = computed(() => {
  if (pricing.value === null) return 0;
  return mode.value === 'channel'
    ? pricing.value.eventChannelSendCoins
    : pricing.value.eventTopInviteCoins;
});

/** Already bought once — the server refuses a second, so do not offer it. */
const channelAvailable = computed(() => props.event.channelStatus === 'NONE');

const canBuy = computed(() => {
  if (balance.value === null || balance.value < cost.value) return false;
  if (mode.value === 'channel') return channelAvailable.value;
  return preview.value !== null && preview.value.selected > 0;
});

async function load(): Promise<void> {
  error.value = null;
  try {
    if (session.catalog === null) await session.loadCatalog();
    await session.refreshMe();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'اطلاعات خرید بارگذاری نشد.';
  }
}

/** Reads only. The server method behind this writes nothing and charges nothing. */
async function runPreview(): Promise<void> {
  if (previewing.value) return;
  previewing.value = true;
  error.value = null;
  try {
    preview.value = await events.invitePreview(props.event.publicId);
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'پیش‌نمایش انجام نشد.';
  } finally {
    previewing.value = false;
  }
}

async function selectInvite(): Promise<void> {
  mode.value = 'invite';
  if (preview.value === null) await runPreview();
}

async function confirm(): Promise<void> {
  if (!canBuy.value || inFlight.value) return;
  error.value = null;
  inFlight.value = true;

  try {
    if (mode.value === 'channel') {
      await events.publishToChannel(props.event.publicId);
      outcome.value =
        'ثبت شد. انتشار در کانال توسط سرویس پس‌زمینه انجام می‌شود و ممکن است چند دقیقه طول بکشد.';
    } else {
      const result = await events.inviteTop(props.event.publicId, inviteKey.value);
      outcome.value =
        result.invited === 0
          ? 'کسی واجد شرایط دریافت دعوت‌نامه نبود، بنابراین سکه‌ای کم نشد.'
          : `دعوت‌نامه برای ${toPersianDigits(result.invited)} نفر در صف ارسال قرار گرفت.`;
    }
    // The balance moved; the ledger is the source of truth and `/me` reads it.
    // Nothing is subtracted locally — an optimistic number that survived a failure
    // would be a figure the user acts on and the server does not honour.
    await session.refreshMe().catch(() => undefined);
    haptic('success');
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
    <template v-if="outcome">
      <p class="font-medium">{{ outcome }}</p>
      <button type="button" class="min-h-11 self-start text-tg-link" @click="emit('dismiss')">
        بستن
      </button>
    </template>

    <template v-else>
      <div>
        <h3 class="font-medium">انتشار رویداد</h3>
        <p class="text-sm text-tg-hint">
          دو راه، با دو هزینهٔ متفاوت. هیچ‌کدام تا وقتی تأیید نکنید انجام نمی‌شود.
        </p>
      </div>

      <p v-if="pricing === null" class="text-sm text-tg-hint">در حال دریافت قیمت‌ها…</p>

      <template v-else>
        <div class="flex flex-col gap-2">
          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl p-3 text-start"
            :class="mode === 'channel' ? 'bg-tg-button text-tg-button-text' : 'bg-tg-secondary-bg'"
            :aria-pressed="mode === 'channel'"
            :disabled="!channelAvailable"
            @click="mode = 'channel'"
          >
            <span class="flex items-baseline justify-between gap-2">
              <span class="font-medium">انتشار در کانال</span>
              <span class="text-sm">{{ formatCoins(pricing.eventChannelSendCoins) }}</span>
            </span>
            <span class="text-xs opacity-90">
              رویداد شما یک بار در کانال پایه‌تَم منتشر می‌شود. انتشار توسط سرویس پس‌زمینه انجام
              می‌شود و چند دقیقه طول می‌کشد.
            </span>
          </button>
          <p v-if="!channelAvailable" class="text-xs text-tg-hint">
            این رویداد پیش‌تر برای انتشار در کانال ثبت شده است.
          </p>

          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl p-3 text-start"
            :class="mode === 'invite' ? 'bg-tg-button text-tg-button-text' : 'bg-tg-secondary-bg'"
            :aria-pressed="mode === 'invite'"
            @click="selectInvite"
          >
            <span class="flex items-baseline justify-between gap-2">
              <span class="font-medium">
                دعوت از {{ toPersianDigits(pricing.topInviteMaxRecipients) }} نفر
              </span>
              <span class="text-sm">{{ formatCoins(pricing.eventTopInviteCoins) }}</span>
            </span>
            <span class="text-xs opacity-90">
              دعوت‌نامه فقط برای کسانی فرستاده می‌شود که <b>در همان شهر رویداد</b> هستند و بیشترین
              احتمال شرکت را دارند — بر پایهٔ علاقه‌مندی‌ها و سابقهٔ شرکت در فعالیت‌های مشابه. کسانی
              که دریافت دعوت‌نامه را خاموش کرده‌اند هرگز دعوت نمی‌شوند.
            </span>
          </button>
        </div>

        <!-- ── What the invitation would actually do ─────────────────── -->
        <section
          v-if="mode === 'invite'"
          class="rounded-xl bg-tg-secondary-bg p-3 text-sm"
          role="status"
        >
          <p v-if="previewing" class="text-tg-hint">در حال بررسی…</p>

          <template v-else-if="preview">
            <p v-if="preview.selected === 0" class="text-tg-destructive">
              در حال حاضر کسی واجد شرایط دریافت دعوت‌نامه نیست. اگر ادامه دهید، سکه‌ای کم نمی‌شود —
              اما چیزی هم فرستاده نمی‌شود.
            </p>
            <template v-else>
              <p>
                از {{ toPersianDigits(preview.candidates) }} نفر بررسی‌شده،
                <b>{{ toPersianDigits(preview.selected) }}</b> نفر انتخاب می‌شوند
                <span v-if="preview.selected < preview.maxRecipients" class="text-tg-hint">
                  (کمتر از سقف {{ toPersianDigits(preview.maxRecipients) }} نفر — هزینه همان است)
                </span>
              </p>
              <ul class="mt-1 space-y-0.5 text-xs text-tg-hint">
                <!--
                  Everybody selected is in the event's city from v0.3.1, so this
                  count equals `selected`. It stays because the breakdown is what
                  makes the other three lines legible as a *subset* of it.
                -->
                <li>{{ toPersianDigits(preview.reasons.sameCity) }} نفر در همین شهر</li>
                <li>{{ toPersianDigits(preview.reasons.interestMatch) }} نفر با علاقهٔ مرتبط</li>
                <li>
                  {{ toPersianDigits(preview.reasons.categoryHistory) }} نفر با سابقهٔ شرکت در
                  فعالیت مشابه
                </li>
                <li>
                  {{ toPersianDigits(preview.reasons.recentlyActive) }} نفر فعال در هفته‌های اخیر
                </li>
              </ul>
              <p class="mt-1 text-xs text-tg-hint">
                نام یا مشخصات این افراد به شما نمایش داده نمی‌شود.
              </p>
            </template>
          </template>

          <button v-else type="button" class="min-h-11 text-tg-link" @click="runPreview">
            بررسی گیرندگان
          </button>
        </section>

        <CostNotice :cost="cost" :balance="balance" label="هزینهٔ این کار" />

        <p v-if="error" class="text-sm text-tg-destructive" role="alert">{{ error }}</p>

        <div class="flex gap-2">
          <button
            type="button"
            class="min-h-11 flex-1 rounded-xl bg-tg-button px-4 text-tg-button-text disabled:opacity-50"
            :disabled="!canBuy || inFlight"
            @click="confirm"
          >
            {{ inFlight ? 'در حال ثبت…' : 'تأیید و پرداخت' }}
          </button>
          <button
            type="button"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-4"
            @click="emit('dismiss')"
          >
            انصراف
          </button>
        </div>
      </template>
    </template>
  </div>
</template>
