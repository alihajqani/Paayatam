import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { AdminParticipationListResponse, AdminParticipationView } from '@payetam/shared';
import ParticipationList from './ParticipationList.vue';

const request =
  vi.fn<(path: string, options?: { query?: Record<string, unknown> }) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string, options?: { query?: Record<string, unknown> }) => request(path, options),
  messageOf: (_cause: unknown, fallback: string) => fallback,
}));

/**
 * Who asked to join what, on the user page and under an event's request count.
 *
 * The panel showed a tally of statuses and a count, and the support question
 * that started this — «three activities, sixty coins, in a city we have not
 * opened: which ones, and why are the coins gone?» — needed a database session.
 * Mounted, because what matters is on the screen: which activity, which person,
 * and whether the coins came back.
 */

const GUEST = '5b95a184-5001-43aa-8c23-a81bcc424e7f';
const SEED_GUEST = '8e434d1b-d254-4722-8f27-0fc9aa2e4892';

function row(overrides: Partial<AdminParticipationView>): AdminParticipationView {
  return {
    publicId: crypto.randomUUID(),
    status: 'PENDING',
    requestedAt: '2026-09-30T11:21:18.922Z',
    decidedAt: null,
    cancelledAt: null,
    user: { publicId: GUEST, displayName: 'میلاد', isSeed: false, cityNameFa: 'تهران' },
    outOfCity: false,
    event: {
      publicId: '8ae25454-d462-4df5-a267-48087ee8b853',
      number: 61,
      title: 'کوه نوردی',
      cityNameFa: 'تهران',
      startsAt: '2026-10-04T03:30:00.000Z',
      isSeeded: false,
    },
    joinCoins: { charged: 0, refunded: 0 },
    ...overrides,
  };
}

let app: App | null = null;

async function mount(props: { userPublicId?: string; eventPublicId?: string }) {
  const root = document.createElement('div');
  document.body.append(root);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/users/:publicId', name: 'user-detail', component: { render: () => null } },
    ],
  });
  app = createApp({ render: () => h(ParticipationList, props) });
  app.use(router);
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('table')).not.toBeNull());
  return root;
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  request.mockReset();
});

describe('ParticipationList', () => {
  it('shows what one person asked to join, and whether the coins came back', async () => {
    const page: AdminParticipationListResponse = {
      participations: [
        row({
          status: 'CANCELLED_BY_PARTICIPANT',
          cancelledAt: '2026-09-30T17:41:59.119Z',
          joinCoins: { charged: 20, refunded: 0 },
        }),
        row({
          status: 'REJECTED',
          event: { ...row({}).event, number: 50, title: 'بازارچه', isSeeded: true },
          joinCoins: { charged: 20, refunded: 20 },
        }),
        row({ event: { ...row({}).event, number: 24, title: 'دورهمی' } }),
      ],
      total: 3,
      cities: [],
    };
    request.mockResolvedValue(page);

    const root = await mount({ userPublicId: GUEST });

    expect(request).toHaveBeenCalledWith(
      '/participations',
      expect.objectContaining({ query: expect.objectContaining({ userPublicId: GUEST }) }),
    );
    const rows = [...root.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows[0]).toContain('کوه نوردی');
    expect(rows[0]).toContain('#۶۱');
    expect(rows[0]).toContain('تهران');
    expect(rows[0]).toContain('لغو شده توسط شرکت‌کننده');
    expect(rows[0]).toContain('۲۰ سکه');
    expect(rows[0]).toContain('برنگشت');
    expect(rows[1]).toContain('برگشت خورد');
    expect(rows[1]).toContain('ساختگی');
    expect(rows[2]).toContain('رایگان');
    // The person is the page this sits on, so it is not repeated on every row.
    expect(rows[0]).not.toContain('میلاد');
  });

  it('lists who asked for one activity, each linked to their page', async () => {
    request.mockResolvedValue({
      participations: [
        row({}),
        row({
          user: { publicId: SEED_GUEST, displayName: 'سارا', isSeed: true, cityNameFa: 'تهران' },
        }),
      ],
      total: 2,
      cities: [],
    } satisfies AdminParticipationListResponse);

    const root = await mount({ eventPublicId: '8ae25454-d462-4df5-a267-48087ee8b853' });

    const links = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain(`/users/${GUEST}`);
    // A seed identity is not a person and has no page to open.
    expect(links).not.toContain(`/users/${SEED_GUEST}`);
    expect(root.textContent).toContain('سارا');
    expect(root.textContent).toContain('ساختگی');
    expect(root.textContent).not.toContain('کوه نوردی');
  });
});
