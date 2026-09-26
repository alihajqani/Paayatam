import {
  encodeGuideCallback,
  encodeGuideCommands,
  encodeGuideIndex,
  encodeMenuRoot,
} from './callback-data';
import { helpCommandLines } from './commands';
import { escapeHtml, toPersianDigits } from './escape';
import { HELP_BUTTON_LABEL, MAIN_MENU_LABEL } from './keyboards';
import { renderLightMarkdown } from './policies';

/**
 * The in-bot guide's screens (migration 0063): the contents, one section per
 * page, and the command list `/help` used to be.
 *
 * ── One message that changes ────────────────────────────────────────────────
 *
 * Every button here redraws the message it is on, the way the policy reader
 * does: somebody reading four sections should have one message in the chat,
 * not four, and «↩️ فهرست راهنما» takes them back to where they chose.
 *
 * ── Why the contents are one button per row ─────────────────────────────────
 *
 * The labels are an operator's to edit, up to forty characters, and two to a
 * row truncates anything past about fifteen on a phone. A section whose name
 * is cut off is a section nobody opens.
 */

type Row = { text: string; callbackData: string }[];

/** The one button that offers the guide, under a message that suggests reading it. */
export function readGuideRow(): Row {
  return [{ text: '📖 خواندن راهنمای پایتم', callbackData: encodeGuideIndex() }];
}

export function formatGuideIndex(): string {
  return (
    `<b>📖 راهنمای پایتم</b>\n\n` +
    `هر بخش را بزنید تا توضیحش باز شود؛ هر کدام یکی دو دقیقه وقت می‌گیرد.\n\n` +
    `<i>هر وقت خواستید، دکمهٔ «${escapeHtml(HELP_BUTTON_LABEL)}» پایین صفحه یا /help ` +
    `شما را به همین‌جا برمی‌گرداند.</i>`
  );
}

export function guideIndexRows(guides: readonly { slug: string; title: string }[]): Row[] {
  return [
    ...guides.map((guide) => [
      { text: guide.title, callbackData: encodeGuideCallback(guide.slug) },
    ]),
    [{ text: '⌨️ فهرست دستورها', callbackData: encodeGuideCommands() }],
  ];
}

/**
 * One section. The body is the operator's light markdown with its numbers
 * already filled in; it is escaped here, like every other body this package
 * renders, so nothing typed in the panel can become markup.
 */
export function formatGuidePage(input: {
  title: string;
  body: string;
  index: number;
  total: number;
}): string {
  const position =
    input.total > 1
      ? `\n\n<i>بخش ${toPersianDigits(String(input.index + 1))} از ${toPersianDigits(String(input.total))}</i>`
      : '';
  return `<b>${escapeHtml(input.title)}</b>\n\n${renderLightMarkdown(input.body)}${position}`;
}

export function guidePageRows(input: {
  previousSlug: string | null;
  nextSlug: string | null;
}): Row[] {
  const nav: Row = [];
  if (input.previousSlug !== null) {
    nav.push({ text: '◀️ قبلی', callbackData: encodeGuideCallback(input.previousSlug) });
  }
  if (input.nextSlug !== null) {
    nav.push({ text: 'بعدی ▶️', callbackData: encodeGuideCallback(input.nextSlug) });
  }
  const rows: Row[] = [];
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: '↩️ فهرست راهنما', callbackData: encodeGuideIndex() }]);
  return rows;
}

/**
 * The command list, which is what `/help` printed before it opened the guide.
 *
 * Kept, one tap from the contents, for the people who type: rendered from
 * `BOT_COMMANDS` so it cannot fall behind the menu.
 */
export function formatCommandList(): string {
  return (
    `<b>⌨️ فهرست دستورها</b>\n\n` +
    `${helpCommandLines()}\n\n` +
    `<i>لازم نیست چیزی تایپ کنید: دکمهٔ «${escapeHtml(MAIN_MENU_LABEL)}» پایین صفحه ` +
    `همهٔ این‌ها را به‌صورت دکمه باز می‌کند.</i>`
  );
}

export function commandListRows(): Row[] {
  return [
    [{ text: '☰ فهرست دستورها به‌صورت دکمه', callbackData: encodeMenuRoot() }],
    [{ text: '↩️ فهرست راهنما', callbackData: encodeGuideIndex() }],
  ];
}

/** When a section was hidden or removed after its button was drawn. */
export function formatGuideGone(): string {
  return `<b>📖 راهنمای پایتم</b>\n\nاین بخش دیگر در راهنما نیست. بخش‌های فعلی را از فهرست زیر ببینید.`;
}
