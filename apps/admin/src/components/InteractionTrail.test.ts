import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, type App } from 'vue';
import type { UserInteractionItem, UserInteractionsResponse } from '@payetam/shared';
import InteractionTrail from './InteractionTrail.vue';

const request =
  vi.fn<(path: string, options?: { query?: Record<string, unknown> }) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string, options?: { query?: Record<string, unknown> }) => request(path, options),
  messageOf: (_cause: unknown, fallback: string) => fallback,
}));

/**
 * One person's trail through the bot, on their own file (migration 0065).
 *
 * The question it answers is «what happened to this person», and the answer
 * has to be readable by somebody who has never seen `ev:join` or
 * `PROFILE_INCOMPLETE`: the button by its Persian name, the refusal by the
 * sentence the person was sent, the form by the question they were left on.
 */

const USER = '5b95a184-5001-43aa-8c23-a81bcc424e7f';
const EVENT = '11111111-1111-4111-8111-111111111111';

let sequence = 0;

function item(overrides: Partial<UserInteractionItem>): UserInteractionItem {
  sequence += 1;
  return {
    id: `row-${String(sequence)}`,
    at: '2026-10-10T12:00:00.000Z',
    kind: 'CALLBACK',
    action: 'ev:show',
    ref: null,
    outcome: 'OK',
    detail: null,
    screen: null,
    wizardKind: null,
    wizardStep: null,
    durationMs: 12,
    ...overrides,
  };
}

let app: App | null = null;

async function mount(page: UserInteractionsResponse): Promise<HTMLElement> {
  request.mockResolvedValueOnce(page);
  const root = document.createElement('div');
  document.body.append(root);
  app = createApp({ render: () => h(InteractionTrail, { userPublicId: USER }) });
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('[aria-busy="true"]')).toBeNull());
  return root;
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  request.mockReset();
});

describe('InteractionTrail', () => {
  it('asks for that person’s trail, from the newest', async () => {
    await mount({ items: [item({})], nextBefore: null });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(`/users/${USER}/interactions`, undefined);
  });

  it('names what was pressed and what the person was shown, in Persian', async () => {
    const root = await mount({
      items: [item({ action: 'ev:show', ref: EVENT, screen: 'bot.event_detail' })],
      nextBefore: null,
    });
    const row = root.querySelector('[data-testid="trail-item"]')?.textContent ?? '';

    expect(row).toContain('دیدن جزئیات برنامه');
    expect(row).toContain('صفحهٔ برنامه');
    expect(row).not.toContain('bot.event_detail');
  });

  /** The reason is the sentence the person read, not the code that produced it. */
  it('says why something was refused, in the words the person was sent', async () => {
    const root = await mount({
      items: [item({ action: 'ev:join', outcome: 'REFUSED', detail: 'PROFILE_INCOMPLETE' })],
      nextBefore: null,
    });
    const row = root.querySelector('[data-testid="trail-item"]')?.textContent ?? '';

    expect(row).toContain('درخواست شرکت');
    expect(row).toContain('رد شد');
    expect(row).toContain('اول پروفایلت رو کامل کن');
    expect(row).not.toMatch(/REFUSED|PROFILE_INCOMPLETE/);
  });

  it('says which sign-up step sent somebody back', async () => {
    const root = await mount({
      items: [
        item({ kind: 'COMMAND', action: 'cmd:discover', outcome: 'GATED', detail: 'profile' }),
      ],
      nextBefore: null,
    });
    const row = root.querySelector('[data-testid="trail-item"]')?.textContent ?? '';

    expect(row).toContain('پشت ثبت‌نام ماند');
    expect(row).toContain('تکمیل پروفایل');
  });

  /** Where a form was left is the whole of why somebody did not finish it. */
  it('names the form and the question the person was left on', async () => {
    const root = await mount({
      items: [
        item({
          kind: 'TEXT',
          action: 'text:answer',
          wizardKind: 'CREATE_EVENT',
          wizardStep: 'title',
        }),
        item({ action: 'wz:confirm', wizardKind: 'CREATE_EVENT', wizardStep: '$submitted' }),
      ],
      nextBefore: null,
    });
    const rows = [...root.querySelectorAll('[data-testid="trail-item"]')].map(
      (row) => row.textContent ?? '',
    );

    expect(rows[0]).toContain('ساختن برنامه');
    expect(rows[0]).toContain('title');
    expect(rows[1]).toContain('ثبت شد');
    expect(rows.join(' ')).not.toMatch(/CREATE_EVENT|\$submitted/);
  });

  /**
   * Newest first, so a gap of more than half an hour above a row is the start
   * of a later visit: «came back three hours afterwards» is read straight off.
   */
  it('marks where one visit ends and an earlier one begins', async () => {
    const root = await mount({
      items: [
        item({ at: '2026-10-10T15:00:00.000Z' }),
        item({ at: '2026-10-10T14:55:00.000Z' }),
        item({ at: '2026-10-10T09:00:00.000Z' }),
      ],
      nextBefore: null,
    });

    expect(root.querySelectorAll('[data-testid="trail-item"]')).toHaveLength(3);
    expect(root.querySelectorAll('[data-testid="visit-break"]')).toHaveLength(1);
  });

  it('fetches the older page on request and keeps the newer one above it', async () => {
    const root = await mount({
      items: [item({ action: 'ev:show' })],
      nextBefore: '2026-10-10T11:00:00.000Z',
    });
    request.mockResolvedValueOnce({ items: [item({ action: 'cmd:help' })], nextBefore: null });

    const more = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('قدیمی‌تر'),
    );
    more?.click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="trail-item"]')).toHaveLength(2),
    );

    expect(request).toHaveBeenLastCalledWith(`/users/${USER}/interactions`, {
      query: { before: '2026-10-10T11:00:00.000Z' },
    });
    expect(root.textContent).toContain('دیدن جزئیات برنامه');
    expect(root.textContent).toContain('راهنما');
    // The last page: nothing older to ask for.
    expect(
      [...root.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('قدیمی‌تر'),
      ),
    ).toBe(false);
  });

  it('says so when the person has done nothing since tracking began', async () => {
    const root = await mount({ items: [], nextBefore: null });

    expect(root.textContent).toContain('کاری در ربات ثبت نشده');
  });
});
