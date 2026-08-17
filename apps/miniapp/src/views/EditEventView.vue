<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { updateEventRequest, type CostType, type UpdateEventRequest } from '@payetam/shared';
import { ApiError } from '@/api/client';
import MainButton from '@/components/MainButton.vue';
import StateBlock from '@/components/StateBlock.vue';
import { formatEventWhen, isoToLocalInput, localInputToIso } from '@/format/datetime';
import { toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';

/**
 * Editing an event a host already filed.
 *
 * **The editable set is narrower than the creatable one on purpose.** Category and
 * city are what discovery indexed and what people chose the event *by*; changing them
 * after strangers have asked to join turns their request into a request for something
 * else. Everything here is either a correction (title, description, rules) or a
 * detail the host legitimately revises (time, capacity, cost).
 *
 * `expectedVersion` is sent with every change: two devices editing the same event
 * cannot silently overwrite each other, and the loser gets a Persian conflict message
 * instead of losing their work invisibly.
 */
const route = useRoute();
const router = useRouter();
const events = useEventsStore();

const publicId = computed(() => String(route.params['publicId'] ?? ''));

const title = ref('');
const description = ref('');
const startsAtLocal = ref('');
const endsAtLocal = ref('');
const capacity = ref<number | ''>('');
const costType = ref<CostType>('SPLIT');
const costAmount = ref<number | ''>('');
const costNote = ref('');
const rules = ref('');
const version = ref<number | null>(null);

const loading = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const needsAmount = computed(() => costType.value === 'FIXED' || costType.value === 'APPROX');

const whenLabel = computed(() => {
  const startsAt = localInputToIso(startsAtLocal.value);
  const endsAt = localInputToIso(endsAtLocal.value);
  if (startsAt === null || endsAt === null) return null;
  return formatEventWhen(startsAt, endsAt);
});

const state = computed(() => {
  if (loadError.value !== null) return 'error' as const;
  if (version.value === null) return 'loading' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loadError.value = null;
  try {
    if (events.myEvents.length === 0) await events.loadMyEvents();
    const event = events.myEvents.find((candidate) => candidate.publicId === publicId.value);
    if (!event) {
      loadError.value = 'این رویداد در فهرست رویدادهای شما نیست.';
      return;
    }

    title.value = event.title;
    description.value = event.description;
    startsAtLocal.value = isoToLocalInput(event.startsAt);
    endsAtLocal.value = isoToLocalInput(event.endsAt);
    capacity.value = event.capacity;
    costType.value = event.costType;
    costAmount.value = event.costAmount ?? '';
    costNote.value = event.costNote ?? '';
    rules.value = event.rules ?? '';
    version.value = event.version;
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'این رویداد بارگذاری نشد.';
  }
}

function onCostTypeChange(): void {
  if (!needsAmount.value) costAmount.value = '';
}

function buildRequest(): UpdateEventRequest | null {
  const startsAt = localInputToIso(startsAtLocal.value);
  const endsAt = localInputToIso(endsAtLocal.value);

  const candidate = {
    title: title.value,
    description: description.value,
    startsAt: startsAt ?? '',
    endsAt: endsAt ?? '',
    capacity: capacity.value === '' ? Number.NaN : capacity.value,
    costType: costType.value,
    ...(needsAmount.value && costAmount.value !== '' ? { costAmount: costAmount.value } : {}),
    ...(costNote.value.trim() ? { costNote: costNote.value } : {}),
    ...(rules.value.trim() ? { rules: rules.value } : {}),
    ...(version.value !== null ? { expectedVersion: version.value } : {}),
  };

  /**
   * Validated for its verdict, not for its output.
   *
   * `updateEventRequest` is a `.partial()`, so zod types every key as
   * `key?: T | undefined` — which under `exactOptionalPropertyTypes` is not assignable
   * to `UpdateEventRequest`'s "may be absent". `candidate` is built with conditional
   * spreads and therefore never holds an explicit `undefined`, so it is the value to
   * send; the parse is what decides whether it may be sent at all.
   */
  const parsed = updateEventRequest.safeParse(candidate);
  if (parsed.success) {
    fieldErrors.value = {};
    return candidate;
  }

  fieldErrors.value = Object.fromEntries(
    parsed.error.issues.map((issue) => [String(issue.path[0] ?? ''), messageFor(issue.path[0])]),
  );
  return null;
}

function messageFor(field: PropertyKey | undefined): string {
  switch (field) {
    case 'title':
      return 'عنوان باید بین ۳ تا ۸۰ نویسه باشد.';
    case 'description':
      return 'توضیحات باید بین ۱۰ تا ۲۰۰۰ نویسه باشد.';
    case 'endsAt':
      return 'زمان پایان باید بعد از زمان شروع باشد.';
    case 'capacity':
      return 'ظرفیت باید بین ۱ تا ۵۰ نفر باشد.';
    case 'costAmount':
      return 'برای هزینهٔ مشخص و تقریبی، مبلغ لازم است و برای رایگان و دنگی مجاز نیست.';
    default:
      return 'این مقدار معتبر نیست.';
  }
}

async function submit(): Promise<void> {
  submitError.value = null;
  const body = buildRequest();
  if (!body) {
    haptic('error');
    return;
  }

  loading.value = true;
  try {
    await events.update(publicId.value, body);
    haptic('success');
    await router.replace('/my-events');
  } catch (cause) {
    haptic('error');
    submitError.value =
      cause instanceof ApiError ? cause.messageFa : 'ویرایش رویداد انجام نشد. دوباره تلاش کنید.';
    // A conflict means our copy is stale; reloading is the only useful next step.
    if (cause instanceof ApiError && cause.code === 'CONFLICT_STALE_VERSION') {
      version.value = null;
      await load();
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-5 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">ویرایش رویداد</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.back()">
        بازگشت
      </button>
    </header>

    <StateBlock :state="state" :error-text="loadError" :rows="4" @retry="load">
      <form class="flex flex-col gap-5" @submit.prevent="submit">
        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">عنوان</span>
          <input
            v-model="title"
            type="text"
            maxlength="80"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
          <span v-if="fieldErrors['title']" class="text-sm text-tg-destructive">
            {{ fieldErrors['title'] }}
          </span>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">توضیحات</span>
          <textarea
            v-model="description"
            rows="4"
            maxlength="2000"
            class="rounded-xl bg-tg-secondary-bg p-3 text-tg-text"
          ></textarea>
          <span v-if="fieldErrors['description']" class="text-sm text-tg-destructive">
            {{ fieldErrors['description'] }}
          </span>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">شروع</span>
          <input
            v-model="startsAtLocal"
            type="datetime-local"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">پایان</span>
          <input
            v-model="endsAtLocal"
            type="datetime-local"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
          <span v-if="fieldErrors['endsAt']" class="text-sm text-tg-destructive">
            {{ fieldErrors['endsAt'] }}
          </span>
        </label>

        <p v-if="whenLabel" class="text-sm text-tg-hint">به وقت تهران: {{ whenLabel }}</p>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">ظرفیت</span>
          <select v-model="capacity" class="min-h-11 rounded-xl bg-tg-secondary-bg px-3">
            <option v-for="seats in 50" :key="seats" :value="seats">
              {{ toPersianDigits(seats) }} نفر
            </option>
          </select>
          <span v-if="fieldErrors['capacity']" class="text-sm text-tg-destructive">
            {{ fieldErrors['capacity'] }}
          </span>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">هزینه</span>
          <select
            v-model="costType"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3"
            @change="onCostTypeChange"
          >
            <option value="FREE">رایگان</option>
            <option value="SPLIT">دنگی</option>
            <option value="FIXED">مبلغ مشخص</option>
            <option value="APPROX">تقریبی</option>
          </select>
        </label>

        <label v-if="needsAmount" class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">مبلغ (تومان)</span>
          <input
            v-model.number="costAmount"
            type="number"
            inputmode="numeric"
            min="0"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
          <span v-if="fieldErrors['costAmount']" class="text-sm text-tg-destructive">
            {{ fieldErrors['costAmount'] }}
          </span>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">توضیح هزینه (اختیاری)</span>
          <input
            v-model="costNote"
            type="text"
            maxlength="200"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">قوانین رویداد (اختیاری)</span>
          <textarea
            v-model="rules"
            rows="2"
            maxlength="1000"
            class="rounded-xl bg-tg-secondary-bg p-3 text-tg-text"
          ></textarea>
        </label>

        <p v-if="submitError" class="text-tg-destructive">{{ submitError }}</p>
      </form>

      <div class="flex-1"></div>

      <MainButton text="ذخیرهٔ تغییرات" :loading="loading" @click="submit" />
    </StateBlock>
  </main>
</template>
