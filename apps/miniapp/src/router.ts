import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { useMembershipStore } from '@/stores/membership';
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
    {
      /**
       * The channel gate, when the requirement covers the whole app (v0.3.1).
       *
       * Outside `ONBOARDING_PATHS` and outside `FUNNEL_ROUTES` for different
       * reasons: it is not a step somebody finishes once, and the header would be
       * a way out of a screen that exists to have no way out.
       */
      path: '/join-channels',
      name: 'join-channels',
      component: () => import('@/views/JoinChannelsView.vue'),
    },
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
export function stepFor(
  state: string | undefined,
  pendingPolicies = 0,
  channelBlocked = false,
): string {
  if (state === 'NEW') return '/terms';
  if (state === 'TERMS_ACCEPTED') return '/profile';
  if (state === 'PROFILE_COMPLETE') {
    // The terms come first, deliberately. Both gates can be closed at once, and
    // accepting the rules is the one a user can always complete — the channel
    // check depends on Telegram answering, and being sent to a screen that cannot
    // clear itself is the worse of the two dead ends to start in.
    if (pendingPolicies > 0) return '/terms';
    return channelBlocked ? '/join-channels' : '/home';
  }
  return '/';
}

/**
 * Whether the shell should draw the header, which is also the way home (M22 phase 10).
 *
 * Here rather than in `App.vue` for the same reason `stepFor` is here: it is a
 * question about navigation state, the guard below answers the same question in a
 * different form, and the two must not be able to disagree. If this said yes on a
 * screen the guard sends elsewhere, the header would be a control that visibly
 * does nothing when tapped.
 *
 * The rule is `stepFor`'s, read backwards: the header appears exactly where
 * `stepFor` would return `/home` — a finished profile with no policy outstanding —
 * and on a screen that is not itself part of the funnel.
 */
export function showsHomeButton(
  routeName: string | undefined,
  state: string | undefined,
  pendingPolicies = 0,
  channelBlocked = false,
): boolean {
  if (stepFor(state, pendingPolicies, channelBlocked) !== '/home') return false;
  return !FUNNEL_ROUTES.has(routeName ?? '');
}

/**
 * The named routes the funnel owns.
 *
 * `splash` because it is a redirect with a spinner on it, and `terms` and
 * `profile` because they are the funnel — though in practice `stepFor` has
 * already returned a non-`/home` answer for anyone who can see those two. The set
 * is what covers the third case: a *finished* user re-reading the terms from the
 * home screen, which M22 made reachable. That screen is not a funnel step for
 * them, but it is still not a screen to hang a second navigation off.
 */
const FUNNEL_ROUTES = new Set(['splash', 'terms', 'profile', 'join-channels']);

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
 * Screens a blocked user may still reach.
 *
 * `/join-channels` because it is the gate itself, and `/terms` because a user can
 * owe both at once and the rules must stay readable — a gate that hides the terms
 * would make "read and accept the policies" unanswerable. Everything else is
 * closed while any required channel is outstanding.
 */
const CHANNEL_GATE_EXEMPT = new Set(['/join-channels', '/terms']);

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

  const membership = useMembershipStore();
  const channelBlocked = membership.blocksApp;

  const expected = stepFor(session.onboardingState, session.pendingPolicies.length, channelBlocked);

  // Still in the funnel, or held at the channel gate: exactly one screen is
  // correct — except the handful the gate deliberately leaves open.
  if (expected !== '/home') {
    if (to.path === expected) return true;
    if (expected === '/join-channels' && CHANNEL_GATE_EXEMPT.has(to.path)) return true;
    return expected;
  }

  // Onboarding done and nothing outstanding: go anywhere except back into the
  // funnel, and not to the gate screen a cleared user has no business seeing.
  if (to.path === '/join-channels') return '/home';
  return ONBOARDING_PATHS.has(to.path) ? '/home' : true;
});

export default router;
