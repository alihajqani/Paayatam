<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type {
  CostType,
  CreateEventSuggestionRequest,
  EventSuggestionsResponse,
  EventSuggestionView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatDateTime, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Event suggestions (migration 0064).
 *
 * A real programme outside the product — a screening, a play, a group hike —
 * offered in the channel as «میزبانش می‌شوم». The post itself is written by
 * hand, with a poster; this screen makes the suggestion and hands over the link
 * for it, which is the one thing in the post a person cannot type correctly.
 *
 * The time is typed in Tehran's wall clock, because that is what the programme's
 * own page says, and sent as the instant it names (ADR-0008). Tehran has kept
 * +03:30 all year since 2022.
 */
const session = useSessionStore();

const data = ref<EventSuggestionsResponse | null>(null);
const error = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const closingId = ref<string | null>(null);
const copiedId = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (data.value === null) return 'loading' as const;
  return 'ready' as const;
});

const COST_TYPES: { value: CostType; label: string }[] = [
  { value: 'FREE', label: 'رایگان' },
  { value: 'SPLIT', label: 'دنگی' },
  { value: 'APPROX', label: 'تقریبی' },
  { value: 'FIXED', label: 'مبلغ ثابت' },
];

const form = reactive({
  cityId: '',
  categoryId: '',
  title: '',
  description: '',
  venueLabel: '',
  date: '',
  time: '',
  durationHours: 2,
  capacity: 4,
  costType: 'FREE' as CostType,
  costAmount: '',
  externalLink: '',
});

const needsAmount = computed(() => form.costType === 'FIXED' || form.costType === 'APPROX');

async function load(): Promise<void> {
  error.value = null;
  try {
    data.value = await request<EventSuggestionsResponse>('/suggestions');
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست پیشنهادها بارگذاری نشد.');
  }
}

function linkOf(suggestion: EventSuggestionView): string {
  return `https://t.me/${data.value?.botUsername ?? ''}?start=${suggestion.startPayload}`;
}

/** The text to paste under the poster: what, where, when, and the link. */
function postText(suggestion: EventSuggestionView): string {
  return (
    `📍 ${suggestion.cityNameFa}: ${suggestion.title}\n` +
    `🗓 ${formatDateTime(suggestion.startsAt)}، ${suggestion.venueLabel}\n\n` +
    `${suggestion.description}\n\n` +
    `اگر می‌خواهید بروید، رویدادش را به اسم خودتان بسازید تا دیگران همراهتان شوند 👇\n` +
    linkOf(suggestion)
  );
}

async function copy(suggestion: EventSuggestionView): Promise<void> {
  try {
    await navigator.clipboard.writeText(postText(suggestion));
    copiedId.value = suggestion.publicId;
  } catch {
    // No clipboard (an old browser, or a page without permission): the link is
    // on screen and selectable, which is the fallback.
    copiedId.value = null;
  }
}

async function create(): Promise<void> {
  saving.value = true;
  saveError.value = null;
  try {
    const body: CreateEventSuggestionRequest = {
      cityId: form.cityId,
      categoryId: form.categoryId,
      title: form.title,
      description: form.description,
      venueLabel: form.venueLabel,
      startsAt: new Date(`${form.date}T${form.time}:00+03:30`).toISOString(),
      durationHours: Number(form.durationHours),
      capacity: Number(form.capacity),
      costType: form.costType,
      ...(needsAmount.value ? { costAmount: Number(form.costAmount) } : {}),
      ...(form.externalLink.trim() !== '' ? { externalLink: form.externalLink.trim() } : {}),
    };
    const created = await request<EventSuggestionView>('/suggestions', { method: 'POST', body });
    if (data.value) data.value.suggestions = [created, ...data.value.suggestions];
    form.title = '';
    form.description = '';
    form.venueLabel = '';
    form.externalLink = '';
  } catch (cause) {
    saveError.value = messageOf(cause, 'پیشنهاد ساخته نشد. فیلدها را بررسی کنید.');
  } finally {
    saving.value = false;
  }
}

async function close(suggestion: EventSuggestionView): Promise<void> {
  closingId.value = suggestion.publicId;
  try {
    const closed = await request<EventSuggestionView>(`/suggestions/${suggestion.publicId}/close`, {
      method: 'PATCH',
      body: {},
    });
    if (data.value) {
      const index = data.value.suggestions.findIndex((s) => s.publicId === closed.publicId);
      if (index !== -1) data.value.suggestions[index] = closed;
    }
  } catch (cause) {
    saveError.value = messageOf(cause, 'بستن پیشنهاد ناموفق بود.');
  } finally {
    closingId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="max-w-3xl text-sm text-ink-soft">
      یک برنامه‌ی واقعی بیرون از پایتم (اکران، تئاتر، کوه) را اینجا ثبت کنید و لینکش را زیر پوستر در
      کانال بگذارید. هر کس روی لینک بزند، رویداد به اسم خودش با همین مشخصات ساخته می‌شود و فقط تأیید
      می‌کند. نفر دوم به رویداد نفر اول فرستاده می‌شود تا آدم‌ها کنار هم جمع شوند.
    </p>

    <StateBlock :state="state" :error-text="error" empty-text="" @retry="load">
      <form
        class="grid gap-3 rounded-xl border border-line bg-surface p-4 md:grid-cols-3"
        @submit.prevent="create"
      >
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">شهر</span>
          <select
            v-model="form.cityId"
            name="cityId"
            required
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          >
            <option value="" disabled>انتخاب کنید</option>
            <option v-for="city in data?.cities ?? []" :key="city.id" :value="city.id">
              {{ city.nameFa }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">دسته</span>
          <select
            v-model="form.categoryId"
            name="categoryId"
            required
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          >
            <option value="" disabled>انتخاب کنید</option>
            <option
              v-for="category in data?.categories ?? []"
              :key="category.id"
              :value="category.id"
            >
              {{ category.nameFa }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">عنوان</span>
          <input
            v-model="form.title"
            name="title"
            required
            minlength="3"
            maxlength="80"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">مکان (مثلاً سینما هویزه)</span>
          <input
            v-model="form.venueLabel"
            name="venueLabel"
            required
            minlength="2"
            maxlength="60"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">تاریخ (میلادی)</span>
          <input
            v-model="form.date"
            name="date"
            type="date"
            required
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">ساعت شروع (به وقت تهران)</span>
          <input
            v-model="form.time"
            name="time"
            type="time"
            required
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">مدت (ساعت)</span>
          <input
            v-model.number="form.durationHours"
            name="durationHours"
            type="number"
            min="1"
            max="24"
            class="min-h-10 rounded-lg border border-line bg-surface px-3 tabular-nums"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">ظرفیت پیشنهادی</span>
          <input
            v-model.number="form.capacity"
            name="capacity"
            type="number"
            min="1"
            max="1000"
            class="min-h-10 rounded-lg border border-line bg-surface px-3 tabular-nums"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">هزینه</span>
          <select
            v-model="form.costType"
            name="costType"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          >
            <option v-for="type in COST_TYPES" :key="type.value" :value="type.value">
              {{ type.label }}
            </option>
          </select>
        </label>
        <label v-if="needsAmount" class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">مبلغ (تومان)</span>
          <input
            v-model="form.costAmount"
            name="costAmount"
            type="number"
            min="0"
            required
            class="min-h-10 rounded-lg border border-line bg-surface px-3 tabular-nums"
          />
        </label>
        <label class="flex flex-col gap-1 md:col-span-2">
          <span class="text-sm text-ink-soft">لینک بلیت یا اطلاعات (اختیاری)</span>
          <input
            v-model="form.externalLink"
            name="externalLink"
            type="url"
            dir="ltr"
            placeholder="https://"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1 md:col-span-3">
          <span class="text-sm text-ink-soft">توضیح کوتاه</span>
          <textarea
            v-model="form.description"
            name="description"
            required
            minlength="10"
            maxlength="2000"
            rows="3"
            class="rounded-lg border border-line bg-surface px-3 py-2"
          />
        </label>
        <div class="flex items-center gap-3 md:col-span-3">
          <button
            type="submit"
            class="min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
            :disabled="!session.canMutate || saving"
          >
            {{ saving ? 'در حال ساختن…' : 'ساختن پیشنهاد' }}
          </button>
          <p v-if="saveError" class="text-sm text-danger">{{ saveError }}</p>
        </div>
      </form>

      <div class="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[64rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">برنامه</th>
              <th class="px-4 py-3 text-start font-medium">زمان</th>
              <th class="px-4 py-3 text-start font-medium">وضعیت</th>
              <th class="px-4 py-3 text-start font-medium">رویداد ساخته‌شده</th>
              <th class="px-4 py-3 text-start font-medium">لینک</th>
              <th class="px-4 py-3 text-start font-medium"><span class="sr-only">اقدام</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="(data?.suggestions ?? []).length === 0">
              <td colspan="6" class="px-4 py-6 text-center text-ink-soft">
                هنوز پیشنهادی ثبت نشده است.
              </td>
            </tr>
            <tr
              v-for="suggestion in data?.suggestions ?? []"
              :key="suggestion.publicId"
              class="border-b border-line last:border-0"
            >
              <td class="px-4 py-3">
                <span class="font-medium">{{ suggestion.title }}</span>
                <span class="block text-xs text-ink-faint">
                  {{ suggestion.cityNameFa }}، {{ suggestion.venueLabel }}
                </span>
              </td>
              <td class="px-4 py-3">{{ formatDateTime(suggestion.startsAt) }}</td>
              <td class="px-4 py-3">{{ suggestion.isOpen ? 'باز' : 'بسته' }}</td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ toPersianDigits(suggestion.eventCount) }}</bdi>
              </td>
              <td class="px-4 py-3">
                <code dir="ltr" class="select-all text-xs">{{ linkOf(suggestion) }}</code>
              </td>
              <td class="flex flex-wrap gap-2 px-4 py-3">
                <button
                  type="button"
                  class="min-h-9 rounded-lg border border-line px-3 text-xs"
                  @click="copy(suggestion)"
                >
                  {{ copiedId === suggestion.publicId ? 'کپی شد' : 'کپی متن پست' }}
                </button>
                <button
                  v-if="suggestion.isOpen"
                  type="button"
                  class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                  :disabled="!session.canMutate || closingId === suggestion.publicId"
                  @click="close(suggestion)"
                >
                  بستن
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </div>
</template>
