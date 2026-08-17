<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { OwnReviewView, PendingReviewView, ReviewTag } from '@payetam/shared';
import { ApiError } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatRelative } from '@/format/datetime';
import { toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useReviewsStore } from '@/stores/reviews';

/**
 * Blind reviews (M11, ADR-0011 D7/D7a).
 *
 * **Nothing of the other side's review appears here, and cannot.** There is no
 * contract for reading it before reveal anywhere in `@payetam/shared` — that absence
 * is the feature, and it is why this screen shows only what the user themselves
 * wrote. Both are revealed simultaneously at T+24h, by the server.
 *
 * The edit window is asked for, not calculated: `editableUntil` goes null once the
 * hour passes *or* the pair has revealed, and only the server knows which. Doing the
 * arithmetic here would produce a form that submits into a refusal.
 */
const router = useRouter();
const reviews = useReviewsStore();

const loadError = ref<string | null>(null);
const formError = ref<string | null>(null);
const active = ref<PendingReviewView | null>(null);
const editing = ref<OwnReviewView | null>(null);

const rating = ref(5);
const tags = ref<ReviewTag[]>([]);
const comment = ref('');

const state = computed(() => {
  if (loadError.value !== null) return 'error' as const;
  if (reviews.loading && reviews.pending.length === 0) return 'loading' as const;
  if (reviews.pending.length === 0) return 'empty' as const;
  return 'ready' as const;
});

const TAG_FA: Record<ReviewTag, string> = {
  PUNCTUAL: 'وقت‌شناس',
  FRIENDLY: 'خوش‌برخورد',
  GOOD_CONVERSATION: 'هم‌صحبت خوب',
  WELL_ORGANISED: 'برنامه‌ریزی منظم',
  AS_DESCRIBED: 'مطابق توضیحات',
  WOULD_MEET_AGAIN: 'دوباره شرکت می‌کنم',
  LATE: 'با تأخیر',
  UNCOMMUNICATIVE: 'کم‌ارتباط',
};

const ALL_TAGS = Object.keys(TAG_FA) as ReviewTag[];

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await reviews.loadPending();
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'فهرست نظرها بارگذاری نشد.';
  }
}

async function open(review: PendingReviewView): Promise<void> {
  formError.value = null;
  active.value = review;
  rating.value = 5;
  tags.value = [];
  comment.value = '';

  // They may have written one already and come back inside the hour.
  try {
    const existing = await reviews.loadOwn(review.participantPublicId);
    editing.value = existing;
    if (existing) {
      rating.value = existing.rating;
      tags.value = [...existing.tags];
      comment.value = existing.comment ?? '';
    }
  } catch {
    editing.value = null;
  }
}

function toggleTag(tag: ReviewTag): void {
  const index = tags.value.indexOf(tag);
  if (index === -1) {
    if (tags.value.length >= 5) return;
    tags.value.push(tag);
  } else {
    tags.value.splice(index, 1);
  }
  haptic('selection');
}

async function submit(): Promise<void> {
  const target = active.value;
  if (target === null) return;
  formError.value = null;

  const body = {
    rating: rating.value,
    tags: tags.value,
    ...(comment.value.trim() ? { comment: comment.value.trim() } : {}),
  };

  try {
    if (editing.value && editing.value.editableUntil !== null) {
      await reviews.edit(target.participantPublicId, body);
    } else {
      await reviews.submit(target.participantPublicId, body);
    }
    haptic('success');
    active.value = null;
    editing.value = null;
    await load();
  } catch (cause) {
    haptic('error');
    formError.value = cause instanceof ApiError ? cause.messageFa : 'ثبت نظر انجام نشد.';
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">نظرها</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.push('/home')">
        خانه
      </button>
    </header>

    <p class="text-sm text-tg-hint">
      نظر شما و نظر طرف مقابل هم‌زمان و ۲۴ ساعت پس از پایان رویداد نمایش داده می‌شوند. تا آن لحظه
      هیچ‌کدام نظر دیگری را نمی‌بیند.
    </p>

    <!-- The form, when one is open. -->
    <section v-if="active" class="flex flex-col gap-4 rounded-2xl bg-tg-secondary-bg p-4">
      <div>
        <h2 class="font-medium">{{ active.eventTitle }}</h2>
        <p class="text-sm text-tg-hint">
          نظر شما دربارهٔ {{ active.revieweeDisplayName }} ·
          {{ active.role === 'HOST' ? 'شما میزبان بودید' : 'شما میهمان بودید' }}
        </p>
        <p class="text-xs text-tg-hint">مهلت: {{ formatRelative(active.deadlineAt) }}</p>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm text-tg-subtitle">امتیاز</legend>
        <div class="flex gap-2">
          <button
            v-for="value in 5"
            :key="value"
            type="button"
            class="min-h-11 flex-1 rounded-xl text-sm"
            :class="rating >= value ? 'bg-tg-button text-tg-button-text' : 'bg-tg-bg'"
            :aria-pressed="rating === value"
            @click="rating = value"
          >
            {{ toPersianDigits(value) }}
          </button>
        </div>
      </fieldset>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm text-tg-subtitle">
          برچسب‌ها ({{ toPersianDigits(tags.length) }} از ۵)
        </legend>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="tag in ALL_TAGS"
            :key="tag"
            type="button"
            class="min-h-11 rounded-full px-4 text-sm"
            :class="tags.includes(tag) ? 'bg-tg-button text-tg-button-text' : 'bg-tg-bg'"
            :aria-pressed="tags.includes(tag)"
            @click="toggleTag(tag)"
          >
            {{ TAG_FA[tag] }}
          </button>
        </div>
      </fieldset>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">توضیح (اختیاری)</span>
        <textarea
          v-model="comment"
          rows="3"
          maxlength="500"
          class="rounded-xl bg-tg-bg p-3 text-tg-text"
        ></textarea>
      </label>

      <p v-if="editing && editing.editableUntil" class="text-xs text-tg-hint">
        تا {{ formatRelative(editing.editableUntil) }} می‌توانید نظرتان را تغییر دهید.
      </p>
      <p v-else-if="editing" class="text-xs text-tg-hint">این نظر دیگر قابل ویرایش نیست.</p>

      <p v-if="formError" class="text-sm text-tg-destructive">{{ formError }}</p>

      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-11 flex-1 rounded-xl bg-tg-button text-sm text-tg-button-text disabled:opacity-50"
          :disabled="reviews.submitting || (editing !== null && editing.editableUntil === null)"
          @click="submit"
        >
          {{ reviews.submitting ? 'در حال ثبت…' : 'ثبت نظر' }}
        </button>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-tg-bg px-4 text-sm"
          @click="active = null"
        >
          انصراف
        </button>
      </div>
    </section>

    <StateBlock
      v-else
      :state="state"
      :error-text="loadError"
      empty-text="در حال حاضر نظری برای نوشتن ندارید."
      @retry="load"
    >
      <ul class="flex flex-col gap-3">
        <li
          v-for="review in reviews.pending"
          :key="review.participantPublicId"
          class="flex flex-col gap-2 rounded-2xl bg-tg-secondary-bg p-4"
        >
          <h2 class="font-medium">{{ review.eventTitle }}</h2>
          <p class="text-sm text-tg-hint">
            دربارهٔ {{ review.revieweeDisplayName }} · مهلت
            {{ formatRelative(review.deadlineAt) }}
          </p>
          <button
            type="button"
            class="min-h-11 self-start rounded-xl bg-tg-button px-4 text-sm text-tg-button-text"
            @click="open(review)"
          >
            نوشتن نظر
          </button>
        </li>
      </ul>
    </StateBlock>
  </main>
</template>
