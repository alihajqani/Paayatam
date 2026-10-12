<script setup lang="ts">
import {
  ACQUISITION_SOURCE_FA,
  UNATTRIBUTED_FA,
  interactionStepLabel,
  interactionWizardLabel,
} from '@payetam/shared';
import type {
  InteractionFunnelsResponse,
  InteractionOnboardingFunnel,
  InteractionOnboardingRow,
} from '@payetam/shared';
import { formatNumber } from '@/format/fa';
import { share } from '@/format/share';

/**
 * How far new accounts get, and where each form loses people.
 *
 * ── Two funnels, two denominators ───────────────────────────────────────────
 *
 * The first table is about **accounts the window created**: every column is a
 * share of the people who arrived from that source, so two sources can be
 * compared however different their sizes.
 *
 * The cards under it are about **forms**: every step is a share of the people
 * who started that form. «همین‌جا ماندند» is the number to read — the people
 * who never sent the form and were last shown that question.
 *
 * Both count people, not attempts. Somebody who opens the profile form three
 * times and finishes it once is one person who finished.
 */
defineProps<{ data: InteractionFunnelsResponse }>();

const STEPS: Array<{ key: keyof InteractionOnboardingFunnel; label: string; hint: string }> = [
  {
    key: 'pressedAnything',
    label: 'کاری کردند',
    hint: 'بعد از شروع دست‌کم یک دکمه یا دستور زده‌اند',
  },
  { key: 'termsAccepted', label: 'قوانین', hint: 'قوانین را پذیرفته‌اند' },
  { key: 'profileComplete', label: 'پروفایل', hint: 'پروفایل را کامل کرده‌اند' },
  {
    key: 'openedDiscovery',
    label: 'فهرست را دیدند',
    hint: 'فهرست برنامه‌ها دست‌کم یک بار نشانشان داده شده',
  },
  {
    key: 'openedEvent',
    label: 'یک برنامه را دیدند',
    hint: 'صفحهٔ یک برنامه دست‌کم یک بار نشانشان داده شده',
  },
  { key: 'requested', label: 'درخواست دادند', hint: 'دست‌کم یک درخواست شرکت داده‌اند' },
];

function sourceLabel(row: InteractionOnboardingRow): string {
  return row.source === null ? UNATTRIBUTED_FA : ACQUISITION_SOURCE_FA[row.source];
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="funnels">
    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-semibold">از ورود تا اولین درخواست</h2>
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[56rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">منبع</th>
              <th class="px-4 py-3 text-start font-medium">وارد شدند</th>
              <th
                v-for="step in STEPS"
                :key="step.key"
                class="px-4 py-3 text-start font-medium"
                :title="step.hint"
              >
                {{ step.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in data.onboarding.rows"
              :key="row.source ?? 'none'"
              class="border-b border-line"
            >
              <td class="px-4 py-3 font-medium">{{ sourceLabel(row) }}</td>
              <td class="px-4 py-3 font-medium tabular-nums">
                <bdi>{{ formatNumber(row.arrived) }}</bdi>
              </td>
              <td v-for="step in STEPS" :key="step.key" class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(row[step.key]) }}</bdi>
                <span class="ms-1 text-xs text-ink-soft">
                  <bdi>{{ share(row[step.key], row.arrived) }}</bdi>
                </span>
              </td>
            </tr>
          </tbody>
          <tfoot class="bg-neutral-soft/40">
            <tr>
              <td class="px-4 py-3 font-semibold">همه</td>
              <td class="px-4 py-3 font-semibold tabular-nums">
                <bdi>{{ formatNumber(data.onboarding.totals.arrived) }}</bdi>
              </td>
              <td v-for="step in STEPS" :key="step.key" class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(data.onboarding.totals[step.key]) }}</bdi>
                <span class="ms-1 text-xs text-ink-soft">
                  <bdi>{{
                    share(data.onboarding.totals[step.key], data.onboarding.totals.arrived)
                  }}</bdi>
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="text-xs text-ink-faint">
        فقط حساب‌هایی که در همین بازه ساخته شده‌اند. درصدها نسبت به «وارد شدند» همان ردیف است. ترتیب
        ستون‌ها مسیر معمول است، نه اجباری: کسی که با لینک یک برنامه می‌آید ممکن است آن را پیش از
        فهرست ببیند.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-semibold">فرم‌ها، قدم به قدم</h2>
      <p v-if="data.forms.length === 0" class="text-sm text-ink-soft">
        در این بازه کسی فرمی باز نکرده است.
      </p>
      <article
        v-for="form in data.forms"
        :key="form.kind"
        class="rounded-xl border border-line bg-surface p-4"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold">{{ interactionWizardLabel(form.kind) }}</h3>
          <p class="text-sm text-ink-soft">
            <bdi>{{ formatNumber(form.started) }}</bdi> نفر شروع کردند،
            <bdi>{{ formatNumber(form.submitted) }}</bdi> نفر فرستادند
            <bdi class="text-xs">({{ share(form.submitted, form.started) }})</bdi
            ><template v-if="form.cancelled > 0"
              >، <bdi>{{ formatNumber(form.cancelled) }}</bdi> نفر خودشان بستند</template
            >
          </p>
        </div>
        <table class="mt-3 w-full text-sm">
          <thead class="text-ink-soft">
            <tr>
              <th class="pb-2 text-start font-medium">قدم</th>
              <th class="pb-2 text-start font-medium">رسیدند</th>
              <th
                class="pb-2 text-start font-medium"
                title="فرم را نفرستادند و آخرین چیزی که دیدند همین قدم بود"
              >
                همین‌جا ماندند
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="step in form.steps" :key="step.step" class="border-t border-line">
              <td class="py-2">{{ interactionStepLabel(step.step) }}</td>
              <td class="py-2 tabular-nums">
                <bdi>{{ formatNumber(step.users) }}</bdi>
              </td>
              <td class="py-2 tabular-nums" :class="step.leftHere > 0 ? 'font-medium' : ''">
                <bdi>{{ formatNumber(step.leftHere) }}</bdi>
                <span v-if="step.leftHere > 0" class="ms-1 text-xs text-ink-soft">
                  <bdi>{{ share(step.leftHere, form.started) }}</bdi>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </article>
      <p class="text-xs text-ink-faint">
        آدم‌ها شمرده می‌شوند، نه دفعات: کسی که یک فرم را سه بار باز کند و یک بار بفرستد، یک نفر است
        که فرستاده. درصد «همین‌جا ماندند» نسبت به کسانی است که آن فرم را شروع کردند.
      </p>
    </section>
  </div>
</template>
