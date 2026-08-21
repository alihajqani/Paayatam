<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { PERMISSIONS, type AdminUserDetailView, type SetUserStatusRequest } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatNumber, formatTrust, toPersianDigits } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * One account, from every angle a support conversation asks about.
 *
 * **What is not here is the point.** There is no Telegram id, no `@username` and
 * no phone number, because the API does not project them and no relation reaches
 * `telegram_account` (invariant 7). The one time an identity is genuinely needed
 * is a break-glass unseal, which requires an open case and a written reason
 * (T14) — and that is a different screen for a reason.
 *
 * The bio arrives with contact details already masked. The leak scan found that
 * the day this screen was added: a user who typed their number into their bio has
 * not consented to hand it to staff, and `user.read` is held by `SUPPORT`, which
 * is the role most exposed to social engineering.
 */
const route = useRoute();
const session = useSessionStore();

const detail = ref<AdminUserDetailView | null>(null);
const error = ref<string | null>(null);

const publicId = computed(() => String(route.params.publicId));
const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  return detail.value === null ? ('loading' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  error.value = null;
  try {
    detail.value = await request<AdminUserDetailView>(`/users/${publicId.value}`);
  } catch (cause) {
    error.value = messageOf(cause, 'پروندهٔ کاربر بارگذاری نشد.');
  }
}

// ── Suspending or banning ───────────────────────────────────────────────────

const pendingStatus = ref<SetUserStatusRequest['status'] | null>(null);
const acting = ref(false);
const actionError = ref<string | null>(null);
const notice = ref<string | null>(null);

const STATUS_ACTIONS: Array<{
  status: SetUserStatusRequest['status'];
  label: string;
  body: string;
  tone: 'danger' | 'default';
}> = [
  {
    status: 'SUSPENDED',
    label: 'تعلیق حساب',
    body: 'کاربر تا رفع تعلیق نمی‌تواند فعالیت تازه‌ای انجام دهد. این کار برگشت‌پذیر است.',
    tone: 'danger',
  },
  {
    status: 'BANNED',
    label: 'مسدودسازی حساب',
    body: 'دسترسی کاربر به‌طور کامل بسته می‌شود و کد دعوت او نیز از کار می‌افتد. این کار توسط یک مدیر قابل بازگردانی است، اما تأثیر آن فوری است.',
    tone: 'danger',
  },
  { status: 'ACTIVE', label: 'بازگرداندن حساب', body: 'حساب دوباره فعال می‌شود.', tone: 'default' },
];

const pendingAction = computed(() =>
  STATUS_ACTIONS.find((action) => action.status === pendingStatus.value),
);

async function applyStatus(reason: string): Promise<void> {
  if (pendingStatus.value === null) return;
  acting.value = true;
  actionError.value = null;
  try {
    await request<void>(`/users/${publicId.value}/status`, {
      method: 'POST',
      body: { status: pendingStatus.value, reason },
    });
    pendingStatus.value = null;
    notice.value = 'وضعیت حساب تغییر کرد و در گزارش رخدادها ثبت شد.';
    // Re-read rather than patch locally: the server is what decided, and a
    // screen that assumes the outcome is a screen that disagrees with it after
    // the first refusal.
    await load();
  } catch (cause) {
    actionError.value = messageOf(cause, 'تغییر وضعیت انجام نشد.');
  } finally {
    acting.value = false;
  }
}

/** «۳ درخواست پذیرفته‌شده، ۱ عدم حضور» — the sparse tally, rendered. */
const participationRows = computed(() =>
  Object.entries(detail.value?.participations ?? {}).sort(([a], [b]) => a.localeCompare(b)),
);

onMounted(load);
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="5" @retry="load">
    <div v-if="detail" class="flex flex-col gap-5">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3">
            <h1 class="text-xl font-bold">{{ detail.displayName ?? 'بدون نام' }}</h1>
            <StatusPill :value="detail.status" />
          </div>
          <bdi class="mt-1 block font-mono text-xs text-ink-faint">{{ detail.publicId }}</bdi>
        </div>

        <div v-if="session.can(PERMISSIONS.USER_BAN)" class="flex flex-wrap gap-2">
          <button
            v-for="action in STATUS_ACTIONS.filter((entry) => entry.status !== detail?.status)"
            :key="action.status"
            type="button"
            class="min-h-10 rounded-lg border px-3 text-sm disabled:opacity-40"
            :class="
              action.tone === 'danger' ? 'border-danger text-danger' : 'border-line text-ink-soft'
            "
            :disabled="!session.canMutate"
            @click="pendingStatus = action.status"
          >
            {{ action.label }}
          </button>
        </div>
      </header>

      <p v-if="notice" class="rounded-lg bg-good-soft px-4 py-2 text-sm text-good" role="status">
        {{ notice }}
      </p>

      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">امتیاز اعتماد</p>
          <p class="mt-1 text-xl font-bold">{{ formatTrust(detail.trustScore) }}</p>
        </article>
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">موجودی سکه</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <bdi>{{ formatNumber(detail.coinBalance) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(detail.coins.granted) }}</bdi> دریافتی،
            <bdi>{{ formatNumber(detail.coins.spent) }}</bdi> خرج‌شده در
            <bdi>{{ formatNumber(detail.coins.entries) }}</bdi> تراکنش
          </p>
        </article>
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">فعالیت‌های میزبانی‌شده</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <bdi>{{ formatNumber(detail.events.hosted) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(detail.events.published) }}</bdi> منتشر شده
          </p>
        </article>
        <article
          class="rounded-xl border p-4"
          :class="detail.reportsAgainst > 0 ? 'border-warn bg-warn-soft' : 'border-line bg-surface'"
        >
          <p class="text-sm text-ink-soft">گزارش‌های تخلف</p>
          <p class="mt-1 text-xl font-bold tabular-nums">
            <bdi>{{ formatNumber(detail.reportsAgainst) }}</bdi> علیه این حساب
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(detail.reportsFiled) }}</bdi> گزارش ثبت‌شده توسط او
          </p>
        </article>
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">پروفایل</h2>
          <dl class="mt-3 flex flex-col gap-2 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">شهر</dt>
              <dd>{{ detail.cityNameFa ?? '—' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">منطقه</dt>
              <dd>{{ detail.districtNameFa ?? '—' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">سال تولد</dt>
              <dd>
                <bdi>{{ detail.birthYear ? toPersianDigits(detail.birthYear) : '—' }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">مرحلهٔ عضویت</dt>
              <dd>
                <bdi class="font-mono text-xs">{{ detail.onboardingState }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">تاریخ عضویت</dt>
              <dd>{{ formatDate(detail.createdAt) }}</dd>
            </div>
          </dl>

          <div v-if="detail.bio" class="mt-4 border-t border-line pt-3">
            <p class="text-sm text-ink-soft">دربارهٔ کاربر</p>
            <p class="mt-1 text-sm leading-relaxed">{{ detail.bio }}</p>
            <!--
              Said out loud, because a moderator who sees «حذف شد» without this
              line cannot tell masking from a user who wrote it themselves.
            -->
            <p v-if="detail.bioRedactions > 0" class="mt-2 text-xs text-ink-faint">
              <bdi>{{ toPersianDigits(detail.bioRedactions) }}</bdi>
              مورد اطلاعات تماس در این متن پنهان شده است. کاربر رضایتی برای در اختیار گذاشتن آن‌ها
              به تیم نداده است.
            </p>
          </div>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">درخواست‌های شرکت</h2>
          <ul v-if="participationRows.length > 0" class="mt-3 flex flex-col gap-2">
            <li
              v-for="[status, count] in participationRows"
              :key="status"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <StatusPill :value="status" />
              <bdi class="tabular-nums">{{ formatNumber(count) }}</bdi>
            </li>
          </ul>
          <p v-else class="mt-3 text-sm text-ink-faint">هنوز درخواستی ثبت نکرده است.</p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">معرفی دوستان</h2>
          <dl class="mt-3 flex flex-col gap-2 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">دعوت‌های ثبت‌شده</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(detail.referrals.made) }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">واجد شرایط</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(detail.referrals.qualified) }}</bdi>
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-ink-soft">رد شده</dt>
              <dd>
                <bdi class="tabular-nums">{{ formatNumber(detail.referrals.rejected) }}</bdi>
              </dd>
            </div>
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-soft">خودش با کد دعوت آمده؟</dt>
              <dd>
                <StatusPill
                  v-if="detail.referrals.receivedStatus"
                  :value="detail.referrals.receivedStatus"
                />
                <span v-else class="text-ink-faint">خیر</span>
              </dd>
            </div>
          </dl>

          <div class="mt-4 border-t border-line pt-3 text-sm">
            <p class="text-ink-soft">کدهای هدیه</p>
            <p class="mt-1">
              <bdi class="tabular-nums">{{ formatNumber(detail.giftCodeRedemptions.count) }}</bdi>
              دریافت، مجموعاً
              <bdi class="tabular-nums">{{ formatNumber(detail.giftCodeRedemptions.coins) }}</bdi>
              سکه
            </p>
          </div>
        </article>
      </section>
    </div>
  </StateBlock>

  <ConfirmDialog
    :open="pendingStatus !== null"
    :title="pendingAction?.label ?? ''"
    :body="pendingAction?.body ?? ''"
    :confirm-label="pendingAction?.label ?? 'تأیید'"
    :tone="pendingAction?.tone ?? 'default'"
    reason-label="دلیل این تصمیم (در گزارش رخدادها ثبت می‌شود)"
    :busy="acting"
    :error="actionError"
    @cancel="pendingStatus = null"
    @confirm="applyStatus"
  />
</template>
