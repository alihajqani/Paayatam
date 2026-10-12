import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import type {
  InteractionActionsResponse,
  InteractionLinksResponse,
  InteractionOverviewResponse,
} from '@payetam/shared';
import InteractionsView from './InteractionsView.vue';

const request = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string) => request(path),
  messageOf: (_cause: unknown, fallback: string) => fallback,
}));

/**
 * What an operator reads on «رفتار کاربران» (migration 0065).
 *
 * Mounted, for the reason the acquisition page is: what goes wrong here goes
 * wrong on the screen. An action shown as `ev:join`, an outcome shown as
 * `REFUSED`, a share computed against the wrong total, a refusal that names a
 * code instead of the sentence the person was actually sent — every one of
 * those is a report that is correct and unreadable.
 */

const EVENT = '11111111-1111-4111-8111-111111111111';

const OVERVIEW: InteractionOverviewResponse = {
  windowDays: 30,
  since: '2026-09-10T12:00:00.000Z',
  trackingSince: '2026-10-01T08:00:00.000Z',
  totals: {
    interactions: 1200,
    activeUsers: 80,
    sessions: 300,
    stepsPerSession: 3.7,
    newAccounts: 40,
    newAccountsSilent: 30,
  },
  byDay: [
    { day: '2026-10-08', interactions: 400, activeUsers: 30 },
    { day: '2026-10-09', interactions: 800, activeUsers: 60 },
  ],
  byKind: [
    { kind: 'CALLBACK', interactions: 900, users: 70 },
    { kind: 'START', interactions: 200, users: 60 },
    { kind: 'BLOCKED', interactions: 12, users: 12 },
  ],
  byOutcome: [
    { outcome: 'OK', interactions: 900 },
    { outcome: 'REFUSED', interactions: 240 },
    { outcome: 'GATED', interactions: 60 },
  ],
  byHour: [
    { hour: 9, interactions: 100 },
    { hour: 21, interactions: 500 },
  ],
};

const LINKS: InteractionLinksResponse = {
  windowDays: 30,
  since: OVERVIEW.since,
  rows: [
    {
      action: 'start:event',
      ref: EVENT,
      title: 'دورهمی بازی رومیزی',
      taps: 50,
      users: 40,
      newAccounts: 10,
      returningUsers: 30,
    },
    {
      action: 'start:campaign',
      ref: 'tgads_anon1',
      title: null,
      taps: 20,
      users: 20,
      newAccounts: 20,
      returningUsers: 0,
    },
  ],
  omittedRows: 0,
};

const ACTIONS: InteractionActionsResponse = {
  windowDays: 30,
  since: OVERVIEW.since,
  rows: [
    {
      kind: 'CALLBACK',
      action: 'ev:join',
      count: 200,
      users: 90,
      refused: 50,
      gated: 0,
      stale: 0,
      failed: 0,
      topRefusal: 'PROFILE_INCOMPLETE',
      averageMs: 42,
    },
    {
      kind: 'CALLBACK',
      action: 'zz:brand_new',
      count: 3,
      users: 2,
      refused: 0,
      gated: 0,
      stale: 0,
      failed: 0,
      topRefusal: null,
      averageMs: 8,
    },
  ],
  omittedRows: 0,
};

let app: App | null = null;
let root: HTMLElement;

async function mount(): Promise<HTMLElement> {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(InteractionsView);
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('[data-testid="overview"]')).not.toBeNull());
  return root;
}

function button(page: HTMLElement, label: string): HTMLButtonElement {
  const found = [...page.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button «${label}»`);
  return found;
}

async function openTab(page: HTMLElement, label: string, testId: string): Promise<HTMLElement> {
  button(page, label).click();
  await vi.waitFor(() => expect(page.querySelector(`[data-testid="${testId}"]`)).not.toBeNull());
  const panel = page.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (panel === null) throw new Error(`no panel ${testId}`);
  return panel;
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation((path: string) => {
    if (path.startsWith('/interactions/overview')) return Promise.resolve(OVERVIEW);
    if (path.startsWith('/interactions/links')) return Promise.resolve(LINKS);
    if (path.startsWith('/interactions/actions')) return Promise.resolve(ACTIONS);
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  root.remove();
});

describe('the «رفتار کاربران» page', () => {
  it('opens on the overview of the last thirty days, and asks for nothing else yet', async () => {
    await mount();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/interactions/overview?days=30');
  });

  it('answers «do people move around at all» in the first row of numbers', async () => {
    const page = await mount();
    const text = page.querySelector('[data-testid="overview"]')?.textContent ?? '';

    expect(text).toContain('۸۰');
    expect(text).toContain('۳۰۰');
    // Three point seven steps a visit, in Persian digits with a Persian decimal mark.
    expect(text).toContain('۳٫۷');
    // Thirty of forty new accounts pressed nothing after /start.
    expect(text).toContain('۷۵٪');
  });

  it('names kinds and outcomes in Persian, never by their enum', async () => {
    const page = await mount();
    const text = page.querySelector('[data-testid="overview"]')?.textContent ?? '';

    expect(text).toContain('دکمهٔ زیر پیام');
    expect(text).toContain('بلاک کردن ربات');
    expect(text).toContain('رد شد');
    expect(text).toContain('پشت ثبت‌نام ماند');
    expect(text).not.toMatch(/CALLBACK|REFUSED|GATED|BLOCKED/);
  });

  /** A share of the window's interactions: 240 of 1200 were refused. */
  it('shows each outcome as a share of everything that was done', async () => {
    const page = await mount();
    const refused = [...page.querySelectorAll('[data-testid="outcome-row"]')].find((row) =>
      row.textContent?.includes('رد شد'),
    );

    expect(refused?.textContent).toContain('۲۰٪');
  });

  it('says when tracking began, so an empty past is not read as a quiet one', async () => {
    const page = await mount();

    expect(page.textContent).toContain('ثبت رفتار از');
  });

  it('says so plainly when nothing has been recorded yet', async () => {
    request.mockImplementation(() =>
      Promise.resolve({
        ...OVERVIEW,
        trackingSince: null,
        totals: { ...OVERVIEW.totals, interactions: 0, activeUsers: 0, sessions: 0 },
        byDay: [],
        byKind: [],
        byOutcome: [],
        byHour: [],
      }),
    );
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(InteractionsView);
    app.mount(root);

    await vi.waitFor(() => expect(root.textContent).toContain('هنوز چیزی ثبت نشده'));
  });

  describe('links', () => {
    it('is fetched when it is opened, for the window already chosen', async () => {
      const page = await mount();
      await openTab(page, 'لینک‌ها', 'links');

      expect(request).toHaveBeenLastCalledWith('/interactions/links?days=30');
    });

    /**
     * The point of the tab: fifty taps on a post that created ten accounts.
     * The other thirty people were already members.
     */
    it('shows new people and members apart, with what the link points at', async () => {
      const page = await mount();
      const panel = await openTab(page, 'لینک‌ها', 'links');
      const row = panel.querySelector('tbody tr');

      expect(row?.textContent).toContain('لینک «جزئیات برنامه»');
      expect(row?.textContent).toContain('دورهمی بازی رومیزی');
      expect(row?.textContent).toContain('۵۰');
      expect(row?.textContent).toContain('۱۰');
      expect(row?.textContent).toContain('۳۰');
      expect(panel.textContent).toContain('tgads_anon1');
      expect(panel.textContent).not.toContain('start:event');
    });
  });

  describe('buttons and commands', () => {
    it('is fetched when it is opened', async () => {
      const page = await mount();
      await openTab(page, 'دکمه‌ها و دستورها', 'actions');

      expect(request).toHaveBeenLastCalledWith('/interactions/actions?days=30');
    });

    /**
     * Fifty of two hundred, and the sentence those fifty people were sent —
     * which is what tells an operator what to fix.
     */
    it('names an action, how often it is refused, and what the person was told', async () => {
      const page = await mount();
      const panel = await openTab(page, 'دکمه‌ها و دستورها', 'actions');
      const row = panel.querySelector('tbody tr');

      expect(row?.textContent).toContain('درخواست شرکت');
      expect(row?.textContent).toContain('۲۰۰');
      expect(row?.textContent).toContain('۲۵٪');
      expect(row?.textContent).toContain('پروفایل');
      expect(row?.textContent).not.toContain('PROFILE_INCOMPLETE');
    });

    /** A button added after the labels were written is still on the report. */
    it('shows an action nobody has named yet by its key', async () => {
      const page = await mount();
      const panel = await openTab(page, 'دکمه‌ها و دستورها', 'actions');

      expect(panel.textContent).toContain('zz:brand_new');
    });
  });

  it('asks again, for the open tab only, when the window changes', async () => {
    const page = await mount();
    await openTab(page, 'لینک‌ها', 'links');
    request.mockClear();

    button(page, '۷ روز').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    expect(request).toHaveBeenCalledWith('/interactions/links?days=7');
  });

  it('refetches a tab that was loaded for another window when it is reopened', async () => {
    const page = await mount();
    button(page, '۷ روز').click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenLastCalledWith('/interactions/overview?days=7'),
    );

    await openTab(page, 'دکمه‌ها و دستورها', 'actions');

    expect(request).toHaveBeenLastCalledWith('/interactions/actions?days=7');
  });
});
