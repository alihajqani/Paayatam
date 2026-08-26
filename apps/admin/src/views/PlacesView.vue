<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type {
  AdminCityListResponse,
  AdminCityView,
  AdminProvinceListResponse,
  AdminProvinceView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import { formatNumber } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Provinces and cities (M22 phase 9).
 *
 * M21 generated 31 provinces and 1,252 cities with `city.is_active` defaulting to
 * **false**, and left no way to turn one on outside `psql`. That is the gap this
 * closes: opening a city is a business decision somebody makes weekly, and it was
 * a database session.
 *
 * ── Why this list pages the server ───────────────────────────────────────────
 *
 * The Mini App's picker filters a list the client already downloaded, because it
 * only ever shows ~1,200 *active* cities and the catalog ships them once. This one
 * shows every city including the retired ones, each with reference counts
 * attached — data no browser should be holding, and counts no cached response
 * should carry. So the search is debounced and the query goes to the server.
 *
 * ── The deactivation flow ────────────────────────────────────────────────────
 *
 * A city with profiles or events in it cannot be switched off in one click. The
 * first attempt comes back `CITY_HAS_REFERENCES` with the counts, and the panel
 * turns that into a confirmation naming them — «۲۳۴ پروفایل و ۱۲ فعالیت» rather
 * than «مطمئنید؟». The second attempt carries `confirmReferences`.
 */
const session = useSessionStore();

const provinces = ref<AdminProvinceView[] | null>(null);
const cities = ref<AdminCityView[] | null>(null);
const total = ref(0);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const query = ref('');
const provinceFilter = ref('');
const activeFilter = ref<'' | 'true' | 'false'>('');
const offset = ref(0);
const LIMIT = 50;

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (cities.value === null || provinces.value === null) return 'loading' as const;
  return 'ready' as const;
});

const provinceName = computed(
  () => new Map((provinces.value ?? []).map((province) => [province.id, province.nameFa])),
);

async function loadProvinces(): Promise<void> {
  const response = await request<AdminProvinceListResponse>('/provinces');
  provinces.value = response.provinces;
}

async function loadCities(): Promise<void> {
  const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset.value) });
  if (query.value.trim() !== '') params.set('query', query.value.trim());
  if (provinceFilter.value !== '') params.set('provinceId', provinceFilter.value);
  if (activeFilter.value !== '') params.set('isActive', activeFilter.value);

  const response = await request<AdminCityListResponse>(`/cities?${params.toString()}`);
  cities.value = response.cities;
  total.value = response.total;
}

async function load(): Promise<void> {
  error.value = null;
  try {
    await Promise.all([loadProvinces(), loadCities()]);
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست شهرها بارگذاری نشد.');
  }
}

/**
 * Debounced, because this list is on the server.
 *
 * 300 ms is long enough that typing «قائم‌شهر» is one query rather than eight, and
 * short enough that it still feels like filtering rather than searching.
 */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch([query, provinceFilter, activeFilter], () => {
  offset.value = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void loadCities().catch((cause: unknown) => {
      error.value = messageOf(cause, 'جست‌وجو انجام نشد.');
    });
  }, 300);
});

watch(offset, () => {
  void loadCities().catch((cause: unknown) => {
    error.value = messageOf(cause, 'صفحهٔ بعد بارگذاری نشد.');
  });
});

// ── Activating and deactivating ─────────────────────────────────────────────

const busyId = ref<string | null>(null);
const pendingDeactivation = ref<{
  city: AdminCityView;
  profileCount: number;
  eventCount: number;
} | null>(null);

async function setActive(city: AdminCityView, isActive: boolean, confirm = false): Promise<void> {
  busyId.value = city.id;
  error.value = null;
  try {
    await request<AdminCityView>(`/cities/${city.id}`, {
      method: 'PATCH',
      body: { isActive, ...(confirm ? { confirmReferences: true } : {}) },
    });
    pendingDeactivation.value = null;
    notice.value = isActive
      ? `«${city.nameFa}» فعال شد و از این پس در فهرست کاربران دیده می‌شود.`
      : `«${city.nameFa}» غیرفعال شد. پروفایل‌ها و فعالیت‌های موجود دست‌نخورده‌اند.`;
    await loadCities();
  } catch (cause) {
    const details = detailsOf(cause);
    if (details !== null) {
      // The server refused and told us why. Turn it into the confirmation rather
      // than into an error message the operator cannot act on.
      pendingDeactivation.value = { city, ...details };
    } else {
      error.value = messageOf(cause, 'تغییر وضعیت شهر انجام نشد.');
    }
  } finally {
    busyId.value = null;
  }
}

/** The sentence the confirmation shows, with the counts the server sent back. */
const deactivationBody = computed(() => {
  const pending = pendingDeactivation.value;
  if (pending === null) return '';
  return (
    `«${pending.city.nameFa}» هم‌اکنون ${formatNumber(pending.profileCount)} پروفایل و ` +
    `${formatNumber(pending.eventCount)} فعالیت دارد. غیرفعال کردن، این شهر را از فهرست ` +
    'انتخاب کاربران حذف می‌کند؛ داده‌های موجود پاک نمی‌شوند و فعالیت‌های ثبت‌شده سر جای خود ' +
    'می‌مانند. کاربران ساکن این شهر تا زمانی که شهر دیگری انتخاب نکنند، همان شهر را در ' +
    'پروفایل خود می‌بینند.'
  );
});

function confirmDeactivation(): void {
  const pending = pendingDeactivation.value;
  if (pending === null) return;
  void setActive(pending.city, false, true);
}

/** The counts a `CITY_HAS_REFERENCES` refusal carries, if that is what this is. */
function detailsOf(cause: unknown): { profileCount: number; eventCount: number } | null {
  const error = cause as {
    code?: string;
    details?: { profileCount?: number; eventCount?: number };
  };
  if (error.code !== 'CITY_HAS_REFERENCES') return null;
  return {
    profileCount: error.details?.profileCount ?? 0,
    eventCount: error.details?.eventCount ?? 0,
  };
}

// ── Adding a city ───────────────────────────────────────────────────────────

const adding = ref(false);
const addBusy = ref(false);
const addError = ref<string | null>(null);
const addForm = ref({ slug: '', nameFa: '', provinceId: '', isActive: false });

const addValid = computed(
  () =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(addForm.value.slug) &&
    addForm.value.nameFa.trim().length >= 1,
);

async function submitAdd(): Promise<void> {
  if (addBusy.value || !addValid.value) return;
  addBusy.value = true;
  addError.value = null;
  try {
    await request<AdminCityView>('/cities', {
      method: 'POST',
      body: {
        slug: addForm.value.slug,
        nameFa: addForm.value.nameFa.trim(),
        ...(addForm.value.provinceId !== '' ? { provinceId: addForm.value.provinceId } : {}),
        isActive: addForm.value.isActive,
      },
    });
    adding.value = false;
    addForm.value = { slug: '', nameFa: '', provinceId: '', isActive: false };
    notice.value = 'شهر تازه ثبت شد.';
    await load();
  } catch (cause) {
    addError.value = messageOf(cause, 'ثبت شهر انجام نشد.');
  } finally {
    addBusy.value = false;
  }
}

// ── Renaming and re-filing ──────────────────────────────────────────────────

const editingId = ref<string | null>(null);
const editForm = ref({ nameFa: '', provinceId: '' });
const editBusy = ref(false);

function openEdit(city: AdminCityView): void {
  editingId.value = city.id;
  editForm.value = { nameFa: city.nameFa, provinceId: city.provinceId ?? '' };
}

async function submitEdit(city: AdminCityView): Promise<void> {
  if (editBusy.value) return;
  editBusy.value = true;
  error.value = null;
  try {
    await request<AdminCityView>(`/cities/${city.id}`, {
      method: 'PATCH',
      body: {
        nameFa: editForm.value.nameFa.trim(),
        // Null is a value: "not filed under any province" is a real state.
        provinceId: editForm.value.provinceId === '' ? null : editForm.value.provinceId,
      },
    });
    editingId.value = null;
    notice.value = 'شهر به‌روزرسانی شد.';
    await loadCities();
  } catch (cause) {
    error.value = messageOf(cause, 'ویرایش شهر انجام نشد.');
  } finally {
    editBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="6" @retry="load">
    <div class="flex flex-col gap-5">
      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <!-- ── Provinces ────────────────────────────────────────────────── -->
      <section>
        <h2 class="mb-2 text-base font-semibold">استان‌ها</h2>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="province in provinces ?? []"
            :key="province.id"
            class="rounded-full px-3 py-1 text-xs"
            :class="
              province.isActive ? 'bg-neutral-soft text-ink-soft' : 'bg-danger-soft text-danger'
            "
          >
            {{ province.nameFa }}
            <bdi class="text-ink-faint">
              ({{ formatNumber(province.activeCityCount) }}/{{ formatNumber(province.cityCount) }})
            </bdi>
          </span>
        </div>
        <p class="mt-1 text-xs text-ink-faint">
          عدد داخل پرانتز: شهرهای فعال از کل شهرهای آن استان.
        </p>
      </section>

      <!-- ── Filters ──────────────────────────────────────────────────── -->
      <section class="grid gap-3 sm:grid-cols-4">
        <label class="flex flex-col gap-1 sm:col-span-2">
          <span class="text-sm text-ink-soft">جست‌وجو (نام یا شناسه)</span>
          <input
            v-model="query"
            type="search"
            placeholder="مثلاً قائم‌شهر یا qaemshahr"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">استان</span>
          <select
            v-model="provinceFilter"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          >
            <option value="">همه</option>
            <option v-for="province in provinces ?? []" :key="province.id" :value="province.id">
              {{ province.nameFa }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-ink-soft">وضعیت</span>
          <select
            v-model="activeFilter"
            class="min-h-10 rounded-lg border border-line bg-surface px-3"
          >
            <option value="">همه</option>
            <option value="true">فعال</option>
            <option value="false">غیرفعال</option>
          </select>
        </label>
      </section>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-ink-soft">
          <bdi>{{ formatNumber(total) }}</bdi> شهر
        </p>
        <button
          type="button"
          class="min-h-10 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
          :disabled="!session.canMutate"
          @click="adding = !adding"
        >
          افزودن شهر
        </button>
      </div>

      <!-- ── Adding ───────────────────────────────────────────────────── -->
      <section v-if="adding" class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">شهر تازه</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          شناسه (slug) پس از ثبت قابل تغییر نیست — کدها، seedها و مستندات با همان به این شهر ارجاع
          می‌دهند. نام فارسی هر زمان قابل ویرایش است. شهر تازه به‌صورت پیش‌فرض غیرفعال ثبت می‌شود.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">شناسه (لاتین)</span>
            <input
              v-model="addForm.slug"
              type="text"
              dir="ltr"
              placeholder="qaemshahr"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">نام فارسی</span>
            <input
              v-model="addForm.nameFa"
              type="text"
              maxlength="80"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">استان</span>
            <select
              v-model="addForm.provinceId"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            >
              <option value="">بدون استان</option>
              <option v-for="province in provinces ?? []" :key="province.id" :value="province.id">
                {{ province.nameFa }}
              </option>
            </select>
          </label>
          <label class="flex items-center gap-2 pt-6">
            <input v-model="addForm.isActive" type="checkbox" class="size-4" />
            <span class="text-sm text-ink-soft">همین حالا فعال شود</span>
          </label>
        </div>

        <p v-if="addError" class="mt-2 text-sm text-danger" role="alert">{{ addError }}</p>

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="!addValid || addBusy"
            @click="submitAdd"
          >
            {{ addBusy ? 'در حال ثبت…' : 'ثبت شهر' }}
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm"
            @click="adding = false"
          >
            انصراف
          </button>
        </div>
      </section>

      <!-- ── The list ─────────────────────────────────────────────────── -->
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-xs text-ink-faint">
            <tr>
              <th class="p-2 text-start">شهر</th>
              <th class="p-2 text-start">شناسه</th>
              <th class="p-2 text-start">استان</th>
              <th class="p-2 text-start">مناطق</th>
              <th class="p-2 text-start">پروفایل</th>
              <th class="p-2 text-start">فعالیت</th>
              <th class="p-2 text-start">وضعیت</th>
              <th class="p-2 text-start"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="city in cities ?? []" :key="city.id">
              <tr class="border-t border-line">
                <td class="p-2 font-medium">{{ city.nameFa }}</td>
                <td class="p-2">
                  <bdi class="font-mono text-xs">{{ city.slug }}</bdi>
                </td>
                <td class="p-2">{{ provinceName.get(city.provinceId ?? '') ?? '—' }}</td>
                <td class="p-2 tabular-nums">
                  <bdi>{{ formatNumber(city.districtCount) }}</bdi>
                </td>
                <td class="p-2 tabular-nums">
                  <bdi>{{ formatNumber(city.profileCount) }}</bdi>
                </td>
                <td class="p-2 tabular-nums">
                  <bdi>{{ formatNumber(city.eventCount) }}</bdi>
                </td>
                <td class="p-2">
                  <span
                    class="rounded-full px-2 py-0.5 text-xs"
                    :class="
                      city.isActive ? 'bg-good-soft text-good' : 'bg-neutral-soft text-ink-faint'
                    "
                  >
                    {{ city.isActive ? 'فعال' : 'غیرفعال' }}
                  </span>
                </td>
                <td class="p-2">
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                      :disabled="!session.canMutate || busyId === city.id"
                      @click="setActive(city, !city.isActive)"
                    >
                      {{ city.isActive ? 'غیرفعال کردن' : 'فعال کردن' }}
                    </button>
                    <button
                      type="button"
                      class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                      :disabled="!session.canMutate"
                      @click="openEdit(city)"
                    >
                      ویرایش
                    </button>
                  </div>
                </td>
              </tr>

              <tr v-if="editingId === city.id" class="border-t border-line bg-surface-sunken">
                <td colspan="8" class="p-3">
                  <div class="flex flex-wrap items-end gap-3">
                    <label class="flex flex-col gap-1">
                      <span class="text-xs text-ink-soft">نام فارسی</span>
                      <input
                        v-model="editForm.nameFa"
                        type="text"
                        maxlength="80"
                        class="min-h-9 rounded-lg border border-line bg-surface px-3 text-sm"
                      />
                    </label>
                    <label class="flex flex-col gap-1">
                      <span class="text-xs text-ink-soft">استان</span>
                      <select
                        v-model="editForm.provinceId"
                        class="min-h-9 rounded-lg border border-line bg-surface px-3 text-sm"
                      >
                        <option value="">بدون استان</option>
                        <option
                          v-for="province in provinces ?? []"
                          :key="province.id"
                          :value="province.id"
                        >
                          {{ province.nameFa }}
                        </option>
                      </select>
                    </label>
                    <button
                      type="button"
                      class="min-h-9 rounded-lg bg-brand px-3 text-xs text-brand-ink disabled:opacity-40"
                      :disabled="editBusy"
                      @click="submitEdit(city)"
                    >
                      ذخیره
                    </button>
                    <button
                      type="button"
                      class="min-h-9 rounded-lg border border-line px-3 text-xs"
                      @click="editingId = null"
                    >
                      انصراف
                    </button>
                    <p class="text-xs text-ink-faint">
                      شناسه <bdi class="font-mono">{{ city.slug }}</bdi> تغییر نمی‌کند.
                    </p>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <PagerBar :total="total" :limit="LIMIT" :offset="offset" @move="offset = $event" />

      <!-- ── Deactivating a city people are in ────────────────────────── -->
      <ConfirmDialog
        :open="pendingDeactivation !== null"
        title="غیرفعال کردن شهری که در حال استفاده است"
        :body="deactivationBody"
        confirm-label="بله، غیرفعال شود"
        tone="danger"
        :busy="busyId !== null"
        @cancel="pendingDeactivation = null"
        @confirm="confirmDeactivation"
      />
    </div>
  </StateBlock>
</template>
