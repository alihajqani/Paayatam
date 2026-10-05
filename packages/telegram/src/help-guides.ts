import {
  encodeGuideCallback,
  encodeGuideCommands,
  encodeGuideIndex,
  encodeMenuRoot,
} from './callback-data';
import { helpCommandLines } from './commands';
import { escapeHtml, toPersianDigits } from './escape';
import {
  BACK_ICON,
  HELP_BUTTON_LABEL,
  MAIN_MENU_LABEL,
  NEXT_LABEL,
  PREVIOUS_LABEL,
} from './keyboards';
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
 * ── Why the contents are two to a row ───────────────────────────────────────
 *
 * They were one per row, and eleven sections made a column taller than a phone
 * screen: the last ones and the command list were below the fold. Two to a row
 * halves that, like the menu's own groups. The cost is width — the labels are
 * an operator's to edit, up to forty characters, and a half-width button cuts a
 * long one off on a narrow phone — so a title meant for this list should stay
 * short. The command list keeps a row of its own: it is not a section.
 */

type Row = { text: string; callbackData: string }[];

/** The one button that offers the guide, under a message that suggests reading it. */
export function readGuideRow(): Row {
  return [{ text: '📖 راهنمای پایتم رو بخون', callbackData: encodeGuideIndex() }];
}

export function formatGuideIndex(): string {
  return (
    `<b>📖 راهنمای پایتم</b>\n\n` +
    `هر بخش رو بزن تا توضیحش باز بشه؛ هر کدوم یکی دو دقیقه وقت می‌بره.\n\n` +
    `<i>هر وقت خواستی، دکمهٔ «${escapeHtml(HELP_BUTTON_LABEL)}» پایین صفحه یا /help ` +
    `برت می‌گردونه همین‌جا.</i>`
  );
}

export function guideIndexRows(guides: readonly { slug: string; title: string }[]): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < guides.length; index += 2) {
    rows.push(
      guides.slice(index, index + 2).map((guide) => ({
        text: guide.title,
        callbackData: encodeGuideCallback(guide.slug),
      })),
    );
  }
  rows.push([{ text: '⌨️ فهرست دستورها', callbackData: encodeGuideCommands() }]);
  return rows;
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
  // Next before previous: see `NEXT_LABEL`.
  const nav: Row = [];
  if (input.nextSlug !== null) {
    nav.push({ text: NEXT_LABEL, callbackData: encodeGuideCallback(input.nextSlug) });
  }
  if (input.previousSlug !== null) {
    nav.push({ text: PREVIOUS_LABEL, callbackData: encodeGuideCallback(input.previousSlug) });
  }
  const rows: Row[] = [];
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: `${BACK_ICON} فهرست راهنما`, callbackData: encodeGuideIndex() }]);
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
    `<i>لازم نیست چیزی تایپ کنی: دکمهٔ «${escapeHtml(MAIN_MENU_LABEL)}» پایین صفحه ` +
    `همهٔ این‌ها رو با دکمه باز می‌کنه.</i>`
  );
}

export function commandListRows(): Row[] {
  return [
    [{ text: '☰ همین‌ها، با دکمه', callbackData: encodeMenuRoot() }],
    [{ text: `${BACK_ICON} فهرست راهنما`, callbackData: encodeGuideIndex() }],
  ];
}

/** When a section was hidden or removed after its button was drawn. */
export function formatGuideGone(): string {
  return `<b>📖 راهنمای پایتم</b>\n\nاین بخش دیگه توی راهنما نیست. بخش‌های فعلی رو از فهرست زیر ببین.`;
}
