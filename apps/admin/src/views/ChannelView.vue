<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ChannelConfigView, GatedActionView } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import { useSessionStore } from '@/stores/session';

/**
 * The event channel, and whether joining it is required (M22 phase 6).
 *
 * ── The one control that can break the product ───────────────────────────────
 *
 * Switching «عضویت اجباری» on with a channel the bot cannot see refuses every
 * gated action for every user at once. So it is the only setting on this screen
 * behind a typed confirmation, the reasons not to do it are rendered *above* the
 * switch rather than after it, and the API refuses outright when there is nowhere
 * to send people.
 *
 * The mitigation that actually matters is not in this screen, though: the gate
 * **fails open** on every outcome except an authoritative "not a member", so a
 * misconfiguration degrades the requirement rather than the product. This page
 * exists to make the misconfiguration visible rather than to be the only thing
 * standing between it and an outage.
 *
 * ── What is not here ─────────────────────────────────────────────────────────
 *
 * The bot token and `TELEGRAM_CHANNEL_ID`. Both are environment variables: a
 * *posting* destination editable from a web session is one an attacker with a
 * session can redirect, and a token in a form is a token in a browser's memory.
 */
const session = useSessionStore();

const config = ref<ChannelConfigView | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const form = ref({
  chatIdentifier: '',
  publicUsername: '',
  inviteUrl: '',
  verifyViaTelegram: true,
  requiredActions: [] as GatedActionView[],
});

const pendingEnable = ref(false);

const state = computed(() => {
  if (error.value !== null && config.value === null) return 'error' as const;
  return config.value === null ? ('loading' as const) : ('ready' as const);
});

const ACTION_LABELS: Record<GatedActionView, string> = {
  EVENT_CREATE: 'ساخت فعالیت',
  EVENT_JOIN: 'درخواست پیوستن به فعالیت',
  EVENT_CHANNEL_SEND: 'انتشار فعالیت در کانال',
  EVENT_INVITE: 'ارسال دعوت‌نامه',
};

const WARNING_LABELS: Record<string, string> = {
  NO_JOIN_LINK: 'پیوند عضویت تنظیم نشده است — کاربر جایی برای رفتن ندارد.',
  NO_CHAT_IDENTIFIER:
    'شناسهٔ کانال تنظیم نشده است، پس عضویت قابل بررسی نیست و همه اجازهٔ عبور می‌گیرند.',
  NO_ACTIONS_SELECTED: 'هیچ عملیاتی برای اجبار انتخاب نشده است، پس این تنظیم اثری ندارد.',
};

function hydrate(next: ChannelConfigView): void {
  config.value = next;
  form.value = {
    chatIdentifier: next.chatIdentifier ?? '',
    publicUsername: next.publicUsername ?? '',
    inviteUrl: next.inviteUrl ?? '',
    verifyViaTelegram: next.verifyViaTelegram,
    requiredActions: [...next.requiredActions],
  };
}

async function load(): Promise<void> {
  error.value = null;
  try {
    hydrate(await request<ChannelConfigView>('/channel-config'));
  } catch (cause) {
    error.value = messageOf(cause, 'تنظیمات کانال بارگذاری نشد.');
  }
}

/** Every field except the requirement switch, which has its own path. */
async function save(extra: Record<string, unknown> = {}): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    hydrate(
      await request<ChannelConfigView>('/channel-config', {
        method: 'PUT',
        body: {
          // Empty means "clear it", which the API distinguishes from absent.
          chatIdentifier:
            form.value.chatIdentifier.trim() === '' ? null : form.value.chatIdentifier,
          publicUsername:
            form.value.publicUsername.trim() === '' ? null : form.value.publicUsername,
          inviteUrl: form.value.inviteUrl.trim() === '' ? null : form.value.inviteUrl,
          verifyViaTelegram: form.value.verifyViaTelegram,
          requiredActions: form.value.requiredActions,
          ...extra,
        },
      }),
    );
    pendingEnable.value = false;
    notice.value = 'تنظیمات کانال ذخیره شد.';
  } catch (cause) {
    error.value = messageOf(cause, 'ذخیرهٔ تنظیمات انجام نشد.');
  } finally {
    busy.value = false;
  }
}

function toggleAction(action: GatedActionView): void {
  const index = form.value.requiredActions.indexOf(action);
  if (index === -1) form.value.requiredActions.push(action);
  else form.value.requiredActions.splice(index, 1);
}

const enableBody = computed(
  () =>
    'با روشن کردن این گزینه، کاربرانی که عضو کانال نیستند نمی‌توانند عملیات انتخاب‌شده را انجام ' +
    'دهند. اگر ربات نتواند عضویت را بررسی کند — کانال در دسترس نباشد، ربات ادمین نباشد، یا تلگرام ' +
    'پاسخ ندهد — کاربر اجازهٔ عبور می‌گیرد و محصول متوقف نمی‌شود. فقط پاسخ قطعی «عضو نیست» مانع ' +
    'انجام کار می‌شود.',
);

onMounted(load);
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="3" @retry="load">
    <div v-if="config" class="flex max-w-3xl flex-col gap-5">
      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>
      <p v-if="error" class="rounded-lg bg-danger-soft px-4 py-2 text-sm text-danger" role="alert">
        {{ error }}
      </p>

      <!-- ── Why not to switch it on, before the switch ───────────────── -->
      <section
        v-if="config.warnings.length > 0"
        class="rounded-xl border border-warn bg-warn-soft p-4"
      >
        <h2 class="text-sm font-semibold text-warn">پیش از اجباری کردن عضویت</h2>
        <ul class="mt-1 list-disc space-y-1 ps-5 text-sm text-warn">
          <li v-for="warning in config.warnings" :key="warning">
            {{ WARNING_LABELS[warning] ?? warning }}
          </li>
        </ul>
      </section>

      <section class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">کانال رویدادها</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          مقصد انتشار ربات (<bdi class="font-mono">TELEGRAM_CHANNEL_ID</bdi>) و توکن ربات متغیر
          محیطی‌اند و از این‌جا تغییر نمی‌کنند. آن‌چه این‌جا تنظیم می‌شود، چهرهٔ عمومی کانال و
          اجباری بودن عضویت است.
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">شناسهٔ کانال (برای بررسی عضویت)</span>
            <input
              v-model="form.chatIdentifier"
              type="text"
              dir="ltr"
              placeholder="@payetam یا -1001234567890"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm"
            />
            <span class="text-xs text-ink-faint">
              ربات باید ادمین کانال باشد تا بتواند عضویت را ببیند.
            </span>
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">نام کاربری عمومی (اختیاری)</span>
            <input
              v-model="form.publicUsername"
              type="text"
              dir="ltr"
              placeholder="payetam"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm"
            />
          </label>

          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">پیوند عضویت</span>
            <input
              v-model="form.inviteUrl"
              type="url"
              dir="ltr"
              placeholder="https://t.me/payetam"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm"
            />
            <span class="text-xs text-ink-faint">
              فقط <bdi class="font-mono">https://t.me/…</bdi> پذیرفته می‌شود و سرور آن را بازسازی
              می‌کند؛ این پیوند به همهٔ کاربران نمایش داده می‌شود.
            </span>
          </label>

          <label class="flex items-center gap-2 sm:col-span-2">
            <input v-model="form.verifyViaTelegram" type="checkbox" class="size-4" />
            <span class="text-sm text-ink-soft">
              عضویت از طریق تلگرام بررسی شود (اگر خاموش باشد، کاربر فقط دکمهٔ عضویت را می‌بیند)
            </span>
          </label>
        </div>

        <fieldset class="mt-4">
          <legend class="text-sm font-medium">عملیاتی که نیازمند عضویت‌اند</legend>
          <div class="mt-2 flex flex-wrap gap-3">
            <label
              v-for="(label, action) in ACTION_LABELS"
              :key="action"
              class="flex items-center gap-2"
            >
              <input
                type="checkbox"
                class="size-4"
                :checked="form.requiredActions.includes(action as GatedActionView)"
                @change="toggleAction(action as GatedActionView)"
              />
              <span class="text-sm text-ink-soft">{{ label }}</span>
            </label>
          </div>
        </fieldset>

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
            :disabled="busy || !session.canMutate"
            @click="save()"
          >
            {{ busy ? 'در حال ذخیره…' : 'ذخیرهٔ تنظیمات' }}
          </button>

          <span class="text-sm">
            وضعیت فعلی:
            <b :class="config.membershipRequired ? 'text-danger' : 'text-ink-soft'">
              {{ config.membershipRequired ? 'عضویت اجباری است' : 'عضویت اجباری نیست' }}
            </b>
          </span>

          <button
            v-if="!config.membershipRequired"
            type="button"
            class="min-h-10 rounded-lg border border-danger px-4 text-sm text-danger disabled:opacity-40"
            :disabled="busy || !session.canMutate || !config.hasJoinLink"
            @click="pendingEnable = true"
          >
            اجباری کردن عضویت
          </button>
          <button
            v-else
            type="button"
            class="min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
            :disabled="busy || !session.canMutate"
            @click="save({ membershipRequired: false })"
          >
            برداشتن اجبار
          </button>
        </div>
      </section>

      <ConfirmDialog
        :open="pendingEnable"
        title="اجباری کردن عضویت در کانال"
        :body="enableBody"
        confirm-label="بله، اجباری شود"
        tone="danger"
        confirm-word="اجباری"
        :busy="busy"
        @cancel="pendingEnable = false"
        @confirm="save({ membershipRequired: true })"
      />
    </div>
  </StateBlock>
</template>
