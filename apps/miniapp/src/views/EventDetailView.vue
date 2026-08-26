<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ParticipationView } from '@payetam/shared';
import { ApiError } from '@/api/client';
import MainButton from '@/components/MainButton.vue';
import ReportDialog from '@/components/ReportDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import TrustBadge from '@/components/TrustBadge.vue';
import { formatEventWhen, formatRelative } from '@/format/datetime';
import { formatToman, toPersianDigits } from '@/format/fa';
import { haptic, webApp } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';
import { useParticipationStore } from '@/stores/participation';
import { useSessionStore } from '@/stores/session';

/**
 * One event, and the decision to ask to join it.
 *
 * The join answers 201 with either a held seat (`PENDING`) or a place in the queue
 * (`WAITLISTED` with a rank), and this screen renders whichever came back rather
 * than predicting it from `remainingCapacity` — the prediction is wrong exactly when
 * it matters, which is two people tapping join on the last seat (ADR-0006).
 *
 * **A chat exists from the request, not from the acceptance** (plan §3.4). So the
 * moment a request is in, there is somewhere to talk, and that somewhere is the bot.
 */
const route = useRoute();
const router = useRouter();
const events = useEventsStore();
const participation = useParticipationStore();
const session = useSessionStore();

const publicId = computed(() => String(route.params['publicId'] ?? ''));

const loadError = ref<string | null>(null);
const joinError = ref<string | null>(null);
const justJoined = ref<ParticipationView | null>(null);
const reporting = ref(false);

const event = computed(() => events.detail);
const mine = computed(() => justJoined.value ?? participation.liveFor(publicId.value));
const isHost = computed(
  () => event.value !== null && event.value.host.publicId === session.me?.publicId,
);

const state = computed(() => {
  if (loadError.value !== null) return 'error' as const;
  if (events.loadingDetail && event.value === null) return 'loading' as const;
  return 'ready' as const;
});

const cost = computed(() => {
  if (event.value === null) return '';
  const { costType, costAmount, costNote } = event.value;
  if (costType === 'FREE') return 'رایگان';
  if (costType === 'SPLIT') return costNote ?? 'دنگی';
  if (costAmount === null) return costNote ?? '—';
  const amount = formatToman(costAmount);
  return costType === 'APPROX' ? `حدود ${amount}` : amount;
});

const ageRange = computed(() => {
  if (event.value === null) return null;
  const { minAge, maxAge } = event.value;
  if (minAge === null && maxAge === null) return null;
  if (minAge !== null && maxAge !== null)
    return `${toPersianDigits(minAge)} تا ${toPersianDigits(maxAge)} سال`;
  if (minAge !== null) return `از ${toPersianDigits(minAge)} سال`;
  return `تا ${toPersianDigits(maxAge!)} سال`;
});

/** What the primary button says depends entirely on what the server already told us. */
const buttonText = computed(() => {
  if (mine.value !== null) return 'گفت‌وگو در تلگرام';
  if (event.value === null) return 'درخواست پیوستن';
  return event.value.remainingCapacity <= 0 ? 'ثبت در نوبت انتظار' : 'درخواست پیوستن';
});

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await events.loadEvent(publicId.value);
    // Needed to answer "have I already asked?" — and cheap, since the list is the
    // user's own participations rather than a per-event lookup.
    if (participation.mine.length === 0) await participation.loadMine();
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'این رویداد بارگذاری نشد.';
  }
}

async function act(): Promise<void> {
  if (mine.value !== null) {
    // The conversation lives in the bot. Closing returns the user to it.
    webApp?.close();
    return;
  }
  await join();
}

async function join(): Promise<void> {
  joinError.value = null;
  try {
    const result = await participation.join(publicId.value);
    justJoined.value = result;
    haptic('success');
    // The seat count moved for everyone, so the copy on screen is now stale.
    await events.loadEvent(publicId.value).catch(() => undefined);
  } catch (cause) {
    haptic('error');
    joinError.value =
      cause instanceof ApiError ? cause.messageFa : 'درخواست پیوستن ثبت نشد. دوباره تلاش کنید.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <button type="button" class="min-h-11 self-start text-sm text-tg-link" @click="router.back()">
      بازگشت
    </button>

    <StateBlock :state="state" :error-text="loadError" :rows="4" @retry="load">
      <template v-if="event">
        <h1 class="text-xl font-bold leading-snug">{{ event.title }}</h1>

        <section class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4 text-sm">
          <p>{{ formatEventWhen(event.startsAt, event.endsAt) }}</p>
          <p class="text-tg-hint">{{ formatRelative(event.startsAt) }}</p>
          <p>
            {{ event.city.nameFa
            }}<span v-if="event.district">، {{ event.district.nameFa }}</span> ·
            <!--
              For a «سایر»-style tag the host's own words are the useful half;
              «سایر» on its own tells a reader nothing (M21).
            -->
            {{ event.customCategoryLabel ?? event.category.nameFa }}
          </p>
          <p>{{ cost }}</p>
          <p>
            <span v-if="event.remainingCapacity > 0">
              {{ toPersianDigits(event.remainingCapacity) }} جای خالی از
              {{ toPersianDigits(event.capacity) }}
            </span>
            <span v-else class="text-tg-destructive">
              ظرفیت تکمیل است — درخواست شما در نوبت انتظار ثبت می‌شود.
            </span>
          </p>
          <p v-if="ageRange" class="text-tg-hint">محدودهٔ سنی: {{ ageRange }}</p>
          <p v-if="event.genderPreference === 'FEMALE_ONLY'" class="text-tg-hint">فقط خانم‌ها</p>
          <p v-else-if="event.genderPreference === 'MALE_ONLY'" class="text-tg-hint">فقط آقایان</p>
        </section>

        <section class="flex flex-col gap-1">
          <h2 class="text-sm text-tg-subtitle">توضیحات</h2>
          <p class="whitespace-pre-line leading-relaxed">{{ event.description }}</p>
        </section>

        <!--
          The host, and their reputation (M18).

          `flex-wrap` rather than a fixed row: the badge and a long display name
          together overflow a narrow phone, and RTL text does not truncate
          gracefully. On a wide viewport the two sit on one line; on a narrow one
          the badge drops beneath the name instead of pushing it off-screen.
        -->
        <section class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-tg-hint">میزبان: {{ event.host.displayName }}</span>
          <TrustBadge :score="event.host.trustScore" label="امتیاز اعتماد میزبان" />
        </section>

        <a
          v-if="event.externalLink"
          :href="event.externalLink"
          target="_blank"
          rel="noopener noreferrer"
          class="min-h-11 text-tg-link"
          >پیوند بیرونی رویداد</a
        >

        <!-- What happened after asking, in the server's words. -->
        <section
          v-if="mine"
          class="flex flex-col gap-2 rounded-2xl bg-tg-section-bg p-4 text-sm"
          aria-live="polite"
        >
          <p v-if="mine.status === 'PENDING'" class="font-medium">
            درخواست شما ثبت شد و در انتظار پاسخ میزبان است.
          </p>
          <p v-else-if="mine.status === 'WAITLISTED'" class="font-medium">
            ظرفیت تکمیل بود؛ شما
            <span v-if="mine.waitlistRank">نفر {{ toPersianDigits(mine.waitlistRank) }}</span>
            در نوبت انتظار هستید.
          </p>
          <p v-else-if="mine.status === 'ACCEPTED'" class="font-medium">
            میزبان درخواست شما را پذیرفت.
          </p>

          <p v-if="mine.hostDeadlineAt" class="text-tg-hint">
            مهلت پاسخ میزبان: {{ formatRelative(mine.hostDeadlineAt) }}
          </p>

          <p class="text-tg-hint">
            گفت‌وگوی ناشناس شما با میزبان در تلگرام باز است — بدون آنکه هویت هیچ‌کدام مشخص باشد.
            برای ادامه، به گفت‌وگو با ربات بازگردید.
          </p>
        </section>

        <p v-if="joinError" class="text-tg-destructive">{{ joinError }}</p>

        <button
          v-if="!isHost && !reporting"
          type="button"
          class="min-h-11 self-start text-sm text-tg-destructive"
          @click="reporting = true"
        >
          گزارش این رویداد
        </button>
        <ReportDialog
          v-if="reporting"
          target="EVENT"
          :public-id="publicId"
          @close="reporting = false"
        />

        <p v-if="isHost" class="rounded-xl bg-tg-secondary-bg p-3 text-sm text-tg-hint">
          این رویداد از سوی شما میزبانی می‌شود.
        </p>

        <div class="flex-1"></div>

        <MainButton
          v-if="!isHost"
          :text="buttonText"
          :loading="participation.joining"
          @click="act"
        />
        <button
          v-else
          type="button"
          class="min-h-11 rounded-xl bg-tg-secondary-bg"
          @click="router.push('/my-events')"
        >
          مدیریت رویدادهای من
        </button>
      </template>
    </StateBlock>
  </main>
</template>
