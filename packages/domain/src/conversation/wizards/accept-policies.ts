import type { WizardDefinition, WizardStep } from '../wizard';

/**
 * Accepting the policies, as a conversation (ADR-0017).
 *
 * ── Why this one is not like the others ─────────────────────────────────────
 *
 * `CREATE_EVENT` and `EDIT_PROFILE` collect answers. This collects **one
 * decision**, and the machine is carrying it for two reasons rather than one:
 *
 * It is one step, and it is in the machine anyway because the machine is what
 * owns *resumability* and *idempotency*. Somebody who is shown the terms and
 * stops has a conversation to come back to, and a redelivered tap on «می‌پذیرم»
 * is absorbed by `last_update_id` rather than writing a second consent row.
 *
 * ── Why joining the channels is not a step here ─────────────────────────────
 *
 * It was, in the first draft, and it fought the architecture. The channel
 * requirement is **not a funnel step somebody finishes once** — the Mini App's
 * router says exactly that about `/join-channels`, and declares it outside
 * `ONBOARDING_PATHS` for the reason. An operator can switch the requirement on
 * next week, or add a channel, and a user who "finished" that step is blocked
 * again with a completed wizard behind them.
 *
 * So the channel gate stays a *check*, applied wherever it applies, and the bot
 * renders it as a message with join links rather than as a step with state. What
 * a user has finished once is the acceptance; that is what this wizard holds.
 *
 * ── What it deliberately does not have ──────────────────────────────────────
 *
 * **No «انصراف».** Every other wizard offers a way out, because every other
 * wizard is optional. This one *is* the gate: cancelling it would return the
 * user to a bot that refuses everything, with no way back except a command they
 * would have to guess. The step's `optional` is false and `cancellable` is
 * false, and `renderStep` reads the second.
 *
 * **No form.** Nothing here is stored in `form_data` except which step has been
 * reached — the acceptance itself is a `consent` row written by
 * `ConsentService.acceptPolicies`, which is the same call the Mini App's
 * `POST /onboarding/consent` makes. A draft that held "they said yes" would be a
 * second, weaker record of the one thing in this product that must be provable.
 */

export interface AcceptPoliciesForm {
  /** Set once the acceptance row is written, so `back` cannot un-accept. */
  accepted?: boolean;
}

const steps: WizardStep<AcceptPoliciesForm>[] = [
  {
    key: 'review',
    ui: 'confirm',
    cancellable: false,
    prompt: () => 'برای استفاده از پایه‌تم، لازم است قوانین و سیاست حریم خصوصی را بپذیرید.',
    /**
     * Only «می‌پذیرم» advances. Anything else — a stray text message, a button
     * from an older build — leaves the step where it is, which is the correct
     * behaviour for a gate: there is nothing to mistype and nothing to skip.
     */
    accept: (input) =>
      input.action === 'agree'
        ? { ok: true, patch: { accepted: true } }
        : { ok: false, error: 'برای ادامه، دکمهٔ «می‌پذیرم» را بزنید.' },
  },
];

export const acceptPoliciesWizard: WizardDefinition<AcceptPoliciesForm> = {
  steps,
  empty: () => ({}),
};
