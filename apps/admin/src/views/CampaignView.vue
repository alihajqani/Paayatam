<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { PERMISSIONS } from '@payetam/shared';
import type { FoundingMemberListResponse, FoundingReportResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatDateTime, formatNumber } from '@/format/fa';
import { useSessionStore } from '@/stores/session';

/**
 * The launch campaign, on one screen (v0.10.1).
 *
 * The campaign shipped with no surface at all: the numbers existed in
 * `founding_campaign` and `founding_member`, and the only way to read them was a
 * `psql` session on the server. An operator deciding whether to keep spending on
 * traffic had to ask an engineer.
 *
 * ── Read-only, and that is the design ───────────────────────────────────────
 *
 * The campaign has exactly one lever — `founding.enabled` — and «تنظیمات» already
 * owns it. A switch here would be a second write path to one number. What this
 * screen does instead is show the switch's position and link to where it is
 * thrown, for the sessions that hold `settings.manage`.
 *
 * ── Two requests, two permissions ───────────────────────────────────────────
 *
 * The report is aggregates behind `dashboard.read`, so an `ANALYST` can open this
 * page and read all of it. The roster names people and is behind `user.read`, so
 * for that session it is simply not fetched — not fetched and refused, which
 * would put an error on a page that is otherwise working.
 *
 * ── Why the configured schedule sits beside the paid one ────────────────────
 *
 * `founding_member.tier` and `.coins` are snapshotted at allocation. An operator
 * who retunes a tier boundary mid campaign makes the configuration disagree with
 * what people were actually given, and the disagreement is the thing worth
 * seeing — so both are on the tier table rather than one standing in for the
 * other.
 */
const session = useSessionStore();

const report = ref<FoundingReportResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (report.value === null) return 'loading' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    report.value = await request<FoundingReportResponse>('/founding');
  } catch (cause) {
    error.value = messageOf(cause, 'گزارش کمپین بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

/** How far along the campaign is, as a width. Zero cap renders as an empty bar. */
const progress = computed(() => {
  const data = report.value;
  if (data === null || data.max === 0) return 0;
  return Math.min(100, Math.round((data.awarded / data.max) * 100));
});

/**
 * The daily curve, most recent last and trimmed to what fits a strip.
 *
 * The API sends up to ninety days; ninety bars on a phone are a smear. The
 * numbers under the chart are the reliable read — the bars are there to show the
 * shape, which is the one thing a column of numbers does not.
 */
const TREND_BARS = 30;
const trend = computed(() => (report.value?.trend ?? []).slice(-TREND_BARS));
const trendPeak = computed(() => Math.max(1, ...trend.value.map((day) => day.members)));

/** The three counts overlap, so the caption has to say so rather than imply a pie. */
const sourcesTotal = computed(() => {
  const s = report.value?.sources;
  return s === undefined ? 0 : s.referred + s.giftCode + s.direct;
});

// ── The roster ──────────────────────────────────────────────────────────────

const LIMIT = 25;

const canReadMembers = computed(() => session.can(PERMISSIONS.USER_READ));

const members = ref<FoundingMemberListResponse['members']>([]);
const membersTotal = ref(0);
const offset = ref(0);
const tier = ref<'' | '1' | '2' | '3'>('');
const membersLoaded = ref(false);
const membersLoading = ref(false);
const membersError = ref<string | null>(null);

const membersState = computed(() => {
  if (membersError.value !== null) return 'error' as const;
  if (!membersLoaded.value) return 'loading' as const;
  return members.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function loadMembers(): Promise<void> {
  if (!canReadMembers.value) return;
  membersLoading.value = true;
  membersError.value = null;
  try {
    const page = await request<FoundingMemberListResponse>('/founding/members', {
      query: { tier: tier.value, limit: LIMIT, offset: offset.value },
    });
    members.value = page.members;
    membersTotal.value = page.total;
    membersLoaded.value = true;
  } catch (cause) {
    membersError.value = messageOf(cause, 'فهرست اعضا بارگذاری نشد.');
  } finally {
    membersLoading.value = false;
  }
}

watch(tier, () => {
  offset.value = 0;
  void loadMembers();
});
watch(offset, () => void loadMembers());

async function refresh(): Promise<void> {
  await Promise.all([load(), loadMembers()]);
}

onMounted(() => void refresh());
</script>

<template>
  <StateBlock :state="state" :error-text="error" :rows="5" @retry="load">
    <div v-if="report" class="flex flex-col gap-6">
      <!--
        The switch first. Every number below describes a campaign that may or may
        not still be running, and «۴۲۷ نفر» means something different depending on
        which — so the state is read before the counts, not after them.
      -->
      <section
        class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
      >
        <h2 class="text-sm font-semibold">وضعیت کمپین</h2>
        <StatusPill
          :value="report.enabled ? 'در حال اجرا' : 'متوقف'"
          :tone="report.enabled ? 'good' : 'neutral'"
        />
        <p v-if="!report.enabled" class="text-xs text-ink-faint">
          رتبه‌ای صادر نمی‌شود. آنچه پایین‌تر می‌بینید تاریخچهٔ رتبه‌های صادرشده است.
        </p>
        <!--
          The lever lives in «تنظیمات» and this links to it rather than
          duplicating it: one number, one write path. Hidden from a session that
          cannot use it, because a link to a page that answers «دسترسی ندارید» is
          worse than no link.
        -->
        <RouterLink
          v-if="session.can(PERMISSIONS.SETTINGS_MANAGE)"
          :to="{ name: 'settings' }"
          class="text-xs text-brand underline"
        >
          تغییر در تنظیمات («founding.enabled»)
        </RouterLink>
        <button
          type="button"
          class="ms-auto min-h-9 rounded-lg border border-line px-3 text-sm"
          :disabled="loading"
          @click="refresh"
        >
          به‌روزرسانی
        </button>
      </section>

      <section class="rounded-xl border border-line bg-surface p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="text-sm text-ink-soft">رتبه‌های صادرشده</p>
          <p class="text-sm text-ink-faint">
            <bdi>{{ formatNumber(report.remaining) }}</bdi> جای خالی مانده
          </p>
        </div>
        <p class="mt-1 text-3xl font-bold tabular-nums">
          <bdi>{{ formatNumber(report.awarded) }}</bdi>
          <span class="text-lg font-normal text-ink-faint">
            از <bdi>{{ formatNumber(report.max) }}</bdi>
          </span>
        </p>
        <!-- Decoration: the numbers above say the same thing for a screen reader. -->
        <div
          class="mt-3 h-2 overflow-hidden rounded-full bg-neutral-soft"
          role="presentation"
          aria-hidden="true"
        >
          <div class="h-full rounded-full bg-brand" :style="{ width: `${progress}%` }"></div>
        </div>
      </section>

      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">تازه در ۲۴ ساعت</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(report.joinedLast24h) }}</bdi>
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            <bdi>{{ formatNumber(report.joinedLast7Days) }}</bdi> در ۷ روز گذشته
          </p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">سکه‌های پرداخت‌شده</p>
          <p class="mt-1 text-2xl font-bold tabular-nums">
            <bdi>{{ formatNumber(report.coinsGranted) }}</bdi>
          </p>
          <!-- From the snapshot on each row, not from today's tier settings. -->
          <p class="mt-1 text-xs text-ink-faint">بر پایهٔ آنچه هنگام صدور رتبه پرداخت شد</p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">نخستین عضو</p>
          <p class="mt-1 text-base font-medium">{{ formatDateTime(report.firstAwardedAt) }}</p>
        </article>

        <article class="rounded-xl border border-line bg-surface p-4">
          <p class="text-sm text-ink-soft">آخرین عضو</p>
          <p class="mt-1 text-base font-medium">{{ formatDateTime(report.lastAwardedAt) }}</p>
        </article>
      </section>

      <!-- ── The waves ───────────────────────────────────────────────────── -->
      <section class="rounded-xl border border-line bg-surface">
        <div class="border-b border-line px-4 py-3">
          <h2 class="text-sm font-semibold">موج‌ها</h2>
          <p class="mt-1 text-xs text-ink-faint">
            «پیکربندی» آن چیزی است که امروز تنظیم شده؛ «پرداخت‌شده» آن چیزی است که واقعاً داده شد.
            اگر مرزها وسط کمپین جابه‌جا شده باشند، این دو با هم نمی‌خوانند.
          </p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[40rem] text-sm">
            <thead class="border-b border-line text-ink-soft">
              <tr>
                <th class="px-4 py-3 text-start font-medium">موج</th>
                <th class="px-4 py-3 text-start font-medium">تا رتبهٔ</th>
                <th class="px-4 py-3 text-start font-medium">پیکربندی</th>
                <th class="px-4 py-3 text-start font-medium">اعضا</th>
                <th class="px-4 py-3 text-start font-medium">سکهٔ پرداخت‌شده</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="wave in report.tiers"
                :key="wave.tier"
                class="border-b border-line last:border-0"
              >
                <td class="px-4 py-3 font-medium">{{ wave.name }}</td>
                <td class="px-4 py-3 tabular-nums text-ink-soft">
                  <bdi>{{ formatNumber(wave.maxRank) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums text-ink-soft">
                  <bdi>{{ formatNumber(wave.configuredCoins) }}</bdi> سکه
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(wave.members) }}</bdi>
                </td>
                <td class="px-4 py-3 tabular-nums">
                  <bdi>{{ formatNumber(wave.coins) }}</bdi>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ── The curve ───────────────────────────────────────────────────── -->
      <section class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">روند روزانه</h2>
        <p v-if="trend.length === 0" class="mt-2 text-sm text-ink-faint">
          هنوز هیچ رتبه‌ای صادر نشده است.
        </p>
        <template v-else>
          <!--
            `dir="ltr"` on the strip alone: a time axis runs oldest→newest left to
            right in every chart a reader has seen, and mirroring it with the page
            would put yesterday on the right of last week.
          -->
          <div dir="ltr" class="mt-3 flex h-32 items-end gap-1 overflow-x-auto">
            <div
              v-for="day in trend"
              :key="day.day"
              class="flex h-full min-w-2 flex-1 items-end"
              :title="`${formatDate(day.day)} — ${formatNumber(day.members)}`"
            >
              <div
                class="w-full rounded-t bg-brand"
                :style="{ height: `${Math.max(4, (day.members / trendPeak) * 100)}%` }"
              ></div>
            </div>
          </div>
          <p class="mt-2 text-xs text-ink-faint">
            <bdi>{{ formatDate(trend[0]?.day) }}</bdi> تا
            <bdi>{{ formatDate(trend[trend.length - 1]?.day) }}</bdi>
            · بیشترین در یک روز: <bdi>{{ formatNumber(trendPeak) }}</bdi>
          </p>
        </template>
      </section>

      <!-- ── Where they came from ────────────────────────────────────────── -->
      <div class="grid gap-6 xl:grid-cols-2">
        <section class="rounded-xl border border-line bg-surface">
          <div class="border-b border-line px-4 py-3">
            <h2 class="text-sm font-semibold">اعضا بر پایهٔ شهر</h2>
            <p class="mt-1 text-xs text-ink-faint">
              «پروفایل‌ها» همهٔ پروفایل‌های کامل‌شدهٔ آن شهر است؛ «اعضا» فقط کسانی که رتبه
              گرفته‌اند. فاصلهٔ این دو یعنی کسانی که وقتی کمپین خاموش بود یا سقف پر شده بود ثبت‌نام
              کرده‌اند.
            </p>
          </div>
          <p v-if="report.cities.length === 0" class="px-4 py-6 text-sm text-ink-faint">
            هنوز عضوی ثبت نشده است.
          </p>
          <div v-else class="overflow-x-auto">
            <table class="w-full min-w-[28rem] text-sm">
              <thead class="border-b border-line text-ink-soft">
                <tr>
                  <th class="px-4 py-3 text-start font-medium">شهر</th>
                  <th class="px-4 py-3 text-start font-medium">وضعیت</th>
                  <th class="px-4 py-3 text-start font-medium">اعضا</th>
                  <th class="px-4 py-3 text-start font-medium">پروفایل‌ها</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="city in report.cities"
                  :key="city.slug"
                  class="border-b border-line last:border-0"
                >
                  <td class="px-4 py-3 font-medium">{{ city.nameFa }}</td>
                  <td class="px-4 py-3">
                    <StatusPill
                      :value="city.isLaunched ? 'باز' : 'بسته'"
                      :tone="city.isLaunched ? 'good' : 'neutral'"
                    />
                  </td>
                  <td class="px-4 py-3 tabular-nums">
                    <bdi>{{ formatNumber(city.members) }}</bdi>
                  </td>
                  <td class="px-4 py-3 tabular-nums text-ink-soft">
                    <bdi>{{ formatNumber(city.profiles) }}</bdi>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="flex flex-col gap-6">
          <section class="rounded-xl border border-line bg-surface p-4">
            <h2 class="text-sm font-semibold">از کجا آمده‌اند</h2>
            <!--
              Three counts, not three slices. Somebody can arrive on a referral
              code and later redeem a gift code, so the first two overlap; only
              «مستقیم» is a complement. A pie here would be arithmetic laid over
              a false claim.
            -->
            <p class="mt-1 text-xs text-ink-faint">
              این سه با هم جمع نمی‌شوند: یک نفر می‌تواند هم با کد معرفی آمده باشد و هم بعداً کد هدیه
              گرفته باشد.
            </p>
            <dl class="mt-3 grid gap-3 sm:grid-cols-3">
              <div class="rounded-lg bg-surface-sunken p-3">
                <dt class="text-xs text-ink-soft">با کد معرفی</dt>
                <dd class="mt-1 text-xl font-bold tabular-nums">
                  <bdi>{{ formatNumber(report.sources.referred) }}</bdi>
                </dd>
              </div>
              <div class="rounded-lg bg-surface-sunken p-3">
                <dt class="text-xs text-ink-soft">کد هدیه گرفته‌اند</dt>
                <dd class="mt-1 text-xl font-bold tabular-nums">
                  <bdi>{{ formatNumber(report.sources.giftCode) }}</bdi>
                </dd>
              </div>
              <div class="rounded-lg bg-surface-sunken p-3">
                <dt class="text-xs text-ink-soft">هیچ‌کدام</dt>
                <dd class="mt-1 text-xl font-bold tabular-nums">
                  <bdi>{{ formatNumber(report.sources.direct) }}</bdi>
                </dd>
              </div>
            </dl>
            <p v-if="sourcesTotal === 0" class="mt-3 text-sm text-ink-faint">
              هنوز چیزی برای تفکیک نیست.
            </p>
          </section>

          <!--
            The next launch decision. `city.launch_threshold` completed profiles
            open a city, and this is the queue ordered by distance from it — the
            one number an operator needs before choosing where to spend on
            traffic next.
          -->
          <section class="rounded-xl border border-line bg-surface">
            <div class="border-b border-line px-4 py-3">
              <h2 class="text-sm font-semibold">صف شهرهای بسته</h2>
              <p class="mt-1 text-xs text-ink-faint">
                با <bdi>{{ formatNumber(report.waitlist.threshold) }}</bdi> پروفایل کامل، شهر باز
                می‌شود. باز کردن در «شهرها و استان‌ها» انجام می‌شود.
              </p>
            </div>
            <p v-if="report.waitlist.cities.length === 0" class="px-4 py-6 text-sm text-ink-faint">
              هیچ‌کس از شهرهای بسته ثبت‌نام نکرده است.
            </p>
            <ul v-else class="divide-y divide-line">
              <li
                v-for="city in report.waitlist.cities"
                :key="city.slug"
                class="flex items-center gap-3 px-4 py-3"
              >
                <span class="min-w-24 text-sm font-medium">{{ city.nameFa }}</span>
                <span
                  class="h-2 flex-1 overflow-hidden rounded-full bg-neutral-soft"
                  role="presentation"
                  aria-hidden="true"
                >
                  <span
                    class="block h-full rounded-full bg-brand-cyan"
                    :style="{
                      width: `${
                        report.waitlist.threshold === 0
                          ? 0
                          : Math.min(100, (city.profiles / report.waitlist.threshold) * 100)
                      }%`,
                    }"
                  ></span>
                </span>
                <span class="text-sm tabular-nums text-ink-soft">
                  <bdi>{{ formatNumber(city.profiles) }}</bdi> /
                  <bdi>{{ formatNumber(report.waitlist.threshold) }}</bdi>
                </span>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <!-- ── The roster ──────────────────────────────────────────────────── -->
      <section v-if="canReadMembers" class="rounded-xl border border-line bg-surface">
        <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <h2 class="text-sm font-semibold">اعضا، به ترتیب رتبه</h2>
          <label class="ms-auto flex items-center gap-2 text-sm">
            <span class="text-ink-soft">موج</span>
            <select v-model="tier" class="min-h-9 rounded-lg border border-line bg-surface px-2">
              <option value="">همه</option>
              <option v-for="wave in report.tiers" :key="wave.tier" :value="String(wave.tier)">
                {{ wave.name }}
              </option>
            </select>
          </label>
        </div>

        <div class="p-4">
          <StateBlock
            :state="membersState"
            :error-text="membersError"
            empty-text="هنوز عضوی با این فیلتر نیست."
            :rows="4"
            @retry="loadMembers"
          >
            <div class="overflow-x-auto">
              <table class="w-full min-w-[46rem] text-sm">
                <thead class="border-b border-line text-ink-soft">
                  <tr>
                    <th class="px-4 py-3 text-start font-medium">رتبه</th>
                    <th class="px-4 py-3 text-start font-medium">نام نمایشی</th>
                    <th class="px-4 py-3 text-start font-medium">موج</th>
                    <th class="px-4 py-3 text-start font-medium">شهر</th>
                    <th class="px-4 py-3 text-start font-medium">سکه</th>
                    <th class="px-4 py-3 text-start font-medium">زمان</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="member in members"
                    :key="member.publicId"
                    class="border-b border-line last:border-0"
                  >
                    <td class="px-4 py-3 font-bold tabular-nums">
                      <bdi>#{{ formatNumber(member.rank) }}</bdi>
                    </td>
                    <td class="px-4 py-3">
                      <!--
                        Straight to the case file. The public id is the string an
                        operator copies into a report, and it belongs in a `bdi`
                        or its segments render reversed inside RTL text.
                      -->
                      <RouterLink
                        :to="{ name: 'user-detail', params: { publicId: member.publicId } }"
                        class="font-medium text-brand underline"
                      >
                        {{ member.displayName ?? 'بدون نام' }}
                      </RouterLink>
                      <bdi class="block font-mono text-xs text-ink-faint">
                        {{ member.publicId }}
                      </bdi>
                    </td>
                    <td class="px-4 py-3 text-ink-soft">{{ member.name }}</td>
                    <td class="px-4 py-3 text-ink-soft">{{ member.cityNameFa ?? '—' }}</td>
                    <td class="px-4 py-3 tabular-nums">
                      <bdi>{{ formatNumber(member.coins) }}</bdi>
                    </td>
                    <td class="px-4 py-3 text-ink-soft">{{ formatDateTime(member.awardedAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <PagerBar
              :total="membersTotal"
              :limit="LIMIT"
              :offset="offset"
              :loading="membersLoading"
              @move="offset = $event"
            />
          </StateBlock>
        </div>
      </section>

      <!--
        Said rather than left as a blank space: an `ANALYST` holds `dashboard.read`
        and nothing else, and a page that simply stopped would read as broken.
      -->
      <p v-else class="text-sm text-ink-faint">
        فهرست نام اعضا به دسترسی «مشاهدهٔ کاربران» نیاز دارد.
      </p>
    </div>
  </StateBlock>
</template>
