<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { foldedIncludes } from '@payetam/shared';
import { toPersianDigits } from '@/format/fa';
import { useLocationPicker } from '@/composables/useLocationPicker';

/**
 * Choosing one of 1,252 cities, on a phone (M22 phase 9).
 *
 * `useLocationPicker` already narrows the list by province, which turns 1,252
 * into ~40. This adds the other half: a **search box**, because a user who knows
 * the name of their city should not have to know which province it is in — and
 * for the several provinces with over a hundred cities, «انتخاب کنید» over a
 * scroll list is still not a control anybody can use.
 *
 * ── Why the filtering is client-side ─────────────────────────────────────────
 *
 * The catalog is already in memory: `GET /api/v1/catalog` ships every active city
 * once per session (~15 KiB gzipped) and is cached for five minutes. Filtering an
 * array the client already holds costs nothing and answers on every keystroke,
 * where a `?query=` endpoint would be a round trip per character on connections
 * where the round trip is the expensive part. The admin panel's city screen does
 * page the server — it has 1,252 rows *including inactive ones* and needs
 * sorting and editing, which is a different problem.
 *
 * `foldedIncludes` is what makes «قايم» find «قائم‌شهر»: the ی/ي fold and the
 * half-space, shared with the server so both sides agree about what matches.
 */
const props = defineProps<{
  /** The chosen city id. Empty string means nothing chosen yet. */
  modelValue: string;
  /** Shown when the field is required and empty. */
  error?: string | undefined;
  /** Adds a «همهٔ شهرها» option — for a filter sheet, not for a form. */
  allowAny?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const cityId = computed({
  get: () => props.modelValue,
  set: (value: string) => {
    emit('update:modelValue', value);
  },
});

const { provinces, cities, provinceId, onProvinceChange } = useLocationPicker(cityId);

const query = ref('');

/**
 * The province list, plus the search, plus a cap.
 *
 * The cap is the point of the counter below it: showing fifty of two hundred
 * matches with no indication that there are more is how a user concludes their
 * city is not in the list. Typing two more characters is a better answer than
 * rendering two hundred options into a WebView.
 */
const VISIBLE_LIMIT = 60;

const matches = computed(() =>
  query.value.trim() === ''
    ? cities.value
    : cities.value.filter((city) => foldedIncludes(city.nameFa, query.value)),
);

const visible = computed(() => matches.value.slice(0, VISIBLE_LIMIT));
const hidden = computed(() => Math.max(matches.value.length - VISIBLE_LIMIT, 0));

/** The chosen city may be outside the current filter — never hide what is selected. */
const chosen = computed(() => cities.value.find((city) => city.id === cityId.value) ?? null);

// Searching is a way of choosing, so a search that no longer contains the chosen
// city has effectively unchosen it. Clearing here rather than at submit means the
// user sees it happen instead of discovering it in a validation error.
watch(matches, () => {
  if (cityId.value === '') return;
  if (!matches.value.some((city) => city.id === cityId.value)) cityId.value = '';
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1">
      <span class="text-sm text-tg-subtitle">استان</span>
      <select
        v-model="provinceId"
        class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
        @change="onProvinceChange"
      >
        <option value="">همهٔ استان‌ها</option>
        <option v-for="province in provinces" :key="province.id" :value="province.id">
          {{ province.nameFa }}
        </option>
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm text-tg-subtitle">جست‌وجوی شهر</span>
      <input
        v-model="query"
        type="search"
        inputmode="search"
        enterkeyhint="search"
        placeholder="نام شهر را بنویسید"
        aria-label="جست‌وجوی شهر"
        class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm text-tg-subtitle">شهر</span>
      <select v-model="cityId" class="min-h-11 rounded-xl bg-tg-secondary-bg px-3 text-tg-text">
        <option v-if="allowAny" value="">همهٔ شهرها</option>
        <option v-else value="" disabled>انتخاب کنید</option>
        <!--
          The chosen city is rendered first and unconditionally. Without it, a
          selection made before the user typed would vanish from the control the
          moment the filter stopped matching it — and a `<select>` whose value is
          not among its options renders blank.
        -->
        <template v-if="chosen">
          <option v-if="!visible.some((city) => city.id === chosen!.id)" :value="chosen.id">
            {{ chosen.nameFa }}
          </option>
        </template>
        <option v-for="city in visible" :key="city.id" :value="city.id">{{ city.nameFa }}</option>
      </select>

      <span v-if="matches.length === 0" class="text-sm text-tg-hint">
        شهری با این نام پیدا نشد. املای دیگری را امتحان کنید یا استان را عوض کنید.
      </span>
      <span v-else-if="hidden > 0" class="text-sm text-tg-hint">
        {{ toPersianDigits(hidden) }} شهر دیگر هم هست — برای دیدنشان نام را کامل‌تر بنویسید.
      </span>

      <span v-if="error" class="text-sm text-tg-destructive">{{ error }}</span>
    </label>
  </div>
</template>
