<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AppSettingView, AppSettingsResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import { formatNumber } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Every tunable number in the product (§11).
 *
 * §11's heading is *"all in `app_setting`, runtime-changeable"*, and M17 seeded
 * the rows so an operator could **find** them. This is the screen that makes them
 * changeable without `psql`.
 *
 * **There is no free-form key.** The list comes from the code catalogue and the
 * service refuses anything not in it, so there is no arbitrary-key write and no
 * path that could become an "edit any environment variable" screen. Secrets are
 * not here at all: they are environment variables the process reads at boot, and
 * `app_setting` has never held one.
 *
 * Each row shows its **default** beside its current value, so «تغییر داده‌شده» is
 * something the screen can say rather than something an operator has to remember
 * §11 for. A change needs a reason, which lands in `audit_log`: a policy number
 * changed in production with nothing recording why is what invariant 12 exists to
 * prevent.
 *
 * **When it takes effect** is stated per group, because it genuinely differs.
 * `SettingsService` reads through to the database on every call, so most of these
 * are live on the next request — but two things do not: the rate-limit buckets
 * are deliberately compile-time constants (`RATE_LIMITS`, and the reason is in
 * that file), and anything a long-lived job has already read stays read until its
 * next tick.
 */
const session = useSessionStore();

const rows = ref<AppSettingView[]>([]);
const error = ref<string | null>(null);
const loaded = ref(false);
const notice = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    const result = await request<AppSettingsResponse>('/settings');
    rows.value = result.settings;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'تنظیمات بارگذاری نشد.');
  }
}

/**
 * Grouped by the prefix the key already carries.
 *
 * The grouping is derived rather than declared, so a key added to
 * `SETTING_DEFAULTS` appears here without anybody editing this file — and a new
 * *prefix* appears as its own group under its own name rather than being dropped.
 */
const GROUP_LABELS: Record<string, string> = {
  economy: 'اقتصاد و پاداش‌ها',
  trust: 'امتیاز اعتماد',
  referral: 'معرفی دوستان',
  giftcode: 'کدهای هدیه',
  profile: 'پروفایل',
  events: 'فعالیت‌ها',
  participation: 'درخواست‌های شرکت',
  waitlist: 'لیست انتظار',
  cancellation: 'لغو و جریمه',
  channel: 'کانال تلگرام',
  moderation: 'بررسی و تأیید',
  ranking: 'وزن‌های رتبه‌بندی',
};

const groups = computed(() => {
  const buckets = new Map<string, AppSettingView[]>();
  for (const row of rows.value) {
    const prefix = row.key.split('.')[0] ?? 'other';
    buckets.set(prefix, [...(buckets.get(prefix) ?? []), row]);
  }
  return [...buckets.entries()].map(([prefix, settings]) => ({
    prefix,
    label: GROUP_LABELS[prefix] ?? prefix,
    settings,
  }));
});

// ── Changing one ────────────────────────────────────────────────────────────

const editing = ref<AppSettingView | null>(null);
const draft = ref(0);
const acting = ref(false);
const actionError = ref<string | null>(null);

function open(setting: AppSettingView): void {
  editing.value = setting;
  draft.value = setting.value;
  actionError.value = null;
}

/**
 * Integer where the default is an integer.
 *
 * The same rule the service enforces, checked before the request: a coin amount
 * that arrives as 12.5 is a corrupted ledger rather than a rounding question, and
 * a ranking weight that has to be whole would be a weight of 0 or 1.
 */
const draftValid = computed(() => {
  const setting = editing.value;
  if (setting === null) return false;
  if (!Number.isFinite(draft.value) || draft.value < 0) return false;
  return Number.isInteger(setting.defaultValue) ? Number.isInteger(draft.value) : true;
});

async function save(reason: string): Promise<void> {
  if (editing.value === null || !draftValid.value) return;
  acting.value = true;
  actionError.value = null;
  const key = editing.value.key;
  try {
    await request<AppSettingView>(`/settings/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: { value: draft.value, reason },
    });
    editing.value = null;
    notice.value = `«${key}» ذخیره شد و تغییر در گزارش رخدادها ثبت شد.`;
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'ذخیرهٔ تنظیم انجام نشد.');
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
        هر عددی که سیاست محصول را تعیین می‌کند اینجاست و از همین‌جا قابل تغییر است. کلیدها ثابت‌اند
        و از فهرست کد می‌آیند — امکان افزودن کلید دلخواه وجود ندارد و هیچ متغیر محیطی یا رمزی در این
        جدول نگه‌داری نمی‌شود.
      </p>
      <p class="mt-2 text-ink-soft">
        بیشتر این مقادیر از درخواست بعدی اثر می‌گذارند. دو استثنا: سقف‌های تعداد درخواست (<bdi
          class="font-mono"
          >RATE_LIMITS</bdi
        >) عمداً در کد ثابت‌اند و با استقرار تغییر می‌کنند، و کارهای زمان‌بندی‌شده مقداری را که
        خوانده‌اند تا اجرای بعدی نگه می‌دارند.
      </p>
    </section>

    <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
      {{ notice }}
    </p>

    <StateBlock :state="state" :error-text="error" :rows="8" @retry="load">
      <div class="flex flex-col gap-5">
        <section
          v-for="group in groups"
          :key="group.prefix"
          class="overflow-x-auto rounded-xl border border-line bg-surface"
        >
          <h2 class="border-b border-line px-4 py-3 text-sm font-semibold">{{ group.label }}</h2>
          <table class="w-full min-w-[40rem] text-sm">
            <tbody>
              <tr
                v-for="setting in group.settings"
                :key="setting.key"
                class="border-b border-line last:border-0"
              >
                <td class="px-4 py-3">
                  <bdi class="font-mono text-xs">{{ setting.key }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi class="font-bold">{{ formatNumber(setting.value) }}</bdi>
                  <span
                    v-if="setting.overridden"
                    class="ms-2 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
                  >
                    تغییر داده‌شده
                  </span>
                </td>
                <td class="px-4 py-3 text-xs text-ink-faint">
                  پیش‌فرض: <bdi>{{ formatNumber(setting.defaultValue) }}</bdi>
                </td>
                <td class="px-4 py-3 text-end">
                  <button
                    type="button"
                    class="text-brand disabled:opacity-40"
                    :disabled="!session.canMutate"
                    @click="open(setting)"
                  >
                    تغییر
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </StateBlock>
  </div>

  <ConfirmDialog
    :open="editing !== null"
    :title="editing ? `تغییر ${editing.key}` : ''"
    :body="
      editing
        ? `مقدار فعلی ${String(editing.value)} است و پیش‌فرض مستندشده ${String(editing.defaultValue)}. این تغییر روی رفتار محصول از همین حالا اثر می‌گذارد.`
        : ''
    "
    confirm-label="ذخیره"
    reason-label="دلیل تغییر (در گزارش رخدادها ثبت می‌شود)"
    :busy="acting"
    :error="actionError"
    @cancel="editing = null"
    @confirm="save"
  />

  <!--
    The value itself, beside the dialog: the dialog owns the reason and the
    confirmation, and this is the one field that differs per setting.
  -->
  <div v-if="editing !== null" class="fixed inset-x-0 bottom-6 z-50 mx-auto w-full max-w-md px-4">
    <label
      class="flex items-center gap-2 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm shadow-lg"
    >
      <span class="shrink-0 text-ink-soft">مقدار تازه:</span>
      <input
        v-model.number="draft"
        type="number"
        :step="Number.isInteger(editing.defaultValue) ? 1 : 0.01"
        min="0"
        class="min-h-9 flex-1 rounded-lg border border-line bg-surface px-2"
      />
      <span v-if="!draftValid" class="shrink-0 text-xs text-danger">مقدار معتبر نیست</span>
    </label>
  </div>
</template>
