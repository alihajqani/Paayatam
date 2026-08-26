<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ActivityTagView, ActivityTagsResponse, AdminPlacesResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import { formatNumber } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * تفریحات — the activity tags a host files an event under (M21).
 *
 * `catalog.manage` has been in the permission catalogue since M12 with nothing
 * behind it; `docs/admin-panel.md` listed catalog management under "no API was
 * built". This is that screen. Until now, adding an activity meant editing
 * `tools/seed-catalog.ts`, getting a review and shipping a release — the wrong
 * shape for a list whose job is to grow each time the product enters a city it
 * has not served.
 *
 * Four things the screen deliberately does **not** let an operator do, each
 * because the server refuses it anyway and a button that leads to a refusal is
 * worse than no button:
 *
 *  - **Rename a slug.** It is the identifier seeds, tests and docs refer to. It
 *    is shown, greyed, and there is no input for it.
 *  - **Delete a tag with events.** `eventCount` is on the row, so the button is
 *    disabled with the count visible rather than failing on click.
 *  - **Reorder by typing numbers.** Up/down move a row and send the whole order
 *    in one request, so a half-applied drag cannot leave an order nobody chose.
 *  - **Restrict to a city that does not exist.** The picker is fed by
 *    `GET /admin/v1/places`.
 */
const session = useSessionStore();

const tags = ref<ActivityTagView[]>([]);
const places = ref<AdminPlacesResponse>({ provinces: [], cities: [] });
const error = ref<string | null>(null);
const loaded = ref(false);
const notice = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return tags.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

const cityNameById = computed(
  () => new Map(places.value.cities.map((city) => [city.id, city.nameFa])),
);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [tagList, placeList] = await Promise.all([
      request<ActivityTagsResponse>('/activity-tags'),
      request<AdminPlacesResponse>('/places'),
    ]);
    tags.value = tagList.tags;
    places.value = placeList;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست تفریحات بارگذاری نشد.');
  }
}

/** How a tag's city scope reads in the table, without listing 400 names. */
function scopeLabel(tag: ActivityTagView): string {
  if (tag.cityIds === null) return 'همهٔ شهرها';
  if (tag.cityIds.length === 0) return 'هیچ شهری';
  if (tag.cityIds.length <= 2) {
    return tag.cityIds.map((id) => cityNameById.value.get(id) ?? '؟').join('، ');
  }
  return `${formatNumber(tag.cityIds.length)} شهر`;
}

// ── The editor, shared by "new" and "edit" ──────────────────────────────────

type Draft = {
  id: string | null;
  slug: string;
  nameFa: string;
  icon: string;
  isActive: boolean;
  allowsCustomLabel: boolean;
  /** `true` = offered everywhere, which the wire spells `cityIds: null`. */
  everywhere: boolean;
  cityIds: string[];
};

const draft = ref<Draft | null>(null);
const acting = ref(false);
const actionError = ref<string | null>(null);

/** Narrows the 1,252-row city list to something a person can work through. */
const scopeProvinceId = ref('');
const scopeQuery = ref('');

const scopeCities = computed(() => {
  const query = scopeQuery.value.trim();
  return places.value.cities.filter((city) => {
    if (scopeProvinceId.value !== '' && city.provinceId !== scopeProvinceId.value) return false;
    return query === '' || city.nameFa.includes(query) || city.slug.includes(query);
  });
});

function openNew(): void {
  draft.value = {
    id: null,
    slug: '',
    nameFa: '',
    icon: '',
    isActive: true,
    allowsCustomLabel: false,
    everywhere: true,
    cityIds: [],
  };
  resetScopeFilters();
}

function openEdit(tag: ActivityTagView): void {
  draft.value = {
    id: tag.id,
    slug: tag.slug,
    nameFa: tag.nameFa,
    icon: tag.icon ?? '',
    isActive: tag.isActive,
    allowsCustomLabel: tag.allowsCustomLabel,
    everywhere: tag.cityIds === null,
    cityIds: tag.cityIds ?? [],
  };
  resetScopeFilters();
}

function resetScopeFilters(): void {
  scopeProvinceId.value = '';
  scopeQuery.value = '';
  actionError.value = null;
}

function toggleCity(cityId: string): void {
  const current = draft.value;
  if (current === null) return;
  const index = current.cityIds.indexOf(cityId);
  if (index === -1) current.cityIds.push(cityId);
  else current.cityIds.splice(index, 1);
}

/**
 * The same rule `activityTagSlug` enforces, checked before the request.
 *
 * Duplicated deliberately: the server is the authority and refuses regardless,
 * and this exists so the operator learns the rule while typing rather than from
 * a 422 after they have filled the form.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const draftValid = computed(() => {
  const current = draft.value;
  if (current === null) return false;
  if (current.nameFa.trim() === '') return false;
  // Only new tags carry a slug on the wire — an existing one cannot be renamed.
  if (current.id === null && !SLUG_PATTERN.test(current.slug.trim())) return false;
  return true;
});

async function save(): Promise<void> {
  const current = draft.value;
  if (current === null || !draftValid.value) return;

  acting.value = true;
  actionError.value = null;

  const scope = current.everywhere ? null : current.cityIds;
  const shared = {
    nameFa: current.nameFa.trim(),
    icon: current.icon.trim() === '' ? null : current.icon.trim(),
    isActive: current.isActive,
    allowsCustomLabel: current.allowsCustomLabel,
    cityIds: scope,
  };

  try {
    if (current.id === null) {
      await request<ActivityTagView>('/activity-tags', {
        method: 'POST',
        body: { slug: current.slug.trim(), ...shared },
      });
      notice.value = `تفریح «${shared.nameFa}» ساخته شد.`;
    } else {
      await request<ActivityTagView>(`/activity-tags/${current.id}`, {
        method: 'PATCH',
        body: shared,
      });
      notice.value = `تفریح «${shared.nameFa}» ذخیره شد.`;
    }
    draft.value = null;
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'ذخیرهٔ تفریح انجام نشد.');
  } finally {
    acting.value = false;
  }
}

// ── Enable / disable, without opening the editor ────────────────────────────

async function toggleActive(tag: ActivityTagView): Promise<void> {
  notice.value = null;
  try {
    await request<ActivityTagView>(`/activity-tags/${tag.id}`, {
      method: 'PATCH',
      body: { isActive: !tag.isActive },
    });
    await load();
  } catch (cause) {
    error.value = messageOf(cause, 'تغییر وضعیت انجام نشد.');
  }
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Move one row and send the **whole** order.
 *
 * One request rather than two PATCHes: a swap that half-applies leaves two rows
 * claiming the same position, and the operator has no way to tell which half won.
 */
async function move(index: number, delta: number): Promise<void> {
  const target = index + delta;
  if (target < 0 || target >= tags.value.length) return;

  const order = tags.value.map((tag) => tag.id);
  const [moved] = order.splice(index, 1);
  order.splice(target, 0, moved!);

  try {
    const result = await request<ActivityTagsResponse>('/activity-tags/reorder', {
      method: 'POST',
      body: { order },
    });
    tags.value = result.tags;
  } catch (cause) {
    error.value = messageOf(cause, 'تغییر ترتیب انجام نشد.');
  }
}

// ── Deletion ────────────────────────────────────────────────────────────────

const deleting = ref<ActivityTagView | null>(null);

async function confirmDelete(): Promise<void> {
  const tag = deleting.value;
  if (tag === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<{ deleted: true }>(`/activity-tags/${tag.id}`, { method: 'DELETE' });
    deleting.value = null;
    notice.value = `تفریح «${tag.nameFa}» حذف شد.`;
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'حذف انجام نشد.');
  } finally {
    acting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-5">
    <section class="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
      <p>
        فهرست تفریحاتی که میزبان‌ها فعالیت خود را زیر آن ثبت می‌کنند. افزودن، ویرایش، مرتب‌سازی و
        فعال/غیرفعال کردن از همین‌جا انجام می‌شود و به استقرار تازه نیاز ندارد.
      </p>
      <p class="mt-2 text-ink-soft">
        شناسه (<bdi class="font-mono">slug</bdi>) پس از ساخت قابل تغییر نیست؛ کد، اسکریپت‌های
        داده‌گذاری و مستندات با همین شناسه به ردیف ارجاع می‌دهند. برای بازنشسته کردن یک تفریح،
        به‌جای حذف آن را غیرفعال کنید تا فعالیت‌های ثبت‌شده دست‌نخورده بمانند.
      </p>
      <p class="mt-2 text-ink-soft">
        گزینهٔ «عنوان دلخواه» همان رفتار «سایر» است: میزبان می‌تواند نوع تفریح خود را بنویسد و آن
        متن مثل عنوان فعالیت از فیلتر واژگان ممنوع عبور می‌کند.
      </p>
    </section>

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <div class="flex justify-end">
      <button
        type="button"
        class="rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-40"
        :disabled="!session.canMutate"
        @click="openNew"
      >
        تفریح تازه
      </button>
    </div>

    <StateBlock :state="state" :error-text="error" :rows="8" @retry="load">
      <section class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[52rem] text-sm">
          <thead class="border-b border-line text-start text-xs text-ink-faint">
            <tr>
              <th class="px-4 py-3 text-start">تفریح</th>
              <th class="px-4 py-3 text-start">شناسه</th>
              <th class="px-4 py-3 text-start">شهرها</th>
              <th class="px-4 py-3 text-start">فعالیت‌ها</th>
              <th class="px-4 py-3 text-start">وضعیت</th>
              <th class="px-4 py-3 text-end">ترتیب و اقدام</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(tag, index) in tags"
              :key="tag.id"
              class="border-b border-line last:border-0"
            >
              <td class="px-4 py-3">
                <span class="me-1">{{ tag.icon }}</span>
                <span class="font-medium">{{ tag.nameFa }}</span>
                <span
                  v-if="tag.allowsCustomLabel"
                  class="ms-2 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
                >
                  عنوان دلخواه
                </span>
              </td>
              <td class="px-4 py-3">
                <bdi class="font-mono text-xs">{{ tag.slug }}</bdi>
              </td>
              <td class="px-4 py-3 text-xs text-ink-soft">{{ scopeLabel(tag) }}</td>
              <td class="px-4 py-3 tabular-nums text-xs">
                <bdi>{{ formatNumber(tag.eventCount) }}</bdi>
              </td>
              <td class="px-4 py-3">
                <button
                  type="button"
                  class="rounded-full px-2 py-0.5 text-xs disabled:opacity-40"
                  :class="tag.isActive ? 'bg-good-soft text-good' : 'bg-line text-ink-faint'"
                  :disabled="!session.canMutate"
                  @click="toggleActive(tag)"
                >
                  {{ tag.isActive ? 'فعال' : 'غیرفعال' }}
                </button>
              </td>
              <td class="px-4 py-3 text-end">
                <div class="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    class="text-ink-soft disabled:opacity-30"
                    :disabled="!session.canMutate || index === 0"
                    title="بالاتر"
                    @click="move(index, -1)"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="text-ink-soft disabled:opacity-30"
                    :disabled="!session.canMutate || index === tags.length - 1"
                    title="پایین‌تر"
                    @click="move(index, 1)"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="text-brand disabled:opacity-40"
                    :disabled="!session.canMutate"
                    @click="openEdit(tag)"
                  >
                    ویرایش
                  </button>
                  <button
                    type="button"
                    class="text-danger disabled:opacity-30"
                    :disabled="!session.canMutate || tag.eventCount > 0"
                    :title="
                      tag.eventCount > 0
                        ? 'این تفریح در فعالیت‌های ثبت‌شده استفاده شده است؛ آن را غیرفعال کنید.'
                        : 'حذف'
                    "
                    @click="deleting = tag"
                  >
                    حذف
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </StateBlock>
  </div>

  <!-- ── The editor ──────────────────────────────────────────────────────── -->
  <div
    v-if="draft !== null"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
  >
    <div class="w-full max-w-lg overflow-y-auto rounded-xl bg-surface-raised p-5 shadow-lg">
      <h2 class="mb-4 text-sm font-semibold">
        {{ draft.id === null ? 'تفریح تازه' : `ویرایش ${draft.nameFa}` }}
      </h2>

      <div class="flex flex-col gap-3 text-sm">
        <label class="flex flex-col gap-1">
          <span class="text-ink-soft">نام فارسی</span>
          <input
            v-model="draft.nameFa"
            type="text"
            maxlength="60"
            class="min-h-9 rounded-lg border border-line bg-surface px-2"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-ink-soft">
            شناسه
            <span v-if="draft.id !== null" class="text-xs text-ink-faint">
              (پس از ساخت قابل تغییر نیست)
            </span>
          </span>
          <input
            v-model="draft.slug"
            type="text"
            dir="ltr"
            maxlength="48"
            placeholder="cafe-hopping"
            :disabled="draft.id !== null"
            class="min-h-9 rounded-lg border border-line bg-surface px-2 font-mono text-xs disabled:opacity-50"
          />
          <span
            v-if="draft.id === null && draft.slug !== '' && !SLUG_PATTERN.test(draft.slug.trim())"
            class="text-xs text-danger"
          >
            فقط حروف کوچک انگلیسی، رقم و خط تیرهٔ تکی.
          </span>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-ink-soft">آیکون (اموجی، اختیاری)</span>
          <input
            v-model="draft.icon"
            type="text"
            maxlength="16"
            placeholder="☕"
            class="min-h-9 rounded-lg border border-line bg-surface px-2"
          />
        </label>

        <label class="flex items-center gap-2">
          <input v-model="draft.isActive" type="checkbox" />
          <span>فعال — در فهرست انتخاب کاربران دیده می‌شود</span>
        </label>

        <label class="flex items-center gap-2">
          <input v-model="draft.allowsCustomLabel" type="checkbox" />
          <span>عنوان دلخواه — میزبان نوع تفریح خود را می‌نویسد («سایر»)</span>
        </label>

        <fieldset class="rounded-lg border border-line p-3">
          <legend class="px-1 text-xs text-ink-soft">در کدام شهرها ارائه شود</legend>

          <label class="flex items-center gap-2">
            <input v-model="draft.everywhere" type="radio" :value="true" />
            <span>همهٔ شهرها</span>
          </label>
          <label class="mt-1 flex items-center gap-2">
            <input v-model="draft.everywhere" type="radio" :value="false" />
            <span>فقط شهرهای انتخاب‌شده</span>
          </label>

          <div v-if="!draft.everywhere" class="mt-3 flex flex-col gap-2">
            <div class="flex gap-2">
              <select
                v-model="scopeProvinceId"
                class="min-h-9 flex-1 rounded-lg border border-line bg-surface px-2 text-xs"
              >
                <option value="">همهٔ استان‌ها</option>
                <option
                  v-for="province in places.provinces"
                  :key="province.id"
                  :value="province.id"
                >
                  {{ province.nameFa }}
                </option>
              </select>
              <input
                v-model="scopeQuery"
                type="search"
                placeholder="جست‌وجوی شهر"
                class="min-h-9 flex-1 rounded-lg border border-line bg-surface px-2 text-xs"
              />
            </div>

            <p class="text-xs text-ink-faint">
              انتخاب‌شده: <bdi>{{ formatNumber(draft.cityIds.length) }}</bdi> شهر
            </p>

            <!--
              Capped at 200 rows. A province filter or a search narrows to that;
              rendering 1,252 checkboxes would make the dialog the slowest screen
              in the panel for a case nobody wants (restricting a tag to every
              city is what «همهٔ شهرها» is for).
            -->
            <div class="max-h-56 overflow-y-auto rounded-lg border border-line">
              <label
                v-for="city in scopeCities.slice(0, 200)"
                :key="city.id"
                class="flex items-center gap-2 border-b border-line px-2 py-1 text-xs last:border-0"
              >
                <input
                  type="checkbox"
                  :checked="draft.cityIds.includes(city.id)"
                  @change="toggleCity(city.id)"
                />
                <span>{{ city.nameFa }}</span>
                <span v-if="!city.isActive" class="text-ink-faint">(غیرفعال)</span>
              </label>
              <p v-if="scopeCities.length === 0" class="px-2 py-3 text-xs text-ink-faint">
                شهری با این فیلتر پیدا نشد.
              </p>
              <p v-else-if="scopeCities.length > 200" class="px-2 py-2 text-xs text-ink-faint">
                {{ formatNumber(scopeCities.length - 200) }} شهر دیگر — با استان یا جست‌وجو محدودتر
                کنید.
              </p>
            </div>
          </div>
        </fieldset>

        <p v-if="actionError" class="text-xs text-danger">{{ actionError }}</p>

        <div class="mt-2 flex justify-end gap-3">
          <button type="button" class="text-ink-soft" @click="draft = null">انصراف</button>
          <button
            type="button"
            class="rounded-lg bg-brand px-4 py-2 text-white disabled:opacity-40"
            :disabled="acting || !draftValid"
            @click="save"
          >
            ذخیره
          </button>
        </div>
      </div>
    </div>
  </div>

  <ConfirmDialog
    :open="deleting !== null"
    :title="deleting ? `حذف ${deleting.nameFa}` : ''"
    body="این تفریح از فهرست حذف می‌شود. علاقه‌مندی‌های زیر آن بدون دسته باقی می‌مانند و محدودیت‌های شهری آن پاک می‌شود."
    confirm-label="حذف"
    tone="danger"
    :busy="acting"
    :error="actionError"
    @cancel="deleting = null"
    @confirm="confirmDelete"
  />
</template>
