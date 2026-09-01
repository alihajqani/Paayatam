/**
 * The short code that turns an activity into a tappable command.
 *
 * ── Why a command and not a button ──────────────────────────────────────────
 *
 * A digest of five activities used to carry ten inline buttons — «۱ جزئیات», «۱
 * پیوستن», «۲ جزئیات»… — which is a keyboard taller than the list it is under,
 * and every label is a number the reader has to match back to a line. Telegram
 * already has a control for "open this one": a `/command` in the body renders as
 * a tap target *on the line it belongs to*, so the list needs no keyboard at all
 * and the paging controls get the keyboard to themselves.
 *
 * ── Why the code is derived and not stored ──────────────────────────────────
 *
 * `event.public_id` is a UUID: 36 characters, which does not fit in a command —
 * Telegram's own limit is 32 and `parseUpdate` enforces it. A stored short code
 * would be a column, a uniqueness constraint, a generator with a retry loop and
 * a backfill, all to name a row that already has a unique name.
 *
 * So the code is the **first ten hex digits of the public id**, and the lookup
 * is an equality test on that prefix — see `publicIdPrefixOf`. Ten digits is
 * forty bits: at ten thousand activities the chance that any two share a prefix
 * is about one in two hundred thousand, and the consequence if it ever happened
 * is that one of two links opens the other activity, not that anything is
 * disclosed or lost. A column is not worth buying that down.
 *
 * ── Why lowercase hex ───────────────────────────────────────────────────────
 *
 * `onCommand` lowercases the command name before it dispatches, because
 * Telegram's clients do not agree on case. A code that used the full alphabet
 * would be destroyed by that; hex survives it, and a UUID is hex already.
 *
 * ── Authorisation is not in the code ────────────────────────────────────────
 *
 * Exactly as with `callback_data` and `?start=`: this names a **public** id, so
 * the worst a guesser can do is name a resource the service layer refuses on its
 * own. Guessing is also not cheap — forty bits — and `findPublished` answers
 * identically for "not published" and "does not exist", so it is not an
 * existence oracle either.
 */

/** How many hex digits of the public id the code carries. */
const CODE_LENGTH = 10;

const CODE = /^[0-9a-f]{10}$/;
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The command that opens one activity from the discovery list. */
export const EVENT_COMMAND = 'event_';

/**
 * The command that opens one of the caller's **own** activities.
 *
 * A second command rather than one that behaves differently for a host, for two
 * reasons. «بازگشت به فهرست» has to know which list to return to, and the two
 * lists are different messages. And the screens are different — a stranger gets
 * a join button, a host gets a console that can cancel the activity — so
 * deciding from *who is asking* would make one link mean two things and put an
 * ownership check in front of every open.
 */
export const MY_EVENT_COMMAND = 'myevent_';

/** `01a05d34-7820-…` → `01a05d3478`. Null for anything that is not a public id. */
export function eventCodeOf(publicId: string): string | null {
  if (!PUBLIC_ID.test(publicId)) return null;
  return publicId.replaceAll('-', '').slice(0, CODE_LENGTH).toLowerCase();
}

/**
 * The prefix of `public_id` a code stands for: `01a05d3478` → `01a05d34-78`.
 *
 * The dash is at index 8 of a UUID, so ten hex digits span the first eleven
 * characters of the stored string. Returning the prefix rather than the code
 * keeps the SQL a plain equality on `substr(public_id, 1, 11)` — no `LIKE`, no
 * pattern, and an expression index can serve it.
 */
export function publicIdPrefixOf(code: string): string | null {
  const lowered = code.toLowerCase();
  if (!CODE.test(lowered)) return null;
  return `${lowered.slice(0, 8)}-${lowered.slice(8)}`;
}

/** How many characters of `public_id` a prefix covers. Mirrored by the SQL. */
export const PUBLIC_ID_PREFIX_LENGTH = 11;

/** `/event_01a05d3478`, for a line of the discovery list. */
export function eventCommandFor(publicId: string): string | null {
  const code = eventCodeOf(publicId);
  return code === null ? null : `/${EVENT_COMMAND}${code}`;
}

/** `/myevent_01a05d3478`, for a line of «فعالیت‌های من». */
export function myEventCommandFor(publicId: string): string | null {
  const code = eventCodeOf(publicId);
  return code === null ? null : `/${MY_EVENT_COMMAND}${code}`;
}

/**
 * The code a `/event_…` command carries.
 *
 * Null for every other command, which is how `onCommand` tells this apart from
 * its fixed names before the `switch` sees them.
 */
export function parseEventCommand(command: string): string | null {
  return codeAfter(command, EVENT_COMMAND);
}

/** The code a `/myevent_…` command carries. */
export function parseMyEventCommand(command: string): string | null {
  return codeAfter(command, MY_EVENT_COMMAND);
}

function codeAfter(command: string, prefix: string): string | null {
  const lowered = command.toLowerCase();
  if (!lowered.startsWith(prefix)) return null;

  const code = lowered.slice(prefix.length);
  return CODE.test(code) ? code : null;
}
