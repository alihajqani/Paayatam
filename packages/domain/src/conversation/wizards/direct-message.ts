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

export const DIRECT_MESSAGE_MODES = ['new', 'reply', 'guest'] as const;
export type DirectMessageMode = (typeof DIRECT_MESSAGE_MODES)[number];

export interface DirectMessageForm {
  /** `new`, `reply` or `guest` — seeded by the button that opened the form. Never asked. */
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
        ? 'جوابت رو بنویس.'
        : form.mode === 'guest'
          ? 'پیامت رو برای این مهمان بنویس.'
          : 'پیامت رو برای میزبان این برنامه بنویس.') +
      '\n\n' +
      'می‌تونی برای هماهنگی شماره یا آیدی تلگرامت رو بفرستی، ' +
      'ولی این کار با مسئولیت خودته و پایتم این وسط هیچ نقشی نداره. ' +
      'اطلاعات شخصی‌ت رو با احتیاط و فقط با کسی که بهش اطمینان داری در میون بذار.',
    accept: (input: WizardInput) => {
      // A photo and a tapped button are both refused here, and differently from
      // each other: «بنویسید» is useless advice to somebody who just sent a
      // picture believing it was the message.
      if (input.kind === 'photo') {
        return { ok: false, error: 'فعلاً فقط متن فرستاده میشه. پیامت رو بنویس.' };
      }
      if (input.kind !== 'text') return { ok: false, error: 'پیامت رو بنویس و بفرست.' };

      const value = input.value.trim();
      if (value.length < MIN_LENGTH) {
        return { ok: false, error: 'پیام خیلی کوتاهه. یه کم بیشتر بنویس.' };
      }
      if (value.length > MAX_LENGTH) {
        return {
          ok: false,
          error: 'پیام خیلی بلنده. کوتاه‌ترش کن و دوباره بفرست.',
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

/** Whether a value carried in a form is one of the three modes. */
export function isDirectMessageMode(value: unknown): value is DirectMessageMode {
  return DIRECT_MESSAGE_MODES.some((candidate) => candidate === value);
}
