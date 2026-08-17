<script setup lang="ts">
import { ref } from 'vue';
import type { ReportReason, ReportTargetType } from '@payetam/shared';
import { ApiError } from '@/api/client';
import { haptic } from '@/telegram/webapp';
import { useModerationStore } from '@/stores/moderation';

/**
 * Reporting something, from wherever it is being looked at (M12).
 *
 * One component rather than a screen, because a report is always *about* the thing
 * currently on screen and navigating away from it to file one loses the context that
 * made it worth filing.
 *
 * What it says back is deliberately two-valued. `triggeredReview` tells the reporter
 * their report was the one that crossed the threshold; anything more — a count, a
 * position — would let somebody probe how close a rival's event is to being hidden.
 */
const props = defineProps<{ target: ReportTargetType; publicId: string }>();
const emit = defineEmits<{ close: [] }>();

const moderation = useModerationStore();

const reason = ref<ReportReason | ''>('');
const description = ref('');
const error = ref<string | null>(null);
const done = ref<'filed' | 'escalated' | null>(null);

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'SPAM', label: 'هرزنامه یا تبلیغ' },
  { value: 'HARASSMENT', label: 'آزار و توهین' },
  { value: 'INAPPROPRIATE', label: 'محتوای نامناسب' },
  { value: 'SCAM', label: 'کلاهبرداری' },
  { value: 'IMPERSONATION', label: 'جعل هویت' },
  { value: 'SAFETY', label: 'نگرانی درباره ایمنی' },
  { value: 'OTHER', label: 'مورد دیگر' },
];

async function submit(): Promise<void> {
  error.value = null;
  if (reason.value === '') {
    error.value = 'یک دلیل را انتخاب کنید.';
    return;
  }

  try {
    const result = await moderation.report(props.target, props.publicId, {
      reason: reason.value,
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
    });
    haptic('success');
    done.value = result.triggeredReview ? 'escalated' : 'filed';
  } catch (cause) {
    haptic('error');
    error.value = cause instanceof ApiError ? cause.messageFa : 'ثبت گزارش انجام نشد.';
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 rounded-2xl bg-tg-section-bg p-4" role="group">
    <template v-if="done">
      <p class="text-sm font-medium">
        {{
          done === 'escalated'
            ? 'گزارش شما ثبت شد و این مورد برای بررسی به تیم ما رفت.'
            : 'گزارش شما ثبت شد. از اینکه به امن‌ماندن پایه‌تَم کمک می‌کنید سپاسگزاریم.'
        }}
      </p>
      <button type="button" class="min-h-11 self-start text-tg-link" @click="emit('close')">
        بستن
      </button>
    </template>

    <template v-else>
      <h3 class="font-medium">گزارش تخلف</h3>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">دلیل</span>
        <select v-model="reason" class="min-h-11 rounded-xl bg-tg-bg px-3 text-tg-text">
          <option value="" disabled>انتخاب کنید</option>
          <option v-for="option in REASONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-tg-subtitle">توضیح (اختیاری)</span>
        <textarea
          v-model="description"
          rows="3"
          maxlength="1000"
          class="rounded-xl bg-tg-bg p-3 text-tg-text"
        ></textarea>
      </label>

      <p class="text-xs text-tg-hint">
        توضیح شما را فقط تیم بررسی می‌بیند و هرگز به فرد گزارش‌شده نشان داده نمی‌شود.
      </p>

      <p v-if="error" class="text-sm text-tg-destructive">{{ error }}</p>

      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-11 flex-1 rounded-xl bg-tg-destructive text-sm text-tg-button-text disabled:opacity-50"
          :disabled="moderation.submitting"
          @click="submit"
        >
          {{ moderation.submitting ? 'در حال ارسال…' : 'ارسال گزارش' }}
        </button>
        <button
          type="button"
          class="min-h-11 rounded-xl bg-tg-secondary-bg px-4 text-sm"
          @click="emit('close')"
        >
          انصراف
        </button>
      </div>
    </template>
  </div>
</template>
