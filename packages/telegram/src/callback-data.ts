/**
 * The inline-keyboard protocol (plan §6: `chat:accept|reject|close:<id>`).
 *
 * Telegram allows **64 bytes** of `callback_data` and no more, and it is not a
 * budget worth spending on cleverness: the encoder below is a colon-separated
 * triple, and `encodeChatCallback` throws rather than emit something Telegram
 * would refuse at send time — a button that fails to send is a notification that
 * never arrives, discovered in production.
 *
 * **Callback data is untrusted input.** It arrives from a client, so a tampered
 * value must fail the parse rather than reach a service; and because the ids in it
 * are public ids, the worst a tamperer can do is name a resource they do not own,
 * which the service layer refuses on its own (T3.2). Authorisation is not in the
 * button.
 *
 * The single namespace is the plan's. `accept` and `reject` carry a **participant**
 * public id; `close`, `share` and `shareyes` carry a **chat** public id — the host
 * decides from inside the conversation, which is why they all live under `chat:`.
 *
 * ── Why sharing contact details is two actions ──────────────────────────────
 *
 * `share` **asks**; `shareyes` **does**. Consent to disclose is the one decision
 * in this product that must be deliberate — ADR-0009 — and a single tap on a
 * button in a message that arrived unbidden is not deliberate enough for it. The
 * Mini App answers this with a confirmation screen; the bot answers it with a
 * second button and a sentence saying exactly what will happen, which is the same
 * guarantee without sending the user to a different application to get it
 * (report 6).
 *
 * `chat:shareyes:<uuid>` is 52 bytes, comfortably inside the 64 the encoder
 * enforces.
 */

export const CHAT_CALLBACK_ACTIONS = ['accept', 'reject', 'close', 'share', 'shareyes'] as const;
export type ChatCallbackAction = (typeof CHAT_CALLBACK_ACTIONS)[number];

export interface ChatCallback {
  action: ChatCallbackAction;
  /** A participant public id for accept/reject; a chat public id for the rest. */
  id: string;
}

const PREFIX = 'chat';
const MAX_BYTES = 64;

/** Public ids are UUIDs; anything else is a caller mistake or a tampered button. */
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this a value a button may be built from?
 *
 * Used by the templates before they emit a keyboard. Without it, a payload holding
 * something long where a public id belongs would make `encodeChatCallback` throw
 * *inside* `render` — and a renderer that throws fails the send job, which retries,
 * which fails again. A malformed payload should cost a keyboard, not a queue.
 */
export function isPublicId(value: string): boolean {
  return PUBLIC_ID.test(value);
}

export function encodeChatCallback(action: ChatCallbackAction, id: string): string {
  const data = `${PREFIX}:${action}:${id}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    // Thrown at build time rather than sent and refused: `sendMessage` would fail
    // with a 400, the notification would exhaust its retries, and the cause would
    // be a length limit nobody was looking for.
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

export function parseChatCallback(data: string): ChatCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action, id] = parts;
  if (prefix !== PREFIX || id === undefined || !isPublicId(id)) return null;
  if (!isChatAction(action)) return null;

  return { action, id };
}

function isChatAction(value: string | undefined): value is ChatCallbackAction {
  return CHAT_CALLBACK_ACTIONS.some((action) => action === value);
}

/**
 * The event protocol: `ev:<action>:<public id>`.
 *
 * ── Why this namespace had to exist ─────────────────────────────────────────
 *
 * `/discover` listed events and offered no way to join one. The bot could host
 * an activity and could show you activities, and the step between those two —
 * the product's whole point — was reachable only from the Mini App, which
 * v0.4.6 removed every button to. So discovery was a catalogue you could read
 * and not act on.
 *
 * A separate prefix rather than more `chat:` actions, for the reason the two
 * wizard protocols are separate: `chat:` ids are a participant or a conversation
 * and `ev:` ids are an event, so a parser that accepted both would be one
 * mistake away from passing an event id where a participant id belongs. They are
 * told apart by prefix before either parser sees the data.
 *
 * `ev:join:<uuid>` is 44 bytes, well inside the 64 Telegram allows.
 *
 * **Authorisation is not in the button**, exactly as `chat:` says: `join` is
 * refused by `ParticipationService` for an event that is full, cancelled, the
 * caller's own, or one they have already asked to join — and `cancel` is refused
 * for a participation that is not theirs. A tampered id names a resource the
 * service declines, which is the same answer the API gives.
 */
export const EVENT_CALLBACK_ACTIONS = [
  'join',
  'cancel',
  /** One activity in full, before deciding to spend an evening on it. */
  'show',
  /**
   * The host's paid actions, each in two steps — the ask and the act.
   *
   * `post` asks and `postyes` does; `invite` asks and `inviteyes` does; `drop`
   * asks and `dropyes` does. The same shape `chat:share`/`chat:shareyes` uses,
   * and for the same reason: these spend coins or end an activity other people
   * are counting on, and a single tap on a button in a digest somebody opened to
   * read is not a deliberate decision.
   *
   * The ask is also where the **live cost** is stated. `economy.*` are settings
   * an operator can change, so the number in the confirmation is read at the
   * moment it is shown rather than written into a template — a message that
   * names a price the service will not charge is worse than one that names none.
   */
  'post',
  'postyes',
  'boost',
  'boostyes',
  'invite',
  'inviteyes',
  'drop',
  'dropyes',
] as const;
export type EventCallbackAction = (typeof EVENT_CALLBACK_ACTIONS)[number];

export interface EventCallback {
  action: EventCallbackAction;
  /** An event public id for `join`; a participant public id for `cancel`. */
  id: string;
}

const EVENT_PREFIX = 'ev';

export function encodeEventCallback(action: EventCallbackAction, id: string): string {
  const data = `${EVENT_PREFIX}:${action}:${id}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

export function parseEventCallback(data: string): EventCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action, id] = parts;
  if (prefix !== EVENT_PREFIX || id === undefined || !isPublicId(id)) return null;
  if (!EVENT_CALLBACK_ACTIONS.some((candidate) => candidate === action)) return null;

  return { action: action as EventCallbackAction, id };
}

/**
 * The review protocol: `rv:rate<1-5>:<participant public id>`.
 *
 * ── Why the rating is in the action and not the value ───────────────────────
 *
 * The value slot holds the participant public id, which is a UUID and spends 36
 * of the 64 bytes on its own. Putting the rating there too would need a fourth
 * field and a separator the parsers already refuse. `rv:rate4:<uuid>` is 45
 * bytes and needs neither.
 *
 * ── Why a review is two taps and not a form ─────────────────────────────────
 *
 * `ReviewsView` asks for a rating, up to five tags and a comment on one screen.
 * The bot asks for the rating, because the rating is the part that moves the
 * Trust Score and the part almost everybody fills in — and a review that gets
 * written is worth more than a richer one that does not. Tags and the comment
 * are a real gap and want a wizard of their own; `review.edit_window_minutes`
 * is what will let that wizard amend a rating already given.
 *
 * Authorisation is not in the button, as everywhere else: `ReviewService.submit`
 * refuses a participation that is not the caller's, one whose window has not
 * opened, and one whose deadline has passed.
 */
export const REVIEW_RATINGS = [1, 2, 3, 4, 5] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

export interface ReviewCallback {
  rating: ReviewRating;
  /** The participation being reviewed. */
  id: string;
}

const REVIEW_PREFIX = 'rv';

export function encodeReviewCallback(rating: ReviewRating, id: string): string {
  const data = `${REVIEW_PREFIX}:rate${String(rating)}:${id}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

export function parseReviewCallback(data: string): ReviewCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action, id] = parts;
  if (prefix !== REVIEW_PREFIX || id === undefined || !isPublicId(id)) return null;
  if (action === undefined || !action.startsWith('rate')) return null;

  const rating = Number(action.slice(4));
  const match = REVIEW_RATINGS.find((candidate) => candidate === rating);
  return match === undefined ? null : { rating: match, id };
}

/**
 * The reporting protocol: `rp:<target><reason>:<public id>`.
 *
 * ── Why the bot needs one at all ────────────────────────────────────────────
 *
 * Reporting was the last user-facing safety control with no bot surface. The
 * four endpoints have existed since M12 and were reachable only from the Mini
 * App, so from v0.4.6 — when the last button to it went — a user meeting
 * strangers through this product had no way to say that something was wrong.
 * That is the one gap in the retirement that was not a convenience.
 *
 * ── Why the target type is in the callback ──────────────────────────────────
 *
 * `ReportService.file` takes a target *type* and a public id, and public ids do
 * not carry their table. An event, a conversation and a user are three different
 * things to a moderator, and guessing between them by trying each lookup in turn
 * would make a typo in one id resolve as a report against something else.
 *
 * One letter, then the reason: `e` event, `c` conversation, `u` user. The widest
 * is `rp:cIMPERSONATION:<uuid>` at 55 bytes, inside the 64 Telegram allows.
 *
 * `ask` is the menu — `rp:aske:<uuid>` — because seven reasons do not fit under
 * a message that is about something else, and a report filed by a mis-tap is a
 * report a moderator has to read.
 *
 * **Reviews are absent on purpose.** `POST /reviews/:publicId/report` exists,
 * and the bot has no view of a review you have *received* — so there is nothing
 * to report from. That view comes first; the target letter is reserved.
 */
export const REPORT_TARGETS = { e: 'EVENT', c: 'MESSAGE', u: 'USER' } as const;
export type ReportTargetLetter = keyof typeof REPORT_TARGETS;

export const REPORT_REASONS = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE',
  'SCAM',
  'IMPERSONATION',
  'SAFETY',
  'OTHER',
] as const;
export type ReportReasonValue = (typeof REPORT_REASONS)[number];

export interface ReportCallback {
  /** True for the menu, false for a filed reason. */
  asking: boolean;
  target: ReportTargetLetter;
  /** Absent while asking. */
  reason: ReportReasonValue | null;
  id: string;
}

const REPORT_PREFIX = 'rp';

export function encodeReportAsk(target: ReportTargetLetter, id: string): string {
  return guardReport(`${REPORT_PREFIX}:ask${target}:${id}`);
}

export function encodeReportReason(
  target: ReportTargetLetter,
  reason: ReportReasonValue,
  id: string,
): string {
  return guardReport(`${REPORT_PREFIX}:${target}${reason}:${id}`);
}

function guardReport(data: string): string {
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

function isTargetLetter(value: string): value is ReportTargetLetter {
  return Object.hasOwn(REPORT_TARGETS, value);
}

export function parseReportCallback(data: string): ReportCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action, id] = parts;
  if (prefix !== REPORT_PREFIX || id === undefined || action === undefined) return null;
  if (!isPublicId(id)) return null;

  if (action.startsWith('ask')) {
    const target = action.slice(3);
    return isTargetLetter(target) ? { asking: true, target, reason: null, id } : null;
  }

  const target = action.slice(0, 1);
  const reason = action.slice(1);
  if (!isTargetLetter(target)) return null;

  const match = REPORT_REASONS.find((candidate) => candidate === reason);
  return match === undefined ? null : { asking: false, target, reason: match, id };
}

/**
 * The discovery filter protocol: `dc:<when><cost>:<category>`.
 *
 * ── Why the state is in the button and not in a draft ───────────────────────
 *
 * `/discover` has been city-only since M13, and the reason given was honest: the
 * bot holds no per-user query state, so asking for even one of `DiscoveryQuery`'s
 * fourteen filters would mean keeping a half-built search between two updates.
 *
 * It does not have to. **The whole filter set fits in the callback**, so every
 * button carries the complete query it would produce and the bot stays as
 * stateless as it was. A tap is not "add a filter to what I remember about you",
 * it is "run *this* search" — which also means a button from a message three
 * days old still does exactly what it says, rather than combining with whatever
 * somebody has tapped since.
 *
 * ── The three that fit, and the eleven that do not ──────────────────────────
 *
 * `when` (any/today/week) and `cost` (any/free) are one character each; the
 * category is a UUID and spends 36 of the 64 bytes. That is the budget gone, and
 * it is why this is three filters rather than fourteen. They are the three a
 * person actually asks at the door: when, how much, what kind.
 *
 * The city stays the profile's, as it always has — a filter for it would mean
 * asking somebody where they are when the product already knows.
 *
 * `all` is the literal for "no category", so no sentinel UUID has to be reserved
 * and `isPublicId` still guards every real id.
 */
export const DISCOVER_WHEN = ['a', 't', 'w'] as const;
export type DiscoverWhen = (typeof DISCOVER_WHEN)[number];

export const DISCOVER_COST = ['a', 'f'] as const;
export type DiscoverCost = (typeof DISCOVER_COST)[number];

export interface DiscoverFilters {
  /** `a` any time, `t` today, `w` the next seven days. */
  when: DiscoverWhen;
  /** `a` any cost, `f` free only. */
  cost: DiscoverCost;
  /** A category public id, or null for every category. */
  categoryId: string | null;
}

const DISCOVER_PREFIX = 'dc';
const ANY_CATEGORY = 'all';

export function encodeDiscoverCallback(filters: DiscoverFilters): string {
  const category = filters.categoryId ?? ANY_CATEGORY;
  const data = `${DISCOVER_PREFIX}:${filters.when}${filters.cost}:${category}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

export function parseDiscoverCallback(data: string): DiscoverFilters | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, flags, category] = parts;
  if (prefix !== DISCOVER_PREFIX || flags === undefined || category === undefined) return null;
  if (flags.length !== 2) return null;

  const when = DISCOVER_WHEN.find((candidate) => candidate === flags[0]);
  const cost = DISCOVER_COST.find((candidate) => candidate === flags[1]);
  if (when === undefined || cost === undefined) return null;

  if (category === ANY_CATEGORY) return { when, cost, categoryId: null };
  return isPublicId(category) ? { when, cost, categoryId: category } : null;
}
