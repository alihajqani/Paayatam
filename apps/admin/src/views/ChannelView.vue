<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ChannelConfigView, GatedActionView, RequiredChannelView } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import { useSessionStore } from '@/stores/session';

/**
 * The channels users are required to join, and whether they are (v0.3.1).
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
 * ── Why the order is editable ────────────────────────────────────────────────
 *
 * The user is shown the channels in this order and asked to join them in it. That
 * is a product decision — the main channel first, an advertising one after it —
 * so it belongs to the operator rather than to whichever row was inserted first.
 * «↑» and «↓» send the **whole list back** rather than a move instruction, which
 * is the one formulation that cannot produce an order neither side intended.
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
  verifyViaTelegram: true,
  requiredActions: [] as GatedActionView[],
});

/** The add-a-channel form. Cleared on success, kept on failure so nothing is retyped. */
const draft = ref({ title: '', chatIdentifier: '', publicUsername: '', inviteUrl: '' });
const adding = ref(false);

const pendingEnable = ref(false);
const pendingDelete = ref<RequiredChannelView | null>(null);

const state = computed(() => {
  if (error.value !== null && config.value === null) return 'error' as const;
  return config.value === null ? ('loading' as const) : ('ready' as const);
});

const channels = computed(() => config.value?.allChannels ?? []);
const activeChannels = computed(() => channels.value.filter((channel) => channel.isActive));

const ACTION_LABELS: Record<GatedActionView, string> = {
  // First in the list because it is the widest: it stops the Mini App opening at
  // all, rather than refusing one operation inside it.
  APP_ACCESS: 'ورود به برنامه (کل مینی‌اپ)',
  EVENT_CREATE: 'ساخت فعالیت',
  EVENT_JOIN: '«پایتم» گفتن به فعالیت',
  EVENT_CHANNEL_SEND: 'انتشار فعالیت در کانال',
  EVENT_INVITE: 'ارسال دعوت‌نامه',
};

const ACTION_NOTES: Partial<Record<GatedActionView, string>> = {
  APP_ACCESS:
    'صفحهٔ عضویت پیش از هر صفحهٔ دیگری نشان داده می‌شود. این محدودیت در مینی‌اپ اعمال می‌شود؛ ' +
    'چهار مورد دیگر را خود سرور رد می‌کند.',
};

const WARNING_LABELS: Record<string, string> = {
  NO_CHANNELS: 'هیچ کانالی تعریف نشده است — کاربر جایی برای رفتن ندارد.',
  NO_JOIN_LINK: 'دست‌کم یکی از کانال‌ها پیوند عضویت ندارد.',
  NO_CHAT_IDENTIFIER:
    'دست‌کم یکی از کانال‌ها شناسه ندارد، پس عضویت در آن قابل بررسی نیست و همه اجازهٔ عبور می‌گیرند.',
  NO_ACTIONS_SELECTED: 'هیچ عملیاتی برای اجبار انتخاب نشده است، پس این تنظیم اثری ندارد.',
};

function hydrate(next: ChannelConfigView): void {
  config.value = next;
  form.value = {
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

/**
 * Every request on this screen answers with the whole configuration.
 *
 * So one helper runs all of them: adding a channel changes `warnings`,
 * `hasJoinLink` and `canVerify`, and a screen that re-fetched to learn that would
 * render a stale warning block in between.
 */
async function run(
  action: () => Promise<ChannelConfigView>,
  success: string,
  failure: string,
): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  error.value = null;
  try {
    hydrate(await action());
    notice.value = success;
    return true;
  } catch (cause) {
    error.value = messageOf(cause, failure);
    return false;
  } finally {
    busy.value = false;
  }
}

/** The global switches. The requirement itself has its own confirmed path. */
async function save(extra: Record<string, unknown> = {}): Promise<void> {
  const ok = await run(
    () =>
      request<ChannelConfigView>('/channel-config', {
        method: 'PUT',
        body: {
          verifyViaTelegram: form.value.verifyViaTelegram,
          requiredActions: form.value.requiredActions,
          ...extra,
        },
      }),
    'تنظیمات کانال ذخیره شد.',
    'ذخیرهٔ تنظیمات انجام نشد.',
  );
  if (ok) pendingEnable.value = false;
}

async function addChannel(): Promise<void> {
  const ok = await run(
    () =>
      request<ChannelConfigView>('/channel-config/channels', {
        method: 'POST',
        body: {
          title: draft.value.title,
          // Empty means "not set", which the API distinguishes from absent.
          chatIdentifier:
            draft.value.chatIdentifier.trim() === '' ? null : draft.value.chatIdentifier,
          publicUsername:
            draft.value.publicUsername.trim() === '' ? null : draft.value.publicUsername,
          inviteUrl: draft.value.inviteUrl.trim() === '' ? null : draft.value.inviteUrl,
        },
      }),
    'کانال اضافه شد.',
    'افزودن کانال انجام نشد.',
  );
  if (ok) {
    draft.value = { title: '', chatIdentifier: '', publicUsername: '', inviteUrl: '' };
    adding.value = false;
  }
}

async function patchChannel(id: string, body: Record<string, unknown>): Promise<void> {
  await run(
    () => request<ChannelConfigView>(`/channel-config/channels/${id}`, { method: 'PATCH', body }),
    'کانال به‌روزرسانی شد.',
    'به‌روزرسانی کانال انجام نشد.',
  );
}

async function removeChannel(id: string): Promise<void> {
  const ok = await run(
    () => request<ChannelConfigView>(`/channel-config/channels/${id}`, { method: 'DELETE' }),
    'کانال حذف شد.',
    'حذف کانال انجام نشد.',
  );
  if (ok) pendingDelete.value = null;
}

/**
 * Move one channel one place.
 *
 * The **whole order** is sent, not the move: the list on screen is the one the
 * operator is looking at, and sending it back is what makes the result exactly
 * what they saw.
 */
async function move(index: number, delta: number): Promise<void> {
  const ordered = [...channels.value];
  const target = index + delta;
  if (target < 0 || target >= ordered.length) return;

  const moved = ordered[index];
  const displaced = ordered[target];
  if (moved === undefined || displaced === undefined) return;
  ordered[index] = displaced;
  ordered[target] = moved;

  await run(
    () =>
      request<ChannelConfigView>('/channel-config/channels/order', {
        method: 'PUT',
        body: { ids: ordered.map((channel) => channel.id) },
      }),
    'ترتیب کانال‌ها ذخیره شد.',
    'ذخیرهٔ ترتیب انجام نشد.',
  );
}

function toggleAction(action: GatedActionView): void {
  const index = form.value.requiredActions.indexOf(action);
  if (index === -1) form.value.requiredActions.push(action);
  else form.value.requiredActions.splice(index, 1);
}

const enableBody = computed(
  () =>
    'با روشن کردن این گزینه، کاربرانی که عضو همهٔ کانال‌های فعال نیستند نمی‌توانند عملیات ' +
    'انتخاب‌شده را انجام دهند. عضویت در یکی از کانال‌ها کافی نیست. اگر ربات نتواند عضویت را بررسی ' +
    'کند — کانال در دسترس نباشد، ربات ادمین نباشد، یا تلگرام پاسخ ندهد — کاربر اجازهٔ عبور می‌گیرد ' +
    'و محصول متوقف نمی‌شود. فقط پاسخ قطعی «عضو نیست» مانع انجام کار می‌شود.',
);

const deleteBody = computed(() =>
  pendingDelete.value === null
    ? ''
    : `کانال «${pendingDelete.value.title}» از فهرست کانال‌های اجباری حذف می‌شود. ` +
      'کاربرانی که پیش‌تر عضو شده‌اند عضو باقی می‌مانند؛ فقط دیگر از کسی خواسته نمی‌شود.',
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

      <!-- ── The channels ─────────────────────────────────────────────── -->
      <section class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">کانال‌های اجباری</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-faint">
          کاربر باید عضو <b>همهٔ</b> کانال‌های فعال باشد. ترتیب زیر همان ترتیبی است که کاربر می‌بیند
          و از او خواسته می‌شود عضو شود. مقصد انتشار ربات (<bdi class="font-mono"
            >TELEGRAM_CHANNEL_ID</bdi
          >) و توکن ربات متغیر محیطی‌اند و از این‌جا تغییر نمی‌کنند.
        </p>

        <p v-if="channels.length === 0" class="mt-3 text-sm text-ink-soft">
          هنوز کانالی تعریف نشده است.
        </p>

        <ol v-else class="mt-3 flex flex-col gap-2">
          <li
            v-for="(channel, index) in channels"
            :key="channel.id"
            class="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3"
            :class="channel.isActive ? '' : 'opacity-60'"
          >
            <span class="w-6 text-center text-sm text-ink-faint">{{ index + 1 }}</span>

            <div class="flex min-w-40 flex-1 flex-col">
              <span class="text-sm font-medium">{{ channel.title }}</span>
              <bdi class="font-mono text-xs text-ink-faint">
                {{ channel.chatIdentifier ?? 'بدون شناسه' }} · {{ channel.joinUrl ?? 'بدون پیوند' }}
              </bdi>
            </div>

            <span
              class="rounded-full px-2 py-0.5 text-xs"
              :class="channel.isActive ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn'"
            >
              {{ channel.isActive ? 'فعال' : 'غیرفعال' }}
            </span>

            <div class="flex items-center gap-1">
              <button
                type="button"
                class="min-h-9 rounded-lg border border-line px-2 text-sm disabled:opacity-40"
                :disabled="busy || !session.canMutate || index === 0"
                aria-label="بالاتر"
                @click="move(index, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                class="min-h-9 rounded-lg border border-line px-2 text-sm disabled:opacity-40"
                :disabled="busy || !session.canMutate || index === channels.length - 1"
                aria-label="پایین‌تر"
                @click="move(index, 1)"
              >
                ↓
              </button>
              <button
                type="button"
                class="min-h-9 rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                :disabled="busy || !session.canMutate"
                @click="patchChannel(channel.id, { isActive: !channel.isActive })"
              >
                {{ channel.isActive ? 'غیرفعال کردن' : 'فعال کردن' }}
              </button>
              <button
                type="button"
                class="min-h-9 rounded-lg border border-danger px-3 text-sm text-danger disabled:opacity-40"
                :disabled="busy || !session.canMutate"
                @click="pendingDelete = channel"
              >
                حذف
              </button>
            </div>
          </li>
        </ol>

        <button
          v-if="!adding"
          type="button"
          class="mt-3 min-h-10 rounded-lg border border-line px-4 text-sm disabled:opacity-40"
          :disabled="!session.canMutate"
          @click="adding = true"
        >
          افزودن کانال
        </button>

        <div v-else class="mt-3 grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">عنوان (آن‌چه کاربر می‌بیند)</span>
            <input
              v-model="draft.title"
              type="text"
              placeholder="کانال اصلی پایه‌تم"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-sm text-ink-soft">شناسهٔ کانال (برای بررسی عضویت)</span>
            <input
              v-model="draft.chatIdentifier"
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
              v-model="draft.publicUsername"
              type="text"
              dir="ltr"
              placeholder="payetam"
              class="min-h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm"
            />
          </label>

          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-sm text-ink-soft">پیوند عضویت</span>
            <input
              v-model="draft.inviteUrl"
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

          <div class="flex gap-2 sm:col-span-2">
            <button
              type="button"
              class="min-h-10 rounded-lg bg-brand px-4 text-sm text-brand-ink disabled:opacity-40"
              :disabled="busy || !session.canMutate || draft.title.trim().length < 2"
              @click="addChannel"
            >
              {{ busy ? 'در حال ذخیره…' : 'افزودن' }}
            </button>
            <button
              type="button"
              class="min-h-10 rounded-lg border border-line px-4 text-sm"
              @click="adding = false"
            >
              انصراف
            </button>
          </div>
        </div>
      </section>

      <!-- ── The requirement ──────────────────────────────────────────── -->
      <section class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">اجبار عضویت</h2>

        <label class="mt-3 flex items-center gap-2">
          <input v-model="form.verifyViaTelegram" type="checkbox" class="size-4" />
          <span class="text-sm text-ink-soft">
            عضویت از طریق تلگرام بررسی شود (اگر خاموش باشد، کاربر فقط دکمهٔ عضویت را می‌بیند)
          </span>
        </label>

        <fieldset class="mt-4">
          <legend class="text-sm font-medium">عملیاتی که نیازمند عضویت‌اند</legend>
          <div class="mt-2 flex flex-col gap-2">
            <label v-for="(label, action) in ACTION_LABELS" :key="action" class="flex gap-2">
              <input
                type="checkbox"
                class="mt-1 size-4"
                :checked="form.requiredActions.includes(action as GatedActionView)"
                @change="toggleAction(action as GatedActionView)"
              />
              <span class="flex flex-col">
                <span class="text-sm text-ink-soft">{{ label }}</span>
                <span v-if="ACTION_NOTES[action as GatedActionView]" class="text-xs text-ink-faint">
                  {{ ACTION_NOTES[action as GatedActionView] }}
                </span>
              </span>
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
            <template v-if="config.membershipRequired">
              ({{ activeChannels.length }} کانال فعال)
            </template>
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
        title="اجباری کردن عضویت در کانال‌ها"
        :body="enableBody"
        confirm-label="بله، اجباری شود"
        tone="danger"
        confirm-word="اجباری"
        :busy="busy"
        @cancel="pendingEnable = false"
        @confirm="save({ membershipRequired: true })"
      />

      <ConfirmDialog
        :open="pendingDelete !== null"
        title="حذف کانال"
        :body="deleteBody"
        confirm-label="حذف شود"
        tone="danger"
        :busy="busy"
        @cancel="pendingDelete = null"
        @confirm="pendingDelete && removeChannel(pendingDelete.id)"
      />
    </div>
  </StateBlock>
</template>
