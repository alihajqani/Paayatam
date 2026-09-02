<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  PARTICIPANT_STATUS_GUEST_FA,
  type CancellationPreviewResponse,
  type ParticipantStatus,
} from '@payetam/shared';
import { ApiError } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatEventDate, formatRelative } from '@/format/datetime';
import { formatCoins, toPersianDigits } from '@/format/fa';
import { haptic, webApp } from '@/telegram/webapp';
import { useParticipationStore } from '@/stores/participation';

/**
 * "What did I ask to join, and what happened?"
 *
 * Leaving costs something once a seat is held, and how much depends on how close the
 * event is (M10/ADR-0011). The dry-run endpoint is asked first and its answer is what
 * the confirmation shows — the same pattern the host's cancellation uses.
 */
const router = useRouter();
const participation = useParticipationStore();

const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const leaving = ref<string | null>(null);
const preview = ref<CancellationPreviewResponse | null>(null);
const reason = ref('');

const state = computed(() => {
  if (loadError.value !== null) return 'error' as const;
  if (participation.loading && participation.mine.length === 0) return 'loading' as const;
  if (participation.mine.length === 0) return 'empty' as const;
  return 'ready' as const;
});

const LIVE = new Set<ParticipantStatus>(['PENDING', 'WAITLISTED', 'ACCEPTED']);

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await participation.loadMine();
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'درخواست‌های شما بارگذاری نشد.';
  }
}

async function startLeave(publicId: string): Promise<void> {
  actionError.value = null;
  reason.value = '';
  preview.value = null;
  leaving.value = publicId;
  try {
    preview.value = await participation.cancelPreview(publicId);
  } catch (cause) {
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'برآورد هزینهٔ لغو نیامد.';
    leaving.value = null;
  }
}

async function confirmLeave(): Promise<void> {
  const publicId = leaving.value;
  if (publicId === null) return;
  try {
    await participation.cancel(publicId, reason.value.trim() || undefined);
    haptic('success');
    leaving.value = null;
    preview.value = null;
  } catch (cause) {
    haptic('error');
    actionError.value = cause instanceof ApiError ? cause.messageFa : 'لغو درخواست انجام نشد.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">درخواست‌های من</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.push('/home')">
        خانه
      </button>
    </header>

    <StateBlock
      :state="state"
      :error-text="loadError"
      empty-text="هنوز به هیچ فعالیتی «پایتم» نگفته‌اید."
      @retry="load"
    >
      <template #empty-action>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-tg-button px-4 text-tg-button-text"
          @click="router.push('/discover')"
        >
          دیدن رویدادها
        </button>
      </template>

      <p v-if="actionError" class="text-tg-destructive">{{ actionError }}</p>

      <ul class="flex flex-col gap-3">
        <li
          v-for="item in participation.mine"
          :key="item.publicId"
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
        >
          <!--
            Which event this is for. Without it a list of pending requests is a
            column of identical «در انتظار» cards, and the only way to tell them
            apart is to open each one.
          -->
          <p v-if="item.event" class="font-medium">{{ item.event.title }}</p>

          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm">{{
              PARTICIPANT_STATUS_GUEST_FA[item.status] ?? item.status
            }}</span>
            <span v-if="item.waitlistRank" class="text-xs text-tg-hint">
              نفر {{ toPersianDigits(item.waitlistRank) }}
            </span>
          </div>

          <p v-if="item.event" class="text-xs text-tg-hint">
            {{ formatEventDate(item.event.startsAt) }}
          </p>

          <p v-if="item.hostDeadlineAt && item.status === 'PENDING'" class="text-sm text-tg-hint">
            مهلت پاسخ میزبان: {{ formatRelative(item.hostDeadlineAt) }}
          </p>
          <p v-if="item.graceExpiresAt && item.status === 'ACCEPTED'" class="text-sm text-tg-hint">
            لغو بدون هزینه تا {{ formatRelative(item.graceExpiresAt) }}
          </p>

          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm"
              @click="router.push(`/events/${item.eventPublicId}`)"
            >
              رویداد
            </button>
            <button
              v-if="item.chatPublicId"
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm text-tg-link"
              @click="webApp?.close()"
            >
              گفت‌وگو در تلگرام
            </button>
            <button
              v-if="LIVE.has(item.status)"
              type="button"
              class="min-h-11 rounded-xl bg-tg-bg px-3 text-sm text-tg-destructive"
              @click="startLeave(item.publicId)"
            >
              لغو درخواست
            </button>
          </div>

          <div
            v-if="leaving === item.publicId && preview"
            class="flex flex-col gap-2 rounded-xl bg-tg-bg p-3"
          >
            <p class="text-sm">
              <template v-if="preview.coins === 0 && preview.trust === 0">
                لغو این درخواست هزینه‌ای ندارد.
              </template>
              <template v-else>
                لغو در این زمان {{ formatCoins(preview.coins) }} و
                {{ toPersianDigits(preview.trust) }} امتیاز اعتماد هزینه دارد.
              </template>
            </p>
            <input
              v-model="reason"
              type="text"
              maxlength="280"
              placeholder="دلیل (اختیاری)"
              class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
            />
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-11 flex-1 rounded-xl bg-tg-destructive text-sm text-tg-button-text"
                @click="confirmLeave"
              >
                تأیید لغو
              </button>
              <button
                type="button"
                class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
                @click="leaving = null"
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
