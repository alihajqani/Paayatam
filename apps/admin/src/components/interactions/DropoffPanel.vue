<script setup lang="ts">
import {
  ERROR_MESSAGES_FA,
  INTERACTION_GATE_FA,
  interactionActionLabel,
  interactionScreenLabel,
  interactionStepLabel,
  interactionWizardLabel,
} from '@payetam/shared';
import type { InteractionDropoffResponse } from '@payetam/shared';
import { formatNumber, toPersianDigits } from '@/format/fa';
import { share } from '@/format/share';

/**
 * Where people stop, and what stopped them.
 *
 * Five different answers to «چرا ادامه نمی‌دهند», kept apart because they call
 * for different fixes:
 *
 *  - **last seen** — somebody simply did not come back; the screen they were
 *    left on is the only clue there is;
 *  - **refused** — the product said no, and the sentence it said is here;
 *  - **turned back** — they owed a sign-up step;
 *  - **dead buttons and failures** — the bot's own fault, and the shortest list
 *    on the page is the one to empty first;
 *  - **blocks** — the loudest thing a person can say, with how soon they said it.
 *
 * Every number is a count of people or of times, never a person. Whoever needs
 * the person opens their file.
 */
defineProps<{ data: InteractionDropoffResponse }>();

/** The sentence the person was sent; the code when this build has none for it. */
function refusalText(code: string | null): string {
  if (code === null) return '—';
  return (ERROR_MESSAGES_FA as Record<string, string>)[code] ?? code;
}

function gateLabel(gate: string): string {
  return (INTERACTION_GATE_FA as Record<string, string>)[gate] ?? gate;
}

/** Null is an account with nothing recorded before the moment in question. */
function screenLabel(screen: string | null): string {
  return screen === null ? 'چیزی ثبت نشده بود' : interactionScreenLabel(screen);
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="dropoff">
    <section class="rounded-xl border border-line bg-surface p-4">
      <h2 class="text-sm font-semibold">کسانی که دیگر نیامدند</h2>
      <p class="mt-1 text-sm text-ink-soft">
        <bdi>{{ formatNumber(data.quietUsers) }}</bdi> نفر آخرین بار در این بازه دیده شده‌اند و
        دست‌کم <bdi>{{ toPersianDigits(data.quietDays) }}</bdi> روز است کاری در ربات نکرده‌اند. این
        آخرین چیزی است که جلوی چشمشان بود:
      </p>
      <ul class="mt-3 flex flex-col text-sm">
        <li
          v-for="row in data.lastSeen"
          :key="`${row.screen ?? ''}:${row.wizardKind ?? ''}:${row.wizardStep ?? ''}`"
          class="flex flex-wrap items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0"
        >
          <span>
            {{ screenLabel(row.screen) }}
            <span v-if="row.wizardStep" class="text-ink-soft">
              ،
              <template v-if="row.wizardKind"
                >{{ interactionWizardLabel(row.wizardKind) }}،</template
              >
              {{ interactionStepLabel(row.wizardStep) }}
            </span>
          </span>
          <span class="tabular-nums">
            <bdi>{{ formatNumber(row.users) }}</bdi> نفر
            <span class="ms-1 text-xs text-ink-soft">
              <bdi>{{ share(row.users, data.quietUsers) }}</bdi>
            </span>
          </span>
        </li>
      </ul>
      <p v-if="data.lastSeen.length === 0" class="mt-2 text-sm text-ink-faint">
        در این بازه کسی نیست که این‌قدر غایب مانده باشد. برای بازهٔ
        <bdi>{{ toPersianDigits(data.quietDays) }}</bdi> روزه این فهرست همیشه خالی است.
      </p>
    </section>

    <section class="rounded-xl border border-line bg-surface p-4">
      <h2 class="text-sm font-semibold">ربات چه چیزهایی را رد کرد</h2>
      <p v-if="data.refusals.length === 0" class="mt-2 text-sm text-ink-faint">
        در این بازه چیزی رد نشده است.
      </p>
      <div v-else class="mt-3 overflow-x-auto">
        <table class="w-full min-w-[36rem] text-sm">
          <thead class="text-ink-soft">
            <tr>
              <th class="pb-2 text-start font-medium">کاری که می‌خواستند بکنند</th>
              <th class="pb-2 text-start font-medium">پیامی که دیدند</th>
              <th class="pb-2 text-start font-medium">دفعات</th>
              <th class="pb-2 text-start font-medium">نفر</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in data.refusals"
              :key="`${row.action}:${row.detail ?? ''}`"
              class="border-t border-line align-top"
            >
              <td class="py-2 pe-3">{{ interactionActionLabel(row.action) }}</td>
              <td class="py-2 pe-3 text-ink-soft">{{ refusalText(row.detail) }}</td>
              <td class="py-2 tabular-nums">
                <bdi>{{ formatNumber(row.count) }}</bdi>
              </td>
              <td class="py-2 tabular-nums">
                <bdi>{{ formatNumber(row.users) }}</bdi>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="grid gap-4 lg:grid-cols-2">
      <article class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">به ثبت‌نام برگردانده شدند</h2>
        <p class="mt-1 text-xs text-ink-faint">
          چیز دیگری خواستند و ربات اول قدمی را که مانده بود جلویشان گذاشت.
        </p>
        <table v-if="data.gates.length > 0" class="mt-3 w-full text-sm">
          <thead class="text-ink-soft">
            <tr>
              <th class="pb-2 text-start font-medium">قدمی که مانده بود</th>
              <th class="pb-2 text-start font-medium">دفعات</th>
              <th class="pb-2 text-start font-medium">نفر</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data.gates" :key="row.gate" class="border-t border-line">
              <td class="py-2">{{ gateLabel(row.gate) }}</td>
              <td class="py-2 tabular-nums">
                <bdi>{{ formatNumber(row.count) }}</bdi>
              </td>
              <td class="py-2 tabular-nums">
                <bdi>{{ formatNumber(row.users) }}</bdi>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mt-2 text-sm text-ink-faint">کسی برگردانده نشده است.</p>
      </article>

      <article class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">چیزهایی که ربات نفهمید</h2>
        <ul class="mt-3 flex flex-col gap-2 text-sm">
          <li class="flex items-baseline justify-between gap-3">
            <span>متنی که هیچ فرمی منتظرش نبود</span>
            <span class="tabular-nums">
              <bdi>{{ formatNumber(data.unclaimedText.count) }}</bdi> بار،
              <bdi>{{ formatNumber(data.unclaimedText.users) }}</bdi> نفر
            </span>
          </li>
          <li class="flex items-baseline justify-between gap-3">
            <span>استیکر، صدا یا فایل</span>
            <span class="tabular-nums">
              <bdi>{{ formatNumber(data.unsupported.count) }}</bdi> بار،
              <bdi>{{ formatNumber(data.unsupported.users) }}</bdi> نفر
            </span>
          </li>
        </ul>
        <p class="mt-2 text-xs text-ink-faint">
          کسی که تایپ می‌کند و جوابی نمی‌گیرد، معمولاً دکمه‌ای را که لازم داشته پیدا نکرده است.
        </p>
      </article>
    </section>

    <section class="grid gap-4 lg:grid-cols-2">
      <article class="rounded-xl border border-line bg-surface p-4">
        <h2 class="text-sm font-semibold">دکمه‌های ازکارافتاده</h2>
        <ul v-if="data.stale.length > 0" class="mt-3 flex flex-col gap-2 text-sm">
          <li
            v-for="row in data.stale"
            :key="row.action"
            class="flex items-baseline justify-between gap-3"
          >
            <span>{{ interactionActionLabel(row.action) }}</span>
            <span class="tabular-nums">
              <bdi>{{ formatNumber(row.count) }}</bdi> بار،
              <bdi>{{ formatNumber(row.users) }}</bdi> نفر
            </span>
          </li>
        </ul>
        <p v-else class="mt-2 text-sm text-ink-faint">هیچ دکمه‌ای بی‌جواب نمانده است.</p>
      </article>

      <article class="rounded-xl border border-line bg-surface p-4" data-testid="failures">
        <h2 class="text-sm font-semibold">خطاهای خود ربات</h2>
        <ul v-if="data.failures.length > 0" class="mt-3 flex flex-col gap-2 text-sm">
          <li
            v-for="row in data.failures"
            :key="row.action"
            class="flex items-baseline justify-between gap-3"
          >
            <span>{{ interactionActionLabel(row.action) }}</span>
            <span class="tabular-nums text-danger">
              <bdi>{{ formatNumber(row.count) }}</bdi> بار
            </span>
          </li>
        </ul>
        <p v-else class="mt-2 text-sm text-ink-faint">در این بازه خطایی ثبت نشده است.</p>
        <p class="mt-2 text-xs text-ink-faint">
          هر ردیف این‌جا یک باگ است: کاربر چیزی زد و ربات به‌جای جواب، خطا خورد. جزئیاتش در لاگ سرور
          است.
        </p>
      </article>
    </section>

    <section class="rounded-xl border border-line bg-surface p-4" data-testid="blocks">
      <h2 class="text-sm font-semibold">بلاک کردن ربات</h2>
      <p v-if="data.blocks.total === 0" class="mt-2 text-sm text-ink-faint">
        در این بازه کسی ربات را بلاک نکرده است.
      </p>
      <template v-else>
        <p class="mt-1 text-sm text-ink-soft">
          <bdi>{{ formatNumber(data.blocks.total) }}</bdi> بار.
          <bdi>{{ formatNumber(data.blocks.withinFiveMinutes) }}</bdi> بار
          <bdi class="text-xs">({{ share(data.blocks.withinFiveMinutes, data.blocks.total) }})</bdi>
          در پنج دقیقهٔ اول بعد از ساخته‌شدن حساب و
          <bdi>{{ formatNumber(data.blocks.withinDay) }}</bdi> بار
          <bdi class="text-xs">({{ share(data.blocks.withinDay, data.blocks.total) }})</bdi>
          در روز اول.
        </p>
        <h3 class="mt-3 text-xs font-medium text-ink-soft">آخرین چیزی که پیش از بلاک دیده بودند</h3>
        <ul class="mt-2 flex flex-col gap-2 text-sm">
          <li
            v-for="row in data.blocks.lastScreens"
            :key="row.screen ?? 'none'"
            class="flex items-baseline justify-between gap-3"
          >
            <span>{{ screenLabel(row.screen) }}</span>
            <span class="tabular-nums">
              <bdi>{{ formatNumber(row.blocks) }}</bdi> بار
              <span class="ms-1 text-xs text-ink-soft">
                <bdi>{{ share(row.blocks, data.blocks.total) }}</bdi>
              </span>
            </span>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
