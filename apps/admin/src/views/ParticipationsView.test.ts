import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { PERMISSIONS } from '@payetam/shared';
import { useSessionStore } from '@/stores/session';
import type { AdminParticipationListResponse, AdminParticipationView } from '@payetam/shared';
import ParticipationsView from './ParticipationsView.vue';

type Query = Record<string, unknown>;
const request = vi.fn<(path: string, options?: { query?: Query }) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string, options?: { query?: Query }) => request(path, options),
  messageOf: (_cause: unknown, fallback: string) => fallback,
  setUnauthenticatedHandler: () => undefined,
}));

/**
 * «درخواست‌ها» — every request to join, on one page from the menu.
 *
 * The first version lived inside each user's page and under each event's count,
 * so finding «who from a closed city paid to queue somewhere else?» meant opening
 * people one at a time. This page is the list itself: search, filters, and the
 * two links out (to the person, and to everybody else on the same activity).
 */

const MILAD = 'f60ed962-621f-40b5-9bd8-9a82aab50df9';
const HIKING = '8ae25454-d462-4df5-a267-48087ee8b853';
const TEHRAN = '01a04e14-2106-704e-aae8-f6ab2386710f';

function row(overrides: Partial<AdminParticipationView> = {}): AdminParticipationView {
  return {
    publicId: crypto.randomUUID(),
    status: 'PENDING',
    requestedAt: '2026-09-30T11:21:18.922Z',
    decidedAt: null,
    cancelledAt: null,
    user: { publicId: MILAD, displayName: 'میلاد', isSeed: false, cityNameFa: 'ارومیه' },
    outOfCity: true,
    event: {
      publicId: HIKING,
      number: 61,
      title: 'کوه نوردی',
      cityNameFa: 'تهران',
      startsAt: '2026-10-04T03:30:00.000Z',
      isSeeded: false,
    },
    joinCoins: { charged: 20, refunded: 0 },
    ...overrides,
  };
}

const PAGE: AdminParticipationListResponse = {
  participations: [
    row({ status: 'CANCELLED_BY_PARTICIPANT', cancelledAt: '2026-09-30T17:41:59.119Z' }),
    row({
      user: {
        publicId: crypto.randomUUID(),
        displayName: 'سارا',
        isSeed: false,
        cityNameFa: 'تهران',
      },
      outOfCity: false,
      joinCoins: { charged: 20, refunded: 20 },
    }),
  ],
  total: 2,
  cities: [{ id: TEHRAN, nameFa: 'تهران' }],
};

let app: App | null = null;

async function mount(
  path: string,
  permissions: string[] = [PERMISSIONS.USER_READ],
): Promise<{ root: HTMLElement; router: Router }> {
  const root = document.createElement('div');
  document.body.append(root);
  const pinia = createPinia();
  setActivePinia(pinia);
  useSessionStore().session = {
    email: 'ops@payetam.test',
    displayName: 'ops',
    roles: [],
    permissions,
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/participations', name: 'participations', component: ParticipationsView },
      { path: '/users/:publicId', name: 'user-detail', component: { render: () => null } },
      { path: '/messages', name: 'messages', component: { render: () => null } },
    ],
  });
  await router.push(path);
  app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(router);
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());
  return { root, router };
}

function lastQuery(): Query {
  return request.mock.calls.at(-1)?.[1]?.query ?? {};
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  request.mockReset();
});

describe('ParticipationsView', () => {
  it('opens on one person from a link, real people only, newest first', async () => {
    request.mockResolvedValue(PAGE);

    const { root } = await mount(`/participations?user=${MILAD}`);

    expect(request).toHaveBeenCalledWith('/participations', expect.anything());
    expect(lastQuery()).toMatchObject({ userPublicId: MILAD, realOnly: true });
    // The filter that came from the link is visible and removable.
    expect(root.textContent).toContain('فقط این کاربر');
  });

  it('shows the person, the activity, the other-city mark and where the coins went', async () => {
    request.mockResolvedValue(PAGE);

    const { root } = await mount('/participations');

    const rows = [...root.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows[0]).toContain('میلاد');
    expect(rows[0]).toContain('ارومیه');
    expect(rows[0]).toContain('#۶۱');
    expect(rows[0]).toContain('کوه نوردی');
    expect(rows[0]).toContain('شهر دیگر');
    expect(rows[0]).toContain('برنگشت');
    expect(rows[1]).not.toContain('شهر دیگر');
    expect(rows[1]).toContain('برگشت خورد');
    const links = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain(`/users/${MILAD}`);
  });

  it('asks again when a filter changes, and keeps it in the address', async () => {
    request.mockResolvedValue(PAGE);
    const { root, router } = await mount('/participations');

    const status = root.querySelector<HTMLSelectElement>('select[name="status"]');
    expect(status).not.toBeNull();
    status!.value = 'WAITLISTED';
    status!.dispatchEvent(new Event('change'));
    await nextTick();

    await vi.waitFor(() => expect(lastQuery()).toMatchObject({ status: 'WAITLISTED' }));
    await vi.waitFor(() => expect(router.currentRoute.value.query['status']).toBe('WAITLISTED'));

    const away = root.querySelector<HTMLInputElement>('input[name="outOfCity"]');
    away!.click();
    await vi.waitFor(() => expect(lastQuery()).toMatchObject({ outOfCity: true }));
  });

  /** Reaching somebody with no Telegram username is through the bot, from here. */
  it('offers a message to a real person, to an operator who may send one', async () => {
    request.mockResolvedValue({
      ...PAGE,
      participations: [
        ...PAGE.participations,
        row({
          user: {
            publicId: crypto.randomUUID(),
            displayName: 'ساختگی',
            isSeed: true,
            cityNameFa: null,
          },
        }),
      ],
    });

    const { root } = await mount('/participations', [
      PERMISSIONS.USER_READ,
      PERMISSIONS.MESSAGE_SEND,
    ]);

    const messages = [...root.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => href.startsWith('/messages'));
    expect(messages).toContain(`/messages?to=${MILAD}`);
    // Two real people, one seed identity: a seed has no chat to send to.
    expect(messages).toHaveLength(2);
  });

  it('offers no message to an operator who cannot send one', async () => {
    request.mockResolvedValue(PAGE);

    const { root } = await mount('/participations');

    const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href.startsWith('/messages'))).toBe(false);
  });

  it('narrows to everybody on one activity from its title', async () => {
    request.mockResolvedValue(PAGE);
    const { root } = await mount('/participations');

    const title = [...root.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('کوه نوردی'),
    );
    title!.click();

    await vi.waitFor(() => expect(lastQuery()).toMatchObject({ eventPublicId: HIKING }));
    await vi.waitFor(() => expect(root.textContent).toContain('فقط این رویداد'));
  });
});
