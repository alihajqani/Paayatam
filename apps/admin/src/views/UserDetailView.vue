<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  PERMISSIONS,
  foldedIncludes,
  type AdminPlacesResponse,
  type AdminUpdateProfileRequest,
  type AdminUserDetailView,
  type ProfileView,
  type SetUserStatusRequest,
} from '@payetam/shared';
import { messageOf, newIdempotencyKey, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatNumber, formatTrust, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * One account, from every angle a support conversation asks about.
 *
 * **What is not here is the point.** There is no Telegram id, no `@username` and
 * no phone number, because the API does not project them and no relation reaches
 * `telegram_account` (invariant 7). The one time an identity is genuinely needed
 * is a break-glass unseal, which requires an open case and a written reason
 * (T14) — and that is a different screen for a reason.
 *
 * The bio arrives with contact details already masked. The leak scan found that
 * the day this screen was added: a user who typed their number into their bio has
 * not consented to hand it to staff, and `user.read` is held by `SUPPORT`, which
 * is the role most exposed to social engineering.
 */
const route = useRoute();
const session = useSessionStore();

const detail = ref<AdminUserDetailView | null>(null);
const error = ref<string | null>(null);

const publicId = computed(() => String(route.params.publicId));
const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  return detail.value === null ? ('loading' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    detail.value = await request<AdminUserDetailView>(`/users/${publicId.value}`);
  } catch (cause) {
    error.value = messageOf(cause, 'پروندهٔ کاربر بارگذاری نشد.');
  }
}

// ── Suspending or banning ───────────────────────────────────────────────────

const pendingStatus = ref<SetUserStatusRequest['status'] | null>(null);
const acting = ref(false);
const actionError = ref<string | null>(null);
const notice = ref<string | null>(null);

const STATUS_ACTIONS: Array<{
  status: SetUserStatusRequest['status'];
  label: string;
  body: string;
  tone: 'danger' | 'default';
}> = [
  {
    status: 'SUSPENDED',
    label: 'تعلیق حساب',
    body: 'کاربر تا رفع تعلیق نمی‌تواند فعالیت تازه‌ای انجام دهد. این کار برگشت‌پذیر است.',
    tone: 'danger',
  },
  {
    status: 'BANNED',
    label: 'مسدودسازی حساب',
    body: 'دسترسی کاربر به‌طور کامل بسته می‌شود و کد دعوت او نیز از کار می‌افتد. این کار توسط یک مدیر قابل بازگردانی است، اما تأثیر آن فوری است.',
    tone: 'danger',
  },
  { status: 'ACTIVE', label: 'بازگرداندن حساب', body: 'حساب دوباره فعال می‌شود.', tone: 'default' },
];

const pendingAction = computed(() =>
  STATUS_ACTIONS.find((action) => action.status === pendingStatus.value),
);

async function applyStatus(reason: string): Promise<void> {
  if (pendingStatus.value === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<void>(`/users/${publicId.value}/status`, {
      method: 'POST',
      body: { status: pendingStatus.value, reason },
    });
    pendingStatus.value = null;
    notice.value = 'وضعیت حساب تغییر کرد و در گزارش رخدادها ثبت شد.';
    // Re-read rather than patch locally: the server is what decided, and a
    // screen that assumes the outcome is a screen that disagrees with it after
    // the first refusal.
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'تغییر وضعیت انجام نشد.');
  } finally {
    acting.value = false;
  }
}

// ── Hand-written adjustments (ADR-0007, ADR-0010) ───────────────────────────

/**
 * Moving a balance or a score by hand.
 *
 * `coin.adjust` is held by `SUPER_ADMIN` alone and deliberately not by
 * `SUPPORT` — the role most exposed to "please just put the coins back" is the
 * one that must not be able to. The panel hides the form for anybody else and the
 * service refuses it regardless.
 *
 * **The `reference` is an idempotency key generated once per intent**, not per
 * click: the API derives `admin-adjust:{reference}` and `coin_ledger` has a
 * UNIQUE on it, so a retried request over a dropped connection is one adjustment
 * rather than two. Regenerating it on each attempt would defeat exactly the thing
 * it exists for.
 *
 * Nothing here writes a balance. The movement goes through `CoinService` into the
 * append-only ledger like every other coin in the product, which is why the
 * result can be shown as before → after with confidence.
 */
type Adjustment = 'coins' | 'trust';

const adjusting = ref<Adjustment | null>(null);
const adjustAmount = ref(0);
const adjustReason = ref('');
const adjustReference = ref('');
const adjustBusy = ref(false);
const adjustError = ref<string | null>(null);
const adjustResult = ref<{ kind: Adjustment; before: number | null; after: number } | null>(null);

function openAdjust(kind: Adjustment): void {
  adjusting.value = kind;
  adjustAmount.value = 0;
  adjustReason.value = '';
  // One key for one intention, held for as long as the form is open.
  adjustReference.value = newIdempotencyKey();
  adjustError.value = null;
  adjustResult.value = null;
}

const adjustValid = computed(
  () =>
    Number.isInteger(adjustAmount.value) &&
    adjustAmount.value !== 0 &&
    adjustReason.value.trim().length >= 5,
);

async function submitAdjust(): Promise<void> {
  if (adjusting.value === null || !adjustValid.value) return;
  adjustBusy.value = true;
  adjustError.value = null;
  const kind = adjusting.value;
  const before =
    kind === 'coins' ? (detail.value?.coinBalance ?? 0) : (detail.value?.trustScore ?? null);

  try {
    if (kind === 'coins') {
      const result = await request<{ balance: number }>('/coins/adjust', {
        method: 'POST',
        body: {
          userPublicId: publicId.value,
          amount: adjustAmount.value,
          reason: adjustReason.value.trim(),
          reference: adjustReference.value,
        },
      });
      adjustResult.value = { kind, before, after: result.balance };
    } else {
      const result = await request<{ score: number }>('/trust/adjust', {
        method: 'POST',
        body: {
          userPublicId: publicId.value,
          delta: adjustAmount.value,
          reason: adjustReason.value.trim(),
          reference: adjustReference.value,
        },
      });
      adjustResult.value = { kind, before, after: result.score };
    }
    adjusting.value = null;
    await load();
  } catch (cause) {
    adjustError.value = messageOf(cause, 'اصلاح انجام نشد.');
  } finally {
    adjustBusy.value = false;
  }
}

// ── Correcting the profile (M22 phase 2) ────────────────────────────────────

/**
 * Editing somebody else's profile, behind `user.profile.edit`.
 *
 * `SUPPORT` holds `user.read` and deliberately **not** this: reading a record and
 * rewriting it are different acts, and the role most exposed to "please just
 * change it for me" is the one that must not be able to. The panel hides the
 * button for anybody else and the service refuses it regardless — hiding a button
 * is a courtesy, not a control.
 *
 * The form sends a **diff**, like the Mini App's own edit screen: an absent field
 * is left alone, so a moderator fixing a display name cannot blank a bio they
 * never looked at.
 *
 * ── Why the city picker is conditional ───────────────────────────────────────
 *
 * Changing somebody's city needs the city list, and that list is behind
 * `catalog.manage`. Rather than widen either permission so one screen can borrow
 * the other's data, the control simply is not offered to a session that cannot
 * read the list. In practice both keys sit with `SUPER_ADMIN`, so the case is
 * rare — and when it happens, an absent control is a better answer than a select
 * with nothing in it.
 */
const editing = ref(false);
const editBusy = ref(false);
const editError = ref<string | null>(null);
const editReason = ref('');
const editForm = ref({
  displayName: '',
  gender: '' as '' | 'MALE' | 'FEMALE' | 'PREFER_NOT_SAY',
  birthYear: '' as number | '',
  cityId: '',
  districtId: '',
  bio: '',
});

const places = ref<AdminPlacesResponse | null>(null);
const citySearch = ref('');

const canEditProfile = computed(() => session.can(PERMISSIONS.USER_PROFILE_EDIT));
const canPickCity = computed(() => canEditProfile.value && session.can(PERMISSIONS.CATALOG_MANAGE));

/** Active cities only, filtered by the same folding the Mini App's picker uses. */
const cityOptions = computed(() => {
  const all = (places.value?.cities ?? []).filter((city) => city.isActive);
  const matched =
    citySearch.value.trim() === ''
      ? all
      : all.filter((city) => foldedIncludes(city.nameFa, citySearch.value));
  return matched.slice(0, 80);
});

async function openEdit(): Promise<void> {
  if (!detail.value) return;
  editError.value = null;
  editReason.value = '';
  editForm.value = {
    displayName: detail.value.displayName ?? '',
    gender: '',
    birthYear: detail.value.birthYear ?? '',
    cityId: '',
    districtId: '',
    // Deliberately blank rather than pre-filled: `detail.bio` arrives with contact
    // details already masked («حذف شد»), so pre-filling it and saving would write
    // the *mask* back over the user's own words. An admin who wants to clear a bio
    // ticks the box below; one who wants to rewrite it types the whole thing.
    bio: '',
  };
  editing.value = true;

  if (canPickCity.value && places.value === null) {
    try {
      places.value = await request<AdminPlacesResponse>('/places');
    } catch {
      // A picker that could not load is a picker that is not offered. The rest of
      // the form still works, which is the point of failing quietly here.
      places.value = { provinces: [], cities: [] };
    }
  }
}

const clearBio = ref(false);

const editValid = computed(() => editReason.value.trim().length >= 3);

/** Only what the operator actually changed. An empty diff is not a request. */
function buildProfilePatch(): AdminUpdateProfileRequest | null {
  if (!detail.value) return null;
  const body: Record<string, unknown> = { reason: editReason.value.trim() };

  const name = editForm.value.displayName.trim();
  if (name !== '' && name !== detail.value.displayName) body['displayName'] = name;
  if (editForm.value.gender !== '') body['gender'] = editForm.value.gender;
  if (editForm.value.birthYear !== '' && editForm.value.birthYear !== detail.value.birthYear) {
    body['birthYear'] = editForm.value.birthYear;
  }
  if (editForm.value.cityId !== '') body['cityId'] = editForm.value.cityId;
  if (editForm.value.districtId !== '') body['districtId'] = editForm.value.districtId;
  if (clearBio.value) body['bio'] = null;
  else if (editForm.value.bio.trim() !== '') body['bio'] = editForm.value.bio.trim();

  return Object.keys(body).length > 1 ? (body as AdminUpdateProfileRequest) : null;
}

async function submitProfileEdit(): Promise<void> {
  if (editBusy.value || !editValid.value) return;
  const body = buildProfilePatch();
  if (!body) {
    editError.value = 'هیچ تغییری وارد نشده است.';
    return;
  }

  editBusy.value = true;
  editError.value = null;
  try {
    await request<{ profile: ProfileView }>(`/users/${publicId.value}/profile`, {
      method: 'PATCH',
      body,
    });
    editing.value = false;
    clearBio.value = false;
    notice.value = 'پروفایل کاربر اصلاح شد و در گزارش رخدادها ثبت شد.';
    // Re-read rather than patch locally: the panel's view of a user is a
    // projection the server builds, and half of it (the masked bio) is not
    // derivable from what was sent.
    await load();
  } catch (cause) {
    editError.value = messageOf(cause, 'اصلاح پروفایل انجام نشد.');
  } finally {
    editBusy.value = false;
  }
}

/** «۳ درخواست پذیرفته‌شده، ۱ عدم حضور» — the sparse tally, rendered. */
const participationRows = computed(() =>
  Object.entries(detail.value?.participations ?? {}).sort(([a], [b]) => a.localeCompare(b)),
);

onMounted(load);
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="5" @retry="load">
    <div v-if="detail" class="flex flex-col gap-5">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3">
            <h1 class="text-xl font-bold">{{ detail.displayName ?? 'بدون نام' }}</h1>
            <StatusPill :value="detail.status" />
          </div>
          <bdi class="mt-1 block font-mono text-xs text-ink-faint">{{ detail.publicId }}</bdi>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            v-if="session.can(PERMISSIONS.COIN_ADJUST)"
            type="button"
            class="min-h-10 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
            :disabled="!session.canMutate"
            @click="openAdjust('coins')"
          >
            اصلاح موجودی سکه
          </button>
          <button
            v-if="session.can(PERMISSIONS.TRUST_ADJUST)"
            type="button"
            class="min-h-10 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
            :disabled="!session.canMutate"
            @click="openAdjust('trust')"
          >
            اصلاح امتیاز اعتماد
          </button>
          <button
            v-if="canEditProfile"
            type="button"
            class="min-h-10 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
            :disabled="!session.canMutate"
            @click="openEdit"
          >
            اصلاح پروفایل
          </button>
        </div>

        <div v-if="session.can(PERMISSIONS.USER_BAN)" class="flex flex-wrap gap-2">
          <button
            v-for="action in STATUS_ACTIONS.filter((entry) => entry.status !== detail?.status)"
            :key="action.status"
            type="button"
            class="min-h-10 rounded-lg border px-3 text-sm disabled:opacity-40"
            :class="
              action.tone === 'danger' ? 'border-danger text-danger' : 'border-line text-ink-soft'
            "
            :disabled="!session.canMutate"
            @click="pendingStatus = action.status"
          >
            {{ action.label }}
          </button>
        </div>
      </header>

      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <!--
        Before → after, from the server's own answer. The movement went through
        `CoinService` into the append-only ledger like every other coin, so this
        is a fact rather than an optimistic guess.
      -->
      <p
        v-if="adjustResult"
        class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good"
        role="status"
      >
        {{ adjustResult.kind === 'coins' ? 'موجودی سکه' : 'امتیاز اعتماد' }} از
        <bdi class="tabular-nums">{{
          adjustResult.before === null ? '—' : formatNumber(adjustResult.before)
        }}</bdi>
        به <bdi class="tabular-nums">{{ formatNumber(adjustResult.after) }}</bdi> تغییر کرد و یک
        ردیف تازه در دفتر ثبت شد.
      </p>

      <!-- ── The adjustment form ──────────────────────────────────────── -->
      <section v-if="adjusting !== null" class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">
          {{ adjusting === 'coins' ? 'اصلاح دستی موجودی سکه' : 'اصلاح دستی امتیاز اعتماد' }}
        </h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          این تغییر مثل هر تغییر دیگری یک ردیف تازه در دفتر می‌سازد و چیزی را بازنویسی نمی‌کند. عدد
          می‌تواند منفی باشد. دلیل الزامی است و در گزارش رخدادها ثبت می‌شود.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">
              {{ adjusting === 'coins' ? 'مقدار سکه (+ یا −)' : 'تغییر امتیاز (+ یا −)' }}
            </span>
            <input
              v-model.number="adjustAmount"
              type="number"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">دلیل (دست‌کم ۵ نویسه)</span>
            <input
              v-model="adjustReason"
              type="text"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
        </div>

        <p class="mt-2 text-xs text-ink-faint">
          کلید یکتای این اصلاح: <bdi class="font-mono">{{ adjustReference }}</bdi> — اگر ارتباط قطع
          شود و دوباره بفرستید، همین یک اصلاح ثبت می‌شود.
        </p>

        <p v-if="adjustError" class="mt-3 text-sm text-danger" role="alert">{{ adjustError }}</p>

        <div class="mt-4 flex gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="!adjustValid || adjustBusy"
            @click="submitAdjust"
          >
            {{ adjustBusy ? 'در حال ثبت…' : 'ثبت اصلاح' }}
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm"
            @click="adjusting = null"
          >
            انصراف
          </button>
        </div>
      </section>

      <!-- ── Correcting the profile (M22 phase 2) ─────────────────────── -->
      <section v-if="editing" class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">اصلاح پروفایل کاربر</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          فقط فیلدهایی که پر می‌کنید تغییر می‌کنند؛ بقیه دست‌نخورده می‌مانند. دلیل الزامی است و
          همراه مقدار پیشین و تازه در گزارش رخدادها ثبت می‌شود. سن زیر ۱۸ سال از این‌جا هم پذیرفته
          نمی‌شود.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">نام نمایشی</span>
            <input
              v-model="editForm.displayName"
              type="text"
              maxlength="40"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">سال تولد (میلادی)</span>
            <input
              v-model.number="editForm.birthYear"
              type="number"
              min="1900"
              max="2200"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">جنسیت</span>
            <select
              v-model="editForm.gender"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            >
              <option value="">بدون تغییر</option>
              <option value="FEMALE">زن</option>
              <option value="MALE">مرد</option>
              <option value="PREFER_NOT_SAY">ترجیح می‌دهد نگوید</option>
            </select>
          </label>

          <template v-if="canPickCity">
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">جست‌وجوی شهر</span>
              <input
                v-model="citySearch"
                type="search"
                class="min-h-10 rounded-lg border border-line bg-surface px-3"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">شهر</span>
              <select
                v-model="editForm.cityId"
                class="min-h-10 rounded-lg border border-line bg-surface px-3"
              >
                <option value="">بدون تغییر</option>
                <option v-for="city in cityOptions" :key="city.id" :value="city.id">
                  {{ city.nameFa }}
                </option>
              </select>
            </label>
          </template>

          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">دربارهٔ من — بازنویسی کامل (اختیاری)</span>
            <textarea
              v-model="editForm.bio"
              rows="3"
              maxlength="300"
              placeholder="خالی بگذارید تا دست‌نخورده بماند"
              class="rounded-lg border border-line bg-surface p-3"
            ></textarea>
            <!--
              Not pre-filled on purpose: what the panel shows is the *masked* bio,
              and saving that back would replace the user's own words with «حذف شد».
            -->
            <span class="text-xs text-ink-faint">
              متن نمایش‌داده‌شده در این صفحه ماسک‌شده است، پس این کادر خالی باز می‌شود. برای پاک
              کردن کامل، گزینهٔ زیر را بزنید.
            </span>
          </label>

          <label class="flex items-center gap-2 sm:col-span-2">
            <input v-model="clearBio" type="checkbox" class="size-4" />
            <span class="text-sm text-ink-soft">دربارهٔ من پاک شود</span>
          </label>

          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">دلیل (دست‌کم ۳ نویسه)</span>
            <input
              v-model="editReason"
              type="text"
              maxlength="280"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
        </div>

        <p v-if="editError" class="mt-2 text-sm text-danger" role="alert">{{ editError }}</p>

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="!editValid || editBusy"
            @click="submitProfileEdit"
          >
            {{ editBusy ? 'در حال ثبت…' : 'ثبت اصلاح' }}
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm"
            @click="editing = false"
          >
            انصراف
          </button>
        </div>
      </section>

      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">امتیاز اعتماد</p>
          <p class="mt-1 text-xl font-bold">{{ formatTrust(detail.trustScore) }}</p>
        </article>
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">موجودی سکه</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <bdi>{{ formatNumber(detail.coinBalance) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(detail.coins.granted) }}</bdi> دریافتی،
            <bdi>{{ formatNumber(detail.coins.spent) }}</bdi> خرج‌شده در
            <bdi>{{ formatNumber(detail.coins.entries) }}</bdi> تراکنش
          </p>
        </article>
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">فعالیت‌های میزبانی‌شده</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <bdi>{{ formatNumber(detail.events.hosted) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(detail.events.published) }}</bdi> منتشر شده
          </p>
        </article>
        <article
          class="rounded-xl border p-4"
          :class="detail.reportsAgainst > 0 ? 'border-warn bg-warn-soft' : 'border-line bg-surface'"
        >
          <p class="text-sm text-ink-soft">گزارش‌های تخلف</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <bdi>{{ formatNumber(detail.reportsAgainst) }}</bdi> علیه این حساب
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(detail.reportsFiled) }}</bdi> گزارش ثبت‌شده توسط او
          </p>
        </article>
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">پروفایل</h2>
          <dl class="mt-3 flex flex-col gap-2 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">شهر</dt>
              <dd>{{ detail.cityNameFa ?? '—' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">منطقه</dt>
              <dd>{{ detail.districtNameFa ?? '—' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">سال تولد</dt>
              <dd>
                <bdi>{{ detail.birthYear ? toPersianDigits(detail.birthYear) : '—' }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">مرحلهٔ عضویت</dt>
              <dd>
                <bdi class="font-mono text-xs">{{ detail.onboardingState }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">تاریخ عضویت</dt>
              <dd>{{ formatDate(detail.createdAt) }}</dd>
            </div>
          </dl>

          <div v-if="detail.bio" class="mt-4 border-t border-line pt-3">
            <p class="text-sm text-ink-soft">دربارهٔ کاربر</p>
            <p class="mt-1 text-sm leading-relaxed">{{ detail.bio }}</p>
            <!--
              Said out loud, because a moderator who sees «حذف شد» without this
              line cannot tell masking from a user who wrote it themselves.
            -->
            <p v-if="detail.bioRedactions > 0" class="mt-2 text-xs text-ink-faint">
              <bdi>{{ toPersianDigits(detail.bioRedactions) }}</bdi>
              مورد اطلاعات تماس در این متن پنهان شده است. کاربر رضایتی برای در اختیار گذاشتن آن‌ها
              به تیم نداده است.
            </p>
          </div>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">درخواست‌های شرکت</h2>
          <ul v-if="participationRows.length > 0" class="mt-3 flex flex-col gap-2">
            <li
              v-for="[status, count] in participationRows"
              :key="status"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <StatusPill :value="status" />
              <bdi class="tabular-nums">{{ formatNumber(count) }}</bdi>
            </li>
          </ul>
          <p v-else class="mt-3 text-sm text-ink-faint">هنوز درخواستی ثبت نکرده است.</p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">معرفی دوستان</h2>
          <dl class="mt-3 flex flex-col gap-2 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">دعوت‌های ثبت‌شده</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(detail.referrals.made) }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">واجد شرایط</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(detail.referrals.qualified) }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">رد شده</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(detail.referrals.rejected) }}</bdi>
              </dd>
            </div>
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-soft">خودش با کد دعوت آمده؟</dt>
              <dd>
                <StatusPill
                  v-if="detail.referrals.receivedStatus"
                  :value="detail.referrals.receivedStatus"
                />
                <span v-else class="text-ink-faint">خیر</span>
              </dd>
            </div>
          </dl>

          <div class="mt-4 border-t border-line pt-3 text-sm">
            <p class="text-ink-soft">کدهای هدیه</p>
            <p class="mt-1">
              <bdi class="tabular-nums">{{ formatNumber(detail.giftCodeRedemptions.count) }}</bdi>
              دریافت، مجموعاً
              <bdi class="tabular-nums">{{ formatNumber(detail.giftCodeRedemptions.coins) }}</bdi>
              سکه
            </p>
          </div>
        </article>
      </section>
      <p v-if="session.can(PERMISSIONS.LEDGER_READ)" class="text-sm">
        <RouterLink
          :to="{ name: 'ledger', query: { userPublicId: detail.publicId } }"
          class="text-brand"
        >
          دیدن دفتر سکهٔ این کاربر ←
        </RouterLink>
      </p>
    </div>
  </StateBlock>

  <ConfirmDialog
    :open="pendingStatus !== null"
    :title="pendingAction?.label ?? ''"
    :body="pendingAction?.body ?? ''"
    :confirm-label="pendingAction?.label ?? 'تأیید'"
    :tone="pendingAction?.tone ?? 'default'"
    reason-label="دلیل این تصمیم (در گزارش رخدادها ثبت می‌شود)"
    :busy="acting"
    :error="actionError"
    @cancel="pendingStatus = null"
    @confirm="applyStatus"
  />
</template>
