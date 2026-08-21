<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * The confirmation in front of anything irreversible.
 *
 * It is the feature rather than politeness: the panel can ban an account, hide an
 * event, disable a live campaign and change a policy number, and every one of
 * those is something an operator does under pressure from a queue.
 *
 * Two properties beyond "are you sure":
 *
 *  - **A reason, where the API demands one.** `reasonLabel` turns this into the
 *    form for that field rather than a second dialog, and the button stays
 *    disabled until it is long enough — which is the same bound the service
 *    enforces, so the refusal happens before the request rather than after it.
 *  - **A typed confirmation for the worst of them.** `confirmWord` makes the
 *    operator type something, which is the only control that requires them to
 *    have read what they are about to do (the same argument `seed-guard` makes
 *    about a production database name).
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    body?: string;
    confirmLabel?: string;
    tone?: 'danger' | 'default';
    /** Present when the API requires a written reason. */
    reasonLabel?: string | null;
    reasonMinLength?: number;
    /** Present for the irreversible ones — the operator types it back. */
    confirmWord?: string | null;
    busy?: boolean;
    error?: string | null;
  }>(),
  {
    body: '',
    confirmLabel: 'تأیید',
    tone: 'default',
    reasonLabel: null,
    reasonMinLength: 5,
    confirmWord: null,
    busy: false,
    error: null,
  },
);

const emit = defineEmits<{ confirm: [reason: string]; cancel: [] }>();

const reason = ref('');
const typed = ref('');

// Cleared on open rather than on close, so a dialog reopened after a failure
// starts empty instead of showing what was just refused.
watch(
  () => props.open,
  (open) => {
    if (open) {
      reason.value = '';
      typed.value = '';
    }
  },
);

function ready(): boolean {
  if (props.reasonLabel !== null && reason.value.trim().length < props.reasonMinLength)
    return false;
  if (props.confirmWord !== null && typed.value.trim() !== props.confirmWord) return false;
  return !props.busy;
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @keydown.esc="emit('cancel')"
  >
    <div class="w-full max-w-md rounded-2xl border border-line bg-surface-raised p-5 shadow-xl">
      <h2 class="text-lg font-bold">{{ title }}</h2>
      <p v-if="body" class="mt-2 text-sm leading-relaxed text-ink-soft">{{ body }}</p>

      <label v-if="reasonLabel !== null" class="mt-4 block">
        <span class="text-sm text-ink-soft">{{ reasonLabel }}</span>
        <textarea
          v-model="reason"
          rows="3"
          class="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-sm"
          :placeholder="`دست‌کم ${reasonMinLength} نویسه`"
        ></textarea>
      </label>

      <label v-if="confirmWord !== null" class="mt-4 block">
        <span class="text-sm text-ink-soft"> برای تأیید، «{{ confirmWord }}» را بنویسید </span>
        <input
          v-model="typed"
          type="text"
          class="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-sm"
          autocomplete="off"
        />
      </label>

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
          class="min-h-10 rounded-lg px-4 text-sm disabled:opacity-40"
          :class="tone === 'danger' ? 'bg-danger text-brand-ink' : 'bg-brand text-brand-ink'"
          :disabled="!ready()"
          @click="emit('confirm', reason.trim())"
        >
          {{ busy ? 'در حال انجام…' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
