import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { useSessionStore } from '@/stores/session';

/**
 * Three screens and a splash.
 *
 * `createWebHistory` rather than hash routing: Telegram's WebView handles the
 * History API fine, and hash URLs would show up in the deep links M4 needs.
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'splash', component: () => import('@/views/SplashView.vue') },
    { path: '/terms', name: 'terms', component: () => import('@/views/TermsView.vue') },
    { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue') },
    { path: '/home', name: 'home', component: () => import('@/views/HomeView.vue') },
    // Anything else lands on the splash, which redirects by onboarding state.
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/**
 * Sends the user to the step they are actually on.
 *
 * A mirror of the server's gate, not a replacement for it: the terms gate lives
 * in `AuthGuard` and the 18+ rule in `ProfileService`. This exists so the user
 * sees the right screen, not so the rules are enforced — a router guard is a
 * navigation aid and can be walked past by anyone who cares to.
 */
export function stepFor(state: string | undefined): string {
  if (state === 'NEW') return '/terms';
  if (state === 'TERMS_ACCEPTED') return '/profile';
  if (state === 'PROFILE_COMPLETE') return '/home';
  return '/';
}

router.beforeEach((to: RouteLocationNormalized) => {
  if (to.name === 'splash') return true;

  const session = useSessionStore();
  if (!session.ready) return '/';

  const expected = stepFor(session.onboardingState);
  return to.path === expected ? true : expected;
});

export default router;
