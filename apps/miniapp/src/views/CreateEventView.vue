<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  createEventRequest,
  type CostType,
  type CreateEventRequest,
  type GenderPreference,
} from '@payetam/shared';
import { ApiError } from '@/api/client';
import ChannelGate from '@/components/ChannelGate.vue';
import CostNotice from '@/components/CostNotice.vue';
import MainButton from '@/components/MainButton.vue';
import { isoToLocalInput, localInputToIso, nowAsLocalInput } from '@/format/datetime';
import { toPersianDigits } from '@/format/fa';
import { formatEventWhen } from '@/format/datetime';
import { haptic } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';
import { useSessionStore } from '@/stores/session';
import { useLocationPicker } from '@/composables/useLocationPicker';

/**
 * Event authoring (M4).
 *
 * Validated against `createEventRequest` — the schema the API validates with and the
 * one migration 0004 mirrors as CHECK constraints (ADR-0003). Three definitions of a
 * valid event that cannot drift, because two of them are the same file.
 *
 * **Dates.** The inputs are native `datetime-local`, which is what a Telegram
 * WebView gives a usable picker for on both platforms. Their value is read as
 * *Tehran* wall-clock and converted to UTC before sending, never as the device's
 * timezone — a host on a phone set to UTC would otherwise file an event three and a
 * half hours from when they meant. A Jalali echo of what was chosen sits under the
 * fields, because the input itself renders Gregorian and this product is Jalali
 * everywhere a user reads a date (ADR-0008).
 *
 * The title and description go through Persian auto-moderation server-side; a
 * blacklisted title never publishes and the refusal arrives as a Persian message
 * from the error catalogue.
 */
const router = useRouter();
const events = useEventsStore();
const session = useSessionStore();

const title = ref('');
const description = ref('');
const categoryId = ref('');
const customCategoryLabel = ref('');
const cityId = ref('');
const districtId = ref('');
const startsAtLocal = ref('');
const endsAtLocal = ref('');
const capacity = ref<number | ''>(4);
const costType = ref<CostType>('SPLIT');
const costAmount = ref<number | ''>('');
const costNote = ref('');
const rules = ref('');
const genderPreference = ref<GenderPreference | ''>('');
const minAge = ref<number | ''>('');
const maxAge = ref<number | ''>('');
const externalLink = ref('');

const loading = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const { provinces, cities, districts, provinceId, onProvinceChange } = useLocationPicker(cityId);

/**
 * What authoring costs and whether this host can pay (M22 phase 5).
 *
 * Read from the catalog rather than hardcoded: the price is an `app_setting` an
 * admin can change at runtime, so a number compiled into this bundle would be
 * wrong the first time anybody edits it — and the person who found out would be
 * the host being charged something other than what they were shown.
 */
const createCost = computed(() => session.catalog?.promotion.eventCreateCoins ?? 0);
const balance = computed(() => session.me?.coins.balance ?? null);
const affordable = computed(() => balance.value === null || balance.value >= createCost.value);

/**
 * The activity tags offered where this event is (M21).
 *
 * `cityIds === null` means "everywhere", which is what every tag is until an
 * admin narrows one — so before a city is chosen this is the whole list, and
 * after it is the whole list minus anything restricted elsewhere.
 */
const categories = computed(() =>
  (session.catalog?.categories ?? []).filter(
    (category) =>
      category.cityIds === null || cityId.value === '' || category.cityIds.includes(cityId.value),
  ),
);

/** Whether the chosen tag is a «سایر»-style one that wants the host's own words. */
const wantsCustomLabel = computed(
  () =>
    categories.value.find((category) => category.id === categoryId.value)?.allowsCustomLabel ===
    true,
);

const needsAmount = computed(() => costType.value === 'FIXED' || costType.value === 'APPROX');

/** What the host actually chose, spelled back to them in Jalali. */
const whenLabel = computed(() => {
  const startsAt = localInputToIso(startsAtLocal.value);
  const endsAt = localInputToIso(endsAtLocal.value);
  if (startsAt === null || endsAt === null) return null;
  return formatEventWhen(startsAt, endsAt);
});

async function load(): Promise<void> {
  loadError.value = null;
  try {
    if (session.catalog === null) await session.loadCatalog();
    if (cities.value.length === 1) cityId.value = cities.value[0]!.id;
    if (categories.value.length === 1) categoryId.value = categories.value[0]!.id;
    // Tomorrow evening: a sensible default that is always in the future, which is
    // what the server requires.
    const start = nowAsLocalInput(24 * 60);
    startsAtLocal.value = start;
    endsAtLocal.value = isoToLocalInput(
      new Date(
        new Date(localInputToIso(start) ?? Date.now()).getTime() + 2 * 3_600_000,
      ).toISOString(),
    );
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'فهرست‌ها بارگذاری نشد.';
  }
}

function onCityChange(): void {
  districtId.value = '';
  // A tag restricted to other cities is no longer on offer here (M21). Clearing
  // it means the host meets an empty select rather than a server refusal after
  // they have filled in the rest of the form.
  if (categoryId.value !== '' && !categories.value.some((c) => c.id === categoryId.value)) {
    categoryId.value = '';
  }
}

function onCostTypeChange(): void {
  // FREE and SPLIT must not carry an amount; the schema refuses the pair and the
  // table has a CHECK for it. Clearing here means the user never meets either.
  if (!needsAmount.value) costAmount.value = '';
}

function buildRequest(): CreateEventRequest | null {
  const startsAt = localInputToIso(startsAtLocal.value);
  const endsAt = localInputToIso(endsAtLocal.value);

  const candidate = {
    title: title.value,
    description: description.value,
    categoryId: categoryId.value,
    // Only when the tag invites it — the server refuses the field otherwise, and
    // sending an empty string would be sending the field.
    ...(wantsCustomLabel.value && customCategoryLabel.value.trim()
      ? { customCategoryLabel: customCategoryLabel.value.trim() }
      : {}),
    cityId: cityId.value,
    ...(districtId.value ? { districtId: districtId.value } : {}),
    startsAt: startsAt ?? '',
    endsAt: endsAt ?? '',
    capacity: capacity.value === '' ? Number.NaN : capacity.value,
    costType: costType.value,
    ...(needsAmount.value && costAmount.value !== '' ? { costAmount: costAmount.value } : {}),
    ...(costNote.value.trim() ? { costNote: costNote.value } : {}),
    ...(rules.value.trim() ? { rules: rules.value } : {}),
    ...(genderPreference.value ? { genderPreference: genderPreference.value } : {}),
    ...(minAge.value !== '' ? { minAge: minAge.value } : {}),
    ...(maxAge.value !== '' ? { maxAge: maxAge.value } : {}),
    ...(externalLink.value.trim() ? { externalLink: externalLink.value.trim() } : {}),
  };

  const parsed = createEventRequest.safeParse(candidate);
  if (parsed.success) {
    fieldErrors.value = {};
    return parsed.data;
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
    case 'categoryId':
      return 'دسته را انتخاب کنید.';
    case 'customCategoryLabel':
      return 'نوع تفریح را بین ۲ تا ۶۰ نویسه بنویسید.';
    case 'cityId':
      return 'شهر را انتخاب کنید.';
    case 'startsAt':
      return 'زمان شروع را انتخاب کنید.';
    case 'endsAt':
      return 'زمان پایان باید بعد از زمان شروع باشد.';
    case 'capacity':
      return 'ظرفیت باید بین ۱ تا ۵۰ نفر باشد.';
    case 'costAmount':
      return 'برای هزینهٔ مشخص و تقریبی، مبلغ لازم است و برای رایگان و دنگی مجاز نیست.';
    case 'maxAge':
      return 'بیشترین سن باید از کمترین سن کمتر نباشد.';
    case 'externalLink':
      return 'پیوند باید با https:// شروع شود.';
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
    const event = await events.create(body);
    haptic('success');
    await router.replace(`/my-events?created=${event.publicId}`);
  } catch (cause) {
    haptic('error');
    submitError.value =
      cause instanceof ApiError ? cause.messageFa : 'ثبت رویداد انجام نشد. دوباره تلاش کنید.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-5 py-4">
    <header>
      <h1 class="text-xl font-bold">رویداد تازه</h1>
      <p class="text-sm text-tg-hint">
        عنوان و توضیحات پیش از انتشار بررسی می‌شوند. شناسهٔ تلگرام شما هرگز نمایش داده نمی‌شود.
      </p>
    </header>

    <!-- Shown before the form rather than after the submit: the server-side gate
         is the control, and this is the explanation (M22 phase 6). -->
    <ChannelGate action="EVENT_CREATE" />

    <div v-if="loadError" class="flex flex-col items-start gap-2">
      <p class="text-tg-destructive">{{ loadError }}</p>
      <button type="button" class="min-h-11 text-tg-link" @click="load">تلاش دوباره</button>
    </div>

    <form v-else class="flex flex-col gap-5" @submit.prevent="submit">
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
        <span class="text-sm text-tg-subtitle">دسته</span>
        <select v-model="categoryId" class="min-h-11 rounded-xl bg-tg-secondary-bg px-3">
          <option value="" disabled>انتخاب کنید</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">
            {{ category.nameFa }}
          </option>
        </select>
        <span v-if="fieldErrors['categoryId']" class="text-sm text-tg-destructive">
          {{ fieldErrors['categoryId'] }}
        </span>
      </label>

      <!--
        Shown only for a tag that invites it («سایر»). Required when shown: a
        «سایر» activity with no label tells a reader nothing, which is why the
        server refuses one too.
      -->
      <label v-if="wantsCustomLabel" class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">نوع تفریح</span>
        <input
          v-model="customCategoryLabel"
          type="text"
          maxlength="60"
          placeholder="مثلاً: بازدید از نمایشگاه کتاب"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3"
        />
        <span v-if="fieldErrors['customCategoryLabel']" class="text-sm text-tg-destructive">
          {{ fieldErrors['customCategoryLabel'] }}
        </span>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">استان</span>
        <select
          v-model="provinceId"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3"
          @change="onProvinceChange"
        >
          <option value="" disabled>انتخاب کنید</option>
          <option v-for="province in provinces" :key="province.id" :value="province.id">
            {{ province.nameFa }}
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">شهر</span>
        <select
          v-model="cityId"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3"
          @change="onCityChange"
        >
          <option value="" disabled>انتخاب کنید</option>
          <option v-for="city in cities" :key="city.id" :value="city.id">{{ city.nameFa }}</option>
        </select>
        <span v-if="fieldErrors['cityId']" class="text-sm text-tg-destructive">
          {{ fieldErrors['cityId'] }}
        </span>
      </label>

      <label v-if="districts.length > 0" class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">منطقه (اختیاری)</span>
        <select v-model="districtId" class="min-h-11 rounded-xl bg-tg-secondary-bg px-3">
          <option value="">انتخاب نشده</option>
          <option v-for="district in districts" :key="district.id" :value="district.id">
            {{ district.nameFa }}
          </option>
        </select>
      </label>

      <div class="flex flex-col gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">شروع</span>
          <input
            v-model="startsAtLocal"
            type="datetime-local"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
          <span v-if="fieldErrors['startsAt']" class="text-sm text-tg-destructive">
            {{ fieldErrors['startsAt'] }}
          </span>
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
      </div>

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

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm text-tg-subtitle">محدودیت جنسیت (اختیاری)</legend>
        <div class="flex gap-2">
          <button
            v-for="option in [
              { value: 'FEMALE_ONLY', label: 'فقط خانم‌ها' },
              { value: 'MALE_ONLY', label: 'فقط آقایان' },
            ]"
            :key="option.value"
            type="button"
            class="min-h-11 flex-1 rounded-xl px-2 text-sm"
            :class="
              genderPreference === option.value
                ? 'bg-tg-button text-tg-button-text'
                : 'bg-tg-secondary-bg text-tg-text'
            "
            @click="
              genderPreference =
                genderPreference === option.value ? '' : (option.value as GenderPreference)
            "
          >
            {{ option.label }}
          </button>
        </div>
      </fieldset>

      <div class="flex gap-2">
        <label class="flex flex-1 flex-col gap-1">
          <span class="text-sm text-tg-subtitle">کمترین سن</span>
          <input
            v-model.number="minAge"
            type="number"
            inputmode="numeric"
            min="18"
            max="120"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
        </label>
        <label class="flex flex-1 flex-col gap-1">
          <span class="text-sm text-tg-subtitle">بیشترین سن</span>
          <input
            v-model.number="maxAge"
            type="number"
            inputmode="numeric"
            min="18"
            max="120"
            class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
          />
          <span v-if="fieldErrors['maxAge']" class="text-sm text-tg-destructive">
            {{ fieldErrors['maxAge'] }}
          </span>
        </label>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">پیوند بیرونی (اختیاری)</span>
        <input
          v-model="externalLink"
          type="url"
          inputmode="url"
          placeholder="https://"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
        />
        <span v-if="fieldErrors['externalLink']" class="text-sm text-tg-destructive">
          {{ fieldErrors['externalLink'] }}
        </span>
      </label>

      <p v-if="submitError" class="text-tg-destructive">{{ submitError }}</p>
    </form>

    <div class="flex-1"></div>

    <CostNotice :cost="createCost" :balance="balance" label="هزینهٔ ثبت رویداد" class="mt-4" />

    <MainButton text="ثبت رویداد" :loading="loading" :disabled="!affordable" @click="submit" />
  </main>
</template>
