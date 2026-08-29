import type { Choice } from '@payetam/telegram';
import { createEventWizard, type CreateEventForm } from './create-event';
import type { WizardDefinition, WizardStep } from '../wizard';

/**
 * Editing an event, as a conversation (ADR-0017).
 *
 * ── Why it is the create wizard with one step in front ──────────────────────
 *
 * The obvious design is a field picker: "which field do you want to change?",
 * edit it, return to the picker. It is better UX for changing one thing, and it
 * needs something the step machine deliberately does not have — a **loop**.
 * `nextStep` walks forward through a list; a picker walks back to itself, which
 * means either a second navigation model or a `goto` that can name any step,
 * and both are a bigger change than the feature is worth.
 *
 * So editing is the create flow, prefilled, with **every step skippable** —
 * exactly the shape `EDIT_PROFILE` already has, and consistency across the two
 * edit wizards is worth more than saving a host a few taps. «رد کردن» means
 * *leave this as it is*, and the summary shows what the event will say before
 * anything is written.
 *
 * ── Where the fields come from ──────────────────────────────────────────────
 *
 * Every step below **is** the create wizard's step, reused rather than
 * reimplemented: same validation, same Persian, same cross-field `when` for the
 * cost amount. Only two things are added — a step to choose which event, and
 * `optional: true` on the rest.
 *
 * A second copy of those sixteen validators is the thing this file exists to
 * avoid. When `CreateEventView`'s rules change, they change here too, because
 * there is nothing here to forget to update.
 */

export interface EditEventForm extends CreateEventForm {
  /** Which event, chosen at the first step and mirrored to `target_public_id`. */
  eventPublicId?: string;
}

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which event to edit.
 *
 * The options are loaded by the caller — `WizardDeps` has no "my events", and
 * adding one would put a per-user read into an interface every wizard shares.
 * `BotService` supplies them the same way it supplies the catalog.
 */
const pick: WizardStep<EditEventForm> = {
  key: 'pick',
  ui: 'choice',
  prompt: () => 'کدام فعالیت را ویرایش می‌کنید؟',
  accept: (input) =>
    PUBLIC_ID.test(input.value)
      ? { ok: true, patch: { eventPublicId: input.value } }
      : { ok: false, error: 'یکی از فعالیت‌های خود را انتخاب کنید.' },
};

/**
 * The create wizard's steps, each made skippable.
 *
 * `catlabel` and `amount` keep their `when`, so a category that invites a label
 * still asks for one and a FREE event still is not asked for an amount. Making
 * them optional does not weaken that: `when` decides whether a step is *reached*,
 * `optional` decides whether it can be left unanswered once it is.
 */
const editable: WizardStep<EditEventForm>[] = createEventWizard.steps.map((step) => ({
  ...(step as WizardStep<EditEventForm>),
  optional: true,
}));

export const editEventWizard: WizardDefinition<EditEventForm> = {
  steps: [pick, ...editable],
  empty: () => ({}),
};

/** One of the host's events, as a button. */
export function eventChoice(publicId: string, title: string): Choice {
  // Telegram truncates a long button label into uselessness; 30 characters is
  // about what fits on a phone before the middle disappears.
  return { value: publicId, label: title.length > 30 ? `${title.slice(0, 29)}…` : title };
}
