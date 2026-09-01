<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ParticipationView } from '@payetam/shared';
import { ApiError } from '@/api/client';
import ChannelGate from '@/components/ChannelGate.vue';
import EventDisclaimer from '@/components/EventDisclaimer.vue';
import MainButton from '@/components/MainButton.vue';
import ReportDialog from '@/components/ReportDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import TrustBadge from '@/components/TrustBadge.vue';
import { formatEventWhen, formatRelative } from '@/format/datetime';
import { formatToman, toPersianDigits } from '@/format/fa';
import { haptic, openBotChat } from '@/telegram/webapp';
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

/**
 * A first message to the host, sent with the request (report 6).
 *
 * ── Why it is on this screen and not a step after it ─────────────────────────
 *
 * The old flow was: tap join, read "your conversation is open in Telegram",
 * close the app, find the bot, work out which of several conversations is this
 * one, type. Four actions and a context switch between deciding to come and
 * being able to say anything — and the host meanwhile holds a request from a
 * stranger with no words attached, which is the decision they are worst equipped
 * to make.
 *
 * Optional, always: an empty box sends nothing and the request is exactly what
 * it was before. The placeholder suggests what is useful rather than demanding
 * it.
 */
const note = ref('');
/** Whether the greeting actually got through. It is best-effort; see the store. */
const noteSent = ref(false);

/** The bot's @username, so «گفت‌وگو در تلگرام» lands somewhere. */
const botUsername = computed(() => session.catalog?.botUsername ?? '');

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
    // For `botUsername`, which the "open the conversation" button is built from.
    // Cached in the session store, so this costs a request only on a cold start.
    if (session.catalog === null) await session.loadCatalog().catch(() => undefined);
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'این رویداد بارگذاری نشد.';
  }
}

async function act(): Promise<void> {
  if (mine.value !== null) {
    openConversation();
    return;
  }
  await join();
}

/**
 * Into the conversation, in one tap (report 6).
 *
 * `openTelegramLink` where the client has it, `close()` otherwise. The old code
 * only closed, which returns the user to *whatever chat they opened the app
 * from* — the bot for somebody who launched it there, and the channel for
 * somebody who tapped a post's button. The second case is precisely the person
 * who was then told to go and find the bot themselves.
 */
function openConversation(): void {
  openBotChat(botUsername.value);
}

async function join(): Promise<void> {
  joinError.value = null;
  try {
    const result = await participation.join(publicId.value, note.value);
    justJoined.value = result.participation;
    noteSent.value = result.noteSent;
    note.value = '';
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

    <!-- Before the join button rather than after it: the server refuses either
         way, and finding out first is the difference (M22 phase 6). -->
    <ChannelGate action="EVENT_JOIN" />

    <StateBlock :state="state" :error-text="loadError" :rows="4" @retry="load">
      <template v-if="event">
        <!--
          Above the event, which is where report 8 asks for it and where it is
          actually read: this is the screen somebody decides on, so the full
          sentence rather than the one-line form.
        -->
        <EventDisclaimer />

        <h1 class="text-xl font-bold leading-snug">{{ event.title }}</h1>

        <section class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4 text-sm">
          <p>{{ formatEventWhen(event.startsAt, event.endsAt) }}</p>
          <p class="text-tg-hint">{{ formatRelative(event.startsAt) }}</p>
          <p>
            <!--
              The curated district, or the neighbourhood the host typed when the
              catalogue has no row for one (v0.6.5). Never both — the server picks
              between them and a CHECK backs it — so one `v-if` chain reads the
              pair correctly.
            -->
            {{ event.city.nameFa }}<span v-if="event.district">، {{ event.district.nameFa }}</span
            ><span v-else-if="event.districtLabel">، {{ event.districtLabel }}</span> ·
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

          <p v-if="noteSent" class="text-tg-accent">پیام شما برای میزبان فرستاده شد.</p>

          <p class="text-tg-hint">
            گفت‌وگوی ناشناس شما با میزبان در تلگرام باز است — بدون آنکه هویت هیچ‌کدام مشخص باشد.
          </p>

          <!--
            The one action that follows, as a button rather than an instruction
            (report 6). "Go back to the conversation with the bot" is a sentence
            asking the user to do navigation the app can do for them — and for
            somebody who opened the Mini App from a channel post, it was asking
            them to go somewhere they had never been.
          -->
          <button
            type="button"
            class="min-h-11 rounded-xl bg-tg-button px-4 text-sm text-tg-button-text"
            @click="openConversation"
          >
            رفتن به گفت‌وگو در تلگرام
          </button>
        </section>

        <!--
          One optional line to the host, sent with the request (report 6).

          Hidden once the request is in: this is part of *asking*, and leaving an
          empty box on the screen afterwards would suggest a second message can be
          sent from here — it cannot, the conversation is in the bot.
        -->
        <label v-if="!isHost && !mine" class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">پیامی برای میزبان (اختیاری)</span>
          <textarea
            v-model="note"
            rows="2"
            maxlength="500"
            placeholder="مثلاً: سلام، دو نفریم و از قبل هم بازی رومیزی کار کرده‌ایم."
            class="rounded-xl bg-tg-secondary-bg p-3 text-tg-text"
          ></textarea>
          <span class="text-xs text-tg-hint">
            همراه با درخواست شما فرستاده می‌شود. شمارهٔ تماس و نام کاربری شما در پیام‌ها پنهان
            می‌ماند.
          </span>
        </label>

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
