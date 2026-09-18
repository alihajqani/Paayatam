<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { CitySeedConfigView, SeedEventsCitiesResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Marketing seed events — per-city configuration (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
 *
 * `floorCount` is capped at 3 in the form (and by the server), because that
 * is `EventService`'s own concurrent-active-per-host quota — a city's
 * dedicated host account cannot actually reach a higher floor. Each city
 * needs its own host: the 3-concurrent/5-per-day creation budget is per
 * account, not per city, so sharing one host across cities divides its
 * budget between them.
 */
const session = useSessionStore();

const cities = ref<CitySeedConfigView[] | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const savingCityId = ref<string | null>(null);
const saveError = ref<Record<string, string>>({});

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (cities.value === null) return 'loading' as const;
  return cities.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await request<SeedEventsCitiesResponse>('/seed-events/cities');
    cities.value = response.cities;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست شهرها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

interface Draft {
  enabled: boolean;
  floorCount: number;
  eventCapacity: number;
  fillMinutes: number;
  hostUserPublicId: string;
}

const drafts = reactive<Record<string, Draft>>({});

function draftFor(city: CitySeedConfigView): Draft {
  const existing = drafts[city.cityId];
  if (existing) return existing;
  const created: Draft = {
    enabled: city.enabled,
    floorCount: city.floorCount,
    eventCapacity: city.eventCapacity,
    fillMinutes: city.fillMinutes,
    hostUserPublicId: city.hostUserPublicId ?? '',
  };
  drafts[city.cityId] = created;
  return created;
}

async function save(city: CitySeedConfigView): Promise<void> {
  const draft = draftFor(city);
  savingCityId.value = city.cityId;
  saveError.value = { ...saveError.value, [city.cityId]: '' };
  try {
    const updated = await request<CitySeedConfigView>(`/seed-events/cities/${city.cityId}`, {
      method: 'PATCH',
      body: {
        enabled: draft.enabled,
        floorCount: draft.floorCount,
        eventCapacity: draft.eventCapacity,
        fillMinutes: draft.fillMinutes,
        hostUserPublicId: draft.hostUserPublicId,
      },
    });
    if (cities.value) {
      const index = cities.value.findIndex((c) => c.cityId === city.cityId);
      if (index !== -1) cities.value[index] = updated;
    }
    delete drafts[city.cityId];
  } catch (cause) {
    saveError.value = {
      ...saveError.value,
      [city.cityId]: messageOf(cause, 'ذخیره تنظیمات این شهر ناموفق بود.'),
    };
  } finally {
    savingCityId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="max-w-3xl text-sm text-ink-soft">
      برای هر شهر بازشده، تعدادی رویداد ساختگی با میزبان واقعی و شرکت‌کنندگان مصنوعی ساخته می‌شود که
      به‌سرعت پر می‌شوند — تا در ابتدای کار، شهر خالی به نظر نرسد. هر شهر باید میزبان اختصاصی خودش
      را داشته باشد (نه یک اکانت مشترک بین چند شهر)، چون سقف رویداد هم‌زمانِ هر اکانت ۳ رویداد و سقف
      روزانه‌اش ۵ رویداد است — «کف تعداد» بیش از ۳ عملاً قابل دسترس نیست. حساب میزبان باید سکه کافی
      داشته باشد؛ نبود سکه یعنی توقف بی‌صدای ساخت رویداد در همان شهر.
    </p>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="هیچ شهر بازشده‌ای وجود ندارد."
      @retry="load"
    >
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[64rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">شهر</th>
              <th class="px-4 py-3 text-start font-medium">فعال</th>
              <th class="px-4 py-3 text-start font-medium">کف تعداد</th>
              <th class="px-4 py-3 text-start font-medium">ظرفیت هر رویداد</th>
              <th class="px-4 py-3 text-start font-medium">مدت پر شدن (دقیقه)</th>
              <th class="px-4 py-3 text-start font-medium">میزبان (publicId)</th>
              <th class="px-4 py-3 text-start font-medium">در حال پر شدن</th>
              <th class="px-4 py-3 text-start font-medium"><span class="sr-only">اقدام</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="city in cities ?? []"
              :key="city.cityId"
              class="border-b border-line last:border-0"
            >
              <td class="px-4 py-3 font-medium">{{ city.cityNameFa }}</td>
              <td class="px-4 py-3">
                <input
                  type="checkbox"
                  :checked="draftFor(city).enabled"
                  :disabled="!session.canMutate"
                  @change="draftFor(city).enabled = ($event.target as HTMLInputElement).checked"
                />
              </td>
              <td class="px-4 py-3">
                <input
                  type="number"
                  min="0"
                  max="3"
                  :value="draftFor(city).floorCount"
                  :disabled="!session.canMutate"
                  class="min-h-9 w-16 rounded-lg border border-line bg-surface px-2 tabular-nums"
                  @change="
                    draftFor(city).floorCount = Number(($event.target as HTMLInputElement).value)
                  "
                />
              </td>
              <td class="px-4 py-3">
                <input
                  type="number"
                  min="1"
                  max="50"
                  :value="draftFor(city).eventCapacity"
                  :disabled="!session.canMutate"
                  class="min-h-9 w-16 rounded-lg border border-line bg-surface px-2 tabular-nums"
                  @change="
                    draftFor(city).eventCapacity = Number(($event.target as HTMLInputElement).value)
                  "
                />
              </td>
              <td class="px-4 py-3">
                <input
                  type="number"
                  min="1"
                  max="240"
                  :value="draftFor(city).fillMinutes"
                  :disabled="!session.canMutate"
                  class="min-h-9 w-16 rounded-lg border border-line bg-surface px-2 tabular-nums"
                  @change="
                    draftFor(city).fillMinutes = Number(($event.target as HTMLInputElement).value)
                  "
                />
              </td>
              <td class="px-4 py-3">
                <input
                  type="text"
                  v-model="draftFor(city).hostUserPublicId"
                  placeholder="publicId میزبان واقعی"
                  :disabled="!session.canMutate"
                  class="min-h-9 w-56 rounded-lg border border-line bg-surface px-2"
                />
                <span v-if="city.hostDisplayName" class="mt-1 block text-xs text-ink-faint">
                  {{ city.hostDisplayName }}
                </span>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ toPersianDigits(city.fillingEventCount) }}</bdi>
              </td>
              <td class="px-4 py-3">
                <button
                  type="button"
                  class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                  :disabled="!session.canMutate || savingCityId === city.cityId"
                  @click="save(city)"
                >
                  {{ savingCityId === city.cityId ? 'در حال ذخیره…' : 'ذخیره' }}
                </button>
                <p v-if="saveError[city.cityId]" class="mt-1 max-w-48 text-xs text-danger">
                  {{ saveError[city.cityId] }}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </div>
</template>
