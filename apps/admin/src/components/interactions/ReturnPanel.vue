<script setup lang="ts">
import {
  ACQUISITION_SOURCE_FA,
  UNATTRIBUTED_FA,
  interactionNotificationLabel,
} from '@payetam/shared';
import type {
  InteractionReturnCohort,
  InteractionReturnResponse,
  InteractionReturnRow,
} from '@payetam/shared';
import { formatNumber } from '@/format/fa';
import { share } from '@/format/share';

/**
 * Who comes back, and which of the bot's own messages bring them.
 *
 * ── The denominator is the whole page ───────────────────────────────────────
 *
 * «بعد از ۷ روز» is a share of the accounts that arrived **at least seven days
 * ago** — the only ones that can be asked. An account three days old has not
 * failed to return after a week; it has not had a week. So a cell with nobody
 * old enough says «هنوز زود است», which is a different statement from zero and
 * would be a wrong one if it were printed as «۰٪».
 *
 * ── Two columns about a message, and they are not the same claim ────────────
 *
 * «دکمه‌اش زده شد» is exact: a button on that very message. «تا یک روز بعد کاری
 * کرد» is anything the person did in the next day, which the message can only
 * share the credit for. They are labelled for what each can honestly say.
 */
defineProps<{ data: InteractionReturnResponse }>();

const MILESTONES: Array<{
  label: string;
  eligible: keyof InteractionReturnCohort;
  returned: keyof InteractionReturnCohort;
}> = [
  { label: 'بعد از ۱ روز', eligible: 'eligibleDay1', returned: 'returnedDay1' },
  { label: 'بعد از ۷ روز', eligible: 'eligibleDay7', returned: 'returnedDay7' },
  { label: 'بعد از ۳۰ روز', eligible: 'eligibleDay30', returned: 'returnedDay30' },
];

function sourceLabel(row: InteractionReturnRow): string {
  return row.source === null ? UNATTRIBUTED_FA : ACQUISITION_SOURCE_FA[row.source];
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="return">
    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-semibold">چند نفر برگشتند</h2>
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[44rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">منبع</th>
              <th class="px-4 py-3 text-start font-medium">وارد شدند</th>
              <th
                v-for="milestone in MILESTONES"
                :key="milestone.label"
                class="px-4 py-3 text-start font-medium"
              >
                {{ milestone.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in data.cohorts.rows"
              :key="row.source ?? 'none'"
              class="border-b border-line"
            >
              <td class="px-4 py-3 font-medium">{{ sourceLabel(row) }}</td>
              <td class="px-4 py-3 font-medium tabular-nums">
                <bdi>{{ formatNumber(row.arrived) }}</bdi>
              </td>
              <td v-for="milestone in MILESTONES" :key="milestone.label" class="px-4 py-3">
                <span v-if="row[milestone.eligible] === 0" class="text-xs text-ink-faint">
                  هنوز زود است
                </span>
                <span v-else class="tabular-nums">
                  <bdi>{{ share(row[milestone.returned], row[milestone.eligible]) }}</bdi>
                  <span class="ms-1 text-xs text-ink-soft">
                    <bdi>{{ formatNumber(row[milestone.returned]) }}</bdi> از
                    <bdi>{{ formatNumber(row[milestone.eligible]) }}</bdi>
                  </span>
                </span>
              </td>
            </tr>
          </tbody>
          <tfoot class="bg-neutral-soft/40">
            <tr>
              <td class="px-4 py-3 font-semibold">همه</td>
              <td class="px-4 py-3 font-semibold tabular-nums">
                <bdi>{{ formatNumber(data.cohorts.totals.arrived) }}</bdi>
              </td>
              <td v-for="milestone in MILESTONES" :key="milestone.label" class="px-4 py-3">
                <span
                  v-if="data.cohorts.totals[milestone.eligible] === 0"
                  class="text-xs text-ink-faint"
                >
                  هنوز زود است
                </span>
                <span v-else class="tabular-nums">
                  <bdi>{{
                    share(
                      data.cohorts.totals[milestone.returned],
                      data.cohorts.totals[milestone.eligible],
                    )
                  }}</bdi>
                  <span class="ms-1 text-xs text-ink-soft">
                    <bdi>{{ formatNumber(data.cohorts.totals[milestone.returned]) }}</bdi> از
                    <bdi>{{ formatNumber(data.cohorts.totals[milestone.eligible]) }}</bdi>
                  </span>
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="text-xs text-ink-faint">
        فقط حساب‌هایی که در همین بازه ساخته شده‌اند. «بعد از ۷ روز» یعنی هفت روز یا بیشتر پس از
        ورود، دست‌کم یک کار در ربات کرده‌اند. هر درصد نسبت به حساب‌هایی است که آن‌قدر از ورودشان
        گذشته که بشود این را درباره‌شان پرسید؛ برای همین عدد دوم هر خانه با «وارد شدند» یکی نیست.
        بلاک کردن برگشتن حساب نمی‌شود.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-semibold">پیام‌هایی که ربات خودش فرستاد</h2>
      <p v-if="data.notifications.length === 0" class="text-sm text-ink-soft">
        در این بازه پیامی فرستاده نشده است.
      </p>
      <div v-else class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[44rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">پیام</th>
              <th class="px-4 py-3 text-start font-medium">فرستاده شد</th>
              <th class="px-4 py-3 text-start font-medium">به چند نفر</th>
              <th
                class="px-4 py-3 text-start font-medium"
                title="یکی از دکمه‌های زیر همان پیام زده شد"
              >
                دکمه‌اش زده شد
              </th>
              <th
                class="px-4 py-3 text-start font-medium"
                title="گیرنده در ۲۴ ساعت بعد از پیام، هر کاری در ربات کرد"
              >
                تا یک روز بعد کاری کرد
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in data.notifications"
              :key="row.templateKey"
              class="border-b border-line"
            >
              <td class="px-4 py-3 font-medium">
                {{ interactionNotificationLabel(row.templateKey) }}
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(row.sent) }}</bdi>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(row.recipients) }}</bdi>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(row.tapped) }}</bdi>
                <span class="ms-1 text-xs text-ink-soft">
                  <bdi>{{ share(row.tapped, row.sent) }}</bdi>
                </span>
              </td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(row.followedWithinDay) }}</bdi>
                <span class="ms-1 text-xs text-ink-soft">
                  <bdi>{{ share(row.followedWithinDay, row.sent) }}</bdi>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-ink-faint">
        «دکمه‌اش زده شد» دقیق است: دکمه‌ای زیر همان پیام. «تا یک روز بعد کاری کرد» فقط می‌گوید
        گیرنده بعد از پیام در ربات بوده است و همهٔ اعتبارش به پیام نمی‌رسد. جواب‌هایی که ربات به
        دکمه یا دستور خود کاربر می‌دهد این‌جا شمرده نمی‌شوند.
      </p>
    </section>
  </div>
</template>
