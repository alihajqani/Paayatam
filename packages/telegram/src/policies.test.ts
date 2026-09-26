import { describe, expect, it } from 'vitest';
import { parsePolicyCallback } from './callback-data';
import {
  PAGE_BUDGET,
  formatPolicyPage,
  formatPolicySummary,
  formatStanding,
  paginatePolicy,
  policyPageRows,
  policyReadRows,
} from './policies';

/** A document shaped like the real ones: a title, an intro, `##` sections. */
function document(sections: number, sectionLength: number): string {
  const body = Array.from(
    { length: sections },
    (_, index) => `## ${String(index + 1)}. بخش\n\n${'متن '.repeat(sectionLength / 4)}`,
  );
  return ['# قوانین و شرایط استفاده', '', 'آخرین به‌روزرسانی: امروز', '', ...body].join('\n');
}

describe('paginatePolicy', () => {
  /**
   * The bug this replaced: every document longer than a shared 3200-character
   * budget was dropped from the consent screen, and the published documents all
   * are. Nothing may be dropped — every word has to be on some page.
   */
  it('keeps every section of a document longer than one message', () => {
    const markdown = document(12, 600);
    const pages = paginatePolicy(markdown);

    expect(pages.length).toBeGreaterThan(1);
    const joined = pages.join('\n');
    for (let index = 1; index <= 12; index += 1) {
      expect(joined).toContain(`<b>${String(index)}. بخش</b>`);
    }
  });

  it('keeps every page inside the budget', () => {
    for (const page of paginatePolicy(document(12, 600))) {
      expect(page.length).toBeLessThanOrEqual(PAGE_BUDGET);
    }
  });

  /** A page break between a heading and its own text would split a clause. */
  it('breaks only at a heading when the sections fit', () => {
    const pages = paginatePolicy(document(12, 600));
    for (const page of pages.slice(1)) {
      expect(page.startsWith('<b>')).toBe(true);
    }
  });

  it('packs short sections together rather than one per page', () => {
    expect(paginatePolicy(document(6, 100))).toHaveLength(1);
  });

  it('cuts a single section that is longer than a page, without losing it', () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) => `- بند ${String(index)} ${'و'.repeat(60)}`,
    );
    const pages = paginatePolicy(`## بلند\n\n${lines.join('\n')}`);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('\n')).toContain('بند 79');
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(PAGE_BUDGET);
  });

  /** A policy's structure is part of reading it. */
  it('renders headings, bold and bullets, and drops a horizontal rule', () => {
    const [page] = paginatePolicy('# عنوان\n\n**مهم** است\n- یک\n\n***\n');

    expect(page).toContain('<b>عنوان</b>');
    expect(page).toContain('<b>مهم</b>');
    expect(page).toContain('• یک');
    expect(page).not.toContain('***');
  });

  /** The document is operator text, but a stray bracket must not become markup. */
  it('escapes markup in the document', () => {
    const [page] = paginatePolicy('<img src=x onerror=alert(1)>');

    expect(page).toContain('&lt;img');
    expect(page).not.toContain('<img');
  });

  it('is one empty page for an empty document', () => {
    expect(paginatePolicy('')).toEqual(['']);
  });
});

describe('a page', () => {
  it('names the document and where the reader is in it', () => {
    const text = formatPolicyPage({ title: 'قوانین', body: 'متن', page: 1, pages: 3 });

    expect(text).toContain('<b>📄 قوانین</b>');
    expect(text).toContain('بخش ۲ از ۳');
  });

  it('says nothing about position for a one-page document', () => {
    expect(formatPolicyPage({ title: 'قوانین', body: 'متن', page: 0, pages: 1 })).not.toContain(
      'بخش',
    );
  });

  it('escapes the title', () => {
    expect(formatPolicyPage({ title: '<b>x', body: '', page: 0, pages: 1 })).toContain(
      '&lt;b&gt;x',
    );
  });
});

describe('the buttons under a page', () => {
  it('offers the way back and forward, in the document it is in', () => {
    const rows = policyPageRows({ type: 'PRIVACY', page: 1, pages: 3, acceptCallbackData: null });
    const nav = rows[0] ?? [];

    expect(nav.map((button) => button.text)).toEqual(['◀️ قبلی', 'بعدی ▶️']);
    expect(nav.map((button) => parsePolicyCallback(button.callbackData))).toEqual([
      { doc: 'p', page: 0 },
      { doc: 'p', page: 2 },
    ]);
  });

  it('has no «قبلی» on the first page and no «بعدی» on the last', () => {
    const first = policyPageRows({ type: 'TERMS', page: 0, pages: 2, acceptCallbackData: null });
    const last = policyPageRows({ type: 'TERMS', page: 1, pages: 2, acceptCallbackData: null });

    expect(first[0]?.map((button) => button.text)).toEqual(['بعدی ▶️']);
    expect(last[0]?.map((button) => button.text)).toEqual(['◀️ قبلی']);
  });

  /**
   * On every page, not only the last: consent needs the text available before
   * agreeing, not proof somebody paged to the end.
   */
  it('carries the acceptance on every page while one is owed', () => {
    for (const page of [0, 1, 2]) {
      const rows = policyPageRows({
        type: 'TERMS',
        page,
        pages: 3,
        acceptCallbackData: 'wz:agree:',
      });
      expect(rows.flat().some((button) => button.callbackData === 'wz:agree:')).toBe(true);
    }
  });

  it('has no acceptance for somebody who owes none', () => {
    const rows = policyPageRows({ type: 'TERMS', page: 0, pages: 3, acceptCallbackData: null });
    expect(rows.flat().some((button) => button.text === '✅ می‌پذیرم')).toBe(false);
  });

  it('always has the way back to the list of documents', () => {
    const rows = policyPageRows({ type: 'COMMUNITY', page: 0, pages: 1, acceptCallbackData: null });
    expect(rows.flat().map((button) => parsePolicyCallback(button.callbackData))).toContainEqual({
      doc: 's',
      page: 0,
    });
  });
});

describe('the list of documents', () => {
  it('offers one button per published document, in a fixed order', () => {
    const rows = policyReadRows(['COMMUNITY', 'TERMS', 'PRIVACY']);

    expect(rows.map((row) => row[0]?.text)).toEqual([
      '📄 متن کامل قوانین',
      '📄 حریم خصوصی',
      '📄 آیین‌نامهٔ رفتار',
    ]);
  });

  it('offers nothing for a document that is not published', () => {
    expect(policyReadRows(['TERMS'])).toHaveLength(1);
  });
});

describe('the consent summary', () => {
  it('names the points somebody is most likely to be surprised by', () => {
    const text = formatPolicySummary({ mode: 'accept' });

    expect(text).toContain('۱۸ سال');
    expect(text).toContain('پیام مستقیم ناشناس نیست');
    expect(text).toContain('۱۸۰ روز');
    expect(text).toContain('برگشت داده نمی‌شود');
    expect(text).toContain('جای متن کامل را نمی‌گیرد');
  });

  it('says what changed when a new version is being accepted', () => {
    const text = formatPolicySummary({
      mode: 'reaccept',
      changes: [{ title: 'حریم خصوصی', changeSummary: 'مدت نگهداری پیام‌ها ۱۸۰ روز شد' }],
    });

    expect(text).toContain('چه چیزی تغییر کرده است');
    expect(text).toContain('مدت نگهداری پیام‌ها ۱۸۰ روز شد');
  });

  it('escapes what an operator wrote as a change summary', () => {
    const text = formatPolicySummary({
      mode: 'reaccept',
      changes: [{ title: '<b>', changeSummary: '<img src=x>' }],
    });
    expect(text).not.toContain('<img');
  });
});

/**
 * `/terms` for a user who is up to date.
 *
 * The escaping is what earns this body its exemption from the second escape in
 * `render` — see the `PRE_RENDERED` note in `escape.test.ts`.
 */
describe('the standing acceptances', () => {
  it('says so plainly when there are none', () => {
    expect(formatStanding([])).toBe('سندی ثبت نشده است.');
  });

  it('lists each document with the date it was accepted', () => {
    const text = formatStanding([{ title: 'قوانین', acceptedAt: '۱۴۰۵/۰۶/۰۷' }]);

    expect(text).toContain('<b>قوانین</b>');
    expect(text).toContain('۱۴۰۵/۰۶/۰۷');
  });

  it('escapes a title the operator wrote markup into', () => {
    const text = formatStanding([
      { title: '<img src=x onerror=alert(1)>', acceptedAt: '<i>دیروز</i>' },
    ]);

    expect(text).not.toContain('<img');
    expect(text).not.toContain('<i>دیروز');
  });
});
