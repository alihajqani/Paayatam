import { describe, expect, it } from 'vitest';
import {
  encodeGuideCallback,
  encodeGuideCommands,
  encodeGuideIndex,
  encodeMenuRoot,
  parseGuideCallback,
} from './callback-data';
import {
  commandListRows,
  formatGuideIndex,
  formatGuidePage,
  guideIndexRows,
  guidePageRows,
  readGuideRow,
} from './help-guides';
import { TEMPLATES, render } from './templates';

describe('the guide callback', () => {
  it('round-trips the contents, the command list and a section', () => {
    expect(parseGuideCallback(encodeGuideIndex())).toEqual({ kind: 'index' });
    expect(parseGuideCallback(encodeGuideCommands())).toEqual({ kind: 'commands' });
    expect(parseGuideCallback(encodeGuideCallback('trust'))).toEqual({
      kind: 'guide',
      slug: 'trust',
    });
  });

  it('refuses anything else', () => {
    for (const data of ['gd', 'gd:x', 'gd:g:', 'gd:g:Trust', 'gd:g:a:b', 'pl:t:0', 'gd:i:x']) {
      expect(parseGuideCallback(data), data).toBeNull();
    }
  });

  it('stays inside sixty-four bytes for the longest slug', () => {
    expect(Buffer.byteLength(encodeGuideCallback('a'.repeat(40)))).toBeLessThanOrEqual(64);
  });
});

describe('formatGuidePage', () => {
  /** The escaping proof `escape.test.ts` relies on for `BOT_HELP`. */
  it('escapes the operator title and body', () => {
    const text = formatGuidePage({
      title: '<b>x</b>',
      body: '<script>alert(1)</script> **پررنگ**',
      index: 0,
      total: 2,
    });
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('<b>پررنگ</b>');
  });

  it('turns dashes into bullets and says where the reader is', () => {
    const text = formatGuidePage({ title: 'عنوان', body: '- یک\n- دو', index: 2, total: 11 });
    expect(text).toContain('• یک\n• دو');
    expect(text).toContain('بخش ۳ از ۱۱');
  });

  it('says nothing about position when there is one section', () => {
    expect(formatGuidePage({ title: 'ع', body: 'م', index: 0, total: 1 })).not.toContain('بخش');
  });
});

describe('the guide keyboards', () => {
  it('lists the sections two to a row, then the command list on its own', () => {
    const rows = guideIndexRows([
      { slug: 'intro', title: 'شروع' },
      { slug: 'trust', title: 'اعتماد' },
      { slug: 'coins', title: 'سکه' },
    ]);
    expect(rows).toEqual([
      [
        { text: 'شروع', callbackData: 'gd:g:intro' },
        { text: 'اعتماد', callbackData: 'gd:g:trust' },
      ],
      [{ text: 'سکه', callbackData: 'gd:g:coins' }],
      [{ text: '⌨️ فهرست دستورها', callbackData: 'gd:k' }],
    ]);
  });

  it('offers only the neighbours that exist, and always the way back', () => {
    expect(guidePageRows({ previousSlug: null, nextSlug: 'trust' })).toEqual([
      [{ text: 'بعدی ◀️', callbackData: 'gd:g:trust' }],
      [{ text: '↩️ فهرست راهنما', callbackData: 'gd:i' }],
    ]);
    expect(guidePageRows({ previousSlug: 'intro', nextSlug: null })[0]).toEqual([
      { text: '▶️ قبلی', callbackData: 'gd:g:intro' },
    ]);
  });

  it('leads the command list back to the guide and on to the menu', () => {
    expect(
      commandListRows()
        .flat()
        .map((button) => button.callbackData),
    ).toEqual([encodeMenuRoot(), encodeGuideIndex()]);
  });
});

describe('the templates the guide rides on', () => {
  it('sends a pre-rendered page with its keyboard', () => {
    const message = render(TEMPLATES.BOT_HELP, {
      text: formatGuideIndex(),
      keyboard: JSON.stringify(guideIndexRows([{ slug: 'intro', title: 'شروع' }])),
    });
    expect(message?.text).toContain('راهنمای پایتم');
    expect(message?.keyboard?.[0]?.[0]).toMatchObject({ callbackData: 'gd:g:intro' });
  });

  /** The end of signing up offers the guide, above the menu opener. */
  it('puts the guide button on a notice that asks for it, and only then', () => {
    const offered = render(TEMPLATES.BOT_NOTICE, { text: 'ساخته شد', withGuide: true });
    expect(offered?.keyboard?.[0]).toEqual(readGuideRow());
    const plain = render(TEMPLATES.BOT_NOTICE, { text: 'ساخته شد' });
    expect(plain?.keyboard?.flat()).not.toContainEqual(readGuideRow()[0]);
  });
});
