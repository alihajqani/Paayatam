<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import {
  PERMISSIONS,
  type AdminParticipationListResponse,
  type AdminParticipationView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDateTime, toPersianDigits } from '@/format/fa';
import { joinCoinsLine } from '@/format/participation';
import { useSessionStore } from '@/stores/session';

/**
 * «درخواست‌ها» — every request to join an activity, from everybody, on one page.
 *
 * The first version of this lived inside each user's page and under each event's
 * request count, so «who from a city we have not opened paid to queue somewhere
 * else?» meant opening people one at a time. This is the list itself.
 *
 * **The address is the state.** Every filter lives in the query string, so a link
 * from a user's page (`?user=`) or an event (`?event=`) opens the same page
 * already narrowed, the back button undoes a filter, and a view can be pasted to
 * a colleague. Inputs write the address; the address drives the request.
 *
 * Real people only by default: seed identities fill seed events by the dozen and
 * would bury the rows support is looking for. One checkbox brings them back.
 */
const LIMIT = 50;

const route = useRoute();
const router = useRouter();
const session = useSessionStore();

/** «پیام» on a row opens «پیام‌ها» with the person filled in (`message.send`). */
const canMessage = computed(() => session.can(PERMISSIONS.MESSAGE_SEND));

const rows = ref<AdminParticipationView[]>([]);
const total = ref(0);
const cities = ref<AdminParticipationListResponse['cities']>([]);
const offset = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);

function read(key: string): string {
  const value = route.query[key];
  return typeof value === 'string' ? value : '';
}

const filters = computed(() => ({
  q: read('q'),
  status: read('status'),
  eventCity: read('eventCity'),
  userCity: read('userCity'),
  away: read('away') === '1',
  seeds: read('seeds') === '1',
  user: read('user'),
  event: read('event'),
}));

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

/** Only the newest request's answer is drawn; a slow earlier one is dropped. */
let sequence = 0;

async function load(): Promise<void> {
  const mine = (sequence += 1);
  const f = filters.value;
  loading.value = true;
  error.value = null;
  try {
    const page = await request<AdminParticipationListResponse>('/participations', {
      query: {
        query: f.q,
        status: f.status,
        eventCityId: f.eventCity,
        userCityId: f.userCity,
        userPublicId: f.user,
        eventPublicId: f.event,
        ...(f.away ? { outOfCity: true } : {}),
        ...(f.seeds ? {} : { realOnly: true }),
        limit: LIMIT,
        offset: offset.value,
      },
    });
    if (mine !== sequence) return;
    rows.value = page.participations;
    total.value = page.total;
    cities.value = page.cities;
    loaded.value = true;
  } catch (cause) {
    if (mine !== sequence) return;
    error.value = messageOf(cause, 'فهرست درخواست‌ها بارگذاری نشد.');
  } finally {
    if (mine === sequence) loading.value = false;
  }
}

/** Change filters by changing the address; an empty value removes the key. */
function setFilter(patch: Record<string, string | undefined>): void {
  const next: LocationQueryRaw = { ...route.query };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
  }
  offset.value = 0;
  void router.replace({ query: next });
}

function onSelect(key: string, event: Event): void {
  setFilter({ [key]: (event.target as HTMLSelectElement).value });
}

function onToggle(key: string, event: Event): void {
  setFilter({ [key]: (event.target as HTMLInputElement).checked ? '1' : undefined });
}

// The search box writes the address after a pause, not on every keystroke.
const search = ref(filters.value.q);
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => setFilter({ q: value.trim() }), 300);
});

watch(
  () => route.query,
  () => {
    if (search.value.trim() !== filters.value.q) search.value = filters.value.q;
    void load();
  },
);

function move(to: number): void {
  offset.value = to;
  void load();
}

/** A request's own words — `REJECTED` is «رد شد» here, not the event's «تأیید نشده». */
const STATUS_LABELS: Record<AdminParticipationView['status'], string> = {
  PENDING: 'در انتظار پاسخ میزبان',
  WAITLISTED: 'نوبت انتظار',
  ACCEPTED: 'پذیرفته شد',
  REJECTED: 'رد شد',
  EXPIRED: 'بی‌پاسخ ماند',
  CANCELLED_BY_PARTICIPANT: 'لغو توسط کاربر',
  CANCELLED_BY_HOST: 'لغو توسط میزبان',
  COMPLETED: 'شرکت کرد',
  NO_SHOW: 'نیامد',
};

const STATUSES = Object.entries(STATUS_LABELS);

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-sm text-ink-soft">
      همهٔ درخواست‌های شرکت در رویدادها، تازه‌ترین اول. سکهٔ درخواست با رد شدن، بی‌پاسخ ماندن یا باز
      نشدن جا در نوبت انتظار برمی‌گردد؛ اگر خود کاربر لغو کند برنمی‌گردد.
    </p>

    <form class="flex flex-wrap items-end gap-3" @submit.prevent>
      <label class="flex min-w-64 flex-1 flex-col gap-1">
        <span class="text-sm text-ink-soft">جست‌وجو</span>
        <input
          v-model="search"
          name="query"
          type="search"
          placeholder="نام یا شناسهٔ کاربر، عنوان یا شمارهٔ رویداد"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">وضعیت</span>
        <select
          name="status"
          :value="filters.status"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
          @change="onSelect('status', $event)"
        >
          <option value="">همه</option>
          <option v-for="[value, label] in STATUSES" :key="value" :value="value">
            {{ label }}
          </option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">شهر کاربر</span>
        <select
          name="userCity"
          :value="filters.userCity"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
          @change="onSelect('userCity', $event)"
        >
          <option value="">همه</option>
          <option v-for="city in cities" :key="city.id" :value="city.id">{{ city.nameFa }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">شهر رویداد</span>
        <select
          name="eventCity"
          :value="filters.eventCity"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
          @change="onSelect('eventCity', $event)"
        >
          <option value="">همه</option>
          <option v-for="city in cities" :key="city.id" :value="city.id">{{ city.nameFa }}</option>
        </select>
      </label>
      <label class="flex min-h-10 items-center gap-2">
        <input
          name="outOfCity"
          type="checkbox"
          class="size-4"
          :checked="filters.away"
          @change="onToggle('away', $event)"
        />
        <span class="text-sm">فقط رویداد شهر دیگر</span>
      </label>
      <label class="flex min-h-10 items-center gap-2">
        <input
          name="seeds"
          type="checkbox"
          class="size-4"
          :checked="filters.seeds"
          @change="onToggle('seeds', $event)"
        />
        <span class="text-sm">نمایش کاربران ساختگی</span>
      </label>
    </form>

    <div v-if="filters.user || filters.event" class="flex flex-wrap gap-2">
      <button
        v-if="filters.user"
        type="button"
        class="rounded-full border border-line px-3 py-1 text-sm"
        @click="setFilter({ user: undefined })"
      >
        فقط این کاربر ✕
      </button>
      <button
        v-if="filters.event"
        type="button"
        class="rounded-full border border-line px-3 py-1 text-sm"
        @click="setFilter({ event: undefined })"
      >
        فقط این رویداد ✕
      </button>
    </div>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="درخواستی با این مشخصات پیدا نشد."
      @retry="load"
    >
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[56rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">کاربر</th>
              <th class="px-4 py-3 text-start font-medium">رویداد</th>
              <th class="px-4 py-3 text-start font-medium">وضعیت</th>
              <th class="px-4 py-3 text-start font-medium">زمان درخواست</th>
              <th class="px-4 py-3 text-start font-medium">سکهٔ درخواست</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.publicId" class="border-b border-line last:border-0">
              <td class="px-4 py-3">
                <span v-if="row.user.isSeed">
                  {{ row.user.displayName ?? 'بدون نام' }}
                  <span class="ms-1 rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-ink-soft">
                    ساختگی
                  </span>
                </span>
                <RouterLink
                  v-else
                  :to="{ name: 'user-detail', params: { publicId: row.user.publicId } }"
                  class="font-medium text-brand"
                >
                  {{ row.user.displayName ?? 'بدون نام' }}
                </RouterLink>
                <span class="block text-xs text-ink-faint">{{ row.user.cityNameFa ?? '—' }}</span>
                <RouterLink
                  v-if="canMessage && !row.user.isSeed"
                  :to="{ name: 'messages', query: { to: row.user.publicId } }"
                  class="text-xs text-brand"
                >
                  ✉️ پیام
                </RouterLink>
              </td>
              <td class="px-4 py-3">
                <button
                  type="button"
                  class="text-start font-medium hover:text-brand"
                  title="فقط درخواست‌های این رویداد"
                  @click="setFilter({ event: row.event.publicId })"
                >
                  <bdi>#{{ toPersianDigits(row.event.number) }}</bdi>
                  {{ row.event.title }}
                </button>
                <span class="block text-xs text-ink-faint">
                  {{ row.event.cityNameFa }} · {{ formatDateTime(row.event.startsAt) }}
                </span>
                <span class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-if="row.outOfCity"
                    class="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
                  >
                    شهر دیگر
                  </span>
                  <span
                    v-if="row.event.isSeeded"
                    class="rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-ink-soft"
                  >
                    ساختگی
                  </span>
                </span>
              </td>
              <td class="px-4 py-3">
                <StatusPill :value="row.status" :label="STATUS_LABELS[row.status]" />
                <span v-if="row.cancelledAt" class="mt-1 block text-xs text-ink-faint">
                  {{ formatDateTime(row.cancelledAt) }}
                </span>
              </td>
              <td class="px-4 py-3 text-ink-soft">{{ formatDateTime(row.requestedAt) }}</td>
              <td class="px-4 py-3">
                <bdi class="tabular-nums">{{ joinCoinsLine(row.joinCoins).amount }}</bdi>
                <span v-if="joinCoinsLine(row.joinCoins).fate" class="block text-xs text-ink-faint">
                  {{ joinCoinsLine(row.joinCoins).fate }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PagerBar :total="total" :limit="LIMIT" :offset="offset" :loading="loading" @move="move" />
    </StateBlock>
  </div>
</template>
