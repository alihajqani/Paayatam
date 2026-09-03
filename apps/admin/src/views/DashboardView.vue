<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AdminDashboardResponse, Tally } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatNumber, formatRelative } from '@/format/fa';

/**
 * The screen a shift starts on.
 *
 * **One request.** Every number here comes from `GET /admin/v1/dashboard`, which
 * is nineteen parallel aggregates on the server — a panel that fetched a count
 * per card would be a page of twenty round trips, and the first thing to get slow
 * as the product grows.
 *
 * It is also the only screen an `ANALYST` can open, which is ADR-0010's
 * "read-only aggregates means aggregates". So it has to be genuinely complete: if
 * a number is not here, that role cannot get it anywhere.
 *
 * The health block is part of the same response rather than a second fetch to
 * `/ready`, because "is anything down?" is the first question in an incident and
 * a second screen to check is a step somebody skips.
 */
const data = ref<AdminDashboardResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

/** How many conversation rows are left, so the retired tile can hide itself. */
const chatTotal = computed(() =>
  Object.values(data.value?.chats.byStatus ?? {}).reduce((sum, count) => sum + count, 0),
);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (data.value === null) return 'loading' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    data.value = await request<AdminDashboardResponse>('/dashboard');
  } catch (cause) {
    error.value = messageOf(cause, 'داشبورد بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

/**
 * A tally, ordered and complete for display.
 *
 * The API sends a **sparse** map — a status with no rows is absent rather than
 * zero, so the panel can tell "nobody is waitlisted" from "this deployment has no
 * waitlist". A screen has to choose, and this one shows the statuses it knows
 * about at zero and appends anything unexpected, so a new enum value appears
 * rather than being silently dropped.
 */
function ordered(tally: Tally, known: readonly string[]): Array<[string, number]> {
  const rows: Array<[string, number]> = known.map((key) => [key, tally[key] ?? 0]);
  for (const [key, value] of Object.entries(tally)) {
    if (!known.includes(key)) rows.push([key, value]);
  }
  return rows;
}

const EVENT_STATUSES = [
  'PUBLISHED',
  'PENDING_MODERATION',
  'HIDDEN',
  'ONGOING',
  'COMPLETED',
  'CANCELLED_BY_HOST',
  'EXPIRED',
] as const;

const PARTICIPATION_STATUSES = [
  'PENDING',
  'WAITLISTED',
  'ACCEPTED',
  'COMPLETED',
  'REJECTED',
  'NO_SHOW',
] as const;

const CHAT_STATUSES = ['ANONYMOUS', 'OPEN', 'CLOSED', 'BLOCKED'] as const;
const REFERRAL_STATUSES = ['PENDING', 'QUALIFIED', 'REJECTED'] as const;

onMounted(load);
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="4" @retry="load">
    <div v-if="data" class="flex flex-col gap-6">
      <!-- Dependencies first: everything below is meaningless if one is down. -->
      <section
        class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
      >
        <h2 class="text-sm font-semibold">وضعیت سرویس‌ها</h2>
        <span class="flex items-center gap-1 text-sm">
          پایگاه داده
          <StatusPill
            :value="data.health.database === 'up' ? 'فعال' : 'در دسترس نیست'"
            :tone="data.health.database === 'up' ? 'good' : 'danger'"
          />
        </span>
        <span class="flex items-center gap-1 text-sm">
          Redis
          <StatusPill
            :value="data.health.redis === 'up' ? 'فعال' : 'در دسترس نیست'"
            :tone="data.health.redis === 'up' ? 'good' : 'danger'"
          />
        </span>
        <!--
          The worker and the queues are visible through Redis and through the
          backlog below rather than as a separate probe: the API never talks to
          the worker (ADR-0005), so a "worker: up" light here would be a claim
          this process cannot substantiate. What it can show is whether the queue
          it feeds is draining.
        -->
        <span class="text-xs text-ink-faint">
          کارگر از طریق صف و Redis سنجیده می‌شود؛ این فرایند مستقیماً با آن حرف نمی‌زند.
        </span>
        <button
          type="button"
          class="ms-auto min-h-9 rounded-lg border border-line px-3 text-sm"
          :disabled="loading"
          @click="load"
        >
          به‌روزرسانی
        </button>
      </section>

      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">کاربران</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(data.users.total) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(data.users.activeLast7Days) }}</bdi> فعال و
            <bdi>{{ formatNumber(data.users.newLast7Days) }}</bdi> تازه در ۷ روز گذشته
          </p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">سکه‌های در دست کاربران</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(data.economy.coinsHeld) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(data.economy.coinsGranted) }}</bdi> اعطا شده،
            <bdi>{{ formatNumber(data.economy.coinsSpent) }}</bdi> خرج شده
          </p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">تراکنش‌های ۲۴ ساعت اخیر</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(data.economy.ledgerLast24h) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">ردیف‌های دفتر سکه</p>
        </article>

        <article
          class="rounded-xl border p-4"
          :class="
            data.moderationBacklog.openCases > 0
              ? 'border-warn bg-warn-soft'
              : 'border-line bg-surface'
          "
        >
          <p class="text-sm text-ink-soft">صف بررسی</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(data.moderationBacklog.openCases) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(data.moderationBacklog.openReports) }}</bdi> گزارش باز
            <template v-if="data.moderationBacklog.oldestOpenCaseAt">
              · قدیمی‌ترین {{ formatRelative(data.moderationBacklog.oldestOpenCaseAt) }}
            </template>
          </p>
        </article>
      </section>

      <section class="grid gap-4 lg:grid-cols-2">
        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">فعالیت‌ها بر اساس وضعیت</h2>
          <ul class="mt-3 flex flex-col gap-2">
            <li
              v-for="[status, count] in ordered(data.events.byStatus, EVENT_STATUSES)"
              :key="status"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <StatusPill :value="status" />
              <bdi class="tabular-nums">{{ formatNumber(count) }}</bdi>
            </li>
          </ul>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">درخواست‌های شرکت</h2>
          <ul class="mt-3 flex flex-col gap-2">
            <li
              v-for="[status, count] in ordered(
                data.participations.byStatus,
                PARTICIPATION_STATUSES,
              )"
              :key="status"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <StatusPill :value="status" />
              <bdi class="tabular-nums">{{ formatNumber(count) }}</bdi>
            </li>
          </ul>
        </article>

        <!--
          Retired in v0.8.0, and kept as a *decaying* tile rather than deleted.

          The feature is gone; the rows are not. They are closed, on a ninety-day
          retention clock, and a moderator can still be granted a break-glass read
          of one while they last. A dashboard that stopped showing them would make
          the one thing worth knowing — how many are left — invisible, so the tile
          says what it is and will empty itself.
        -->
        <article v-if="chatTotal > 0" class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">گفت‌وگوهای بایگانی‌شده</h2>
          <p class="mt-1 text-xs text-muted">
            این بخش در نسخهٔ ۰.۸ حذف شد. ردیف‌های باقی‌مانده تا پایان دورهٔ نگهداری (۹۰ روز) پاک
            می‌شوند.
          </p>
          <ul class="mt-3 flex flex-col gap-2">
            <li
              v-for="[status, count] in ordered(data.chats.byStatus, CHAT_STATUSES)"
              :key="status"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <StatusPill :value="status" />
              <bdi class="tabular-nums">{{ formatNumber(count) }}</bdi>
            </li>
          </ul>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <h2 class="text-sm font-semibold">معرفی دوستان</h2>
          <ul class="mt-3 flex flex-col gap-2">
            <li
              v-for="[status, count] in ordered(data.referrals.byStatus, REFERRAL_STATUSES)"
              :key="status"
              class="flex items-center justify-between gap-2 text-sm"
            >
              <StatusPill :value="status" />
              <bdi class="tabular-nums">{{ formatNumber(count) }}</bdi>
            </li>
            <li class="flex items-center justify-between gap-2 border-t border-line pt-2 text-sm">
              <span class="text-ink-soft">نشانه‌دار برای بررسی</span>
              <bdi class="tabular-nums">{{ formatNumber(data.referrals.flagged) }}</bdi>
            </li>
          </ul>
        </article>
      </section>

      <section class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">کدهای هدیه</h2>
        <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <p class="text-sm">
            <span class="block text-ink-soft">کل کدها</span>
            <bdi class="text-lg font-bold tabular-nums">{{
              formatNumber(data.giftCodes.total)
            }}</bdi>
          </p>
          <p class="text-sm">
            <span class="block text-ink-soft">فعال</span>
            <bdi class="text-lg font-bold tabular-nums">
              {{ formatNumber(data.giftCodes.active) }}
            </bdi>
          </p>
          <p class="text-sm">
            <span class="block text-ink-soft">دریافت‌ها</span>
            <bdi class="text-lg font-bold tabular-nums">
              {{ formatNumber(data.giftCodes.redemptions) }}
            </bdi>
          </p>
          <p class="text-sm">
            <span class="block text-ink-soft">سکهٔ اعطاشده</span>
            <bdi class="text-lg font-bold tabular-nums">
              {{ formatNumber(data.giftCodes.coinsGranted) }}
            </bdi>
          </p>
          <p class="text-sm">
            <!--
              From `audit_log`, not from the Prometheus counter (ADR-0016 §5): a
              burst here is what a brute-force sweep looks like, and a counter
              that resets on deploy cannot show it a day later.
            -->
            <span class="block text-ink-soft">تلاش ناموفق ۲۴ ساعت</span>
            <bdi
              class="text-lg font-bold tabular-nums"
              :class="data.giftCodes.failedAttemptsLast24h > 50 ? 'text-danger' : ''"
            >
              {{ formatNumber(data.giftCodes.failedAttemptsLast24h) }}
            </bdi>
          </p>
        </div>
      </section>
    </div>
  </StateBlock>
</template>
