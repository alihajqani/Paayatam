<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  PERMISSIONS,
  type HelpGuideAdminView,
  type HelpGuideListResponse,
  type HelpGuidePlaceholderView,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { formatDateTime } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * The in-bot guide's text (migration 0063).
 *
 * ── What is being edited ────────────────────────────────────────────────────
 *
 * Each section of `/help`: its button label, its text, and whether users see
 * it. The default text ships with the code; saving here overrides it, and
 * «بازگشت به متن پیش‌فرض» removes the override, so a later release's
 * corrections reach the section again.
 *
 * ── Why numbers are placeholders ────────────────────────────────────────────
 *
 * Prices and penalties are settings that change without a deploy. A number
 * typed into the guide would go stale the day one moved; `{{setting.key}}` is
 * filled from the live value every time the bot draws the page. The preview
 * below fills them the same way, from the values the server sent.
 *
 * ── Plain text only ─────────────────────────────────────────────────────────
 *
 * The preview is built from segments and `{{ }}`, never `v-html` (CI refuses
 * the latter anywhere in this app).
 */
const session = useSessionStore();

const guides = ref<HelpGuideAdminView[]>([]);
const placeholders = ref<HelpGuidePlaceholderView[]>([]);
const titleMax = ref(40);
const bodyMax = ref(3500);
const loaded = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const selectedSlug = ref<string | null>(null);
const form = ref({ title: '', body: '', hidden: false });
const saving = ref(false);
const saveError = ref<string | null>(null);
const bodyInput = ref<HTMLTextAreaElement | null>(null);

const canEdit = computed(() => session.can(PERMISSIONS.POLICY_MANAGE) && session.canMutate);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return guides.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

const selected = computed(
  () => guides.value.find((guide) => guide.slug === selectedSlug.value) ?? null,
);

async function load(): Promise<void> {
  error.value = null;
  try {
    const response = await request<HelpGuideListResponse>('/help-guides');
    guides.value = response.guides;
    placeholders.value = response.placeholders;
    titleMax.value = response.titleMax;
    bodyMax.value = response.bodyMax;
    loaded.value = true;
    const first = response.guides[0];
    if (selectedSlug.value === null && first !== undefined) select(first);
  } catch (cause) {
    error.value = messageOf(cause, 'راهنما بارگذاری نشد.');
  }
}

function select(guide: HelpGuideAdminView): void {
  selectedSlug.value = guide.slug;
  form.value = { title: guide.title, body: guide.body, hidden: guide.hidden };
  saveError.value = null;
  notice.value = null;
}

const dirty = computed(() => {
  const guide = selected.value;
  if (guide === null) return false;
  return (
    form.value.title !== guide.title ||
    form.value.body !== guide.body ||
    form.value.hidden !== guide.hidden
  );
});

// ── Placeholders ──────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)(\|abs)?\s*\}\}/g;

const values = computed(
  () => new Map(placeholders.value.map((placeholder) => [placeholder.key, placeholder.value])),
);

const unknownKeys = computed(() => {
  const unknown = new Set<string>();
  for (const match of form.value.body.matchAll(PLACEHOLDER)) {
    const key = match[1] ?? '';
    if (!values.value.has(key)) unknown.add(key);
  }
  return [...unknown];
});

/** The same digits the bot writes: «٬» between thousands, «٫» before a fraction. */
function formatValue(value: number): string {
  const [whole = '0', fraction] = String(Math.abs(value)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const text = `${value < 0 ? '-' : ''}${grouped}${fraction === undefined ? '' : `٫${fraction}`}`;
  return text.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)] ?? digit);
}

function fill(text: string): string {
  return text.replace(PLACEHOLDER, (whole, key: string, abs: string | undefined) => {
    const value = values.value.get(key);
    if (value === undefined) return whole;
    return formatValue(abs === undefined ? value : Math.abs(value));
  });
}

function insert(key: string): void {
  const token = `{{${key}}}`;
  const input = bodyInput.value;
  if (input === null) {
    form.value.body += token;
    return;
  }
  const start = input.selectionStart;
  const end = input.selectionEnd;
  form.value.body = form.value.body.slice(0, start) + token + form.value.body.slice(end);
  requestAnimationFrame(() => {
    input.focus();
    input.setSelectionRange(start + token.length, start + token.length);
  });
}

// ── Preview: the bot's light markdown, as segments ─────────────────────────

interface PreviewLine {
  segments: { text: string; bold: boolean }[];
}

const preview = computed<PreviewLine[]>(() =>
  fill(form.value.body)
    .split('\n')
    .map((raw) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim());
      if (heading !== null) {
        return { segments: [{ text: (heading[1] ?? '').replace(/\*\*/g, ''), bold: true }] };
      }
      const bullet = /^[-*]\s+(.*)$/.exec(raw.trim());
      const line = bullet !== null ? `• ${bullet[1] ?? ''}` : raw;
      return {
        segments: line
          .split(/\*\*(.+?)\*\*/)
          .map((text, index) => ({ text, bold: index % 2 === 1 }))
          .filter((segment) => segment.text !== ''),
      };
    }),
);

const filledLength = computed(() => fill(form.value.body).length);

const valid = computed(() => {
  const title = form.value.title.trim();
  const body = form.value.body.trim();
  return (
    title.length > 0 &&
    title.length <= titleMax.value &&
    body.length > 0 &&
    body.length <= bodyMax.value &&
    unknownKeys.value.length === 0
  );
});

// ── Saving ────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  const guide = selected.value;
  if (guide === null || !valid.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const updated = await request<HelpGuideAdminView>(`/help-guides/${guide.slug}`, {
      method: 'PUT',
      body: {
        title: form.value.title,
        body: form.value.body,
        hidden: form.value.hidden,
      },
    });
    replace(updated);
    notice.value = 'ذخیره شد. از همین حالا در ربات دیده می‌شود.';
  } catch (cause) {
    saveError.value = messageOf(cause, 'ذخیره نشد.');
  } finally {
    saving.value = false;
  }
}

async function reset(): Promise<void> {
  const guide = selected.value;
  if (guide === null) return;
  if (!window.confirm('متن و عنوان این بخش به پیش‌فرض برگردد و دوباره نمایش داده شود؟')) return;
  saving.value = true;
  saveError.value = null;
  try {
    const updated = await request<HelpGuideAdminView>(`/help-guides/${guide.slug}`, {
      method: 'DELETE',
    });
    replace(updated);
    notice.value = 'به متن پیش‌فرض برگشت.';
  } catch (cause) {
    saveError.value = messageOf(cause, 'انجام نشد.');
  } finally {
    saving.value = false;
  }
}

function replace(updated: HelpGuideAdminView): void {
  guides.value = guides.value.map((guide) => (guide.slug === updated.slug ? updated : guide));
  select(updated);
}

function customized(guide: HelpGuideAdminView): boolean {
  return guide.titleCustomized || guide.bodyCustomized || guide.hidden;
}

onMounted(load);
</script>

<template>
  <StateBlock
    :state="state"
    :error-text="error"
    empty-text="راهنمایی تعریف نشده است."
    :rows="4"
    @retry="load"
  >
    <div class="flex flex-col gap-5">
      <p class="text-sm leading-relaxed text-ink-soft">
        بخش‌های راهنمای ربات، همان‌هایی که با دکمهٔ «📖 راهنما» یا <bdi>/help</bdi> باز می‌شوند. متن
        پیش‌فرض همراه کد می‌آید؛ هر تغییری اینجا جایش را می‌گیرد تا وقتی که «بازگشت به متن پیش‌فرض»
        را بزنید.
      </p>

      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <div class="grid gap-5 lg:grid-cols-[16rem_1fr]">
        <!-- ── The sections ─────────────────────────────────────────── -->
        <nav class="flex flex-col gap-1" aria-label="بخش‌های راهنما">
          <button
            v-for="guide in guides"
            :key="guide.slug"
            type="button"
            class="flex min-h-10 items-center justify-between gap-2 rounded-lg border px-3 text-start text-sm"
            :class="
              guide.slug === selectedSlug ? 'border-brand bg-brand-soft' : 'border-line bg-surface'
            "
            @click="select(guide)"
          >
            <span :class="guide.hidden ? 'text-ink-faint line-through' : ''">{{
              guide.title
            }}</span>
            <span
              v-if="customized(guide)"
              class="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
            >
              {{ guide.hidden ? 'پنهان' : 'ویرایش‌شده' }}
            </span>
          </button>
        </nav>

        <!-- ── The editor ───────────────────────────────────────────── -->
        <section
          v-if="selected"
          class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
        >
          <div class="grid gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft"
                >عنوان (متن دکمه، حداکثر {{ titleMax }} نویسه)</span
              >
              <input
                v-model="form.title"
                type="text"
                :maxlength="titleMax"
                :disabled="!canEdit"
                class="min-h-10 rounded-lg border border-line bg-surface px-3"
              />
            </label>

            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.hidden" type="checkbox" :disabled="!canEdit" />
              <span>این بخش در ربات نمایش داده نشود</span>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">متن</span>
              <textarea
                ref="bodyInput"
                v-model="form.body"
                rows="18"
                dir="rtl"
                :disabled="!canEdit"
                class="rounded-lg border border-line bg-surface p-3 text-sm leading-relaxed"
              ></textarea>
            </label>
            <p class="text-xs text-ink-faint">
              <bdi>**متن**</bdi> پررنگ می‌شود و خطی که با <bdi>-</bdi> شروع شود، «•» می‌گیرد. طول:
              {{ form.body.trim().length }} از {{ bodyMax }} نویسه (با عددهای جایگزین‌شده:
              {{ filledLength }}).
            </p>
            <p v-if="unknownKeys.length > 0" class="text-sm text-danger" role="alert">
              این جای‌نگهدارها شناخته نمی‌شوند:
              <bdi v-for="key in unknownKeys" :key="key" class="ms-1 font-mono">{{ key }}</bdi>
            </p>
          </div>

          <p v-if="saveError" class="text-sm text-danger" role="alert">{{ saveError }}</p>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
              :disabled="!canEdit || !dirty || !valid || saving"
              @click="save"
            >
              {{ saving ? 'در حال ذخیره…' : 'ذخیره' }}
            </button>
            <button
              type="button"
              class="min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
              :disabled="!dirty || saving"
              @click="select(selected)"
            >
              دور انداختن تغییرها
            </button>
            <button
              type="button"
              class="min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
              :disabled="!canEdit || !customized(selected) || saving"
              @click="reset"
            >
              بازگشت به متن پیش‌فرض
            </button>
            <span v-if="selected.updatedAt" class="text-xs text-ink-faint">
              آخرین تغییر: {{ formatDateTime(selected.updatedAt) }}
            </span>
          </div>

          <!-- ── Preview ───────────────────────────────────────────── -->
          <div>
            <h3 class="mb-2 text-sm font-semibold">پیش‌نمایش در ربات</h3>
            <div
              class="rounded-xl border border-line bg-surface-sunken p-4 text-sm leading-7"
              dir="rtl"
            >
              <p class="font-bold">{{ form.title }}</p>
              <p v-for="(line, index) in preview" :key="index" class="min-h-4 whitespace-pre-wrap">
                <template v-for="(segment, part) in line.segments" :key="part">
                  <b v-if="segment.bold">{{ segment.text }}</b>
                  <template v-else>{{ segment.text }}</template>
                </template>
              </p>
            </div>
          </div>

          <!-- ── Placeholders ──────────────────────────────────────── -->
          <details class="rounded-lg border border-line p-3">
            <summary class="cursor-pointer text-sm font-semibold">
              جای‌نگهدارها ({{ placeholders.length }})
            </summary>
            <p class="mt-2 text-xs leading-relaxed text-ink-faint">
              عدد را مستقیم ننویسید؛ جای‌نگهدار را بگذارید تا اگر آن تنظیم در پنل عوض شد، راهنما هم
              خودکار درست بماند. برای حذف علامت منفی، <bdi class="font-mono">|abs</bdi> را به آخر
              کلید اضافه کنید.
            </p>
            <ul class="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto">
              <li
                v-for="placeholder in placeholders"
                :key="placeholder.key"
                class="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1 text-xs"
              >
                <span>{{ placeholder.label }}</span>
                <span class="flex items-center gap-2">
                  <bdi class="font-mono text-ink-faint">{{ placeholder.key }}</bdi>
                  <span>{{ formatValue(placeholder.value) }}</span>
                  <button
                    type="button"
                    class="rounded border border-line px-2 py-0.5 disabled:opacity-40"
                    :disabled="!canEdit"
                    @click="insert(placeholder.key)"
                  >
                    درج
                  </button>
                </span>
              </li>
            </ul>
          </details>
        </section>
      </div>
    </div>
  </StateBlock>
</template>
