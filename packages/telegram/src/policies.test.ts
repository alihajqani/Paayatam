import { describe, expect, it } from 'vitest';
import { formatPolicies, type PolicyDocument } from './policies';

function doc(over: Partial<PolicyDocument> = {}): PolicyDocument {
  return {
    title: 'قوانین',
    summary: 'شرایط استفاده',
    contentMd: '# عنوان\n\nمتن سند.\n\n- بند یک\n- بند دو',
    ...over,
  };
}

describe('formatPolicies', () => {
  /**
   * The bug this module exists for: production showed «TERMS v1 — قوانین
   * استفاده از پایه‌تَم» and an accept button. That is a label, and consent to a
   * document nobody has been shown is not consent.
   */
  it('renders the document body, not just the title', () => {
    const text = formatPolicies([doc()]);

    expect(text).toContain('متن سند.');
    expect(text).toContain('بند یک');
  });

  it('keeps the title and the summary', () => {
    const text = formatPolicies([doc()]);

    expect(text).toContain('قوانین');
    expect(text).toContain('شرایط استفاده');
  });

  /** A policy's structure is part of reading it. */
  it('turns headings into bold lines rather than dropping them', () => {
    expect(formatPolicies([doc()])).toContain('<b>عنوان</b>');
  });

  it('renders bold and bullets', () => {
    const text = formatPolicies([doc({ contentMd: '**مهم** است\n- یک' })]);

    expect(text).toContain('<b>مهم</b>');
    expect(text).toContain('• یک');
  });

  /** The document is operator text, but a stray bracket must not become markup. */
  it('escapes markup in the document', () => {
    const text = formatPolicies([doc({ contentMd: '<img src=x onerror=alert(1)>' })]);

    expect(text).toContain('&lt;img');
    expect(text).not.toContain('<img');
  });

  it('renders several documents', () => {
    const text = formatPolicies([doc({ title: 'قوانین' }), doc({ title: 'حریم خصوصی' })]);

    expect(text).toContain('قوانین');
    expect(text).toContain('حریم خصوصی');
  });

  /** Telegram's limit is not negotiable; an omission is named, never silent. */
  it('names a document that did not fit rather than dropping it', () => {
    const huge = doc({ contentMd: 'ا'.repeat(4000) });
    const text = formatPolicies([doc(), huge]);

    expect(text).toContain('سند دیگر در این پیام جا نشد');
    expect(text.length).toBeLessThan(4096);
  });

  it('is empty for no documents', () => {
    expect(formatPolicies([])).toBe('');
  });
});
