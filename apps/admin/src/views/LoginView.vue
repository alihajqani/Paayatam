<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminLoginRequest } from '@payetam/shared';
import { messageOf } from '@/api/client';
import { useSessionStore } from '@/stores/session';

/**
 * Email, password and TOTP — all three, always (D11, ADR-0010).
 *
 * The form validates with `adminLoginRequest`, the same zod schema the API
 * validates with, so a six-digit rule is stated once and cannot drift. What it
 * does **not** do is tell the operator which of the three was wrong: the API
 * answers `INVALID_CREDENTIALS` for an unknown email, a wrong password, a wrong
 * code and a suspended account alike, because distinguishing them turns this into
 * an oracle for which staff addresses exist. The panel repeats the server's
 * sentence rather than improving on it.
 *
 * There is no "remember me". The session is a twelve-hour idle cookie the browser
 * holds; adding a longer-lived credential to a surface that can move currency
 * would be trading the one property this login has for convenience.
 */
const router = useRouter();
const route = useRoute();
const session = useSessionStore();

const email = ref('');
const password = ref('');
const totpCode = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

/**
 * Client-side validity, from the shared schema.
 *
 * It disables the button and nothing else — the server validates the same shape
 * again, and a form that let somebody submit a five-digit code just to be told
 * "invalid credentials" would be indistinguishable from a wrong code.
 */
const valid = computed(
  () =>
    adminLoginRequest.safeParse({
      email: email.value,
      password: password.value,
      totpCode: totpCode.value,
    }).success,
);

async function submit(): Promise<void> {
  if (!valid.value || submitting.value) return;
  submitting.value = true;
  error.value = null;

  try {
    await session.login({
      email: email.value.trim(),
      password: password.value,
      totpCode: totpCode.value.trim(),
    });
    const redirect = route.query.redirect;
    await router.push(
      typeof redirect === 'string' && redirect !== '' ? redirect : { name: 'dashboard' },
    );
  } catch (cause) {
    error.value = messageOf(cause, 'ورود انجام نشد.');
    // Cleared on failure, kept on the email: retyping an address you got right is
    // the friction nobody needs, and a password left in a field is one a
    // screenshot picks up.
    password.value = '';
    totpCode.value = '';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-dvh items-center justify-center bg-surface-sunken p-4">
    <form
      class="w-full max-w-sm rounded-2xl border border-line bg-surface p-6"
      novalidate
      @submit.prevent="submit"
    >
      <h1 class="text-xl font-bold">ورود به پنل مدیریت</h1>
      <p class="mt-1 text-sm text-ink-soft">پایه‌تَم</p>

      <label class="mt-6 block">
        <span class="text-sm text-ink-soft">ایمیل</span>
        <input
          v-model="email"
          type="email"
          inputmode="email"
          autocomplete="username"
          dir="ltr"
          class="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3"
          required
        />
      </label>

      <label class="mt-4 block">
        <span class="text-sm text-ink-soft">رمز عبور</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          dir="ltr"
          class="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3"
          required
        />
      </label>

      <label class="mt-4 block">
        <span class="text-sm text-ink-soft">کد تأیید دومرحله‌ای</span>
        <input
          v-model="totpCode"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          dir="ltr"
          class="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 tracking-widest"
          required
        />
      </label>

      <p v-if="error" class="mt-4 text-sm text-danger" role="alert">{{ error }}</p>

      <button
        type="submit"
        class="mt-6 min-h-11 w-full rounded-lg bg-brand text-brand-ink disabled:opacity-40"
        :disabled="!valid || submitting"
      >
        {{ submitting ? 'در حال ورود…' : 'ورود' }}
      </button>

      <p class="mt-4 text-xs leading-relaxed text-ink-faint">
        پس از پنج تلاش ناموفق، حساب برای مدتی قفل می‌شود و این مدت با هر تلاش بیشتر می‌شود.
      </p>
    </form>
  </main>
</template>
