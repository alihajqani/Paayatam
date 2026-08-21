<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { AdminUserListResponse, AdminUserView, UserStatusView } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import PagerBar from '@/components/PagerBar.vue';
import StateBlock from '@/components/StateBlock.vue';
import StatusPill from '@/components/StatusPill.vue';
import { formatDate, formatNumber, formatTrust } from '@/format/fa';

/**
 * Finding a person.
 *
 * The search box takes a display name **or** a `publicId` pasted from a report,
 * because those are the two things an operator actually has when somebody asks
 * them to look at an account. The server matches the name through the ADR-0012
 * normalizer, so «علي» finds «علی» — the admin surface must not be the one search
 * in the product where Persian does not work.
 *
 * Debounced, because a keystroke is not a query: typing «رضایی» unthrottled is
 * six requests, five of which are already stale when they land.
 */
const LIMIT = 25;

const rows = ref<AdminUserView[]>([]);
const total = ref(0);
const offset = ref(0);
const query = ref('');
const status = ref<UserStatusView | ''>('');
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (!loaded.value) return 'loading' as const;
  return rows.value.length === 0 ? ('empty' as const) : ('ready' as const);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await request<AdminUserListResponse>('/users', {
      query: {
        query: query.value.trim(),
        status: status.value,
        limit: LIMIT,
        offset: offset.value,
      },
    });
    rows.value = page.users;
    total.value = page.total;
    loaded.value = true;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست کاربران بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([query, status], () => {
  // Back to the first page: page 4 of the previous filter is not page 4 of this
  // one, and staying there shows an empty table for a search that has results.
  offset.value = 0;
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});

watch(offset, () => void load());

const STATUSES: Array<{ value: UserStatusView | ''; label: string }> = [
  { value: '', label: 'همه' },
  { value: 'ACTIVE', label: 'فعال' },
  { value: 'SUSPENDED', label: 'معلق' },
  { value: 'BANNED', label: 'مسدود' },
  { value: 'DELETED', label: 'حذف‌شده' },
];

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="flex min-w-64 flex-1 flex-col gap-1">
        <span class="text-sm text-ink-soft">جست‌وجو</span>
        <input
          v-model="query"
          type="search"
          placeholder="نام نمایشی یا شناسهٔ عمومی"
          class="min-h-10 rounded-lg border border-line bg-surface px-3"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-sm text-ink-soft">وضعیت حساب</span>
        <select v-model="status" class="min-h-10 rounded-lg border border-line bg-surface px-3">
          <option v-for="option in STATUSES" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <button
        type="submit"
        class="min-h-10 rounded-lg border border-line px-4 text-sm"
        :disabled="loading"
      >
        {{ loading ? 'در حال جست‌وجو…' : 'جست‌وجو' }}
      </button>
    </form>

    <StateBlock
      :state="state"
      :error-text="error"
      empty-text="کاربری با این مشخصات پیدا نشد."
      @retry="load"
    >
      <div class="overflow-x-auto rounded-xl border border-line bg-surface">
        <table class="w-full min-w-[52rem] text-sm">
          <thead class="border-b border-line text-ink-soft">
            <tr>
              <th class="px-4 py-3 text-start font-medium">نام نمایشی</th>
              <th class="px-4 py-3 text-start font-medium">وضعیت</th>
              <th class="px-4 py-3 text-start font-medium">امتیاز اعتماد</th>
              <th class="px-4 py-3 text-start font-medium">موجودی</th>
              <th class="px-4 py-3 text-start font-medium">عضویت</th>
              <th class="px-4 py-3 text-start font-medium"><span class="sr-only">پرونده</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="user in rows"
              :key="user.publicId"
              class="border-b border-line last:border-0"
            >
              <td class="px-4 py-3">
                <span class="font-medium">{{ user.displayName ?? 'بدون نام' }}</span>
                <!--
                  The public id under the name, in a `bdi`: a Latin identifier
                  inside RTL text renders with its segments reversed otherwise,
                  and this is the string an operator copies into a report.
                -->
                <bdi class="block font-mono text-xs text-ink-faint">{{ user.publicId }}</bdi>
              </td>
              <td class="px-4 py-3"><StatusPill :value="user.status" /></td>
              <!-- Null is «تازه‌وارد», never «۰» (ADR-0014). -->
              <td class="px-4 py-3 text-ink-soft">{{ formatTrust(user.trustScore) }}</td>
              <td class="px-4 py-3 tabular-nums">
                <bdi>{{ formatNumber(user.coinBalance) }}</bdi> سکه
              </td>
              <td class="px-4 py-3 text-ink-soft">{{ formatDate(user.createdAt) }}</td>
              <td class="px-4 py-3 text-end">
                <RouterLink
                  :to="{ name: 'user-detail', params: { publicId: user.publicId } }"
                  class="text-brand"
                >
                  پرونده
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PagerBar
        :total="total"
        :limit="LIMIT"
        :offset="offset"
        :loading="loading"
        @move="offset = $event"
      />
    </StateBlock>
  </div>
</template>
