<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import EventCard from '@/components/EventCard.vue';
import StateBlock from '@/components/StateBlock.vue';
import { haptic } from '@/telegram/webapp';
import { useEventsStore } from '@/stores/events';
import { useSessionStore } from '@/stores/session';
import { useLocationPicker } from '@/composables/useLocationPicker';

/**
 * Discovery (M5).
 *
 * Search is server-side and Persian-aware: the ي/ك and half-space variants are
 * normalized by the same pipeline the events were indexed with (ADR-0012), so the
 * client sends the raw query and does no normalizing of its own. Doing it here
 * would be a second implementation of a rule that has to match exactly.
 */
const router = useRouter();
const events = useEventsStore();
const session = useSessionStore();

const error = ref<string | null>(null);
const filtersOpen = ref(false);

const categories = computed(() => session.catalog?.categories ?? []);
// The filter sheet binds straight to the store, so the composable is handed a
// writable ref onto `events.filters.cityId` rather than a local copy.
const filterCityId = computed({
  get: () => events.filters.cityId,
  set: (value: string) => {
    events.filters.cityId = value;
  },
});
const { provinces, cities, districts, provinceId, onProvinceChange } =
  useLocationPicker(filterCityId);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (events.discovering) return 'loading' as const;
  if (events.isEmpty) return 'empty' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  error.value = null;
  try {
    // The catalog feeds the filter pickers and is cached in the session store, so
    // this is one request on first visit and none afterwards.
    if (session.catalog === null) await session.loadCatalog();
    await events.discover();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'فهرست رویدادها بارگذاری نشد.';
  }
}

async function apply(): Promise<void> {
  filtersOpen.value = false;
  haptic('selection');
  await load();
}

async function clear(): Promise<void> {
  events.resetFilters();
  await apply();
}

async function more(): Promise<void> {
  try {
    await events.loadMore();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'صفحهٔ بعد بارگذاری نشد.';
  }
}

function onCityChange(): void {
  events.filters.districtId = '';
}

function openEvent(publicId: string): void {
  void router.push(`/events/${publicId}`);
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <header class="flex items-baseline justify-between gap-2">
      <h1 class="text-xl font-bold">رویدادها</h1>
      <button type="button" class="min-h-11 text-sm text-tg-link" @click="router.push('/home')">
        خانه
      </button>
    </header>

    <form class="flex flex-col gap-2" @submit.prevent="apply">
      <div class="flex gap-2">
        <input
          v-model="events.filters.q"
          type="search"
          inputmode="search"
          enterkeyhint="search"
          placeholder="جست‌وجو…"
          class="min-h-11 flex-1 rounded-xl bg-tg-secondary-bg px-3 text-tg-text"
        />
        <button
          type="button"
          class="min-h-11 rounded-xl px-3 text-sm"
          :class="filtersOpen ? 'bg-tg-button text-tg-button-text' : 'bg-tg-secondary-bg'"
          :aria-expanded="filtersOpen"
          @click="filtersOpen = !filtersOpen"
        >
          صافی‌ها
        </button>
      </div>

      <div v-if="filtersOpen" class="flex flex-col gap-3 rounded-2xl bg-tg-secondary-bg p-3">
        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">دسته</span>
          <select
            v-model="events.filters.categoryId"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
          >
            <option value="">همه</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.nameFa }}
            </option>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">استان</span>
          <select
            v-model="provinceId"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
            @change="onProvinceChange"
          >
            <option value="">همه</option>
            <option v-for="province in provinces" :key="province.id" :value="province.id">
              {{ province.nameFa }}
            </option>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">شهر</span>
          <select
            v-model="events.filters.cityId"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
            @change="onCityChange"
          >
            <option value="">همه</option>
            <option v-for="city in cities" :key="city.id" :value="city.id">
              {{ city.nameFa }}
            </option>
          </select>
        </label>

        <label v-if="districts.length > 0" class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">منطقه</span>
          <select
            v-model="events.filters.districtId"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
          >
            <option value="">همه</option>
            <option v-for="district in districts" :key="district.id" :value="district.id">
              {{ district.nameFa }}
            </option>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">زمان روز</span>
          <select
            v-model="events.filters.timeOfDay"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
          >
            <option value="">هر زمان</option>
            <option value="MORNING">صبح</option>
            <option value="AFTERNOON">بعدازظهر</option>
            <option value="EVENING">عصر</option>
            <option value="NIGHT">شب</option>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">هزینه</span>
          <select
            v-model="events.filters.costType"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
          >
            <option value="">هر هزینه‌ای</option>
            <option value="FREE">رایگان</option>
            <option value="SPLIT">دنگی</option>
            <option value="FIXED">مبلغ مشخص</option>
            <option value="APPROX">تقریبی</option>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm text-tg-subtitle">ترتیب</span>
          <select
            v-model="events.filters.sort"
            class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text"
          >
            <option value="RELEVANCE">مناسب‌ترین</option>
            <option value="SOONEST">نزدیک‌ترین زمان</option>
            <option value="NEWEST">تازه‌ترین</option>
          </select>
        </label>

        <label class="flex min-h-11 items-center gap-2">
          <input v-model="events.filters.hasCapacity" type="checkbox" class="size-5" />
          <span class="text-sm">فقط رویدادهای دارای جای خالی</span>
        </label>

        <label class="flex min-h-11 items-center gap-2">
          <input v-model="events.filters.ageFits" type="checkbox" class="size-5" />
          <span class="text-sm">فقط رویدادهایی که با سن من می‌خواند</span>
        </label>

        <div class="flex gap-2">
          <button type="submit" class="min-h-11 flex-1 rounded-xl bg-tg-button text-tg-button-text">
            اعمال
          </button>
          <button type="button" class="min-h-11 rounded-xl bg-tg-bg px-4" @click="clear">
            پاک‌کردن
          </button>
        </div>
      </div>
    </form>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="رویدادی با این صافی‌ها پیدا نشد."
      @retry="load"
    >
      <template #empty-action>
        <button type="button" class="min-h-11 text-tg-link" @click="clear">پاک‌کردن صافی‌ها</button>
      </template>

      <ul class="flex flex-col gap-3">
        <li v-for="event in events.results" :key="event.publicId">
          <button type="button" class="w-full text-start" @click="openEvent(event.publicId)">
            <EventCard :event="event" />
          </button>
        </li>
      </ul>

      <button
        v-if="events.hasMore"
        type="button"
        class="min-h-11 rounded-xl bg-tg-secondary-bg"
        :disabled="events.loadingMore"
        @click="more"
      >
        {{ events.loadingMore ? 'در حال بارگذاری…' : 'بیشتر' }}
      </button>
    </StateBlock>
  </main>
</template>
