import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { useSessionStore } from '@/stores/session';

/**
 * Onboarding is a funnel; everything after it is an app.
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
    { path: '/discover', name: 'discover', component: () => import('@/views/DiscoverView.vue') },
    {
      path: '/events/new',
      name: 'event-new',
      component: () => import('@/views/CreateEventView.vue'),
    },
    {
      // Declared after `/events/new`, or the literal would be swallowed as an id.
      path: '/events/:publicId',
      name: 'event-detail',
      component: () => import('@/views/EventDetailView.vue'),
    },
    {
      path: '/events/:publicId/edit',
      name: 'event-edit',
      component: () => import('@/views/EditEventView.vue'),
    },
    { path: '/my-events', name: 'my-events', component: () => import('@/views/MyEventsView.vue') },
    {
      path: '/my-requests',
      name: 'my-requests',
      component: () => import('@/views/MyRequestsView.vue'),
    },
    { path: '/chats', name: 'chats', component: () => import('@/views/ChatsView.vue') },
    // Anything else lands on the splash, which redirects by onboarding state.
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/** The one screen a user in each onboarding state belongs on. */
export function stepFor(state: string | undefined): string {
  if (state === 'NEW') return '/terms';
  if (state === 'TERMS_ACCEPTED') return '/profile';
  if (state === 'PROFILE_COMPLETE') return '/home';
  return '/';
}

/** Routes that only make sense while onboarding is unfinished. */
const ONBOARDING_PATHS = new Set(['/terms', '/profile']);

/**
 * Sends the user to the step they are actually on — while they still have one.
 *
 * A mirror of the server's gate, not a replacement for it: the terms gate lives in
 * `AuthGuard` and the 18+ rule in `ProfileService`. This exists so the user sees the
 * right screen, not so the rules are enforced — a router guard is a navigation aid
 * and can be walked past by anyone who cares to.
 *
 * **Once onboarding is finished the funnel stops applying.** Forcing
 * `to.path === stepFor(state)` was right when there were three screens and exactly one
 * of them was correct; with a product behind it, that rule would redirect every
 * navigation back to `/home`.
 */
router.beforeEach((to: RouteLocationNormalized) => {
  if (to.name === 'splash') return true;

  const session = useSessionStore();
  if (!session.ready) return '/';

  const expected = stepFor(session.onboardingState);

  // Still in the funnel: exactly one screen is correct.
  if (expected !== '/home') return to.path === expected ? true : expected;

  // Onboarding done: go anywhere except back into it.
  return ONBOARDING_PATHS.has(to.path) ? '/home' : true;
});

export default router;
