import { escapeHtml, toPersianDigits } from '../escape';
import type { InlineButton, InlineKeyboard } from '../keyboards';
import { encodeWizardCallback } from './callback';
import { calendarKeyboard, choiceKeyboard, controlRow, type Choice } from './keyboards';

/** One drawn screen: the message body, and the buttons under it. */
export interface WizardScreen {
  text: string;
  keyboard: InlineKeyboard;
}

export interface StepScreenInput {
  /** The question, already in Persian. */
  prompt: string;
  /** Which keyboard to draw. */
  ui: 'text' | 'choice' | 'calendar' | 'time' | 'confirm';
  /** The step key, which its buttons carry. */
  stepKey: string;
  /** Options, for a `choice` or `time` step. */
  choices?: readonly Choice[];
  /** Which page of them. */
  page?: number;
  /** The month to draw, and the first day that may be picked. */
  anchor?: Date;
  earliest?: Date;
  /** A refusal to put above the question. */
  error?: string;
  position: number;
  total: number;
  canGoBack: boolean;
  optional: boolean;
  /** «انصراف», offered unless the step is a gate. Default true. */
  cancellable?: boolean;
  /**
   * Extra buttons above the controls, for a `confirm` step.
   *
   * The consent screen needs «می‌پذیرم» and a link to the full text, and neither
   * is a choice from a list — so the caller builds them and this renders them.
   */
  actions?: readonly (readonly InlineButton[])[];
}

/**
 * Draw one step.
 *
 * ── Why the error is in this message and not another ────────────────────────
 *
 * The wizard lives in a single message that is edited in place, so a refusal is
 * rendered *above the question it is about* rather than sent as a new message.
 * A chat that grows a red line every time somebody mistypes is a chat that
 * scrolls the form off the screen — and the form is the thing they are trying to
 * fill in. This is the whole reason `lastMessageId` exists.
 *
 * ── The progress line ───────────────────────────────────────────────────────
 *
 * «گام ۳ از ۸» counts only the steps this form will actually be asked, which is
 * why `total` is computed from the *current* answers rather than from the length
 * of the definition: choosing «رایگان» removes the amount step, and a counter
 * that kept counting it would promise a question that is never coming.
 */
export function renderStep(input: StepScreenInput): WizardScreen {
  const head = `<i>گام ${toPersianDigits(String(input.position))} از ${toPersianDigits(
    String(input.total),
  )}</i>`;

  const complaint = input.error === undefined ? '' : `⚠️ ${escapeHtml(input.error)}\n\n`;
  const text = `${head}\n\n${complaint}${escapeHtml(input.prompt)}`;

  const trailer = controlRow({
    back: input.canGoBack,
    skip: input.optional,
    cancel: input.cancellable !== false,
  });

  switch (input.ui) {
    case 'choice':
    case 'time':
      return {
        text,
        keyboard: choiceKeyboard(input.stepKey, input.choices ?? [], input.page ?? 0, trailer),
      };

    case 'calendar': {
      const anchor = input.anchor ?? new Date();
      return {
        text,
        keyboard: calendarKeyboard(input.stepKey, anchor, input.earliest ?? anchor, trailer),
      };
    }

    /**
     * A `confirm` step draws whatever the caller built — an «می‌پذیرم», a row of
     * channel links — above the usual controls. It has no options of its own, so
     * without `actions` it is a message with a back button, which is what a
     * caller that forgot them deserves to see.
     */
    case 'confirm':
      return {
        text,
        keyboard: [...(input.actions ?? []), ...(trailer.length > 0 ? [trailer] : [])],
      };

    /**
     * A text step still carries its controls. Without them «بازگشت» would be
     * unreachable from any question answered by typing, which is most of them —
     * and a wizard you cannot reverse is one people abandon rather than correct.
     */
    default:
      return { text, keyboard: trailer.length > 0 ? [trailer] : [] };
  }
}

/** One line of the summary: what it is called, and what was answered. */
export interface SummaryLine {
  label: string;
  value: string;
}

/**
 * The confirmation screen: everything answered, and the two ways out.
 *
 * ── Why a summary at all ────────────────────────────────────────────────────
 *
 * Because the wizard edits one message, the earlier answers are *gone* from the
 * screen by the time the last one is given. Submitting without showing them back
 * would be asking somebody to publish a form they can no longer read. This is
 * the one screen that shows the whole thing.
 *
 * ── The three buttons ───────────────────────────────────────────────────────
 *
 * «ثبت» commits. «افزودن جزئیات بیشتر» opens the optional half — the fields kept
 * off the critical path so the common event takes eight taps. «ویرایش» returns to
 * the first step with everything still filled in, which is what makes the summary
 * a checkpoint rather than a point of no return.
 */
export function renderSummary(lines: readonly SummaryLine[], canAddDetails: boolean): WizardScreen {
  const body = lines
    .map((line) => `<b>${escapeHtml(line.label)}:</b> ${escapeHtml(line.value)}`)
    .join('\n');

  const buttons: InlineButton[][] = [
    [
      {
        text: '✅ ثبت فعالیت',
        callbackData: encodeWizardCallback({ action: 'confirm', value: '' }),
      },
    ],
  ];
  if (canAddDetails) {
    buttons.push([
      {
        text: '➕ افزودن جزئیات بیشتر',
        callbackData: encodeWizardCallback({ action: 'details', value: '' }),
      },
    ]);
  }
  buttons.push([
    { text: '✏️ ویرایش', callbackData: encodeWizardCallback({ action: 'back', value: '' }) },
    { text: '✖️ انصراف', callbackData: encodeWizardCallback({ action: 'cancel', value: '' }) },
  ]);

  return {
    text: `<b>بازبینی نهایی</b>\n\n${body}\n\n<i>اگر همه‌چیز درست است، «ثبت فعالیت» را بزنید.</i>`,
    keyboard: buttons,
  };
}
