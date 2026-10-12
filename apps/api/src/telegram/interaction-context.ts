import { AsyncLocalStorage } from 'node:async_hooks';
import type { InteractionOutcome } from '@payetam/shared';

/**
 * What the bot learns about one update while it handles it.
 *
 * `describeIntent` names the inbound half before anything runs: the kind, the
 * action, the id it pointed at. Everything here is the other half, which only
 * exists once the handler has run — who it was, which screen they were left
 * on, which form and step, and whether the product said no.
 */
export interface InteractionNotes {
  /** The internal user id. Null until the sender is resolved, and if they never are. */
  userId: string | null;
  /** True on the `/start` that created the account. */
  createdAccount: boolean;
  /** Replaces the described action, for the one case only a handler knows: `text:answer`. */
  action: string | null;
  wizardKind: string | null;
  wizardStep: string | null;
  outcome: InteractionOutcome;
  /** The error code for `REFUSED`; which gate for `GATED`. */
  detail: string | null;
  /** The template key of the last screen drawn. */
  screen: string | null;
}

export function newInteractionNotes(): InteractionNotes {
  return {
    userId: null,
    createdAccount: false,
    action: null,
    wizardKind: null,
    wizardStep: null,
    outcome: 'OK',
    detail: null,
    screen: null,
  };
}

/**
 * The notes for the update being handled, carried without a parameter.
 *
 * `AsyncLocalStorage`, for the reason `request-context.ts` gives: the places
 * that know something worth recording — `reply`, `refuse`, `drawWizard`, the
 * gates — are several calls below `dispatch` and are reached from every
 * handler in `BotService`. Threading a notes object through each would put a
 * parameter on every method of a file that size, and the first handler written
 * in a hurry would not pass it.
 *
 * Outside `dispatch` there is no store, and every function below is a no-op —
 * so a helper that is one day called from somewhere else records nothing
 * rather than throwing.
 */
const storage = new AsyncLocalStorage<InteractionNotes>();

export function runWithInteraction<T>(notes: InteractionNotes, fn: () => Promise<T>): Promise<T> {
  return storage.run(notes, fn);
}

/** Record who it was, what was drawn, or which form step is now on screen. */
export function noteInteraction(
  patch: Partial<Omit<InteractionNotes, 'outcome' | 'detail'>>,
): void {
  const notes = storage.getStore();
  if (notes !== undefined) Object.assign(notes, patch);
}

/**
 * Record that the update did not simply succeed.
 *
 * **The first one stands.** A refused action usually goes on to draw something
 * — the channel screen, the event it was refused on — and what happens after a
 * refusal must not rewrite why it was refused. So a later call is ignored.
 */
export function noteOutcome(
  outcome: Exclude<InteractionOutcome, 'OK'>,
  detail: string | null = null,
): void {
  const notes = storage.getStore();
  if (notes === undefined || notes.outcome !== 'OK') return;
  notes.outcome = outcome;
  notes.detail = detail;
}
