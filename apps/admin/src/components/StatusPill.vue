<script setup lang="ts">
import { computed } from 'vue';

/**
 * A status, in Persian, coloured by what it means rather than by what it is.
 *
 * One component and one table, because the same six words appear on five screens
 * and a per-screen mapping is five places for «تأیید نشده» to drift. The tone is
 * derived from the *value*, so a status that is bad on one screen is bad on all
 * of them — an operator scanning a queue reads colour before text.
 *
 * Anything unmapped renders as itself in neutral. A new enum value showing up as
 * `PENDING_REVIEW` is honest; inventing a Persian word for it here would be the
 * panel guessing at product copy.
 */
const props = defineProps<{ value: string; tone?: 'good' | 'warn' | 'danger' | 'neutral' }>();

/** Persian for every status the panel renders (glossary §2). */
const LABELS: Record<string, string> = {
  // Accounts
  ACTIVE: 'فعال',
  SUSPENDED: 'معلق',
  BANNED: 'مسدود',
  DELETED: 'حذف‌شده',
  // Events
  DRAFT: 'پیش‌نویس',
  PENDING_MODERATION: 'در انتظار بررسی',
  PUBLISHED: 'منتشر شده',
  HIDDEN: 'پنهان شده',
  REJECTED: 'تأیید نشده',
  CANCELLED_BY_HOST: 'لغو شده توسط میزبان',
  ONGOING: 'در حال برگزاری',
  COMPLETED: 'برگزار شده',
  EXPIRED: 'منقضی شده',
  // Participation
  PENDING: 'در انتظار',
  WAITLISTED: 'در لیست انتظار',
  ACCEPTED: 'پذیرفته شده',
  CANCELLED_BY_PARTICIPANT: 'لغو شده توسط شرکت‌کننده',
  NO_SHOW: 'عدم حضور',
  // Chats
  ANONYMOUS: 'ناشناس',
  OPEN: 'باز',
  CLOSED: 'بسته شده',
  BLOCKED: 'مسدود',
  // Reports and cases
  ACTIONED: 'اقدام شد',
  DISMISSED: 'رد شد',
  IN_REVIEW: 'در حال بررسی',
  APPROVED: 'تأیید شده',
  ESCALATED: 'ارجاع شده',
  // Referrals
  QUALIFIED: 'واجد شرایط',
  // Legal documents (M22)
  ARCHIVED: 'بایگانی',
  // Gift codes
  SCHEDULED: 'زمان‌بندی‌شده',
  DISABLED: 'غیرفعال',
  EXHAUSTED: 'ظرفیت تکمیل',
};

const TONES: Record<string, 'good' | 'warn' | 'danger' | 'neutral'> = {
  ACTIVE: 'good',
  PUBLISHED: 'good',
  ACCEPTED: 'good',
  COMPLETED: 'good',
  OPEN: 'good',
  APPROVED: 'good',
  QUALIFIED: 'good',
  PENDING: 'warn',
  PENDING_MODERATION: 'warn',
  WAITLISTED: 'warn',
  IN_REVIEW: 'warn',
  ESCALATED: 'warn',
  ANONYMOUS: 'warn',
  SCHEDULED: 'warn',
  SUSPENDED: 'danger',
  BANNED: 'danger',
  DELETED: 'danger',
  REJECTED: 'danger',
  NO_SHOW: 'danger',
  BLOCKED: 'danger',
  DISABLED: 'danger',
  EXHAUSTED: 'danger',
};

const label = computed(() => LABELS[props.value] ?? props.value);
const tone = computed(() => props.tone ?? TONES[props.value] ?? 'neutral');

const CLASSES: Record<string, string> = {
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-neutral-soft text-ink-soft',
};
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs whitespace-nowrap"
    :class="CLASSES[tone]"
  >
    {{ label }}
  </span>
</template>
