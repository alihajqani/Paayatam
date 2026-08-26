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
    {
      /**
       * Editing, as opposed to `/profile`, which is the onboarding step (M22).
       *
       * Declared outside `ONBOARDING_PATHS` on purpose: it is a *product* screen
       * reachable from home, and putting it in the funnel would bounce every
       * finished user straight back to `/home` the moment they opened it.
       */
      path: '/profile/edit',
      name: 'profile-edit',
      component: () => import('@/views/EditProfileView.vue'),
    },
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
    { path: '/reviews', name: 'reviews', component: () => import('@/views/ReviewsView.vue') },
    { path: '/wallet', name: 'wallet', component: () => import('@/views/WalletView.vue') },
    // Anything else lands on the splash, which redirects by onboarding state.
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/**
 * The one screen a user in each onboarding state belongs on.
 *
 * `pendingPolicies` is the M22 addition and it applies **after** onboarding: a
 * user who finished months ago and has not accepted a version published since is
 * sent back to `/terms` and stays there until they do. Everything before that is
 * unchanged.
 */
export function stepFor(state: string | undefined, pendingPolicies = 0): string {
  if (state === 'NEW') return '/terms';
  if (state === 'TERMS_ACCEPTED') return '/profile';
  if (state === 'PROFILE_COMPLETE') return pendingPolicies > 0 ? '/terms' : '/home';
  return '/';
}

/**
 * Routes that only make sense while onboarding is unfinished.
 *
 * `/terms` is deliberately **not** here from M22 on. A finished user must be able
 * to re-open the rules they agreed to — "support re-opening the current terms" —
 * and a path in this set is bounced straight back to `/home`. The gate that used
 * to rely on that is now `stepFor`, which returns `/terms` for anybody who owes an
 * acceptance and `/home` for everybody else.
 */
const ONBOARDING_PATHS = new Set(['/profile']);

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

  const expected = stepFor(session.onboardingState, session.pendingPolicies.length);

  // Still in the funnel: exactly one screen is correct.
  if (expected !== '/home') return to.path === expected ? true : expected;

  // Onboarding done: go anywhere except back into it.
  return ONBOARDING_PATHS.has(to.path) ? '/home' : true;
});

export default router;
