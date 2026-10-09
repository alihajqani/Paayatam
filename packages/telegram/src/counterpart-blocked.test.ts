import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

/**
 * «فلانی بی‌معرفتی کرده» (v0.24.0). One sentence per thing that failed to
 * arrive, because each leaves the reader a different next step.
 */
describe('COUNTERPART_BLOCKED_BOT', () => {
  const base = { blockedDisplayName: 'سارا', eventTitle: 'کوه‌نوردی دربند' };

  it('tells a guest their request still stands and expires on its own', () => {
    const text = render(TEMPLATES.COUNTERPART_BLOCKED_BOT, {
      ...base,
      reason: 'JOIN_REQUEST',
    })?.text;

    expect(text).toContain('سارا ربات رو بلاک کرده');
    expect(text).toContain('بی‌معرفتی');
    expect(text).toContain('«کوه‌نوردی دربند»');
    expect(text).toContain('آخر وقت');
  });

  it('tells a host their accepted guest may not turn up', () => {
    const text = render(TEMPLATES.COUNTERPART_BLOCKED_BOT, { ...base, reason: 'ACCEPTED' })?.text;

    expect(text).toContain('قبول کردی');
    expect(text).toContain('نیاد');
  });

  it('tells whoever wrote that their message did not arrive', () => {
    const text = render(TEMPLATES.COUNTERPART_BLOCKED_BOT, {
      ...base,
      reason: 'DIRECT_MESSAGE',
    })?.text;

    expect(text).toContain('پیامت به سارا نرسید');
  });

  it('escapes the name, and never renders an empty one', () => {
    const hostile = render(TEMPLATES.COUNTERPART_BLOCKED_BOT, {
      ...base,
      blockedDisplayName: '<b>x</b>',
      reason: 'JOIN_REQUEST',
    })?.text;
    expect(hostile).toContain('&lt;b&gt;x&lt;/b&gt;');

    const nameless = render(TEMPLATES.COUNTERPART_BLOCKED_BOT, { reason: 'DIRECT_MESSAGE' })?.text;
    expect(nameless).toContain('طرف مقابل');
  });

  it('writes no long dash, which the voice guide forbids in Persian text', () => {
    for (const reason of ['JOIN_REQUEST', 'ACCEPTED', 'DIRECT_MESSAGE']) {
      expect(render(TEMPLATES.COUNTERPART_BLOCKED_BOT, { ...base, reason })?.text).not.toContain(
        '—',
      );
    }
  });
});
