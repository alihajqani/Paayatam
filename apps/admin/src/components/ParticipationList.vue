<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { AdminParticipationListResponse, AdminParticipationView } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDateTime, formatNumber, toPersianDigits } from '@/format/fa';

/**
 * Who asked to join what — under one person, or under one activity.
 *
 * The user page had a tally by status and the event list a request count, so
 * «which activities did this person ask for, and where did the coins go?» was a
 * database session. Given a `userPublicId` this lists the activities; given an
 * `eventPublicId`, the people. The column the page already names is left out.
 *
 * The coins column is the ledger's own answer: what the request took and whether
 * a rejection, an expiry, an unreached waiting place or a host cancellation gave
 * it back. A withdrawal keeps it — «برنگشت» on a cancelled row is a guest who paid
 * and withdrew, which is the conversation support is usually having.
 *
 * The parent shows this only to a session with `user.read`; the API refuses it
 * to anyone else regardless.
 */
const props = defineProps<{ userPublicId?: string; eventPublicId?: string }>();

const LIMIT = 50;

const rows = ref<AdminParticipationView[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);

const byPerson = computed(() => props.userPublicId !== undefined);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<AdminParticipationListResponse>('/participations', {
      query: {
        ...(props.userPublicId !== undefined ? { userPublicId: props.userPublicId } : {}),
        ...(props.eventPublicId !== undefined ? { eventPublicId: props.eventPublicId } : {}),
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.participations;
    total.value = page.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست درخواست‌ها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

/** «۲۰ سکه — برنگشت», or «رایگان» for a request that took nothing. */
function coinsLine(row: AdminParticipationView): { amount: string; fate: string | null } {
  const { charged, refunded } = row.joinCoins;
  if (charged === 0) return { amount: 'رایگان', fate: null };
  const amount = `${formatNumber(charged)} سکه`;
  if (refunded >= charged) return { amount, fate: 'برگشت خورد' };
  if (refunded > 0) return { amount, fate: `${formatNumber(refunded)} سکه برگشت خورد` };
  return { amount, fate: 'برنگشت' };
}

watch(offset, () => void load());
watch(
  () => [props.userPublicId, props.eventPublicId],
  () => {
    offset.value = 0;
    void load();
  },
);
onMounted(load);
</script>

<template>
  <StateBlock
    :state="state"
    :error-text="error"
    :rows="3"
    :empty-text="byPerson ? 'هنوز برای رویدادی درخواست نداده است.' : 'هنوز کسی درخواست نداده است.'"
    @retry="load"
  >
    <div class="overflow-x-auto">
      <table class="w-full min-w-[40rem] text-sm">
        <thead class="border-b border-line text-ink-soft">
          <tr>
            <th class="px-3 py-2 text-start font-medium">{{ byPerson ? 'رویداد' : 'کاربر' }}</th>
            <th class="px-3 py-2 text-start font-medium">وضعیت</th>
            <th class="px-3 py-2 text-start font-medium">زمان درخواست</th>
            <th class="px-3 py-2 text-start font-medium">سکهٔ درخواست</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.publicId" class="border-b border-line last:border-0">
            <td class="px-3 py-2">
              <template v-if="byPerson">
                <span class="font-medium">
                  <bdi>#{{ toPersianDigits(row.event.number) }}</bdi>
                  {{ row.event.title }}
                </span>
                <span class="block text-xs text-ink-faint">
                  {{ row.event.cityNameFa }} · {{ formatDateTime(row.event.startsAt) }}
                </span>
                <span
                  v-if="row.event.isSeeded"
                  class="mt-1 inline-block rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-ink-soft"
                >
                  ساختگی
                </span>
              </template>
              <template v-else>
                <span v-if="row.user.isSeed">
                  {{ row.user.displayName ?? 'بدون نام' }}
                  <span class="ms-1 rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-ink-soft">
                    ساختگی
                  </span>
                </span>
                <RouterLink
                  v-else
                  :to="{ name: 'user-detail', params: { publicId: row.user.publicId } }"
                  class="text-brand"
                >
                  {{ row.user.displayName ?? 'بدون نام' }}
                </RouterLink>
              </template>
            </td>
            <td class="px-3 py-2">
              <StatusPill :value="row.status" />
              <span v-if="row.cancelledAt" class="mt-1 block text-xs text-ink-faint">
                لغو: {{ formatDateTime(row.cancelledAt) }}
              </span>
            </td>
            <td class="px-3 py-2 text-ink-soft">{{ formatDateTime(row.requestedAt) }}</td>
            <td class="px-3 py-2">
              <bdi class="tabular-nums">{{ coinsLine(row).amount }}</bdi>
              <span v-if="coinsLine(row).fate" class="block text-xs text-ink-faint">
                {{ coinsLine(row).fate }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <PagerBar
      v-if="total > LIMIT"
      :total="total"
      :limit="LIMIT"
      :offset="offset"
      :loading="loading"
      @move="offset = $event"
    />
  </StateBlock>
</template>
