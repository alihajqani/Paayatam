import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

const SEAT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const EVENT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const buttons = (message: ReturnType<typeof render>): string[] =>
  (message?.keyboard ?? []).flat().map((button) => button.callbackData ?? '');

/**
 * The no-show, told to the person it was recorded against (review H1).
 *
 * The heaviest penalty in the economy, and the message said only that the host
 * had reported it — not what it cost — and pointed at «بخش پشتیبانی», which is
 * not the name of anything on screen. From plan 08 it carries the two ways to
 * say it is wrong.
 */
describe('a recorded no-show', () => {
  it('says what it cost', () => {
    const text = String(
      render(TEMPLATES.NO_SHOW_RECORDED, { eventTitle: 'قهوه و بازی', coinsCharged: 60 })?.text,
    );
    expect(text).toContain('قهوه و بازی');
    expect(text).toContain('۶۰ سکه');
  });

  it('says nothing about coins when nothing was taken', () => {
    const text = String(render(TEMPLATES.NO_SHOW_RECORDED, { eventTitle: 'قهوه' })?.text);
    expect(text).not.toContain('سکه');
  });

  /** Plan 08: «من حاضر بودم», and «میزبان نیامد» for a host who marked everybody absent. */
  it('carries the dispute and the report about the host, by the seat', () => {
    const message = render(TEMPLATES.NO_SHOW_RECORDED, {
      eventTitle: 'قهوه',
      participantPublicId: SEAT,
      disputeClosesAt: '2026-09-17T09:00:00.000Z',
    });
    expect(buttons(message)).toEqual([`ev:disp:${SEAT}`, `ev:habs:${SEAT}`]);
    expect(message?.text).toContain('تا ');
  });

  it('still renders a payload from before plan 08, without buttons it cannot fill', () => {
    const message = render(TEMPLATES.NO_SHOW_RECORDED, { eventTitle: 'قهوه' });
    expect(message?.keyboard).toBeUndefined();
    expect(message?.text).not.toContain('بخش پشتیبانی');
  });
});

describe('the offer to dispute an earlier no-show', () => {
  it('names the evening, the deadline and the two buttons', () => {
    const message = render(TEMPLATES.NO_SHOW_DISPUTE_OFFER, {
      eventTitle: 'کوه',
      participantPublicId: SEAT,
      disputeClosesAt: '2026-09-17T09:00:00.000Z',
    });
    expect(message?.text).toContain('کوه');
    expect(message?.text).toContain('اعتراض');
    expect(buttons(message)).toEqual([`ev:disp:${SEAT}`, `ev:habs:${SEAT}`]);
  });
});

describe('the host asked about «میزبان نیامد»', () => {
  it('says a report exists, until when to answer, and that nothing has moved', () => {
    const message = render(TEMPLATES.HOST_ABSENT_REPORTED, {
      eventTitle: 'کوه',
      eventPublicId: EVENT,
      respondBy: '2026-09-12T09:00:00.000Z',
    });
    expect(message?.text).toContain('کوه');
    expect(message?.text).toContain('سکه‌ای جابه‌جا نمی‌شود');
    expect(buttons(message)).toEqual([`ev:hresp:${EVENT}`]);
  });
});

describe('a claim, decided', () => {
  const decided = (payload: Record<string, unknown>): string =>
    String(render(TEMPLATES.NO_SHOW_CLAIM_DECIDED, { eventTitle: 'کوه', ...payload })?.text);

  it('tells a guest their dispute was upheld, and what came back', () => {
    const text = decided({
      recipientRole: 'GUEST',
      kind: 'GUEST_ABSENT_DISPUTE',
      upheld: true,
      coins: 60,
    });
    expect(text).toContain('پذیرفته شد');
    expect(text).toContain('۶۰ سکه');
  });

  it('promises no coins that did not come back', () => {
    const text = decided({ recipientRole: 'GUEST', kind: 'GUEST_ABSENT_DISPUTE', upheld: true });
    expect(text).not.toContain('سکه');
  });

  it('tells a guest a dispute was not upheld', () => {
    expect(
      decided({ recipientRole: 'GUEST', kind: 'GUEST_ABSENT_DISPUTE', upheld: false }),
    ).toContain('پذیرفته نشد');
  });

  it('tells the host the no-show they recorded was removed', () => {
    expect(
      decided({ recipientRole: 'HOST', kind: 'GUEST_ABSENT_DISPUTE', upheld: true }),
    ).toContain('برداشته شد');
  });

  it('tells the host what being found absent cost', () => {
    const text = decided({
      recipientRole: 'HOST',
      kind: 'HOST_ABSENT_REPORT',
      upheld: true,
      coins: 90,
    });
    expect(text).toContain('۹۰ سکه');
    expect(text).toContain('سپرده');
  });

  it('tells a guest the host was found absent, and the refund', () => {
    const text = decided({
      recipientRole: 'GUEST',
      kind: 'HOST_ABSENT_REPORT',
      upheld: true,
      coins: 20,
    });
    expect(text).toContain('حاضر نبوده');
    expect(text).toContain('۲۰ سکه');
  });

  it('tells the host and a reporter when the report was not upheld', () => {
    expect(decided({ recipientRole: 'HOST', kind: 'HOST_ABSENT_REPORT', upheld: false })).toContain(
      'پذیرفته نشد',
    );
    expect(
      decided({ recipientRole: 'GUEST', kind: 'HOST_ABSENT_REPORT', upheld: false }),
    ).toContain('پذیرفته نشد');
  });

  it('escapes the title', () => {
    expect(
      decided({
        eventTitle: '<b>x</b>',
        recipientRole: 'GUEST',
        kind: 'GUEST_ABSENT_DISPUTE',
        upheld: false,
      }),
    ).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
