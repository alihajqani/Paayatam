import type { Choice } from '@payetam/telegram';

/**
 * The step machine behind every bot form (ADR-0017).
 *
 * ── Why this, and not `@grammyjs/conversations` ──────────────────────────────
 *
 * ADR-0017 §1 has the argument in full; the short of it is that the plugin
 * drives a flow by awaiting inside a live context and replying with `ctx.reply`,
 * and invariant 11 forbids replying from the API process at all. What is here
 * instead is a list of steps and one pure function per step. `apply` touches no
 * database, no clock and no network, which is what makes a per-step unit test one
 * call and an assertion rather than a grammY harness.
 *
 * ── The shape of a step ─────────────────────────────────────────────────────
 *
 * A step owns three things and nothing else: the question it asks, how it is
 * drawn, and what it does with an answer. It does **not** own where it sits in
 * the flow — `nextStep` decides that from `when`, so a conditional field is
 * declared beside the field rather than encoded in a chain of successors that has
 * to be re-threaded whenever one moves.
 */

/**
 * What arrived: a tapped button, typed text, or a photo.
 *
 * `photo` is v0.6.5 and exists for one wizard — BUG_REPORT, whose whole value is
 * the screenshot attached to it. `value` then carries a Telegram **`file_id`**
 * rather than any content: the image stays on Telegram's servers and this
 * product stores a handle to it. Every other wizard's `accept` refuses a photo
 * the same way it refuses a tap on the wrong keyboard, so adding the member here
 * changes nothing for them.
 */
export interface WizardInput {
  kind: 'callback' | 'text' | 'photo';
  /** The action a callback named. Absent for text and photos. */
  action?: string;
  value: string;
}

/**
 * The outcome of handing an answer to a step.
 *
 * The error is a **Persian sentence**, because it is shown to the person who
 * typed it, in the same edited message they typed into. A code would have to be
 * translated somewhere, and the somewhere would be a second catalogue.
 */
/**
 * Every field optional *and* explicitly assignable `undefined`.
 *
 * Not `Partial<F>`: under `exactOptionalPropertyTypes` that means "may be
 * absent" but not "may be present and undefined" — and clearing a field is
 * exactly what a patch has to express. Choosing «رایگان» after «مبلغ مشخص» must
 * *unset* `costAmount`, or the contract refuses an event the user believes they
 * have just fixed. The same distinction is documented on `EventBodyDraft` in
 * `@payetam/shared`, for the same reason.
 */
export type FormPatch<F> = { [K in keyof F]?: F[K] | undefined };

export type StepResult<F> = { ok: true; patch: FormPatch<F> } | { ok: false; error: string };

/** How a step is drawn. The service turns this into a keyboard. */
export type StepUi = 'text' | 'choice' | 'calendar' | 'time' | 'confirm';

/** What a step may ask the service to load for it. */
export interface WizardDeps {
  categories(): Promise<Choice[]>;
  provinces(): Promise<Choice[]>;
  citiesOf(provinceId: string): Promise<Choice[]>;
  districtsOf(cityId: string): Promise<Choice[]>;
}

export interface WizardStep<F> {
  /** Short, lowercase — it rides in `callback_data` (see the codec's charset). */
  key: string;
  ui: StepUi;
  /** The question, in Persian. May read the form, for a step that recaps. */
  prompt(form: F): string;
  /** Options, for a `choice` step. */
  load?(form: F, deps: WizardDeps): Promise<Choice[]>;
  /**
   * Whether this step applies at all, given what has been answered.
   *
   * This is where conditional validation lives: `costAmount` is asked only for
   * FIXED and APPROX, and *not asking* is a better expression of "not allowed
   * for FREE" than asking and then refusing.
   */
  when?(form: F): boolean;
  /** Answerable with «رد کردن», leaving the field unset. */
  optional?: boolean;
  /**
   * Whether «انصراف» is offered. Default true.
   *
   * False for the consent wizard and nothing else so far: that one *is* the
   * gate, so cancelling would return the user to a bot that refuses everything
   * with no way back except a command they would have to guess. Every other
   * wizard is optional and must be escapable.
   */
  cancellable?: boolean;
  accept(input: WizardInput, form: F): StepResult<F>;
}

export interface WizardDefinition<F> {
  steps: readonly WizardStep<F>[];
  /** The first form, before anything is answered. */
  empty(): F;
}

/** The step with this key, or null for a key from an older build. */
export function stepByKey<F>(definition: WizardDefinition<F>, key: string): WizardStep<F> | null {
  return definition.steps.find((step) => step.key === key) ?? null;
}

/**
 * The step after `key` that applies to this form, or null when the form is done.
 *
 * Null is what the caller turns into the confirmation screen. Skipping is
 * re-evaluated on every move rather than decided once, so answering «رایگان» at
 * the cost step removes the amount step even if it had already been visited —
 * which is the case a chain of successors gets wrong.
 */
export function nextStep<F>(
  definition: WizardDefinition<F>,
  key: string,
  form: F,
): WizardStep<F> | null {
  const index = definition.steps.findIndex((step) => step.key === key);
  if (index < 0) return null;

  for (const step of definition.steps.slice(index + 1)) {
    if (applies(step, form)) return step;
  }
  return null;
}

/** The applicable step before `key`, or null when `key` is the first one. */
export function previousStep<F>(
  definition: WizardDefinition<F>,
  key: string,
  form: F,
): WizardStep<F> | null {
  const index = definition.steps.findIndex((step) => step.key === key);
  if (index <= 0) return null;

  for (const step of definition.steps.slice(0, index).reverse()) {
    if (applies(step, form)) return step;
  }
  return null;
}

/** The first applicable step. */
export function firstStep<F>(definition: WizardDefinition<F>, form: F): WizardStep<F> | null {
  return definition.steps.find((step) => applies(step, form)) ?? null;
}

/** How many applicable steps there are, and which one this is — for «گام ۳ از ۸». */
export function progressOf<F>(
  definition: WizardDefinition<F>,
  key: string,
  form: F,
): { position: number; total: number } {
  const applicable = definition.steps.filter((step) => applies(step, form));
  const position = applicable.findIndex((step) => step.key === key) + 1;
  return { position, total: applicable.length };
}

function applies<F>(step: WizardStep<F>, form: F): boolean {
  return step.when === undefined || step.when(form);
}

/**
 * Hand an answer to a step and get the next form.
 *
 * Kept separate from `nextStep` because the two fail differently: a rejected
 * answer re-renders the *same* step with a message above it, and a accepted one
 * moves on. Fusing them produced a version where a validation error advanced the
 * wizard anyway, which is the bug this signature makes unrepresentable.
 */
export function apply<F>(step: WizardStep<F>, input: WizardInput, form: F): StepResult<F> {
  if (input.action === 'skip') {
    if (step.optional !== true) {
      return { ok: false, error: 'این مورد را نمی‌توان رد کرد.' };
    }
    return { ok: true, patch: {} };
  }
  return step.accept(input, form);
}
