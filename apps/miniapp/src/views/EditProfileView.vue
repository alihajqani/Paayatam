<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { updateProfileRequest, type Gender, type UpdateProfileRequest } from '@payetam/shared';
import { ApiError } from '@/api/client';
import CityPicker from '@/components/CityPicker.vue';
import MainButton from '@/components/MainButton.vue';
import StateBlock from '@/components/StateBlock.vue';
import { birthYearOptions, toPersianDigits } from '@/format/fa';
import { haptic } from '@/telegram/webapp';
import { useInterestPicker } from '@/composables/useInterestPicker';
import { useSessionStore } from '@/stores/session';

/**
 * Editing a profile that already exists (M22 phase 2).
 *
 * A different screen from `ProfileView`, which is the onboarding *step*: that one
 * takes a whole profile, grants coins and moves on to the home screen. This one
 * takes whatever changed and comes back to where it was opened from. Sharing one
 * component would have meant a `mode` prop and a branch at every difference —
 * and the differences are the interesting part.
 *
 * ── What it sends ────────────────────────────────────────────────────────────
 *
 * Only the fields that actually changed. `PATCH /me/profile` leaves an absent
 * field alone, so a diff against the loaded profile is both the smallest request
 * and the safest one: two people editing different halves of the same profile
 * from two devices do not overwrite each other, and a field this screen does not
 * render cannot be cleared by a screen that forgot about it.
 *
 * Validated against `updateProfileRequest` — the schema the API validates with
 * (ADR-0003), so the client and the server cannot disagree about what a valid
 * edit is.
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
const inviteOptOut = ref(false);

const loading = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const saved = ref(false);
const fieldErrors = ref<Record<string, string>>({});

const years = birthYearOptions(new Date().getFullYear());
const profile = computed(() => session.me?.profile ?? null);
const interests = computed(() => session.catalog?.interests ?? []);

/** Districts of the chosen city, from the catalog the picker already loaded. */
const districts = computed(
  () => (session.catalog?.cities ?? []).find((city) => city.id === cityId.value)?.districts ?? [],
);

/**
 * Fill the form from what is stored.
 *
 * Called on mount and by «بازگرداندن», so "undo my edits" is the same code path
 * as "open the screen" rather than a second, subtly different reset.
 */
function hydrate(): void {
  const current = profile.value;
  if (!current) return;
  displayName.value = current.displayName;
  gender.value = current.gender ?? '';
  birthYear.value = current.birthYear ?? '';
  cityId.value = current.city.id;
  districtId.value = current.district?.id ?? '';
  bio.value = current.bio ?? '';
  interestIds.value = current.interests.map((interest) => interest.id);
  inviteOptOut.value = current.inviteOptOut;
  fieldErrors.value = {};
  submitError.value = null;
  saved.value = false;
}

async function load(): Promise<void> {
  loadError.value = null;
  try {
    // Both, in parallel: the catalog for the pickers and `/me` for the values.
    // `refreshMe` rather than trusting what is in the store, because this screen
    // is reachable long after sign-in and an edit against a stale copy would
    // compute the wrong diff.
    await Promise.all([session.loadCatalog(), session.refreshMe()]);
    hydrate();
  } catch (cause) {
    loadError.value = cause instanceof ApiError ? cause.messageFa : 'اطلاعات پروفایل بارگذاری نشد.';
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
  // A district only means something inside its city, and the server is right to
  // refuse a mismatched pair. Clearing here makes that visible instead of turning
  // it into a validation error the user has to interpret.
  if (!districts.value.some((district) => district.id === districtId.value)) districtId.value = '';
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * The diff, or null with `fieldErrors` populated.
 *
 * An empty diff is not an error and not a request: the server refuses a body with
 * no fields, and sending one to be told so would be a round trip to learn what
 * the client already knows.
 */
function buildRequest(): UpdateProfileRequest | null | 'unchanged' {
  const current = profile.value;
  if (!current) return null;

  const candidate: Record<string, unknown> = {};

  if (displayName.value.trim() !== current.displayName) {
    candidate['displayName'] = displayName.value;
  }
  if ((gender.value === '' ? null : gender.value) !== current.gender) {
    candidate['gender'] = gender.value === '' ? null : gender.value;
  }
  if (birthYear.value !== '' && birthYear.value !== current.birthYear) {
    candidate['birthYear'] = birthYear.value;
  }
  if (cityId.value !== current.city.id) candidate['cityId'] = cityId.value;
  if ((districtId.value === '' ? null : districtId.value) !== (current.district?.id ?? null)) {
    candidate['districtId'] = districtId.value === '' ? null : districtId.value;
  }
  const nextBio = bio.value.trim() === '' ? null : bio.value.trim();
  if (nextBio !== current.bio) candidate['bio'] = nextBio;
  if (
    !sameSet(
      interestIds.value,
      current.interests.map((interest) => interest.id),
    )
  ) {
    candidate['interestIds'] = interestIds.value;
  }
  if (inviteOptOut.value !== current.inviteOptOut) candidate['inviteOptOut'] = inviteOptOut.value;

  if (Object.keys(candidate).length === 0) return 'unchanged';

  const parsed = updateProfileRequest.safeParse(candidate);
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
  // The first guard against a double submit. The button disables itself too, but
  // a Telegram MainButton tap can arrive twice on a slow device and the cheapest
  // place to refuse the second is before it becomes a request.
  if (loading.value) return;

  submitError.value = null;
  saved.value = false;

  const body = buildRequest();
  if (body === 'unchanged') {
    saved.value = true;
    return;
  }
  if (!body) {
    haptic('error');
    return;
  }

  loading.value = true;
  try {
    await session.updateProfile(body);
    haptic('success');
    // Re-fill from what the server actually stored, so the form shows the saved
    // state rather than the submitted one — they differ whenever the server
    // normalised part of an edit. `hydrate` clears the flag, so it is set after.
    hydrate();
    saved.value = true;
  } catch (cause) {
    haptic('error');
    submitError.value =
      cause instanceof ApiError ? cause.messageFa : 'ذخیرهٔ تغییرات انجام نشد. دوباره تلاش کنید.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-5 py-4">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold">ویرایش پروفایل</h1>
        <p class="text-sm text-tg-hint">
          فقط چیزهایی که تغییر می‌دهید ذخیره می‌شود. شناسهٔ تلگرام شما هرگز به کسی نمایش داده
          نمی‌شود.
        </p>
      </div>
      <button
        type="button"
        class="min-h-11 shrink-0 text-tg-link"
        aria-label="بازگشت به خانه"
        @click="router.push('/home')"
      >
        خانه
      </button>
    </header>

    <StateBlock v-if="loadError" state="error" :error-text="loadError" @retry="load" />

    <div v-else-if="!profile" class="flex flex-col gap-2" aria-hidden="true">
      <div v-for="n in 6" :key="n" class="h-11 rounded-xl bg-tg-secondary-bg"></div>
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
            :aria-pressed="gender === option.value"
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

      <CityPicker
        v-model="cityId"
        :error="fieldErrors['cityId']"
        @update:model-value="onCityChange"
      />

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

      <label class="flex min-h-11 items-center gap-3">
        <input
          v-model="inviteOptOut"
          type="checkbox"
          class="size-5 accent-[var(--color-tg-button)]"
        />
        <span class="text-sm">دعوت‌نامهٔ رویدادها برایم فرستاده نشود.</span>
      </label>

      <!--
        What cannot be edited, said out loud rather than left as an absence.
        A form that silently omits a field reads as a form that lost it.
      -->
      <section class="rounded-xl bg-tg-secondary-bg p-4 text-sm text-tg-hint">
        <h2 class="mb-1 font-medium text-tg-subtitle">مواردی که تغییر نمی‌کنند</h2>
        <p>حساب تلگرام شما، تاریخ عضویت، امتیاز اعتماد و موجودی سکه از این صفحه ویرایش نمی‌شوند.</p>
      </section>

      <p v-if="submitError" class="text-tg-destructive" role="alert">{{ submitError }}</p>
      <p v-else-if="saved" class="text-tg-accent" role="status">تغییرات ذخیره شد.</p>
    </form>

    <div class="flex-1"></div>

    <MainButton text="ذخیرهٔ تغییرات" :loading="loading" :disabled="!profile" @click="submit" />
  </main>
</template>
