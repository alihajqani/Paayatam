import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import type { AcquisitionReportResponse } from '@payetam/shared';
import AcquisitionView from './AcquisitionView.vue';

const request = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string) => request(path),
  messageOf: (_cause: unknown, fallback: string) => fallback,
}));

/**
 * What an operator reads on the acquisition page (migration 0061).
 *
 * Mounted rather than asserted on the report, because the two things that go
 * wrong here are both on the screen: a source rendered as its enum, and a share
 * computed against the wrong denominator — the whole table rather than the row.
 */

const FUNNEL = {
  termsAccepted: 0,
  profileComplete: 0,
  requested: 0,
  attended: 0,
  hosted: 0,
  botBlocked: 0,
};

const REPORT: AcquisitionReportResponse = {
  windowDays: 30,
  since: '2026-08-26T00:00:00.000Z',
  trackingSince: '2026-09-25T08:00:00.000Z',
  totals: { ...FUNNEL, users: 50, profileComplete: 12, botBlocked: 20 },
  rows: [
    {
      ...FUNNEL,
      source: 'CAMPAIGN',
      ref: 'tgads_anon1',
      users: 40,
      profileComplete: 10,
      botBlocked: 20,
    },
    { ...FUNNEL, source: 'OTHER', ref: 'tgads2', users: 6 },
    { ...FUNNEL, source: null, ref: null, users: 4, profileComplete: 2 },
  ],
  omittedRows: 0,
  botUsername: 'paayatambot',
};

let app: App | null = null;
let root: HTMLElement;

async function mount(): Promise<HTMLElement> {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AcquisitionView);
  app.mount(root);
  // The request, then the render it resolves into.
  await vi.waitFor(() => expect(root.querySelector('table')).not.toBeNull());
  return root;
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(REPORT);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root.remove();
});

describe('the acquisition page', () => {
  it('asks for the last thirty days first', async () => {
    await mount();

    expect(request).toHaveBeenCalledWith('/acquisition?days=30');
  });

  it('names every source in Persian, with the tag beside a campaign', async () => {
    const page = await mount();
    const text = page.querySelector('tbody')?.textContent ?? '';

    expect(text).toContain('کمپین');
    expect(text).toContain('tgads_anon1');
    expect(text).toContain('لینک ناشناخته');
    expect(text).toContain('پیش از ردیابی');
    expect(text).not.toMatch(/CAMPAIGN|OTHER/);
  });

  /** Ten of forty is a quarter of that ad's people, not a fifth of everybody. */
  it("computes each share against the row's own sign-ups", async () => {
    const page = await mount();
    const campaign = page.querySelector('tbody tr');

    expect(campaign?.textContent).toContain('۲۵٪');
    expect(campaign?.textContent).toContain('۵۰٪');
  });

  it('warns that a link without the prefix was probably built wrong', async () => {
    const page = await mount();

    expect(page.textContent).toContain('بدون پیشوند');
  });

  it('builds the ad link the bot reads, lower-cased', async () => {
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error('no tag input');

    input.value = 'TgAds_Anon2';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    expect(page.textContent).toContain('https://t.me/paayatambot?start=src_tgads_anon2');
  });

  it('refuses a tag the link could not carry, instead of building a broken link', async () => {
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error('no tag input');

    input.value = 'تبلیغ ۱';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    expect(page.textContent).not.toContain('?start=');
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('asks again for a different window', async () => {
    const page = await mount();
    const allTime = [...page.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'همه',
    );

    allTime?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(request).toHaveBeenLastCalledWith('/acquisition');
  });
});
