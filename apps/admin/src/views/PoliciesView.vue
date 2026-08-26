<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  PERMISSIONS,
  type AdminPolicyListResponse,
  type AdminPolicyView,
  type PolicyConsentResponse,
} from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatNumber } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Authoring the rules (M22 phase 8).
 *
 * `policy.manage` had been in the permission catalogue since M12 with nothing
 * behind it, and `tools/seed-policies.ts` refuses to run against production — so
 * whatever text was seeded on the first deploy was the text forever. This is the
 * screen that closes that.
 *
 * ── Three things the UI does deliberately ────────────────────────────────────
 *
 * **The publish button asks for the version number, typed.** Not a checkbox: a
 * checkbox is a reflex, and this page can show three drafts at once. The server
 * checks it too, so the control is a prompt rather than the guard.
 *
 * **Content is rendered as plain text, never as HTML.** It is Markdown authored by
 * a person and read by every user; passing it through `v-html` anywhere would be
 * an XSS surface pointed at the whole product. The Mini App renders it the same
 * way, for the same reason.
 *
 * **A published version has no edit control at all**, rather than a disabled one.
 * Immutability is what makes a consent record mean something, and a greyed-out
 * button invites somebody to make it work.
 */
const session = useSessionStore();

const policies = ref<AdminPolicyView[] | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const canDraft = computed(() => session.can(PERMISSIONS.POLICY_MANAGE));
const canPublish = computed(() => session.can(PERMISSIONS.POLICY_PUBLISH));
const canReadConsents = computed(() => session.can(PERMISSIONS.POLICY_CONSENT_READ));

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (policies.value === null) return 'loading' as const;
  return policies.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

const TYPE_LABELS: Record<string, string> = {
  TERMS: 'قوانین و شرایط',
  PRIVACY: 'حریم خصوصی',
  COMMUNITY: 'آیین‌نامهٔ رفتار',
};

/** Grouped by document, newest version first inside each. */
const grouped = computed(() => {
  const byType = new Map<string, AdminPolicyView[]>();
  for (const policy of policies.value ?? []) {
    const list = byType.get(policy.type) ?? [];
    list.push(policy);
    byType.set(policy.type, list);
  }
  return [...byType.entries()].map(([type, versions]) => ({ type, versions }));
});

async function load(): Promise<void> {
  error.value = null;
  try {
    const response = await request<AdminPolicyListResponse>('/policies');
    policies.value = response.policies;
  } catch (cause) {
    error.value = messageOf(cause, 'اسناد حقوقی بارگذاری نشد.');
  }
}

// ── Drafting ────────────────────────────────────────────────────────────────

const drafting = ref(false);
const draftBusy = ref(false);
const draftError = ref<string | null>(null);
const draftForm = ref({
  type: 'TERMS' as 'TERMS' | 'PRIVACY' | 'COMMUNITY',
  titleFa: '',
  contentMd: '',
  summaryFa: '',
  changeSummaryFa: '',
});

/**
 * Start a new draft, pre-filled from the current version of the same type.
 *
 * Copying the published text is what makes "change one clause" a realistic
 * action. It is a copy into a *new* row — the published one is never touched —
 * which is the whole reason the next version starts from it rather than from a
 * blank page somebody re-types the unchanged 95% into.
 */
function openDraft(type: 'TERMS' | 'PRIVACY' | 'COMMUNITY'): void {
  const current = (policies.value ?? []).find((policy) => policy.type === type && policy.isCurrent);
  draftForm.value = {
    type,
    titleFa: current?.titleFa ?? TYPE_LABELS[type] ?? type,
    contentMd: current?.contentMd ?? '',
    summaryFa: current?.summaryFa ?? '',
    changeSummaryFa: '',
  };
  draftError.value = null;
  drafting.value = true;
}

const draftValid = computed(
  () => draftForm.value.titleFa.trim().length >= 2 && draftForm.value.contentMd.trim().length >= 50,
);

async function submitDraft(): Promise<void> {
  if (draftBusy.value || !draftValid.value) return;
  draftBusy.value = true;
  draftError.value = null;
  try {
    await request<AdminPolicyView>('/policies', {
      method: 'POST',
      body: {
        type: draftForm.value.type,
        titleFa: draftForm.value.titleFa.trim(),
        contentMd: draftForm.value.contentMd.trim(),
        ...(draftForm.value.summaryFa.trim() !== ''
          ? { summaryFa: draftForm.value.summaryFa.trim() }
          : {}),
        ...(draftForm.value.changeSummaryFa.trim() !== ''
          ? { changeSummaryFa: draftForm.value.changeSummaryFa.trim() }
          : {}),
      },
    });
    drafting.value = false;
    notice.value = 'پیش‌نویس ساخته شد. تا زمانی که منتشر نشود، به کاربران نمایش داده نمی‌شود.';
    await load();
  } catch (cause) {
    draftError.value = messageOf(cause, 'ساخت پیش‌نویس انجام نشد.');
  } finally {
    draftBusy.value = false;
  }
}

// ── Editing an open draft ───────────────────────────────────────────────────

const editingId = ref<string | null>(null);
const editForm = ref({ titleFa: '', contentMd: '', changeSummaryFa: '', expectedRevision: 0 });
const editBusy = ref(false);
const editError = ref<string | null>(null);

function openEdit(policy: AdminPolicyView): void {
  editingId.value = policy.id;
  editForm.value = {
    titleFa: policy.titleFa ?? '',
    contentMd: policy.contentMd,
    changeSummaryFa: policy.changeSummaryFa ?? '',
    // Held from the moment the form opened. If somebody else saves in the
    // meantime the server refuses this one rather than overwriting theirs.
    expectedRevision: policy.revision,
  };
  editError.value = null;
}

async function submitEdit(): Promise<void> {
  if (editingId.value === null || editBusy.value) return;
  editBusy.value = true;
  editError.value = null;
  try {
    await request<AdminPolicyView>(`/policies/${editingId.value}`, {
      method: 'PATCH',
      body: {
        expectedRevision: editForm.value.expectedRevision,
        titleFa: editForm.value.titleFa.trim(),
        contentMd: editForm.value.contentMd.trim(),
        changeSummaryFa:
          editForm.value.changeSummaryFa.trim() === ''
            ? null
            : editForm.value.changeSummaryFa.trim(),
      },
    });
    editingId.value = null;
    notice.value = 'پیش‌نویس ذخیره شد.';
    await load();
  } catch (cause) {
    editError.value = messageOf(cause, 'ذخیرهٔ پیش‌نویس انجام نشد.');
  } finally {
    editBusy.value = false;
  }
}

// ── Publishing ──────────────────────────────────────────────────────────────

const publishing = ref<AdminPolicyView | null>(null);
const publishConfirm = ref('');
const publishReason = ref('');
const publishBusy = ref(false);
const publishError = ref<string | null>(null);

function openPublish(policy: AdminPolicyView): void {
  publishing.value = policy;
  publishConfirm.value = '';
  publishReason.value = '';
  publishError.value = null;
}

const publishValid = computed(
  () =>
    publishing.value !== null &&
    Number(publishConfirm.value) === publishing.value.version &&
    publishReason.value.trim().length >= 3,
);

async function submitPublish(): Promise<void> {
  const policy = publishing.value;
  if (policy === null || publishBusy.value || !publishValid.value) return;
  publishBusy.value = true;
  publishError.value = null;
  try {
    await request<AdminPolicyView>(`/policies/${policy.id}/publish`, {
      method: 'POST',
      body: { confirmVersion: Number(publishConfirm.value), reason: publishReason.value.trim() },
    });
    publishing.value = null;
    notice.value =
      'نسخه منتشر شد. از این پس کاربران برای ادامهٔ استفاده باید آن را بپذیرند و نسخه‌های پیشین دست‌نخورده باقی می‌مانند.';
    await load();
  } catch (cause) {
    publishError.value = messageOf(cause, 'انتشار انجام نشد.');
  } finally {
    publishBusy.value = false;
  }
}

async function archive(policy: AdminPolicyView): Promise<void> {
  const reason = window.prompt('دلیل بایگانی این نسخه؟');
  if (reason === null || reason.trim().length < 3) return;
  try {
    await request<AdminPolicyView>(`/policies/${policy.id}/archive`, {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    notice.value = 'نسخه بایگانی شد. سوابق پذیرش آن دست‌نخورده است.';
    await load();
  } catch (cause) {
    error.value = messageOf(cause, 'بایگانی انجام نشد.');
  }
}

// ── The acceptance log ──────────────────────────────────────────────────────

const consentsFor = ref<AdminPolicyView | null>(null);
const consents = ref<PolicyConsentResponse | null>(null);
const consentsError = ref<string | null>(null);

async function openConsents(policy: AdminPolicyView): Promise<void> {
  consentsFor.value = policy;
  consents.value = null;
  consentsError.value = null;
  try {
    consents.value = await request<PolicyConsentResponse>(
      `/policy-consents?policyVersionId=${encodeURIComponent(policy.id)}&limit=100`,
    );
  } catch (cause) {
    consentsError.value = messageOf(cause, 'سوابق پذیرش بارگذاری نشد.');
  }
}

onMounted(load);
</script>

<template>
  <StateBlock
    :state="state"
    :error-text="error"
    empty-text="هنوز هیچ سندی ثبت نشده است."
    :rows="4"
    @retry="load"
  >
    <div class="flex flex-col gap-5">
      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <div v-if="canDraft" class="flex flex-wrap gap-2">
        <button
          v-for="type in ['TERMS', 'PRIVACY', 'COMMUNITY']"
          :key="type"
          type="button"
          class="min-h-10 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
          :disabled="!session.canMutate"
          @click="openDraft(type as 'TERMS' | 'PRIVACY' | 'COMMUNITY')"
        >
          نسخهٔ تازهٔ «{{ TYPE_LABELS[type] }}»
        </button>
      </div>

      <!-- ── The draft form ───────────────────────────────────────────── -->
      <section v-if="drafting" class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">پیش‌نویس تازه — {{ TYPE_LABELS[draftForm.type] }}</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          متن از نسخهٔ جاری کپی شده است تا فقط بندهای تغییریافته را ویرایش کنید. تا زمانی که منتشر
          نشود هیچ کاربری آن را نمی‌بیند، و شمارهٔ نسخه را سرور تعیین می‌کند.
        </p>

        <div class="mt-3 grid gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">عنوان</span>
            <input
              v-model="draftForm.titleFa"
              type="text"
              maxlength="120"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">خلاصه (اختیاری)</span>
            <input
              v-model="draftForm.summaryFa"
              type="text"
              maxlength="280"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">چه چیزی نسبت به نسخهٔ قبل تغییر کرده؟</span>
            <input
              v-model="draftForm.changeSummaryFa"
              type="text"
              maxlength="1000"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">متن سند (دست‌کم ۵۰ نویسه)</span>
            <textarea
              v-model="draftForm.contentMd"
              rows="16"
              class="rounded-lg border border-line bg-surface p-3 font-mono text-sm"
            ></textarea>
          </label>
        </div>

        <p v-if="draftError" class="mt-2 text-sm text-danger" role="alert">{{ draftError }}</p>

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="!draftValid || draftBusy"
            @click="submitDraft"
          >
            {{ draftBusy ? 'در حال ذخیره…' : 'ذخیرهٔ پیش‌نویس' }}
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm"
            @click="drafting = false"
          >
            انصراف
          </button>
        </div>
      </section>

      <!-- ── Versions, grouped by document ────────────────────────────── -->
      <section v-for="group in grouped" :key="group.type" class="flex flex-col gap-3">
        <h2 class="text-base font-semibold">{{ TYPE_LABELS[group.type] ?? group.type }}</h2>

        <article
          v-for="policy in group.versions"
          :key="policy.id"
          class="rounded-xl border border-line bg-surface p-4"
          :class="policy.isCurrent ? 'border-good' : ''"
        >
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <span class="font-medium"
                >نسخهٔ <bdi>{{ formatNumber(policy.version) }}</bdi></span
              >
              <StatusPill :value="policy.status" />
              <span
                v-if="policy.isCurrent"
                class="rounded-full bg-good-soft px-2 py-0.5 text-xs text-good"
              >
                نسخهٔ جاری
              </span>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                v-if="canDraft && policy.status === 'DRAFT'"
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="openEdit(policy)"
              >
                ویرایش
              </button>
              <button
                v-if="canPublish && policy.status === 'DRAFT'"
                type="button"
                class="min-h-9 rounded-lg bg-brand px-3 text-xs text-brand-ink disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="openPublish(policy)"
              >
                انتشار
              </button>
              <button
                v-if="canPublish && policy.status === 'PUBLISHED' && !policy.isCurrent"
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                :disabled="!session.canMutate"
                @click="archive(policy)"
              >
                بایگانی
              </button>
              <button
                v-if="canReadConsents"
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-xs"
                @click="openConsents(policy)"
              >
                سوابق پذیرش
              </button>
            </div>
          </header>

          <dl class="mt-2 grid gap-x-6 gap-y-1 text-xs text-ink-faint sm:grid-cols-3">
            <div>
              <dt class="inline">عنوان:</dt>
              <dd class="inline">{{ policy.titleFa ?? '—' }}</dd>
            </div>
            <div>
              <dt class="inline">پذیرش‌ها:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(policy.acceptanceCount) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">انتشار:</dt>
              <dd class="inline">
                {{ policy.publishedAt ? formatDate(policy.publishedAt) : '—' }}
              </dd>
            </div>
          </dl>

          <p v-if="policy.changeSummaryFa" class="mt-2 text-sm text-ink-soft">
            تغییرات: {{ policy.changeSummaryFa }}
          </p>

          <!-- ── Editing this draft ─────────────────────────────────── -->
          <div v-if="editingId === policy.id" class="mt-3 grid gap-3 border-t border-line pt-3">
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">عنوان</span>
              <input
                v-model="editForm.titleFa"
                type="text"
                maxlength="120"
                class="min-h-10 rounded-lg border border-line bg-surface px-3"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">تغییرات نسبت به نسخهٔ قبل</span>
              <input
                v-model="editForm.changeSummaryFa"
                type="text"
                maxlength="1000"
                class="min-h-10 rounded-lg border border-line bg-surface px-3"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">متن سند</span>
              <textarea
                v-model="editForm.contentMd"
                rows="16"
                class="rounded-lg border border-line bg-surface p-3 font-mono text-sm"
              ></textarea>
            </label>

            <p v-if="editError" class="text-sm text-danger" role="alert">{{ editError }}</p>

            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
                :disabled="editBusy"
                @click="submitEdit"
              >
                {{ editBusy ? 'در حال ذخیره…' : 'ذخیره' }}
              </button>
              <button
                type="button"
                class="min-h-10 rounded-lg border border-line px-4 text-sm"
                @click="editingId = null"
              >
                انصراف
              </button>
            </div>
          </div>

          <!--
            Plain text, never `v-html`. This is Markdown a person typed and every
            user reads; rendering it as HTML would point an XSS surface at the whole
            product. The Mini App shows it the same way.
          -->
          <details v-else class="mt-2">
            <summary class="cursor-pointer text-xs text-ink-soft">دیدن متن</summary>
            <pre
              class="mt-2 max-h-96 overflow-auto rounded-lg bg-surface-sunken p-3 text-xs leading-6 whitespace-pre-wrap"
              >{{ policy.contentMd }}</pre>
          </details>
        </article>
      </section>

      <!-- ── Publish confirmation ─────────────────────────────────────── -->
      <section
        v-if="publishing"
        class="rounded-xl border border-danger bg-surface p-4"
        role="dialog"
        aria-modal="false"
      >
        <h2 class="text-sm font-semibold text-danger">
          انتشار «{{ TYPE_LABELS[publishing.type] }}» نسخهٔ
          <bdi>{{ formatNumber(publishing.version) }}</bdi>
        </h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          پس از انتشار، همهٔ کاربران برای ادامهٔ استفاده باید این نسخه را بپذیرند. نسخه‌های پیشین
          تغییر نمی‌کنند و سوابق پذیرش آن‌ها دست‌نخورده می‌ماند. این کار برگشت‌پذیر نیست؛ برای تغییر
          باید نسخهٔ تازه‌ای منتشر کنید.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">
              برای تأیید، شمارهٔ نسخه را بنویسید ({{ publishing.version }})
            </span>
            <input
              v-model="publishConfirm"
              type="text"
              inputmode="numeric"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">دلیل (دست‌کم ۳ نویسه)</span>
            <input
              v-model="publishReason"
              type="text"
              maxlength="280"
              class="min-h-10 rounded-lg border border-line bg-surface px-3"
            />
          </label>
        </div>

        <p v-if="publishError" class="mt-2 text-sm text-danger" role="alert">{{ publishError }}</p>

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-danger px-4 text-sm text-white disabled:opacity-40"
            :disabled="!publishValid || publishBusy"
            @click="submitPublish"
          >
            {{ publishBusy ? 'در حال انتشار…' : 'انتشار نسخه' }}
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm"
            @click="publishing = null"
          >
            انصراف
          </button>
        </div>
      </section>

      <!-- ── The acceptance log ───────────────────────────────────────── -->
      <section v-if="consentsFor" class="rounded-xl border border-line bg-surface p-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-semibold">
            سوابق پذیرش — {{ TYPE_LABELS[consentsFor.type] }} نسخهٔ
            <bdi>{{ formatNumber(consentsFor.version) }}</bdi>
          </h2>
          <button type="button" class="min-h-9 text-sm text-ink-soft" @click="consentsFor = null">
            بستن
          </button>
        </div>

        <p v-if="consentsError" class="mt-2 text-sm text-danger">{{ consentsError }}</p>
        <p v-else-if="consents === null" class="mt-2 text-sm text-ink-faint">در حال بارگذاری…</p>
        <p v-else-if="consents.total === 0" class="mt-2 text-sm text-ink-faint">
          هنوز کسی این نسخه را نپذیرفته است.
        </p>

        <div v-else class="mt-2 overflow-x-auto">
          <p class="mb-2 text-xs text-ink-faint">
            مجموع: <bdi>{{ formatNumber(consents.total) }}</bdi> — ۱۰۰ مورد نخست
          </p>
          <table class="w-full text-sm">
            <thead class="text-xs text-ink-faint">
              <tr>
                <th class="p-2 text-start">کاربر</th>
                <th class="p-2 text-start">نسخه</th>
                <th class="p-2 text-start">زمینه</th>
                <th class="p-2 text-start">زمان</th>
                <th class="p-2 text-start">نسخهٔ برنامه</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in consents.consents"
                :key="row.userPublicId"
                class="border-t border-line"
              >
                <td class="p-2">
                  <bdi class="font-mono text-xs">{{ row.userPublicId }}</bdi>
                </td>
                <td class="p-2">
                  <bdi>{{ row.label ?? '—' }}</bdi>
                </td>
                <td class="p-2">{{ row.context === 'REACCEPT' ? 'پذیرش دوباره' : 'ثبت‌نام' }}</td>
                <td class="p-2">{{ formatDate(row.acceptedAt) }}</td>
                <td class="p-2">
                  <bdi>{{ row.appVersion ?? '—' }}</bdi>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </StateBlock>
</template>
