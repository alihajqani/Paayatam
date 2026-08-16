<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import MainButton from '@/components/MainButton.vue';
import { ApiError } from '@/api/client';
import { haptic } from '@/telegram/webapp';
import { useSessionStore } from '@/stores/session';

/**
 * Step one: read the rules, agree to them.
 *
 * The checkbox is not the consent record — the server writes that, against the
 * specific policy versions it considers current, and refuses a stale set. This
 * screen's only job is to make the act deliberate.
 */
const router = useRouter();
const session = useSessionStore();

const loading = ref(false);
const agreed = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    await session.loadPolicies();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'قوانین بارگذاری نشد.';
  }
}

async function submit(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    await session.acceptTerms();
    haptic('success');
    await router.replace('/profile');
  } catch (cause) {
    haptic('error');
    error.value = cause instanceof ApiError ? cause.messageFa : 'ثبت پذیرش انجام نشد.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="flex flex-1 flex-col gap-4 py-4">
    <h1 class="text-xl font-bold">قوانین و شرایط استفاده</h1>

    <div v-if="error" class="flex flex-col items-start gap-2">
      <p class="text-tg-destructive">{{ error }}</p>
      <button type="button" class="min-h-11 text-tg-link" @click="load">تلاش دوباره</button>
    </div>

    <!-- Skeleton, not a spinner: the shape of this screen is known in advance. -->
    <div v-else-if="session.policies.length === 0" class="flex flex-col gap-2" aria-hidden="true">
      <div v-for="n in 6" :key="n" class="h-4 rounded bg-tg-secondary-bg"></div>
    </div>

    <section
      v-for="policy in session.policies"
      v-else
      :key="policy.id"
      class="rounded-xl bg-tg-secondary-bg p-4"
    >
      <h2 class="mb-2 font-medium">{{ policy.summaryFa ?? policy.type }}</h2>
      <!--
        `white-space: pre-line` rather than a Markdown renderer. The seeded text is
        plain paragraphs, and shipping a Markdown parser to render five of them
        would be bytes over a mobile connection for nothing. A real renderer
        arrives with the admin-authored policies in M12.
      -->
      <p class="whitespace-pre-line text-sm leading-7 text-tg-subtitle">{{ policy.contentMd }}</p>
    </section>

    <label class="flex min-h-11 items-center gap-3">
      <input v-model="agreed" type="checkbox" class="size-5 accent-[var(--color-tg-button)]" />
      <span>قوانین و سیاست حریم خصوصی را خوانده‌ام و می‌پذیرم.</span>
    </label>

    <div class="flex-1"></div>

    <MainButton
      text="می‌پذیرم و ادامه می‌دهم"
      :disabled="!agreed || session.policies.length === 0"
      :loading="loading"
      @click="submit"
    />
  </main>
</template>
