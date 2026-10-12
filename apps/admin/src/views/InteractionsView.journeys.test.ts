import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import type {
  InteractionDropoffResponse,
  InteractionFunnelsResponse,
  InteractionOverviewResponse,
  InteractionReturnResponse,
} from '@payetam/shared';
import InteractionsView from './InteractionsView.vue';

const request = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string) => request(path),
  messageOf: (_cause: unknown, fallback: string) => fallback,
}));

/**
 * The second three tabs of «رفتار کاربران»: funnels, drop-off, return.
 *
 * `InteractionsView.test.ts` covers the first three and the way a tab is
 * fetched. This file is about the sentences these three make, because each one
 * turns on a denominator somebody could get wrong: a step's share is of the
 * people who started the form, a block's of all blocks, and "came back after a
 * week" of the accounts old enough to be asked — never of everybody.
 */

const SINCE = '2026-09-10T12:00:00.000Z';

const OVERVIEW: InteractionOverviewResponse = {
  windowDays: 30,
  since: SINCE,
  trackingSince: '2026-10-01T08:00:00.000Z',
  totals: {
    interactions: 10,
    activeUsers: 5,
    sessions: 5,
    stepsPerSession: 2,
    newAccounts: 2,
    newAccountsSilent: 1,
  },
  byDay: [],
  byKind: [],
  byOutcome: [],
  byHour: [],
};

const ONBOARDING = {
  arrived: 40,
  pressedAnything: 30,
  termsAccepted: 24,
  profileComplete: 12,
  openedDiscovery: 10,
  openedEvent: 8,
  requested: 4,
};

const FUNNELS: InteractionFunnelsResponse = {
  windowDays: 30,
  since: SINCE,
  onboarding: { totals: ONBOARDING, rows: [{ ...ONBOARDING, source: 'CAMPAIGN' }] },
  forms: [
    {
      kind: 'EDIT_PROFILE',
      started: 20,
      submitted: 10,
      cancelled: 2,
      steps: [
        { step: 'name', users: 20, leftHere: 1 },
        { step: 'city', users: 16, leftHere: 6 },
        { step: '$summary', users: 11, leftHere: 1 },
      ],
    },
  ],
};

const DROPOFF: InteractionDropoffResponse = {
  windowDays: 30,
  since: SINCE,
  quietDays: 7,
  quietUsers: 10,
  lastSeen: [
    { screen: 'bot.wizard', wizardKind: 'EDIT_PROFILE', wizardStep: 'city', users: 6 },
    { screen: 'bot.discover', wizardKind: null, wizardStep: null, users: 4 },
  ],
  refusals: [{ action: 'ev:join', detail: 'PROFILE_INCOMPLETE', count: 9, users: 5 }],
  gates: [{ gate: 'profile', count: 12, users: 7 }],
  stale: [{ action: 'ad:list', count: 3, users: 2 }],
  failures: [{ action: 'ev:show', count: 1 }],
  unclaimedText: { count: 15, users: 8 },
  unsupported: { count: 2, users: 2 },
  blocks: {
    total: 8,
    withinFiveMinutes: 6,
    withinDay: 7,
    lastScreens: [
      { screen: 'bot.wizard', blocks: 5 },
      { screen: null, blocks: 3 },
    ],
  },
};

const COHORT = {
  arrived: 40,
  eligibleDay1: 36,
  returnedDay1: 9,
  eligibleDay7: 20,
  returnedDay7: 2,
  eligibleDay30: 0,
  returnedDay30: 0,
};

const RETURN: InteractionReturnResponse = {
  windowDays: 30,
  since: SINCE,
  cohorts: { totals: COHORT, rows: [{ ...COHORT, source: 'CAMPAIGN' }] },
  notifications: [
    {
      templateKey: 'participation.accepted',
      sent: 20,
      recipients: 18,
      tapped: 5,
      followedWithinDay: 12,
    },
    { templateKey: 'some.new_template', sent: 2, recipients: 2, tapped: 0, followedWithinDay: 0 },
  ],
};

let app: App | null = null;
let root: HTMLElement;

async function open(label: string, testId: string): Promise<HTMLElement> {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(InteractionsView);
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('[data-testid="overview"]')).not.toBeNull());

  const tab = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (tab === undefined) throw new Error(`no tab «${label}»`);
  tab.click();
  await vi.waitFor(() => expect(root.querySelector(`[data-testid="${testId}"]`)).not.toBeNull());

  const panel = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (panel === null) throw new Error(`no panel ${testId}`);
  return panel;
}

/** The row of a table or list whose text contains `needle`. */
function rowWith(panel: HTMLElement, needle: string): string {
  const row = [...panel.querySelectorAll('tr, li')].find((candidate) =>
    candidate.textContent?.includes(needle),
  );
  if (row === undefined) throw new Error(`no row containing «${needle}»`);
  return row.textContent ?? '';
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation((path: string) => {
    if (path.startsWith('/interactions/overview')) return Promise.resolve(OVERVIEW);
    if (path.startsWith('/interactions/funnels')) return Promise.resolve(FUNNELS);
    if (path.startsWith('/interactions/dropoff')) return Promise.resolve(DROPOFF);
    if (path.startsWith('/interactions/return')) return Promise.resolve(RETURN);
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  root.remove();
});

describe('funnels', () => {
  it('is fetched when it is opened', async () => {
    await open('قیف‌ها', 'funnels');
    expect(request).toHaveBeenLastCalledWith('/interactions/funnels?days=30');
  });

  /** Twelve of forty finished a profile: a share of who arrived, on every column. */
  it('reads each step as a share of the accounts that arrived', async () => {
    const panel = await open('قیف‌ها', 'funnels');
    const campaign = rowWith(panel, 'کمپین');

    expect(campaign).toContain('۴۰');
    expect(campaign).toContain('۷۵٪'); // pressed anything
    expect(campaign).toContain('۳۰٪'); // profile complete
    expect(campaign).toContain('۱۰٪'); // asked to join
    expect(panel.textContent).not.toContain('CAMPAIGN');
  });

  /**
   * Six of the twenty who opened the profile form were left on the city
   * question. A share of who *started*, so the three steps can be compared.
   */
  it('names a form and the question it loses people on', async () => {
    const panel = await open('قیف‌ها', 'funnels');

    expect(panel.textContent).toContain('فرم پروفایل');
    // Ten of twenty sent it.
    expect(panel.textContent).toContain('۵۰٪');
    const city = rowWith(panel, 'قدم city');
    expect(city).toContain('۱۶');
    expect(city).toContain('۶');
    expect(city).toContain('۳۰٪');
    expect(panel.textContent).toContain('بازبینی نهایی');
    expect(panel.textContent).not.toMatch(/EDIT_PROFILE|\$summary/);
  });
});

describe('drop-off', () => {
  it('is fetched when it is opened', async () => {
    await open('نقطه‌های ریزش', 'dropoff');
    expect(request).toHaveBeenLastCalledWith('/interactions/dropoff?days=30');
  });

  it('says where the people who stopped coming were last seen', async () => {
    const panel = await open('نقطه‌های ریزش', 'dropoff');
    const midForm = rowWith(panel, 'قدم city');

    expect(midForm).toContain('فرم پروفایل');
    expect(midForm).toContain('۶۰٪'); // six of the ten who went quiet
    expect(panel.textContent).toContain('فهرست برنامه‌ها');
    expect(panel.textContent).not.toMatch(/bot\.wizard|bot\.discover/);
  });

  it('says what was refused in the words the person was sent', async () => {
    const panel = await open('نقطه‌های ریزش', 'dropoff');
    const refusal = rowWith(panel, 'درخواست شرکت');

    expect(refusal).toContain('اول پروفایلت رو کامل کن');
    expect(refusal).toContain('۹');
    expect(panel.textContent).not.toContain('PROFILE_INCOMPLETE');
  });

  it('names the sign-up step people were sent back to', async () => {
    const panel = await open('نقطه‌های ریزش', 'dropoff');
    expect(rowWith(panel, 'تکمیل پروفایل')).toContain('۱۲');
  });

  /** Six of eight blocks came within five minutes of the account being made. */
  it('says how soon people blocked, and what they had been shown', async () => {
    const panel = await open('نقطه‌های ریزش', 'dropoff');
    const blocks = panel.querySelector('[data-testid="blocks"]')?.textContent ?? '';

    expect(blocks).toContain('۷۵٪');
    expect(blocks).toContain('یک فرم');
    // A block with nothing recorded before it: an account older than tracking.
    expect(blocks).toContain('چیزی ثبت نشده بود');
  });

  it('shows the bot’s own failures, which are bugs', async () => {
    const panel = await open('نقطه‌های ریزش', 'dropoff');
    expect(panel.querySelector('[data-testid="failures"]')?.textContent).toContain(
      'دیدن جزئیات برنامه',
    );
  });
});

describe('return', () => {
  it('is fetched when it is opened', async () => {
    await open('بازگشت', 'return');
    expect(request).toHaveBeenLastCalledWith('/interactions/return?days=30');
  });

  /**
   * Nine of the thirty-six old enough to be asked, not nine of forty: the four
   * who arrived today have not had a day in which to come back.
   */
  it('divides by the accounts old enough to be asked', async () => {
    const panel = await open('بازگشت', 'return');
    const campaign = rowWith(panel, 'کمپین');

    expect(campaign).toContain('۲۵٪'); // 9 of 36
    expect(campaign).toContain('۱۰٪'); // 2 of 20
  });

  /** Nobody in the window is thirty days old yet. That is "too early", not "zero". */
  it('says «too early» rather than zero when nobody is old enough', async () => {
    const panel = await open('بازگشت', 'return');
    expect(rowWith(panel, 'کمپین')).toContain('هنوز زود است');
  });

  it('names a message the product sent, and what followed it', async () => {
    const panel = await open('بازگشت', 'return');
    const accepted = rowWith(panel, 'درخواستت پذیرفته شد');

    expect(accepted).toContain('۲۰');
    expect(accepted).toContain('۲۵٪'); // 5 of 20 pressed a button on it
    expect(accepted).toContain('۶۰٪'); // 12 of 20 did something within a day
    expect(panel.textContent).not.toContain('participation.accepted');
  });

  it('shows a message nobody has named yet by its key', async () => {
    const panel = await open('بازگشت', 'return');
    expect(panel.textContent).toContain('some.new_template');
  });
});
