import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { PERMISSIONS } from '@payetam/shared';
import { useSessionStore } from '@/stores/session';

/**
 * Every screen, and the permission it needs (ADR-0010).
 *
 * `meta.permission` is what the navigation reads to decide what to show and what
 * the guard reads to decide what to open — one declaration, two consumers, so a
 * screen cannot be linked from a menu it is not allowed to open.
 *
 * **This is a courtesy, not a control.** Every one of these permissions is
 * checked again in the service layer, which is where invariant 12 lives. A guard
 * that stops a person from opening a page they cannot use is a better experience
 * than a page full of 403s; it is not security, and an operator who edits the URL
 * gets the same refusals from the API either way.
 */
export interface AdminRouteMeta {
  /** Persian, for the navigation and the page heading. */
  title: string;
  permission?: string;
  /** Which navigation group it belongs to. `null` hides it from the menu. */
  group: 'overview' | 'moderation' | 'economy' | 'system' | null;
  /** Signed-out routes. Only the login screen. */
  anonymous?: boolean;
}

/**
 * Teach `vue-router` what this application's `meta` is.
 *
 * An interface with no members of its own, which is the only way module
 * augmentation can widen a declared type — `type RouteMeta = AdminRouteMeta`
 * is not a legal augmentation, and an empty extension is exactly what the
 * library's own documentation prescribes.
 */
declare module 'vue-router' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RouteMeta extends AdminRouteMeta {}
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: 'ورود', group: null, anonymous: true },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { title: 'نمای کلی', permission: PERMISSIONS.DASHBOARD_READ, group: 'overview' },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('@/views/UsersView.vue'),
    meta: { title: 'کاربران', permission: PERMISSIONS.USER_READ, group: 'overview' },
  },
  {
    path: '/users/:publicId',
    name: 'user-detail',
    component: () => import('@/views/UserDetailView.vue'),
    meta: { title: 'پروندهٔ کاربر', permission: PERMISSIONS.USER_READ, group: null },
  },
  {
    path: '/events',
    name: 'events',
    component: () => import('@/views/EventsView.vue'),
    meta: { title: 'فعالیت‌ها', permission: PERMISSIONS.EVENT_MODERATE, group: 'moderation' },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('@/views/ReportsView.vue'),
    meta: { title: 'گزارش‌های تخلف', permission: PERMISSIONS.REPORT_REVIEW, group: 'moderation' },
  },
  {
    path: '/cases',
    name: 'cases',
    component: () => import('@/views/CasesView.vue'),
    meta: {
      title: 'پرونده‌های بررسی',
      permission: PERMISSIONS.EVENT_MODERATE,
      group: 'moderation',
    },
  },
  {
    path: '/gift-codes',
    name: 'gift-codes',
    component: () => import('@/views/GiftCodesView.vue'),
    meta: { title: 'کدهای هدیه', permission: PERMISSIONS.GIFT_CODE_MANAGE, group: 'economy' },
  },
  {
    path: '/gift-codes/:publicId',
    name: 'gift-code-detail',
    component: () => import('@/views/GiftCodeDetailView.vue'),
    meta: { title: 'گزارش کد هدیه', permission: PERMISSIONS.GIFT_CODE_MANAGE, group: null },
  },
  {
    path: '/referrals',
    name: 'referrals',
    component: () => import('@/views/ReferralsView.vue'),
    meta: { title: 'معرفی دوستان', permission: PERMISSIONS.REFERRAL_MANAGE, group: 'economy' },
  },
  {
    path: '/ledger',
    name: 'ledger',
    component: () => import('@/views/LedgerView.vue'),
    meta: { title: 'دفتر سکه', permission: PERMISSIONS.LEDGER_READ, group: 'economy' },
  },
  {
    path: '/audit',
    name: 'audit',
    component: () => import('@/views/AuditView.vue'),
    meta: { title: 'گزارش رخدادها', permission: PERMISSIONS.AUDIT_READ, group: 'system' },
  },
  {
    path: '/activities',
    name: 'activities',
    component: () => import('@/views/ActivitiesView.vue'),
    meta: { title: 'تفریحات', permission: PERMISSIONS.CATALOG_MANAGE, group: 'system' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: 'تنظیمات', permission: PERMISSIONS.SETTINGS_MANAGE, group: 'system' },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('@/views/ForbiddenView.vue'),
    meta: { title: 'دسترسی ندارید', group: null },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHistory(), routes });

/**
 * Sign-in, then permission, then the page.
 *
 * The wait on `ready` is what makes a hard refresh work: navigation happens
 * before the first `/me` resolves, and without it a signed-in operator is bounced
 * to the login screen every time they reload.
 *
 * A route the session cannot open lands on `/forbidden` rather than silently
 * redirecting to the dashboard, because "nothing happened when I clicked" is a
 * worse answer than "you do not have this permission" — and an ANALYST, who holds
 * `dashboard.read` and nothing else, meets this on every other link.
 */
router.beforeEach(async (to) => {
  const session = useSessionStore();
  if (!session.ready) await session.restore();

  if (to.meta.anonymous === true) {
    return session.signedIn ? { name: 'dashboard' } : true;
  }

  if (!session.signedIn) {
    // `redirect` so signing in returns to where they were going, which matters
    // when the link came from an alert or a colleague.
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }

  if (to.meta.permission !== undefined && !session.can(to.meta.permission)) {
    return { name: 'forbidden', query: { required: to.meta.permission } };
  }

  return true;
});

/** The tab title, so several open panels are tellable apart. */
router.afterEach((to) => {
  document.title = `${to.meta.title ?? 'پنل مدیریت'} · پایه‌تَم`;
});

export default router;
