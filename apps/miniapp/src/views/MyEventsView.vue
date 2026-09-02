<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  EVENT_STATUS_FA,
  PARTICIPANT_STATUS_HOST_FA,
  type HostCancellationPreviewResponse,
} from '@payetam/shared';
import { ApiError } from '@/api/client';
import ReachDialog from '@/components/ReachDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import TrustBadge from '@/components/TrustBadge.vue';
import { formatEventWhen, formatRelative } from '@/format/datetime';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';
import { useParticipationStore } from '@/stores/participation';

/**
 * The host's side: what I am hosting, who asked, and my answer.
 *
 * Accept and reject reach the same service the bot's inline buttons reach — one code
 * path, so a host who decides here and a host who decides from the notification
 * cannot produce different outcomes. The bot remains the faster surface for a single
 * decision; this is the one that shows the whole queue at once.
 *
 * Cancelling asks the dry-run endpoint first and shows what it will cost before it
 * costs it (M10). A host who is told the price after paying it has been tricked by
 * their own software.
 */
const route = useRoute();
const router = useRouter();
const events = useEventsStore();
const participation = useParticipationStore();

const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const expanded = ref<string | null>(null);
const deciding = ref<string | null>(null);

/**
 * Which event has the publish dialog open.
 *
 * One dialog, and one thing to buy. The VIP-and-boost screen went in v0.6.0
 * because this deployment has one channel, so «کانال ویژه», «برجسته‌سازی» and
 * «ویژه (دائمی)» described placements that do not exist; v0.7.0 removed the
 * endpoints behind it as well, so promotion is gone rather than merely hidden.
 */
const reaching = ref<string | null>(null);
const cancelling = ref<string | null>(null);
const cancelPreview = ref<HostCancellationPreviewResponse | null>(null);
const cancelReason = ref('');

/** Set by the authoring screen, so a freshly created event is obvious in the list. */
const createdPublicId = computed(() => String(route.query['created'] ?? ''));

/**
 * Whether the post-creation offer has been waved away.
 *
 * The offer appears once, for the event just created, and skipping it is a plain
 * button rather than a buried gesture — promotion is optional and nothing about the
 * event depends on buying it.
 */
const offerDismissed = ref(false);
const showCreationOffer = computed(
  () => createdPublicId.value !== '' && !offerDismissed.value && reaching.value === null,
);

const state = computed(() => {
  if (loadError.value !== null) return 'error' as const;
  if (events.loadingMine && events.myEvents.length === 0) return 'loading' as const;
  if (events.myEvents.length === 0) return 'empty' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await events.loadMyEvents();
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'رویدادهای شما بارگذاری نشد.';
  }
}

async function toggle(publicId: string): Promise<void> {
  actionError.value = null;
  if (expanded.value === publicId) {
    expanded.value = null;
    return;
  }
  expanded.value = publicId;
  try {
    await events.loadParticipants(publicId);
  } catch (cause) {
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'فهرست درخواست‌ها نیامد.';
  }
}

async function decide(
  participantPublicId: string,
  eventPublicId: string,
  accept: boolean,
): Promise<void> {
  actionError.value = null;
  deciding.value = participantPublicId;
  try {
    if (accept) await participation.accept(participantPublicId);
    else await participation.reject(participantPublicId);
    haptic('success');
    // Both the queue and the seat count moved.
    await Promise.all([events.loadParticipants(eventPublicId), events.loadMyEvents()]);
  } catch (cause) {
    haptic('error');
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'ثبت پاسخ انجام نشد.';
  } finally {
    deciding.value = null;
  }
}

/**
 * Reloads after a purchase so the new state is what the server says it is.
 *
 * `channelStatus` in particular is derived server-side from the `channel_post` rows,
 * so the only way to learn that the sweep has published is to ask again.
 */
async function onPublished(): Promise<void> {
  await events.loadMyEvents().catch(() => undefined);
}

async function startCancel(publicId: string): Promise<void> {
  actionError.value = null;
  cancelReason.value = '';
  cancelPreview.value = null;
  cancelling.value = publicId;
  try {
    cancelPreview.value = await events.cancelPreview(publicId);
  } catch (cause) {
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'برآورد هزینهٔ لغو نیامد.';
    cancelling.value = null;
  }
}

async function confirmCancel(): Promise<void> {
  const publicId = cancelling.value;
  if (publicId === null) return;
  try {
    await events.cancel(publicId, cancelReason.value.trim());
    haptic('success');
    cancelling.value = null;
    cancelPreview.value = null;
  } catch (cause) {
    haptic('error');
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'لغو رویداد انجام نشد.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">رویدادهای من</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.push('/home')">
        خانه
      </button>
    </header>

    <StateBlock
      :state="state"
      :error-text="loadError"
      empty-text="هنوز رویدادی نساخته‌اید."
      @retry="load"
    >
      <template #empty-action>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-tg-button px-4 text-tg-button-text"
          @click="router.push('/events/new')"
        >
          ساخت رویداد
        </button>
      </template>

      <p v-if="actionError" class="text-tg-destructive">{{ actionError }}</p>

      <!--
        The offer, immediately after creation (§3.7).
        Optional by construction: «فعلاً نه» dismisses it and the event is already
        published and joinable either way. Nothing here gates the event on spending.
      -->
      <section
        v-if="showCreationOffer"
        class="flex flex-col gap-2 rounded-2xl bg-tg-section-bg p-4"
      >
        <h2 class="font-medium">رویداد شما ساخته شد 🎉</h2>
        <p class="text-sm text-tg-hint">
          می‌خواهید آن را در کانال پایه‌تَم منتشر کنید یا برای کسانی که بیشترین احتمال شرکت را دارند
          بفرستید؟ این کار اختیاری است.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="min-h-11 flex-1 rounded-xl bg-tg-button text-sm text-tg-button-text"
            @click="reaching = createdPublicId"
          >
            دیدن گزینه‌ها
          </button>
          <button
            type="button"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
            @click="offerDismissed = true"
          >
            فعلاً نه
          </button>
        </div>
      </section>

      <ul class="flex flex-col gap-3">
        <li
          v-for="event in events.myEvents"
          :key="event.publicId"
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
          :class="event.publicId === createdPublicId ? 'ring-2 ring-tg-button' : ''"
        >
          <div class="flex items-start justify-between gap-2">
            <h2 class="flex-1 font-medium leading-snug">{{ event.title }}</h2>
            <span class="rounded-full bg-tg-bg px-2 py-0.5 text-xs">
              {{ EVENT_STATUS_FA[event.status] ?? event.status }}
            </span>
          </div>

          <p class="text-sm text-tg-subtitle">
            {{ formatEventWhen(event.startsAt, event.endsAt) }}
          </p>
          <p class="text-sm text-tg-hint">
            {{ toPersianDigits(event.acceptedCount) }} از {{ toPersianDigits(event.capacity) }} جا
            پر شده ·
            {{ formatRelative(event.startsAt) }}
          </p>

          <p v-if="event.moderationStatus === 'PENDING'" class="text-sm text-tg-hint">
            در انتظار بررسی خودکار؛ پس از تأیید در فهرست دیده می‌شود.
          </p>
          <p v-else-if="event.moderationStatus === 'REJECTED'" class="text-sm text-tg-destructive">
            این رویداد رد شد و منتشر نمی‌شود.
          </p>

          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              :aria-expanded="expanded === event.publicId"
              @click="toggle(event.publicId)"
            >
              درخواست‌ها
            </button>
            <button
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              @click="router.push(`/events/${event.publicId}/edit`)"
            >
              ویرایش
            </button>
            <button
              v-if="event.status === 'PUBLISHED'"
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              @click="reaching = reaching === event.publicId ? null : event.publicId"
            >
              انتشار رویداد
            </button>
            <button
              v-if="event.status === 'PUBLISHED' || event.status === 'PENDING_MODERATION'"
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm text-tg-destructive"
              @click="startCancel(event.publicId)"
            >
              لغو رویداد
            </button>
          </div>

          <!-- The queue for this event. -->
          <div
            v-if="expanded === event.publicId"
            class="flex flex-col gap-2 border-t border-tg-bg pt-2"
          >
            <p v-if="events.loadingParticipants" class="text-sm text-tg-hint">در حال بارگذاری…</p>
            <p v-else-if="events.participants.length === 0" class="text-sm text-tg-hint">
              هنوز کسی درخواست نداده است.
            </p>
            <div
              v-for="person in events.participants"
              :key="person.publicId"
              class="flex flex-col gap-2 rounded-xl bg-tg-bg p-3"
            >
              <div class="flex items-baseline justify-between gap-2">
                <span class="font-medium">{{ person.displayName }}</span>
                <span class="text-xs text-tg-hint">
                  {{ PARTICIPANT_STATUS_HOST_FA[person.status] ?? person.status }}
                  <template v-if="person.waitlistRank">
                    ({{ toPersianDigits(person.waitlistRank) }})
                  </template>
                </span>
              </div>
              <!--
                This requester's reputation, keyed to this requester (M18).

                Inside the `v-for` and bound to `person`, so a queue of six shows
                six scores each attached to the name above it. `person.publicId` is
                already the loop key, which is what keeps the pairing stable when
                the list reorders after a decision.
              -->
              <TrustBadge :score="person.trustScore" class="self-start" />
              <p v-if="person.hostDeadlineAt" class="text-xs text-tg-hint">
                مهلت پاسخ: {{ formatRelative(person.hostDeadlineAt) }}
              </p>
              <div v-if="person.status === 'PENDING'" class="flex gap-2">
                <button
                  type="button"
                  class="min-h-11 flex-1 rounded-xl bg-tg-button text-sm text-tg-button-text disabled:opacity-50"
                  :disabled="deciding === person.publicId"
                  @click="decide(person.publicId, event.publicId, true)"
                >
                  پذیرفتن
                </button>
                <button
                  type="button"
                  class="min-h-11 flex-1 rounded-xl bg-tg-secondary-bg text-sm disabled:opacity-50"
                  :disabled="deciding === person.publicId"
                  @click="decide(person.publicId, event.publicId, false)"
                >
                  رد کردن
                </button>
              </div>
            </div>
          </div>

          <!--
            Where the publication has got to. Two states rather than a claim of
            success: the channel post is produced by a sweep, so saying "published"
            at purchase time would be a promise the product cannot keep.

            Promotion is gone entirely (v0.7.0), so there is no VIP or boost
            line to draw and nothing ranks on either column any more.
          -->
          <div v-if="event.channelStatus !== 'NONE'" class="flex flex-col gap-1 text-sm">
            <p v-if="event.channelStatus === 'QUEUED'" class="text-tg-hint">
              در نوبت انتشار در کانال — معمولاً چند دقیقه طول می‌کشد.
            </p>
            <p v-else-if="event.channelStatus === 'PUBLISHED'" class="text-tg-accent">
              در کانال پایه‌تَم منتشر شد.
            </p>
          </div>

          <!-- Publishing: to the channel, or to the twenty most likely to come.
               Both priced and previewed before anything moves (report 5). -->
          <ReachDialog
            v-if="reaching === event.publicId"
            :event="event"
            @done="onPublished"
            @dismiss="reaching = null"
          />

          <!-- Cancellation, priced before it is committed. -->
          <div
            v-if="cancelling === event.publicId && cancelPreview"
            class="flex flex-col gap-2 rounded-xl bg-tg-bg p-3"
          >
            <p class="text-sm">
              <template v-if="cancelPreview.affected === 0">
                هیچ‌کس جای تأییدشده ندارد، پس لغو این رویداد هزینه‌ای ندارد.
              </template>
              <template v-else>
                {{ toPersianDigits(cancelPreview.affected) }} نفر جای تأییدشده دارند. لغو،
                {{ formatCoins(cancelPreview.coins) }} و
                {{ toPersianDigits(cancelPreview.trust) }} امتیاز اعتماد هزینه دارد.
              </template>
            </p>
            <input
              v-model="cancelReason"
              type="text"
              maxlength="280"
              placeholder="دلیل (اختیاری)"
              class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
            />
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-11 flex-1 rounded-xl bg-tg-destructive text-sm text-tg-button-text"
                @click="confirmCancel"
              >
                تأیید لغو
              </button>
              <button
                type="button"
                class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
                @click="cancelling = null"
              >
                بازگشت
              </button>
            </div>
          </div>
        </li>
      </ul>
    </StateBlock>
  </main>
</template>
