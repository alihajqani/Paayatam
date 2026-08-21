<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AdminAuditEntryView, AdminAuditResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import { formatDateTime } from '@/format/fa';

/**
 * The audit trail (invariants 10 and 12).
 *
 * **Immutable, and there is nothing here that suggests otherwise** — no edit, no
 * delete, no "resolve". `audit_log` carries a `BEFORE DELETE` trigger, so there
 * is no writing path to expose in the first place.
 *
 * `before` and `after` are shown as stored. That is safe because of a rule that
 * lives elsewhere: `AuditService`'s contract is an **allowlist at every call
 * site**, never a spread of an entity, which is why nothing in this product ever
 * put a gift code or a Telegram id into one. The panel does not re-redact,
 * because a second redactor would be a second thing to keep correct and would
 * hide the day the first one failed.
 *
 * What it *does* is refuse to render anything key-shaped. `token`, `secret`,
 * `password` and `hash` are replaced with «پنهان» — not because anything writes
 * them today, but because this is the screen where such a value would first be
 * seen, and an operator reading an incident should not be the person who
 * discovers it by screenshotting it.
 *
 * The action filter is a **prefix**, so `giftcode.` finds all six gift-code
 * actions without anybody having to know their names.
 */
const LIMIT = 50;

const rows = ref<AdminAuditEntryView[]>([]);
const total = ref(0);
const offset = ref(0);
const action = ref('');
const actorType = ref('');
const actorId = ref('');
const targetType = ref('');
const targetId = ref('');
const from = ref('');
const to = ref('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const expanded = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

function toIso(day: string, endOfDay = false): string | undefined {
  if (day === '') return undefined;
  return new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<AdminAuditResponse>('/audit/search', {
      query: {
        action: action.value.trim(),
        actorType: actorType.value,
        actorId: actorId.value.trim(),
        targetType: targetType.value.trim(),
        targetId: targetId.value.trim(),
        from: toIso(from.value),
        to: toIso(to.value, true),
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.entries;
    total.value = page.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'گزارش رخدادها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([action, actorType, actorId, targetType, targetId, from, to], () => {
  offset.value = 0;
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});
watch(offset, () => void load());

/**
 * Anything key-shaped, replaced before it reaches the DOM.
 *
 * A belt over the braces `AuditService`'s allowlist already provides. It matches
 * on the *key* rather than on the value, because a secret is recognisable by what
 * it is called and not by what it looks like.
 */
const SENSITIVE = /token|secret|password|hash|csrf|key$/i;

function render(payload: unknown): string {
  if (payload === null || payload === undefined) return '—';
  if (typeof payload !== 'object') return String(payload);

  const safe = Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      key,
      SENSITIVE.test(key) ? '«پنهان»' : value,
    ]),
  );
  return JSON.stringify(safe, null, 2);
}

/** The action families worth a one-click filter, since nobody memorises prefixes. */
const FAMILIES = [
  { prefix: '', label: 'همه' },
  { prefix: 'admin.', label: 'ورود و حساب‌های مدیریت' },
  { prefix: 'giftcode.', label: 'کدهای هدیه' },
  { prefix: 'referral.', label: 'معرفی دوستان' },
  { prefix: 'coin.', label: 'اصلاح سکه' },
  { prefix: 'trust.', label: 'اصلاح امتیاز اعتماد' },
  { prefix: 'user.', label: 'وضعیت حساب کاربران' },
  { prefix: 'event.', label: 'بررسی فعالیت‌ها' },
  { prefix: 'report.', label: 'گزارش‌های تخلف' },
  { prefix: 'moderation.', label: 'پرونده‌های بررسی' },
  { prefix: 'chat.', label: 'دسترسی اضطراری به گفت‌وگو' },
  { prefix: 'role.', label: 'تغییر نقش‌ها' },
  { prefix: 'setting.', label: 'تنظیمات' },
  { prefix: 'ratelimit.', label: 'عبور از سقف درخواست' },
];

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap gap-2">
      <button
        v-for="family in FAMILIES"
        :key="family.prefix"
        type="button"
        class="min-h-9 rounded-full border px-3 text-sm"
        :class="action === family.prefix ? 'border-brand bg-brand-soft text-brand' : 'border-line'"
        @click="action = family.prefix"
      >
        {{ family.label }}
      </button>
    </div>

    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">عامل</span>
        <select v-model="actorType" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option value="">همه</option>
          <option value="ADMIN">مدیر</option>
          <option value="USER">کاربر</option>
          <option value="SYSTEM">سامانه</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">شناسهٔ عامل</span>
        <input
          v-model="actorId"
          type="search"
          dir="ltr"
          class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">نوع مورد</span>
        <input
          v-model="targetType"
          type="search"
          dir="ltr"
          placeholder="user، event، gift_code"
          class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">شناسهٔ مورد</span>
        <input
          v-model="targetId"
          type="search"
          dir="ltr"
          class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">از تاریخ</span>
        <input
          v-model="from"
          type="date"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">تا تاریخ</span>
        <input
          v-model="to"
          type="date"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>
    </form>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="رخدادی با این فیلترها ثبت نشده است."
      @retry="load"
    >
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[56rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">زمان</th>
              <th class="px-4 py-3 text-start font-medium">رخداد</th>
              <th class="px-4 py-3 text-start font-medium">عامل</th>
              <th class="px-4 py-3 text-start font-medium">مورد</th>
              <th class="px-4 py-3 text-start font-medium"><span class="sr-only">جزئیات</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in rows" :key="entry.id">
              <tr class="border-b border-line">
                <td class="px-4 py-3 whitespace-nowrap text-ink-soft">
                  {{ formatDateTime(entry.createdAt) }}
                </td>
                <td class="px-4 py-3">
                  <bdi class="font-mono text-xs">{{ entry.action }}</bdi>
                </td>
                <td class="px-4 py-3">
                  <bdi class="font-mono text-xs">{{ entry.actorType }}</bdi>
                  <bdi v-if="entry.actorId" class="block font-mono text-xs text-ink-faint">
                    {{ entry.actorId }}
                  </bdi>
                </td>
                <td class="px-4 py-3">
                  <bdi class="font-mono text-xs">{{ entry.targetType }}</bdi>
                  <bdi v-if="entry.targetId" class="block font-mono text-xs text-ink-faint">
                    {{ entry.targetId }}
                  </bdi>
                </td>
                <td class="px-4 py-3 text-end">
                  <button
                    v-if="entry.before !== null || entry.after !== null"
                    type="button"
                    class="text-brand"
                    @click="expanded = expanded === entry.id ? null : entry.id"
                  >
                    {{ expanded === entry.id ? 'بستن' : 'جزئیات' }}
                  </button>
                </td>
              </tr>
              <tr v-if="expanded === entry.id" class="border-b border-line bg-surface-sunken">
                <td colspan="5" class="px-4 py-3">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <div>
                      <p class="text-xs text-ink-soft">پیش از تغییر</p>
                      <pre
                        class="mt-1 overflow-x-auto rounded-lg bg-surface p-2 font-mono text-xs"
                        dir="ltr"
                        >{{ render(entry.before) }}</pre>
                    </div>
                    <div>
                      <p class="text-xs text-ink-soft">پس از تغییر</p>
                      <pre
                        class="mt-1 overflow-x-auto rounded-lg bg-surface p-2 font-mono text-xs"
                        dir="ltr"
                        >{{ render(entry.after) }}</pre>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <PagerBar
        :total="total"
        :limit="LIMIT"
        :offset="offset"
        :loading="loading"
        @move="offset = $event"
      />
    </StateBlock>

    <p class="text-xs leading-relaxed text-ink-faint">
      این گزارش فقط افزودنی است و از هیچ مسیری قابل ویرایش یا حذف نیست. تنها استثنا، پاک‌سازی خودکار
      طبق سیاست نگه‌داری است: رکوردهای قدیمی‌تر از ۲۴ ماه حذف می‌شوند.
    </p>
  </div>
</template>
