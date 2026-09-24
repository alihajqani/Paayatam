<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AppSettingView, AppSettingsResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import SettingEditDialog from '@/components/SettingEditDialog.vue';
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
 * **Every row carries its own explanation**, served with the value from a
 * catalogue that lives beside the defaults. That is the difference between a
 * table somebody can act on and a table of 88 machine keys: `economy.host_reward_cap`
 * is not self-describing, and neither is a multiplier that only makes sense
 * against a number three rows away. The full text — what it is, what a good value
 * looks like, what breaks at the extremes — opens with the edit dialog, which is
 * the moment it is needed.
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
  events: 'رویدادها',
  participation: 'درخواست‌های شرکت',
  waitlist: 'لیست انتظار',
  cancellation: 'لغو و جریمه',
  channel: 'کانال تلگرام',
  moderation: 'بررسی و تأیید',
  ranking: 'وزن‌های رتبه‌بندی',
  founding: 'کمپین هزار نفر اول',
  city: 'شهرها',
  invite: 'دعوت هدفمند',
  review: 'نظرها',
  release: 'استقرار',
};

/** The unit after a value in the table. `switch` renders as روشن/خاموش instead. */
const UNIT_LABELS: Record<string, string> = {
  coins: 'سکه',
  toman: 'تومان',
  days: 'روز',
  hours: 'ساعت',
  minutes: 'دقیقه',
  count: '',
  score: 'امتیاز',
  rank: '',
  weight: '',
  multiplier: 'برابر',
  switch: '',
};

/**
 * A search box, because 88 rows across seventeen groups is not a list anybody
 * scrolls.
 *
 * Matches the Persian label and summary as well as the key, so somebody who
 * knows the *thing* they want to change — «جریمه» — finds it without knowing
 * that the product spells it `cancellation`.
 */
const search = ref('');

const groups = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const matching =
    needle === ''
      ? rows.value
      : rows.value.filter(
          (row) =>
            row.key.toLowerCase().includes(needle) ||
            row.label.toLowerCase().includes(needle) ||
            row.summary.toLowerCase().includes(needle),
        );

  const buckets = new Map<string, AppSettingView[]>();
  for (const row of matching) {
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
const acting = ref(false);
const actionError = ref<string | null>(null);

function open(setting: AppSettingView): void {
  editing.value = setting;
  actionError.value = null;
}

/**
 * The value and its validation live in the dialog now.
 *
 * They used to live here, with the field itself pinned to the bottom of the page
 * outside the confirmation — two controls in two places for one act, and the half
 * that mattered was the half outside the dialog.
 */
async function save(value: number, reason: string): Promise<void> {
  const setting = editing.value;
  if (setting === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<AppSettingView>(`/settings/${encodeURIComponent(setting.key)}`, {
      method: 'POST',
      body: { value, reason },
    });
    notice.value = `«${setting.label}» ذخیره شد و تغییر در گزارش رخدادها ثبت شد.`;
    editing.value = null;
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

    <label class="block">
      <span class="sr-only">جست‌وجو در تنظیمات</span>
      <input
        v-model="search"
        type="search"
        placeholder="جست‌وجو — نام فارسی، توضیح یا کلید"
        class="min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm"
      />
    </label>

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
                  <span class="font-semibold">{{ setting.label }}</span>
                  <p class="mt-0.5 text-xs leading-relaxed text-ink-soft">{{ setting.summary }}</p>
                  <bdi class="mt-1 block font-mono text-[0.65rem] text-ink-faint">
                    {{ setting.key }}
                  </bdi>
                </td>
                <td class="whitespace-nowrap px-4 py-3 tabular-nums">
                  <bdi class="font-bold">
                    {{
                      setting.unit === 'switch'
                        ? setting.value === 0
                          ? 'خاموش'
                          : 'روشن'
                        : formatNumber(setting.value)
                    }}
                  </bdi>
                  <span v-if="setting.unit !== 'switch'" class="ms-1 text-xs text-ink-soft">
                    {{ UNIT_LABELS[setting.unit] }}
                  </span>
                  <span
                    v-if="setting.overridden"
                    class="ms-2 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
                  >
                    تغییر داده‌شده
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-3 text-xs text-ink-faint">
                  پیش‌فرض:
                  <bdi>
                    {{
                      setting.unit === 'switch'
                        ? setting.defaultValue === 0
                          ? 'خاموش'
                          : 'روشن'
                        : formatNumber(setting.defaultValue)
                    }}
                  </bdi>
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

  <SettingEditDialog
    :setting="editing"
    :busy="acting"
    :error="actionError"
    @cancel="editing = null"
    @confirm="save"
  />
</template>
