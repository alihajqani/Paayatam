import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * «دایرکت» — one message to the other party about one activity (v0.7.0).
 *
 * ── One field, and a kind of its own ────────────────────────────────────────
 *
 * The smallest wizard after `REDEEM_CODE`, and a separate kind for the same
 * reason that one is: the form is one field, and what differs is what the answer
 * is handed to. Folding it into another kind would put a branch in a submit
 * handler where a `ConversationKind` already says which thing this is.
 *
 * ── What arrives seeded, and why it must ────────────────────────────────────
 *
 * `mode` says whether this message starts a thread or answers one, and
 * `conversation_state.target_public_id` carries an **event** public id in the
 * first case and a **direct-message** public id in the second. Both are UUIDs,
 * so nothing downstream could tell them apart by looking — the button that was
 * tapped knows, and it is the only thing that does.
 *
 * That seeding is also the authorisation boundary's other half. The service
 * refuses a reply from anybody but the parent's recipient and derives a new
 * thread's addressee from the activity, so a tampered id names a resource the
 * service declines — exactly as `ev:` and `chat:` already work.
 *
 * ── «انصراف» is the requirement, and it is the default ──────────────────────
 *
 * Every wizard is cancellable unless it is a gate, and this one must be: the
 * brief asks for a cancel button under the compose prompt in as many words, and
 * a message half-written to a stranger is the clearest case for one.
 */

export const DIRECT_MESSAGE_MODES = ['new', 'reply'] as const;
export type DirectMessageMode = (typeof DIRECT_MESSAGE_MODES)[number];

export interface DirectMessageForm {
  /** `new` or `reply` — seeded by the button that opened the form. Never asked. */
  mode?: DirectMessageMode;
  body?: string;
}

/** The service's own bounds, restated so a refusal names the field. */
const MIN_LENGTH = 2;
const MAX_LENGTH = 1000;

const steps: WizardStep<DirectMessageForm>[] = [
  {
    key: 'body',
    ui: 'text',
    /**
     * The prompt carries the warning, and it carries it *here*.
     *
     * Not in the message that arrives, and not in a settings page: this is the
     * moment somebody is deciding whether to type their phone number, and a
     * caution shown after they have sent it is a caution about something that has
     * already happened.
     */
    prompt: (form) =>
      (form.mode === 'reply'
        ? 'پاسخ خود را بنویسید.'
        : 'پیامتان را برای میزبان این فعالیت بنویسید.') +
      '\n\n' +
      'می‌توانید برای هماهنگی شمارهٔ تماس یا شناسهٔ تلگرامتان را بفرستید — ' +
      'اما این کار با مسئولیت خودتان است و پایه‌تَم در این میان هیچ نقشی ندارد. ' +
      'اطلاعات شخصی را با احتیاط و فقط با کسی که به او اطمینان دارید در میان بگذارید.',
    accept: (input: WizardInput) => {
      // A photo and a tapped button are both refused here, and differently from
      // each other: «بنویسید» is useless advice to somebody who just sent a
      // picture believing it was the message.
      if (input.kind === 'photo') {
        return { ok: false, error: 'فعلاً فقط متن فرستاده می‌شود. پیامتان را بنویسید.' };
      }
      if (input.kind !== 'text') return { ok: false, error: 'پیامتان را بنویسید و بفرستید.' };

      const value = input.value.trim();
      if (value.length < MIN_LENGTH) {
        return { ok: false, error: 'پیام خیلی کوتاه است. کمی بیشتر بنویسید.' };
      }
      if (value.length > MAX_LENGTH) {
        return {
          ok: false,
          error: 'پیام خیلی بلند است. آن را کوتاه‌تر کنید و دوباره بفرستید.',
        };
      }

      return { ok: true, patch: { body: value } };
    },
  },
];

export const directMessageWizard: WizardDefinition<DirectMessageForm> = {
  steps,
  empty: () => ({}),
};

/** Whether a value carried in a form is one of the two modes. */
export function isDirectMessageMode(value: unknown): value is DirectMessageMode {
  return DIRECT_MESSAGE_MODES.some((candidate) => candidate === value);
}
