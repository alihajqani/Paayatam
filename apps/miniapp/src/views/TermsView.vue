<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import MainButton from '@/components/MainButton.vue';
import { ApiError } from '@/api/client';
import { formatEventDateWithYear } from '@/format/datetime';
import { haptic } from '@/telegram/webapp';
import { useSessionStore } from '@/stores/session';

/**
 * The rules, in the three situations a user meets them (M22 phase 8).
 *
 *  - **Onboarding.** Read them, tick the box, continue to the profile.
 *  - **Re-acceptance.** A version was published after they joined. Same screen,
 *    different heading, and afterwards they go back to `/home` rather than into
 *    the funnel. The router sends them here from wherever they were and keeps
 *    sending them until `pendingPolicies` is empty.
 *  - **Re-reading.** Nothing is pending; the screen is a document viewer with no
 *    checkbox and no button. This is what "support re-opening the current terms"
 *    means, and it is why `/terms` left `ONBOARDING_PATHS` in M22.
 *
 * The checkbox is not the consent record — the server writes that, against the
 * specific policy versions it considers current, and refuses a stale set. This
 * screen's only job is to make the act deliberate: it starts unticked, every time,
 * and opening the page records nothing.
 */
const router = useRouter();
const session = useSessionStore();

const loading = ref(false);
const agreed = ref(false);
const error = ref<string | null>(null);
/**
 * True once `load()` has settled, however it settled.
 *
 * Without it, "no policy has been published" and "the documents have not arrived
 * yet" render the same skeleton — forever, on a deployment whose legal text is
 * still in draft. Two states that look identical and mean different things is
 * how a screen becomes a spinner nobody can get past (report 1).
 */
const loaded = ref(false);

/** Nothing outstanding means this is a read, not a decision. */
const readOnly = computed(
  () => session.onboardingState === 'PROFILE_COMPLETE' && session.pendingPolicies.length === 0,
);

/** True when the user has accepted *something* before — so this is an update. */
const isUpdate = computed(
  () => session.acceptedPolicies.length > 0 && session.pendingPolicies.length > 0,
);

const heading = computed(() => {
  if (readOnly.value) return 'قوانین و شرایط استفاده';
  return isUpdate.value ? 'قوانین به‌روزرسانی شده است' : 'قوانین و شرایط استفاده';
});

/** When it was accepted, per document — so «آخرین پذیرش» is answerable in-app. */
const acceptedAtByPolicy = computed(
  () => new Map(session.acceptedPolicies.map((entry) => [entry.policy.id, entry.acceptedAt])),
);

const pendingIds = computed(() => new Set(session.pendingPolicies.map((policy) => policy.id)));

async function load(): Promise<void> {
  error.value = null;
  try {
    await session.loadPolicies();
    await session.loadMyPolicies();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.messageFa : 'قوانین بارگذاری نشد.';
  } finally {
    loaded.value = true;
  }
}

async function submit(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    await session.acceptTerms();
    haptic('success');
    // Onboarding continues into the profile; an existing user goes back to the
    // product they were using when the gate stopped them.
    await router.replace(session.onboardingState === 'PROFILE_COMPLETE' ? '/home' : '/profile');
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
    <header class="flex items-start justify-between gap-3">
      <h1 class="text-xl font-bold">{{ heading }}</h1>
      <button
        v-if="readOnly"
        type="button"
        class="min-h-11 shrink-0 text-tg-link"
        aria-label="بازگشت به خانه"
        @click="router.push('/home')"
      >
        خانه
      </button>
    </header>

    <p v-if="isUpdate" class="rounded-xl bg-tg-secondary-bg p-4 text-sm">
      نسخهٔ تازه‌ای از قوانین منتشر شده است. برای ادامهٔ استفاده از پایه‌تَم، لطفاً آن را بخوانید و
      بپذیرید.
    </p>

    <div v-if="error" class="flex flex-col items-start gap-2">
      <p class="text-tg-destructive">{{ error }}</p>
      <button type="button" class="min-h-11 text-tg-link" @click="load">تلاش دوباره</button>
    </div>

    <!-- Skeleton, not a spinner: the shape of this screen is known in advance. -->
    <div
      v-else-if="!loaded && session.policies.length === 0"
      class="flex flex-col gap-2"
      aria-hidden="true"
    >
      <div v-for="n in 6" :key="n" class="h-4 rounded bg-tg-secondary-bg"></div>
    </div>

    <!--
      Loaded, and there is nothing to show.

      A deployment whose legal text is still in draft has no current version, and
      `ConsentService.hasAcceptedCurrentPolicies` returns true for that state on
      purpose — so nothing is blocked and this screen is a read with nothing in
      it. Saying so is the difference between a product that is fine and a screen
      that looks broken.
    -->
    <div v-else-if="session.policies.length === 0" class="flex flex-col gap-3">
      <p class="text-tg-hint">هنوز نسخه‌ای از قوانین منتشر نشده است.</p>
      <button type="button" class="min-h-11 self-start text-tg-link" @click="router.push('/home')">
        بازگشت به خانه
      </button>
    </div>

    <section
      v-for="policy in session.policies"
      v-else
      :key="policy.id"
      class="rounded-xl bg-tg-secondary-bg p-4"
    >
      <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="font-medium">{{ policy.titleFa ?? policy.summaryFa ?? policy.type }}</h2>
        <!--
          The exact version, shown because it is what the consent record snapshots.
          A user asked to agree to «نسخهٔ ۳» should be able to see that they are.
        -->
        <span class="text-xs text-tg-hint">{{ policy.label }}</span>
      </div>

      <p v-if="policy.changeSummaryFa" class="mb-2 text-sm text-tg-accent">
        تغییرات این نسخه: {{ policy.changeSummaryFa }}
      </p>

      <p
        v-if="acceptedAtByPolicy.has(policy.id)"
        class="mb-2 text-xs text-tg-hint"
        data-testid="accepted-at"
      >
        پذیرفته‌شده در {{ formatEventDateWithYear(acceptedAtByPolicy.get(policy.id)!) }}
      </p>
      <p v-else-if="pendingIds.has(policy.id)" class="mb-2 text-xs text-tg-destructive">
        هنوز پذیرفته نشده است.
      </p>

      <!--
        `white-space: pre-line` rather than a Markdown renderer, and that is now a
        security property as well as a size one: the text is authored in the admin
        panel from M22 on, and rendering admin-authored Markdown as HTML would be
        an XSS surface pointed at every user. Interpolation escapes; `v-html` would
        not, which is why it is not here.
      -->
      <p class="whitespace-pre-line text-sm leading-7 text-tg-subtitle">{{ policy.contentMd }}</p>
    </section>

    <template v-if="!readOnly">
      <label class="flex min-h-11 items-center gap-3">
        <!--
          Starts unticked, always. A pre-checked box is not consent, and rebuilding
          this component on every visit is what guarantees it.
        -->
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
    </template>
  </main>
</template>
