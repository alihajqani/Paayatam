import { AppError, ErrorCode } from '@payetam/shared';

/**
 * The single `assertTransition()` (plan §7).
 *
 * Every module declares its legal transitions as a table in
 * `<module>/state-machine.ts`; this enforces them. One enforcement point rather
 * than a `switch` per service is what makes invariant 10 checkable: a reviewer
 * can find every state change by finding the callers of this function.
 *
 * An illegal transition is a 409, never a 500. It means the caller acted on a
 * stale view of the world — two moderators deciding the same case, a host
 * cancelling an event that just expired — which is a conflict, not a bug.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
  context: { entity: string; id?: string },
): void {
  if (canTransition(table, from, to)) return;

  throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, {
    entity: context.entity,
    ...(context.id !== undefined ? { id: context.id } : {}),
    from,
    to,
  });
}

/** States with no outgoing transitions. Useful for "is this over?" checks. */
export function terminalStates<S extends string>(table: TransitionTable<S>): S[] {
  return (Object.keys(table) as S[]).filter((state) => table[state].length === 0);
}
