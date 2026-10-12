<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  ERROR_MESSAGES_FA,
  INTERACTION_GATE_FA,
  INTERACTION_KIND_FA,
  INTERACTION_OUTCOME_FA,
  INTERACTION_SESSION_GAP_MINUTES,
  interactionActionLabel,
  interactionScreenLabel,
  interactionStepLabel,
  interactionWizardLabel,
} from '@payetam/shared';
import type { UserInteractionItem, UserInteractionsResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatDateTime, formatNumber } from '@/format/fa';

/**
 * One person's trail through the bot, newest first (migration 0065).
 *
 * «رفتار کاربران» counts everybody. This is the other reading of the same
 * rows: what one person pressed, what they were shown, and what refused them —
 * the conversation support is having when somebody writes «ربات کار نمی‌کند».
 *
 * Everything is named the way the person met it. A button by its Persian
 * label, a refusal by the sentence they were sent, a form by the question it
 * left them on. The keys underneath are for whoever has to find the code.
 *
 * The parent shows this only to a session with `user.read`; the API refuses it
 * to anyone else regardless. No message text is here to show: the bot records
 * that something was typed, never what.
 */
const props = defineProps<{ userPublicId: string }>();

const items = ref<UserInteractionItem[]>([]);
const nextBefore = ref<string | null>(null);
const loaded = ref(false);
const loadingMore = ref(false);
const error = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null && !loaded.value) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return items.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(before?: string): Promise<void> {
  error.value = null;
  loadingMore.value = before !== undefined;
  try {
    const page = await request<UserInteractionsResponse>(
      `/users/${props.userPublicId}/interactions`,
      before === undefined ? undefined : { query: { before } },
    );
    items.value = before === undefined ? page.items : [...items.value, ...page.items];
    nextBefore.value = page.nextBefore;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'مسیر کاربر در ربات بارگذاری نشد.');
  } finally {
    loadingMore.value = false;
  }
}

function reload(): void {
  items.value = [];
  nextBefore.value = null;
  loaded.value = false;
  void load();
}

/**
 * Each row, and whether an earlier visit begins at it.
 *
 * The list runs newest first, so a gap longer than a visit's own limit *above*
 * a row means that row is the last thing the person did in an earlier visit.
 * The same thirty minutes the reports cut visits at, so the two agree.
 */
const rows = computed(() =>
  items.value.map((item, index) => {
    const newer = items.value[index - 1];
    const gap = newer === undefined ? 0 : Date.parse(newer.at) - Date.parse(item.at);
    return { item, earlierVisit: gap > INTERACTION_SESSION_GAP_MINUTES * 60_000 };
  }),
);

/** Why it did not simply succeed, in words rather than a code. */
function reason(item: UserInteractionItem): string | null {
  if (item.detail === null) return null;
  if (item.outcome === 'REFUSED') {
    return (ERROR_MESSAGES_FA as Record<string, string>)[item.detail] ?? item.detail;
  }
  if (item.outcome === 'GATED') {
    return (INTERACTION_GATE_FA as Record<string, string>)[item.detail] ?? item.detail;
  }
  return item.detail;
}

onMounted(() => void load());
watch(() => props.userPublicId, reload);
</script>

<template>
  <StateBlock
    :state="state"
    :error-text="error"
    :rows="4"
    empty-text="از زمانی که ثبت رفتار شروع شده، از این کاربر کاری در ربات ثبت نشده است."
    @retry="reload"
  >
    <ol class="flex flex-col text-sm">
      <template v-for="row in rows" :key="row.item.id">
        <li
          v-if="row.earlierVisit"
          class="my-2 flex items-center gap-3 text-xs text-ink-faint"
          data-testid="visit-break"
          aria-label="بازدید قبلی"
        >
          <span class="h-px flex-1 bg-line" />
          بازدید قبلی
          <span class="h-px flex-1 bg-line" />
        </li>
        <li class="border-b border-line py-2 last:border-b-0" data-testid="trail-item">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <bdi class="tabular-nums text-ink-soft">{{ formatDateTime(row.item.at) }}</bdi>
            <span class="font-medium">{{ interactionActionLabel(row.item.action) }}</span>
            <span
              v-if="row.item.outcome !== 'OK'"
              class="rounded-full px-2 py-0.5 text-xs"
              :class="
                row.item.outcome === 'FAILED'
                  ? 'bg-danger/10 text-danger'
                  : 'bg-neutral-soft text-ink-soft'
              "
            >
              {{ INTERACTION_OUTCOME_FA[row.item.outcome] }}
            </span>
          </div>
          <p v-if="reason(row.item)" class="mt-1 text-xs text-ink-soft">
            {{ row.item.outcome === 'REFUSED' ? 'پیامی که دید:' : 'مرحله‌ای که مانده بود:' }}
            «{{ reason(row.item) }}»
          </p>
          <p class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-faint">
            <span>{{ INTERACTION_KIND_FA[row.item.kind] }}</span>
            <span v-if="row.item.wizardStep">
              فرم<template v-if="row.item.wizardKind">
                «{{ interactionWizardLabel(row.item.wizardKind) }}»</template
              >: {{ interactionStepLabel(row.item.wizardStep) }}
            </span>
            <span v-if="row.item.screen">
              روی صفحه ماند: {{ interactionScreenLabel(row.item.screen) }}
            </span>
            <bdi v-if="row.item.ref" class="font-mono" dir="ltr">{{ row.item.ref }}</bdi>
            <span
              ><bdi class="tabular-nums">{{ formatNumber(row.item.durationMs) }}</bdi>
              میلی‌ثانیه</span
            >
          </p>
        </li>
      </template>
    </ol>

    <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}</p>
    <button
      v-if="nextBefore !== null"
      type="button"
      class="mt-3 min-h-9 rounded-full border border-line px-3 text-sm"
      :disabled="loadingMore"
      @click="load(nextBefore)"
    >
      {{ loadingMore ? 'در حال بارگذاری…' : 'قدیمی‌ترها' }}
    </button>
  </StateBlock>
</template>
