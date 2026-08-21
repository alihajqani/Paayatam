<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useSessionStore } from '@/stores/session';

/**
 * Where the router sends a session that cannot open a page.
 *
 * A page rather than a silent redirect to the dashboard, because "nothing
 * happened when I clicked" is a worse answer than "you do not have this
 * permission" — and it names the permission, because the fix is a role change
 * somebody else has to approve (four-eyes, ADR-0010 rule 4) and they will ask
 * which one.
 */
const route = useRoute();
const session = useSessionStore();
</script>

<template>
  <div class="mx-auto max-w-lg rounded-2xl border border-line bg-surface p-8 text-center">
    <h1 class="text-xl font-bold">دسترسی ندارید</h1>
    <p class="mt-3 text-sm leading-relaxed text-ink-soft">
      حساب شما مجوز لازم برای این بخش را ندارد. اگر به آن نیاز دارید، از یک مدیر ارشد بخواهید نقش
      شما را تغییر دهد — این تغییر به تأیید یک مدیر دیگر هم نیاز دارد.
    </p>
    <p v-if="route.query.required" class="mt-4 text-sm text-ink-faint">
      مجوز لازم: <bdi class="font-mono">{{ route.query.required }}</bdi>
    </p>
    <p class="mt-2 text-sm text-ink-faint">
      نقش فعلی شما: {{ session.session?.roles.join('، ') || '—' }}
    </p>
  </div>
</template>
