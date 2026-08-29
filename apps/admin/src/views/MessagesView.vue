<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  PERMISSIONS,
  TELEGRAM_MESSAGE_LIMIT,
  validateTelegramMessage,
  type AdminCityListResponse,
  type MessageCampaignListResponse,
  type MessageCampaignView,
  type MessagePreviewResponse,
} from '@payetam/shared';
import { messageOf, newIdempotencyKey, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatNumber } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * Sending a Telegram message from the panel (M22 phase 4).
 *
 * ── Three buttons, in an order that cannot be shortcut ───────────────────────
 *
 * **پیش‌نمایش** asks the server how many people an audience reaches and writes
 * nothing. **ثبت پیش‌نویس** records the campaign and materialises its recipients,
 * still sending nothing. **ارسال** is the only one that delivers, and it is a
 * separate request against a campaign that already exists — so a slip on the
 * first two costs nothing and the third has the recipient count in front of it.
 *
 * ── The idempotency key is minted when the form opens ────────────────────────
 *
 * Not when it is submitted, and that is the whole point: a key generated per
 * click would make a double-tap two campaigns, which is exactly what it exists to
 * prevent. It is regenerated only when the operator starts a *new* message.
 *
 * ── The body is validated here and again on the server ───────────────────────
 *
 * `validateTelegramMessage` is the same function the API runs (ADR-0003), so the
 * two cannot disagree about what Telegram will accept. Doing it here means an
 * operator sees «تگ ناشناخته: div» while typing rather than after pressing send.
 */
const session = useSessionStore();

const canSend = computed(() => session.can(PERMISSIONS.MESSAGE_SEND));
const canBroadcast = computed(() => session.can(PERMISSIONS.MESSAGE_BROADCAST));

const campaigns = ref<MessageCampaignView[] | null>(null);
const total = ref(0);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  return campaigns.value === null ? ('loading' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    const response = await request<MessageCampaignListResponse>('/messages?limit=25');
    campaigns.value = response.campaigns;
    total.value = response.total;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست پیام‌ها بارگذاری نشد.');
  }
}

// ── Composing ───────────────────────────────────────────────────────────────

const bodyText = ref('');
const useHtml = ref(false);
const idempotencyKey = ref(newIdempotencyKey());

const audienceMode = ref<'users' | 'filter'>('users');
const userIds = ref('');
const cityIds = ref<string[]>([]);
const onlyComplete = ref<'' | 'true' | 'false'>('');
const onlyHosts = ref(false);
const everyone = ref(false);

const cities = ref<{ id: string; nameFa: string }[]>([]);

const parseMode = computed<'HTML' | undefined>(() => (useHtml.value ? 'HTML' : undefined));

/** The same verdict the server will reach, so the two cannot disagree. */
const verdict = computed(() => validateTelegramMessage(bodyText.value, parseMode.value));

const problemText = computed(() =>
  verdict.value.problems.map((problem) => {
    switch (problem.kind) {
      case 'EMPTY':
        return 'متن پیام خالی است.';
      case 'TOO_LONG':
        return `متن ${formatNumber(problem.length)} نویسه است؛ سقف تلگرام ${formatNumber(problem.limit)} نویسه است.`;
      case 'UNKNOWN_TAG':
        return `تگ ناشناخته: ${problem.tag}`;
      case 'UNCLOSED_TAG':
        return `تگ بسته‌نشده: ${problem.tag}`;
      case 'UNEXPECTED_CLOSING_TAG':
        return `تگ بستهٔ اضافه: ${problem.tag}`;
      case 'UNSAFE_LINK':
        return 'فقط پیوند https پذیرفته می‌شود.';
      case 'UNSUPPORTED_ATTRIBUTE':
        return `ویژگی پشتیبانی‌نشده روی ${problem.tag}: ${problem.attribute}`;
    }
  }),
);

/** The audience, as the API takes it. Empty keys are omitted, never sent as null. */
function buildAudience(): Record<string, unknown> {
  if (audienceMode.value === 'users') {
    const ids = userIds.value
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter((id) => id !== '');
    return ids.length > 0 ? { userPublicIds: ids } : {};
  }

  const audience: Record<string, unknown> = {};
  if (everyone.value) audience['everyone'] = true;
  if (cityIds.value.length > 0) audience['cityIds'] = cityIds.value;
  if (onlyComplete.value !== '') audience['profileComplete'] = onlyComplete.value === 'true';
  if (onlyHosts.value) audience['hasHostedEvent'] = true;
  return audience;
}

const audienceReady = computed(() => Object.keys(buildAudience()).length > 0);
const composeReady = computed(() => verdict.value.ok && audienceReady.value);

const preview = ref<MessagePreviewResponse | null>(null);
const busy = ref(false);
const composeError = ref<string | null>(null);

async function runPreview(): Promise<void> {
  if (busy.value || !composeReady.value) return;
  busy.value = true;
  composeError.value = null;
  try {
    preview.value = await request<MessagePreviewResponse>('/messages/preview', {
      method: 'POST',
      body: {
        bodyText: bodyText.value,
        ...(parseMode.value !== undefined ? { parseMode: parseMode.value } : {}),
        audience: buildAudience(),
      },
    });
  } catch (cause) {
    composeError.value = messageOf(cause, 'پیش‌نمایش انجام نشد.');
  } finally {
    busy.value = false;
  }
}

async function createDraft(dryRun: boolean): Promise<void> {
  if (busy.value || !composeReady.value) return;
  busy.value = true;
  composeError.value = null;
  try {
    await request<MessageCampaignView>('/messages', {
      method: 'POST',
      body: {
        bodyText: bodyText.value,
        ...(parseMode.value !== undefined ? { parseMode: parseMode.value } : {}),
        audience: buildAudience(),
        dryRun,
        idempotencyKey: idempotencyKey.value,
      },
    });
    notice.value = dryRun
      ? 'اجرای آزمایشی ثبت شد. هیچ پیامی ارسال نشد.'
      : 'پیش‌نویس ثبت شد. برای ارسال، آن را از فهرست زیر تأیید کنید.';
    await load();
  } catch (cause) {
    composeError.value = messageOf(cause, 'ثبت پیام انجام نشد.');
  } finally {
    busy.value = false;
  }
}

/** A *new* message, so a new key. The old one belongs to the campaign it made. */
function resetCompose(): void {
  bodyText.value = '';
  preview.value = null;
  composeError.value = null;
  idempotencyKey.value = newIdempotencyKey();
}

// ── Confirming, cancelling, resuming ────────────────────────────────────────

const pendingConfirm = ref<MessageCampaignView | null>(null);
const actionBusy = ref(false);

const confirmBody = computed(() => {
  const campaign = pendingConfirm.value;
  if (campaign === null) return '';
  return (
    `این پیام برای ${formatNumber(campaign.counts.total)} نفر در صف ارسال قرار می‌گیرد. ` +
    'ارسال برگشت‌پذیر نیست — پیام‌هایی که تحویل شده‌اند قابل بازگرداندن نیستند. ' +
    'می‌توانید ارسال را نیمه‌کاره لغو کنید؛ در آن صورت فقط گیرندگان باقی‌مانده حذف می‌شوند.'
  );
});

async function act(
  campaign: MessageCampaignView,
  action: 'confirm' | 'cancel' | 'resume',
): Promise<void> {
  actionBusy.value = true;
  error.value = null;
  try {
    await request<MessageCampaignView>(`/messages/${campaign.publicId}/${action}`, {
      method: 'POST',
      body: {},
    });
    pendingConfirm.value = null;
    notice.value =
      action === 'confirm'
        ? 'ارسال آغاز شد. وضعیت را در همین صفحه دنبال کنید.'
        : action === 'cancel'
          ? 'ارسال لغو شد. گیرندگان باقی‌مانده حذف شدند.'
          : 'ارسال از سر گرفته شد.';
    await load();
  } catch (cause) {
    error.value = messageOf(cause, 'انجام نشد.');
  } finally {
    actionBusy.value = false;
  }
}

onMounted(async () => {
  await load();
  if (session.can(PERMISSIONS.CATALOG_MANAGE)) {
    try {
      const response = await request<AdminCityListResponse>('/cities?isActive=true&limit=200');
      cities.value = response.cities.map((city) => ({ id: city.id, nameFa: city.nameFa }));
    } catch {
      // The city filter is a convenience. Losing it must not take the screen down.
      cities.value = [];
    }
  }
});
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="4" @retry="load">
    <div class="flex flex-col gap-5">
      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <!-- ── Composing ────────────────────────────────────────────────── -->
      <section v-if="canSend" class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">پیام تازه</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          هیچ‌کدام از دکمه‌های این بخش پیامی نمی‌فرستد. ارسال واقعی فقط با تأیید یک پیش‌نویس در
          فهرست پایین انجام می‌شود. کاربران مسدودشده، حذف‌شده و کسانی که ربات را بلاک کرده‌اند
          به‌طور خودکار کنار گذاشته می‌شوند.
        </p>

        <label class="mt-3 flex flex-col gap-1">
          <span class="text-sm text-ink-soft">
            متن پیام
            <bdi class="text-ink-faint">
              ({{ formatNumber(bodyText.length) }}/{{ formatNumber(TELEGRAM_MESSAGE_LIMIT) }})
            </bdi>
          </span>
          <textarea
            v-model="bodyText"
            rows="6"
            class="rounded-lg border border-line bg-surface p-3"
          ></textarea>
        </label>

        <label class="mt-2 flex items-center gap-2">
          <input v-model="useHtml" type="checkbox" class="size-4" />
          <span class="text-sm text-ink-soft">
            قالب‌بندی HTML تلگرام (b، i، u، s، code، pre، blockquote، a)
          </span>
        </label>
        <p v-if="!useHtml" class="mt-1 text-xs text-ink-faint">
          بدون قالب‌بندی، متن دقیقاً همان‌طور که نوشته‌اید نمایش داده می‌شود.
        </p>

        <ul v-if="bodyText !== '' && !verdict.ok" class="mt-2 space-y-1">
          <li v-for="(problem, index) in problemText" :key="index" class="text-sm text-danger">
            {{ problem }}
          </li>
        </ul>

        <!-- ── The audience ───────────────────────────────────────────── -->
        <fieldset class="mt-4 flex flex-col gap-2">
          <legend class="text-sm font-medium">گیرندگان</legend>

          <div class="flex gap-3">
            <label class="flex items-center gap-2">
              <input v-model="audienceMode" type="radio" value="users" class="size-4" />
              <span class="text-sm">فهرست مشخص</span>
            </label>
            <label class="flex items-center gap-2">
              <input
                v-model="audienceMode"
                type="radio"
                value="filter"
                class="size-4"
                :disabled="!canBroadcast"
              />
              <span class="text-sm" :class="canBroadcast ? '' : 'text-ink-faint'">
                فیلتر {{ canBroadcast ? '' : '(نیازمند دسترسی ارسال گروهی)' }}
              </span>
            </label>
          </div>

          <label v-if="audienceMode === 'users'" class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">شناسهٔ عمومی کاربران، جدا با فاصله یا ویرگول</span>
            <textarea
              v-model="userIds"
              rows="2"
              dir="ltr"
              class="rounded-lg border border-line bg-surface p-3 font-mono text-xs"
            ></textarea>
          </label>

          <div v-else class="grid gap-3 sm:grid-cols-3">
            <label class="flex items-center gap-2 sm:col-span-3">
              <input v-model="everyone" type="checkbox" class="size-4" />
              <span class="text-sm text-danger">همهٔ کاربران</span>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">شهرها</span>
              <select
                v-model="cityIds"
                multiple
                size="5"
                class="rounded-lg border border-line bg-surface px-3 py-2"
              >
                <option v-for="city in cities" :key="city.id" :value="city.id">
                  {{ city.nameFa }}
                </option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm text-ink-soft">تکمیل پروفایل</span>
              <select
                v-model="onlyComplete"
                class="min-h-10 rounded-lg border border-line bg-surface px-3"
              >
                <option value="">مهم نیست</option>
                <option value="true">فقط کامل</option>
                <option value="false">فقط ناتمام</option>
              </select>
            </label>
            <label class="flex items-center gap-2">
              <input v-model="onlyHosts" type="checkbox" class="size-4" />
              <span class="text-sm text-ink-soft">فقط میزبان‌ها</span>
            </label>
          </div>
        </fieldset>

        <p v-if="preview" class="mt-3 rounded-lg bg-neutral-soft px-4 py-2 text-sm" role="status">
          این پیام به <bdi class="font-bold">{{ formatNumber(preview.recipients) }}</bdi> نفر
          می‌رسد.
          <span class="text-ink-faint">
            فیلترها: {{ preview.appliedFilters.join('، ') || 'بدون فیلتر' }}
          </span>
        </p>

        <p v-if="composeError" class="mt-2 text-sm text-danger" role="alert">{{ composeError }}</p>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
            :disabled="!composeReady || busy || !session.canMutate"
            @click="runPreview"
          >
            پیش‌نمایش گیرندگان
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
            :disabled="!composeReady || busy || !session.canMutate"
            @click="createDraft(true)"
          >
            اجرای آزمایشی
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="!composeReady || busy || !session.canMutate"
            @click="createDraft(false)"
          >
            ثبت پیش‌نویس
          </button>
          <button
            type="button"
            class="min-h-10 rounded-lg px-4 text-sm text-ink-soft"
            @click="resetCompose"
          >
            پاک کردن
          </button>
        </div>
      </section>

      <!-- ── The list ─────────────────────────────────────────────────── -->
      <section class="flex flex-col gap-3">
        <h2 class="text-base font-semibold">
          پیام‌های اخیر <bdi class="text-sm text-ink-faint">({{ formatNumber(total) }})</bdi>
        </h2>

        <article
          v-for="campaign in campaigns ?? []"
          :key="campaign.publicId"
          class="rounded-xl border border-line bg-surface p-4"
        >
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <StatusPill :value="campaign.status" />
              <span
                v-if="campaign.dryRun"
                class="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"
              >
                اجرای آزمایشی
              </span>
              <span
                v-if="campaign.pausedAt"
                class="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger"
              >
                متوقف‌شده
              </span>
              <span class="text-xs text-ink-faint">{{ formatDate(campaign.createdAt) }}</span>
            </div>

            <div v-if="canSend && session.canMutate" class="flex flex-wrap gap-2">
              <button
                v-if="campaign.status === 'DRAFT' && !campaign.dryRun"
                type="button"
                class="min-h-9 rounded-lg bg-brand px-3 text-xs text-brand-ink disabled:opacity-40"
                :disabled="actionBusy"
                @click="pendingConfirm = campaign"
              >
                ارسال
              </button>
              <button
                v-if="['DRAFT', 'QUEUED', 'SENDING'].includes(campaign.status)"
                type="button"
                class="min-h-9 rounded-lg border border-danger px-3 text-xs text-danger disabled:opacity-40"
                :disabled="actionBusy"
                @click="act(campaign, 'cancel')"
              >
                لغو
              </button>
              <button
                v-if="campaign.pausedAt"
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-xs disabled:opacity-40"
                :disabled="actionBusy"
                @click="act(campaign, 'resume')"
              >
                از سرگیری
              </button>
            </div>
          </header>

          <p class="mt-2 max-h-24 overflow-auto text-sm whitespace-pre-wrap">
            {{ campaign.bodyText }}
          </p>

          <dl class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-faint">
            <div>
              <dt class="inline">گیرندگان:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.total) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">در صف:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.pending) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">ارسال‌شده:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.sent) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">محدودشده:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.rateLimited) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">بلاک‌کرده:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.blocked) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">نامعتبر:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.invalid) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">ناموفق:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.failed) }}</bdi>
              </dd>
            </div>
            <div>
              <dt class="inline">حذف‌شده:</dt>
              <dd class="inline">
                <bdi>{{ formatNumber(campaign.counts.skipped) }}</bdi>
              </dd>
            </div>
          </dl>

          <p v-if="campaign.pauseReason" class="mt-1 text-xs text-danger">
            دلیل توقف: {{ campaign.pauseReason }}
          </p>
        </article>

        <p v-if="(campaigns ?? []).length === 0" class="text-sm text-ink-faint">
          هنوز پیامی ثبت نشده است.
        </p>
      </section>

      <ConfirmDialog
        :open="pendingConfirm !== null"
        title="ارسال پیام به گیرندگان"
        :body="confirmBody"
        confirm-label="بله، ارسال شود"
        tone="danger"
        confirm-word="ارسال"
        :busy="actionBusy"
        @cancel="pendingConfirm = null"
        @confirm="pendingConfirm && act(pendingConfirm, 'confirm')"
      />
    </div>
  </StateBlock>
</template>
