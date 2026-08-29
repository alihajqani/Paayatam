<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { completeProfileRequest, type CompleteProfileRequest, type Gender } from '@payetam/shared';
import MainButton from '@/components/MainButton.vue';
import { ApiError } from '@/api/client';
import { birthYearOptions, toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useInterestPicker } from '@/composables/useInterestPicker';
import { useSessionStore } from '@/stores/session';
import { useLocationPicker } from '@/composables/useLocationPicker';

/**
 * Step two: the profile.
 *
 * Validated against `completeProfileRequest` — the very schema the API validates
 * with (ADR-0003). Client and server cannot disagree about what a valid profile
 * is, because there is only one definition of it.
 *
 * What the client deliberately does *not* decide: whether the user is old enough.
 * That is computed on the server clock from the submitted year (invariant 9), so
 * the year list here is a convenience, not a gate.
 */
const router = useRouter();
const session = useSessionStore();

const displayName = ref('');
const gender = ref<Gender | ''>('');
const birthYear = ref<number | ''>('');
const cityId = ref('');
const districtId = ref('');
const bio = ref('');
const interestIds = ref<string[]>([]);

const loading = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const years = birthYearOptions(new Date().getFullYear());

const interests = computed(() => session.catalog?.interests ?? []);
// The province → city → district cascade (M21). `cityId` stays the submitted
// value; the province is scaffolding for choosing it.
const { provinces, cities, districts, provinceId, onProvinceChange } = useLocationPicker(cityId);

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await session.loadCatalog();
    // Kept from the Tehran-only launch: with a single active city there is
    // nothing to choose, so choosing it removes a pointless tap. Now that the
    // catalog holds 1,252 it simply never fires — except on a deployment that
    // has activated exactly one, which is a real way to run this product.
    if (cities.value.length === 1) cityId.value = cities.value[0]!.id;
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'فهرست‌ها بارگذاری نشد.';
  }
}

/**
 * The cap, enforced where the user can see it (report 4).
 *
 * This was a local toggle that knew nothing about the limit, so a user could tick
 * fifteen chips and be told by a 400 at submit time. The rule now lives in a
 * composable both profile screens share and a unit test covers.
 */
const interestPicker = useInterestPicker(interestIds);

function toggleInterest(id: string): void {
  // A refused tap still gets a haptic, and a different one: silence would be
  // indistinguishable from a tap that missed.
  haptic(interestPicker.toggle(id) ? 'selection' : 'error');
}

function onCityChange(): void {
  // A district only means something inside its city; keeping a stale one would
  // send a pair the server is right to reject.
  districtId.value = '';
}

/**
 * Builds the request, or returns null and populates `fieldErrors`.
 *
 * Optional fields are omitted rather than sent empty: the schema treats an
 * absent `bio` as "not provided" and an empty string as a value that happens to
 * be blank, and only the first is what the user meant.
 */
function buildRequest(): CompleteProfileRequest | null {
  const candidate = {
    displayName: displayName.value,
    ...(gender.value ? { gender: gender.value } : {}),
    birthYear: birthYear.value === '' ? Number.NaN : birthYear.value,
    cityId: cityId.value,
    ...(districtId.value ? { districtId: districtId.value } : {}),
    ...(bio.value.trim() ? { bio: bio.value } : {}),
    interestIds: interestIds.value,
  };

  const parsed = completeProfileRequest.safeParse(candidate);
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
    case 'displayName':
      return 'نام نمایشی باید بین ۲ تا ۴۰ نویسه باشد.';
    case 'birthYear':
      return 'سال تولد خود را انتخاب کنید.';
    case 'cityId':
      return 'شهر خود را انتخاب کنید.';
    case 'interestIds':
      return 'حداقل یک علاقه‌مندی و حداکثر ۱۰ مورد انتخاب کنید.';
    case 'bio':
      return 'دربارهٔ من نباید بیش از ۳۰۰ نویسه باشد.';
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
    const result = await session.completeProfile(body);
    haptic('success');
    await router.replace({ path: '/home', query: result.rewardGranted ? { welcome: '1' } : {} });
  } catch (cause) {
    haptic('error');
    submitError.value =
      cause instanceof ApiError ? cause.messageFa : 'ثبت پروفایل انجام نشد. دوباره تلاش کنید.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-5 py-4">
    <header>
      <h1 class="text-xl font-bold">پروفایل شما</h1>
      <p class="text-sm text-tg-hint">
        این اطلاعات به میزبان‌ها کمک می‌کند شما را بهتر بشناسند. شناسهٔ تلگرام شما هرگز نمایش داده
        نمی‌شود.
      </p>
    </header>

    <div v-if="loadError" class="flex flex-col items-start gap-2">
      <p class="text-tg-destructive">{{ loadError }}</p>
      <button type="button" class="min-h-11 text-tg-link" @click="load">تلاش دوباره</button>
    </div>

    <form v-else class="flex flex-col gap-5" @submit.prevent="submit">
      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">نام نمایشی</span>
        <input
          v-model="displayName"
          type="text"
          maxlength="40"
          autocomplete="nickname"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
        />
        <span v-if="fieldErrors['displayName']" class="text-sm text-tg-destructive">
          {{ fieldErrors['displayName'] }}
        </span>
      </label>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm text-tg-subtitle">جنسیت (اختیاری)</legend>
        <div class="flex gap-2">
          <button
            v-for="option in [
              { value: 'FEMALE', label: 'زن' },
              { value: 'MALE', label: 'مرد' },
              { value: 'PREFER_NOT_SAY', label: 'ترجیح می‌دهم نگویم' },
            ]"
            :key="option.value"
            type="button"
            class="min-h-11 flex-1 rounded-xl px-2 text-sm"
            :class="
              gender === option.value
                ? 'bg-tg-button text-tg-button-text'
                : 'bg-tg-secondary-bg text-tg-text'
            "
            @click="gender = gender === option.value ? '' : (option.value as Gender)"
          >
            {{ option.label }}
          </button>
        </div>
      </fieldset>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">سال تولد (شمسی)</span>
        <select
          v-model="birthYear"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
        >
          <option value="" disabled>انتخاب کنید</option>
          <option v-for="year in years" :key="year.gregorian" :value="year.gregorian">
            {{ year.labelFa }}
          </option>
        </select>
        <span v-if="fieldErrors['birthYear']" class="text-sm text-tg-destructive">
          {{ fieldErrors['birthYear'] }}
        </span>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">استان</span>
        <select
          v-model="provinceId"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
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
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
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
        <select
          v-model="districtId"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
        >
          <option value="">انتخاب نشده</option>
          <option v-for="district in districts" :key="district.id" :value="district.id">
            {{ district.nameFa }}
          </option>
        </select>
      </label>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm text-tg-subtitle">
          علاقه‌مندی‌ها ({{ toPersianDigits(interestIds.length) }} از
          {{ toPersianDigits(interestPicker.max) }})
        </legend>
        <div class="flex flex-wrap gap-2">
          <!--
            At the cap, everything unselected is `disabled` rather than merely
            refused on tap (report 4). `aria-disabled` alongside it, so a screen
            reader is told what the opacity says.
          -->
          <button
            v-for="interest in interests"
            :key="interest.id"
            type="button"
            class="min-h-11 rounded-full px-4 text-sm disabled:opacity-40"
            :class="
              interestPicker.isSelected(interest.id)
                ? 'bg-tg-button text-tg-button-text'
                : 'bg-tg-secondary-bg text-tg-text'
            "
            :aria-pressed="interestPicker.isSelected(interest.id)"
            :disabled="interestPicker.isDisabled(interest.id)"
            :aria-disabled="interestPicker.isDisabled(interest.id)"
            @click="toggleInterest(interest.id)"
          >
            {{ interest.nameFa }}
          </button>
        </div>
        <span
          v-if="interestPicker.notice.value"
          class="text-sm"
          :class="interestPicker.limitHit.value ? 'text-tg-destructive' : 'text-tg-hint'"
          role="status"
        >
          {{ interestPicker.notice.value }}
        </span>
        <span v-if="fieldErrors['interestIds']" class="text-sm text-tg-destructive">
          {{ fieldErrors['interestIds'] }}
        </span>
      </fieldset>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">دربارهٔ من (اختیاری)</span>
        <textarea
          v-model="bio"
          rows="3"
          maxlength="300"
          class="rounded-xl bg-tg-secondary-bg p-3 text-tg-text"
        ></textarea>
        <span v-if="fieldErrors['bio']" class="text-sm text-tg-destructive">
          {{ fieldErrors['bio'] }}
        </span>
      </label>

      <p v-if="submitError" class="text-tg-destructive">{{ submitError }}</p>
    </form>

    <div class="flex-1"></div>

    <MainButton text="ثبت و ادامه" :loading="loading" @click="submit" />
  </main>
</template>
