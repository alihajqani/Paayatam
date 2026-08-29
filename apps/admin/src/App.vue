<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import AppVersion from '@/components/AppVersion.vue';
import { useSessionStore } from '@/stores/session';

/**
 * The shell: navigation, identity, sign-out — and nothing else.
 *
 * It renders **bare** on an anonymous route, so the login screen is a page rather
 * than a page inside a chrome that has nothing to put in it.
 *
 * The navigation is built from the router's own `meta`, filtered by what the
 * session holds. One declaration, two consumers (`router.ts`), so a menu entry
 * cannot point at a page the guard refuses — and an `ANALYST`, who holds
 * `dashboard.read` and nothing else, sees one link rather than eleven that all
 * lead to «دسترسی ندارید».
 */
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const GROUPS = [
  { key: 'overview', label: 'نمای کلی' },
  { key: 'moderation', label: 'بررسی و تأیید' },
  { key: 'economy', label: 'اقتصاد' },
  { key: 'system', label: 'سامانه' },
] as const;

interface NavItem {
  name: string;
  title: string;
  group: string;
}

const items = computed<NavItem[]>(() =>
  router
    .getRoutes()
    .filter((entry) => entry.meta.group !== null && entry.meta.group !== undefined)
    .filter((entry) => entry.meta.permission === undefined || session.can(entry.meta.permission))
    .map((entry) => ({
      name: String(entry.name),
      title: entry.meta.title,
      group: entry.meta.group as string,
    })),
);

const bare = computed(() => route.meta.anonymous === true || !session.signedIn);

async function signOut(): Promise<void> {
  await session.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <RouterView v-if="bare" />

  <div v-else class="flex min-h-dvh flex-col bg-surface-sunken lg:flex-row">
    <!--
      A sidebar on a desk and a scrolling strip on a phone. Logical properties
      throughout — `border-e`, `ps-`, `pe-` — so `dir="ltr"` on the document is
      the whole of an LTR locale (§3.7).
    -->
    <aside
      class="flex shrink-0 flex-col border-b border-line bg-surface lg:min-h-dvh lg:w-64 lg:border-b-0 lg:border-e"
    >
      <div class="flex items-center justify-between gap-3 px-4 py-4">
        <RouterLink :to="{ name: 'dashboard' }" class="flex items-center gap-2 text-lg font-bold">
          <!--
            The mark (M22 phase 10). `alt=""` because the words beside it are the
            link's accessible name, and width/height so the row does not reflow
            when the image lands.
          -->
          <img
            src="/brand/mark-96.webp"
            alt=""
            aria-hidden="true"
            width="24"
            height="24"
            decoding="async"
            class="size-6 shrink-0"
          />
          پنل پایه‌تَم
        </RouterLink>
        <span class="rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-ink-soft lg:hidden">
          {{ session.session?.displayName }}
        </span>
      </div>

      <!-- The six ribbon colours, as the Mini App draws them. Decoration; no text
           is drawn in it or on it, so it cannot fail a contrast check. -->
      <div class="brand-rule mx-4 h-0.5 rounded-full opacity-80" role="presentation"></div>

      <nav class="flex gap-4 overflow-x-auto px-4 pb-3 lg:flex-col lg:gap-5 lg:overflow-visible">
        <div v-for="group in GROUPS" :key="group.key" class="flex shrink-0 flex-col gap-1">
          <template v-if="items.some((item) => item.group === group.key)">
            <p class="hidden text-xs text-ink-faint lg:block">{{ group.label }}</p>
            <div class="flex gap-2 lg:flex-col lg:gap-0.5">
              <RouterLink
                v-for="item in items.filter((entry) => entry.group === group.key)"
                :key="item.name"
                :to="{ name: item.name }"
                class="rounded-lg px-3 py-2 text-sm whitespace-nowrap hover:bg-neutral-soft"
                :class="
                  route.name === item.name
                    ? 'bg-brand-soft font-medium text-brand'
                    : 'text-ink-soft'
                "
                :aria-current="route.name === item.name ? 'page' : undefined"
              >
                {{ item.title }}
              </RouterLink>
            </div>
          </template>
        </div>
      </nav>

      <!--
        `mt-auto`, so on a desk it sits at the foot of a full-height sidebar; on a
        phone the sidebar is a short strip and it simply follows the nav.
      -->
      <AppVersion class="mt-auto" />
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="hidden items-center justify-between gap-4 border-b border-line bg-surface px-6 py-3 lg:flex"
      >
        <h1 class="text-base font-semibold">{{ route.meta.title }}</h1>
        <div class="flex items-center gap-3 text-sm">
          <!--
            The email, because a staff account is identified by one and an
            operator with two panels open needs to know which is which. The roles
            beside it, because what somebody can do explains what they are seeing.
          -->
          <span class="text-ink-soft">
            {{ session.session?.displayName }}
            <span class="text-ink-faint">· {{ session.session?.email }}</span>
          </span>
          <button type="button" class="min-h-9 rounded-lg border border-line px-3" @click="signOut">
            خروج
          </button>
        </div>
      </header>

      <!--
        A tab that reloaded holds the cookie and gets its CSRF token back from
        `/me`. If it somehow did not, every mutation would 403 — so the panel says
        so once, at the top, rather than per click.
      -->
      <p
        v-if="!session.canMutate"
        class="border-b border-line bg-warn-soft px-6 py-2 text-sm text-warn"
        role="status"
      >
        این نشست فقط خواندنی است. برای انجام تغییرات دوباره وارد شوید.
      </p>

      <main class="min-w-0 flex-1 p-4 lg:p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
