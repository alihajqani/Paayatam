<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AppSettingView } from '@payetam/shared';
import { formatNumber, parseTypedNumber } from '@/format/fa';

/**
 * The dialog behind «تغییر» on the settings screen.
 *
 * ── What it replaced, and why ───────────────────────────────────────────────
 *
 * A generic `ConfirmDialog` asking for a reason, plus a **separate floating
 * input** pinned to the bottom of the page holding the value. Two controls, in
 * two places, for one act — and the half that mattered, the number, was the half
 * outside the dialog. Somebody could confirm a change while looking at a field
 * they had to scroll to find.
 *
 * ── Why the explanation is here at all ──────────────────────────────────────
 *
 * A settings table showing a key, a number and a button is a table nobody can
 * safely act on. `economy.host_reward_cap` is not self-describing; neither is
 * `cancellation.host_penalty_multiplier`; and `founding.enabled` is a switch
 * whose position cannot be taken back. The three fields that matter —
 * *what it is*, *what a good value looks like*, *what breaks at the extremes* —
 * come from a catalogue that lives beside the defaults themselves, so the number
 * and its explanation cannot drift apart.
 *
 * ── Switches are switches ───────────────────────────────────────────────────
 *
 * Eight of these keys hold 0 or 1. Rendered as a number field they invite a 2 —
 * a value every reader treats as truthy and nobody intended. `unit === 'switch'`
 * gets two buttons and no field.
 */
const props = defineProps<{
  setting: AppSettingView | null;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{ confirm: [value: number, reason: string]; cancel: [] }>();

/**
 * The typed value as **text**, not a number.
 *
 * `v-model.number` on an `<input type="number">` yields `NaN` for an empty field
 * and for anything a Persian keyboard produces, and `NaN` compares false against
 * every bound — so the save button silently never enabled. Keeping the raw string
 * and parsing it through `parseTypedNumber` folds ASCII, Persian and Arabic-Indic
 * digits, which is the same thing the bot's wizard does with typed numbers.
 */
const draft = ref('');
const reason = ref('');

const REASON_MIN = 5;

// Reset on open rather than on close, so a dialog reopened after a refusal
// starts from the stored value instead of from what was just rejected.
watch(
  () => props.setting,
  (setting) => {
    draft.value = setting === null ? '' : String(setting.value);
    reason.value = '';
  },
);

const UNIT_LABELS: Record<string, string> = {
  coins: 'سکه',
  toman: 'تومان',
  days: 'روز',
  hours: 'ساعت',
  minutes: 'دقیقه',
  count: 'عدد',
  score: 'امتیاز',
  rank: 'رتبه',
  weight: 'وزن',
  multiplier: 'برابر',
  switch: '',
};

const unitLabel = computed(() => UNIT_LABELS[props.setting?.unit ?? ''] ?? '');
const isSwitch = computed(() => props.setting?.unit === 'switch');

const parsed = computed(() => parseTypedNumber(draft.value));

/**
 * The same rule the service enforces, checked before the request.
 *
 * An integer default takes an integer: a coin amount arriving as 12.5 is a
 * corrupted ledger rather than a rounding question. A fractional default — a
 * ranking weight, the host penalty multiplier — takes anything finite.
 */
const valid = computed(() => {
  const setting = props.setting;
  const value = parsed.value;
  if (setting === null || value === null) return false;
  if (value < 0) return false;
  return Number.isInteger(setting.defaultValue) ? Number.isInteger(value) : true;
});

const changed = computed(() => parsed.value !== null && parsed.value !== props.setting?.value);
const ready = computed(
  () => valid.value && reason.value.trim().length >= REASON_MIN && !props.busy,
);

/** Shown under the field, so «صفر یعنی خاموش» is not something to be discovered. */
const preview = computed(() => {
  const value = parsed.value;
  if (value === null) return '';
  if (isSwitch.value) return value === 0 ? 'خاموش' : 'روشن';
  return `${formatNumber(value)} ${unitLabel.value}`.trim();
});

function setSwitch(value: number): void {
  draft.value = String(value);
}

function submit(): void {
  const value = parsed.value;
  if (value === null || !ready.value) return;
  emit('confirm', value, reason.value.trim());
}
</script>

<template>
  <div
    v-if="setting !== null"
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @keydown.esc="emit('cancel')"
  >
    <div
      class="my-auto w-full max-w-lg rounded-2xl border border-line bg-surface-raised p-5 shadow-xl"
    >
      <header>
        <h2 class="text-lg font-bold">{{ setting.label }}</h2>
        <bdi class="mt-1 block font-mono text-xs text-ink-faint">{{ setting.key }}</bdi>
      </header>

      <!-- What it is. The paragraph an operator needs before touching anything. -->
      <section class="mt-4 rounded-xl bg-surface p-3 text-sm leading-relaxed">
        <p>{{ setting.detail }}</p>
      </section>

      <!-- What a good value looks like. Kept visually apart, because it is
           advice rather than description and the two read differently. -->
      <section
        class="mt-3 rounded-xl border border-brand-soft bg-brand-soft/40 p-3 text-sm leading-relaxed"
      >
        <h3 class="mb-1 font-semibold">عدد خوب چیست؟</h3>
        <p>{{ setting.guidance }}</p>
      </section>

      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div class="rounded-lg bg-surface p-3">
          <dt class="text-xs text-ink-faint">مقدار فعلی</dt>
          <dd class="mt-1 font-bold tabular-nums">
            <bdi>{{
              isSwitch ? (setting.value === 0 ? 'خاموش' : 'روشن') : formatNumber(setting.value)
            }}</bdi>
            <span v-if="!isSwitch && unitLabel" class="ms-1 text-xs font-normal text-ink-soft">
              {{ unitLabel }}
            </span>
          </dd>
        </div>
        <div class="rounded-lg bg-surface p-3">
          <dt class="text-xs text-ink-faint">پیش‌فرض مستندشده</dt>
          <dd class="mt-1 font-bold tabular-nums">
            <bdi>
              {{
                isSwitch
                  ? setting.defaultValue === 0
                    ? 'خاموش'
                    : 'روشن'
                  : formatNumber(setting.defaultValue)
              }}
            </bdi>
          </dd>
        </div>
      </dl>

      <!-- Switches get two buttons. A number field here would accept a 2. -->
      <div v-if="isSwitch" class="mt-4">
        <span class="text-sm text-ink-soft">مقدار تازه</span>
        <div class="mt-1 flex gap-2">
          <button
            type="button"
            class="min-h-10 flex-1 rounded-lg border px-4 text-sm"
            :class="
              parsed === 1 ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface'
            "
            @click="setSwitch(1)"
          >
            روشن
          </button>
          <button
            type="button"
            class="min-h-10 flex-1 rounded-lg border px-4 text-sm"
            :class="
              parsed === 0 ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface'
            "
            @click="setSwitch(0)"
          >
            خاموش
          </button>
        </div>
      </div>

      <label v-else class="mt-4 block">
        <span class="text-sm text-ink-soft">
          مقدار تازه<span v-if="unitLabel"> ({{ unitLabel }})</span>
        </span>
        <input
          v-model="draft"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          class="mt-1 min-h-10 w-full rounded-lg border border-line bg-surface px-3 tabular-nums"
        />
        <span v-if="valid" class="mt-1 block text-xs text-ink-faint">
          ثبت می‌شود: <bdi>{{ preview }}</bdi>
        </span>
        <span v-else-if="draft.trim() !== ''" class="mt-1 block text-xs text-danger">
          {{
            Number.isInteger(setting.defaultValue)
              ? 'این تنظیم فقط عدد صحیح و نامنفی می‌پذیرد.'
              : 'یک عدد نامنفی بنویسید.'
          }}
        </span>
      </label>

      <label class="mt-4 block">
        <span class="text-sm text-ink-soft">دلیل تغییر (در گزارش رخدادها ثبت می‌شود)</span>
        <textarea
          v-model="reason"
          rows="2"
          class="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-sm"
          :placeholder="`دست‌کم ${String(REASON_MIN)} نویسه`"
        ></textarea>
      </label>

      <p v-if="!changed && valid" class="mt-2 text-xs text-ink-faint">
        این همان مقدار فعلی است. ذخیره کردنش فقط یک ردیف در گزارش رخدادها می‌نویسد.
      </p>

      <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}</p>

      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="min-h-10 rounded-lg border border-line px-4 text-sm"
          :disabled="busy"
          @click="emit('cancel')"
        >
          انصراف
        </button>
        <button
          type="button"
          class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
          :disabled="!ready"
          @click="submit"
        >
          {{ busy ? 'در حال ذخیره…' : 'ذخیره' }}
        </button>
      </div>
    </div>
  </div>
</template>
