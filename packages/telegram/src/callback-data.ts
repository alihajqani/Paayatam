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
   * Who is coming, and recording that somebody did not turn up.
   *
   * `who` carries an **event** public id; `noshow` and `noshowyes` carry a
   * **participant** one — the same split `join`/`cancel` already has, and the
   * reason both parsers refuse to guess at a target from an id alone.
   *
   * Two steps for the same reason the paid actions have two: a no-show moves
   * somebody's Trust Score down and cannot be undone from the bot.
   */
  'who',
  'noshow',
  'noshowyes',
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
 * `v` is reviews, added in v0.6.0 with the view that made it reachable: the
 * endpoint had existed since M12 and the bot had nothing to report *from*.
 */
export const REPORT_TARGETS = { e: 'EVENT', c: 'MESSAGE', u: 'USER', v: 'REVIEW' } as const;
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

/**
 * Which half of the discovery screen is drawn: the list, or the filters.
 *
 * ── Why this is in the callback and not in a row somewhere ──────────────────
 *
 * Because it is the same argument the rest of this record makes. The bot holds
 * no per-user query state, so «باز کردن فیلترها» cannot be "remember that they
 * opened the filters" — it has to be a button that carries the complete screen
 * it produces, exactly as a filter button carries the complete search it runs.
 *
 * ── Why the two halves are one message and not two ──────────────────────────
 *
 * Six filter rows and five activities do not fit on a phone together, and the
 * list is what somebody came for. So the filters are behind a button and open
 * *in place* — the message becomes the filter panel, applying a filter redraws
 * it, and «بازگشت به فهرست» turns it back into the list. One message, three
 * states, which is what an anonymous-chat bot does and what makes it feel like
 * a screen rather than a transcript.
 */
export const DISCOVER_VIEWS = ['l', 'f'] as const;
export type DiscoverView = (typeof DISCOVER_VIEWS)[number];

export interface DiscoverFilters {
  /** `a` any time, `t` today, `w` the next seven days. */
  when: DiscoverWhen;
  /** `a` any cost, `f` free only. */
  cost: DiscoverCost;
  /** A category public id, or null for every category. */
  categoryId: string | null;
  /**
   * Which page of results, zero-based (v0.6.5).
   *
   * Part of the *filters* rather than held per user, for the reason the rest of
   * this record is: the bot keeps no query state, so «صفحهٔ بعد» has to be a
   * button that carries the whole query plus one. That also makes a page button
   * in a three-day-old message still mean the page it says.
   *
   * Bounded by `MAX_DISCOVER_PAGE` because it is encoded as a single base-36
   * character, which keeps the payload the same width it was.
   */
  page: number;
  /** `l` the numbered list, `f` the filter panel. See `DISCOVER_VIEWS`. */
  view: DiscoverView;
}

const DISCOVER_PREFIX = 'dc';
const ANY_CATEGORY = 'all';

/**
 * The highest page a button can name — `z` in base 36.
 *
 * Thirty-six pages of five is a hundred and eighty activities in one city under
 * one filter, which is far beyond where anybody is still reading. A cap that a
 * real list can reach would need a wider encoding; this one cannot be reached,
 * so the paging control stops offering «بعدی» long before it matters.
 */
export const MAX_DISCOVER_PAGE = 35;

/** `0`–`z`. One character, so an old two-flag payload stays parseable. */
function encodePage(page: number): string {
  const clamped = Math.min(Math.max(Math.trunc(page), 0), MAX_DISCOVER_PAGE);
  return clamped.toString(36);
}

function decodePage(letter: string | undefined): number | null {
  // Absent is page 0: that is what every button minted before v0.6.5 carries,
  // and they must keep working rather than becoming «این دکمه دیگر کار نمی‌کند».
  if (letter === undefined) return 0;
  if (!/^[0-9a-z]$/.test(letter)) return null;
  const page = Number.parseInt(letter, 36);
  return page > MAX_DISCOVER_PAGE ? null : page;
}

export function encodeDiscoverCallback(filters: DiscoverFilters): string {
  const category = filters.categoryId ?? ANY_CATEGORY;
  const data =
    `${DISCOVER_PREFIX}:${filters.when}${filters.cost}${encodePage(filters.page)}${filters.view}` +
    `:${category}`;
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
  /**
   * Two, three or four characters — one shape per release, and every one of them
   * still parses.
   *
   * Two is pre-v0.6.5 and means page 0; three carries the page; four carries the
   * view as well. A button lives in a message for as long as the message does,
   * and «این دکمه دیگر کار نمی‌کند» on a two-day-old list is a bug rather than a
   * graceful degradation.
   */
  if (flags.length < 2 || flags.length > 4) return null;

  const when = DISCOVER_WHEN.find((candidate) => candidate === flags[0]);
  const cost = DISCOVER_COST.find((candidate) => candidate === flags[1]);
  if (when === undefined || cost === undefined) return null;

  const page = decodePage(flags[2]);
  if (page === null) return null;

  // Absent is the list, which is what every button minted before v0.6.7 means.
  const view = flags[3] === undefined ? 'l' : DISCOVER_VIEWS.find((c) => c === flags[3]);
  if (view === undefined) return null;

  if (category === ANY_CATEGORY) return { when, cost, categoryId: null, page, view };
  return isPublicId(category) ? { when, cost, categoryId: category, page, view } : null;
}

/**
 * «بازگشت به فهرست»: `bk:<list>:<message id>`.
 *
 * ── What the payload has to carry, and why ──────────────────────────────────
 *
 * Going back from an activity means the list becomes the last thing in the chat
 * again — so two messages have to go: the activity the bot drew, and the
 * `/event_…` the reader tapped to open it. The first is the message the button
 * is on, which Telegram names in the callback. The second is **the user's own
 * message**, and nothing else in the update knows its id, so the button that
 * will delete it is the only place to keep it.
 *
 * Zero means "there was none": a detail opened from somewhere other than a
 * tapped command has nothing of the user's to tidy away, and a missing id must
 * not be confused with message zero.
 *
 * ── Why the list is named ───────────────────────────────────────────────────
 *
 * `d` and `m` are the discovery list and «فعالیت‌های من», and they are different
 * messages further up the chat. Nothing is redrawn — both lists are still
 * there — but the letter is what a future "and refresh it" would need, and a
 * protocol that cannot say which list it came from is one that has to guess.
 */
export const BACK_TARGETS = ['d', 'm'] as const;
export type BackTarget = (typeof BACK_TARGETS)[number];

export interface BackCallback {
  target: BackTarget;
  /** The `/event_…` message to delete with the detail, or null if there was none. */
  commandMessageId: number | null;
}

const BACK_PREFIX = 'bk';

export function encodeBackCallback(target: BackTarget, commandMessageId: number | null): string {
  const id = commandMessageId === null || commandMessageId <= 0 ? 0 : Math.trunc(commandMessageId);
  const data = `${BACK_PREFIX}:${target}:${String(id)}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

export function parseBackCallback(data: string): BackCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, target, id] = parts;
  if (prefix !== BACK_PREFIX || id === undefined) return null;

  const found = BACK_TARGETS.find((candidate) => candidate === target);
  if (found === undefined) return null;
  // A message id is a positive integer Telegram assigns per chat. Anything else
  // is a tampered or truncated button, and fails the parse like every other one.
  if (!/^\d{1,12}$/.test(id)) return null;

  const messageId = Number.parseInt(id, 10);
  return { target: found, commandMessageId: messageId === 0 ? null : messageId };
}

/**
 * The settings protocol: `st:<field><value>:x`.
 *
 * ── Why a board and not a wizard ────────────────────────────────────────────
 *
 * A wizard walks somebody through a sequence and ends. Settings are not a
 * sequence — they are a board you glance at, change one thing on, and leave.
 * Making them a wizard would mean answering four questions to change the one you
 * came for, and it would consume the single `conversation_state` slot, so
 * opening settings mid-way through creating an activity would silently discard
 * the draft.
 *
 * So: a message that redraws itself, with every button carrying the value it
 * sets. The same shape as the discovery filters, and stateless for the same
 * reason — a button says what it does, and doing it twice is doing it once.
 *
 * The value slot is unused (`x`) because the three-part shape is what every
 * parser here expects and a fourth field would need a separator they all refuse.
 *
 * ── Why five letters and not three ──────────────────────────────────────────
 *
 * The board shows three things — notifications, privacy and language — and until
 * v0.6.3 only the first was tappable. The other two were **sentences telling the
 * reader to send a command**: «برای تغییر این مورد، /edit_profile را بفرستید».
 * A settings screen that answers a tap with homework is a settings screen that
 * has given up, and the whole point of this surface is that nothing here needs a
 * command.
 *
 * So the letters cover all three, and where a value lives is the *bot's*
 * problem rather than the protocol's:
 *
 *  * `c` `e` `m` — the three columns of `user_settings`.
 *  * `p` — **privacy**, which is `user_profile.invite_opt_out` and has been
 *    since M22. Not copied into `user_settings`: a setting with two homes is a
 *    setting that will disagree with itself.
 *  * `g` — **language**, which is `user.locale` and has exactly one value. The
 *    button exists so the row is not the one dead thing on a board of live
 *    ones; it answers with a sentence rather than changing anything.
 *
 * `p` is sent as **what the reader sees** — «دریافت دعوت», the inverse of
 * `invite_opt_out` — because a button whose label and payload disagree is the
 * one place an inversion bug hides. The bot flips it once, at the write.
 */
export const SETTING_FIELDS = { c: 'notifyChat', e: 'notifyEvents', m: 'notifyCampaigns' } as const;
export type SettingFieldLetter = keyof typeof SETTING_FIELDS;

/** Privacy — `user_profile.invite_opt_out`, carried as its positive reading. */
export const SETTING_PRIVACY = 'p';
/** Language — `user.locale`, which the product has exactly one of. */
export const SETTING_LANGUAGE = 'g';
/** Finishing a profile, offered where the privacy switch would be if there were one. */
export const SETTING_PROFILE = 'n';

export const SETTING_LETTERS = [
  ...(Object.keys(SETTING_FIELDS) as SettingFieldLetter[]),
  SETTING_PRIVACY,
  SETTING_LANGUAGE,
  SETTING_PROFILE,
] as const;

export type SettingLetter = (typeof SETTING_LETTERS)[number];

export interface SettingCallback {
  field: SettingLetter;
  value: boolean;
}

/** Whether this letter names one of the three `user_settings` columns. */
export function isNotificationField(field: SettingLetter): field is SettingFieldLetter {
  return Object.hasOwn(SETTING_FIELDS, field);
}

const SETTING_PREFIX = 'st';

export function encodeSettingCallback(field: SettingLetter, value: boolean): string {
  return `${SETTING_PREFIX}:${field}${value ? '1' : '0'}:x`;
}

export function parseSettingCallback(data: string): SettingCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action] = parts;
  if (prefix !== SETTING_PREFIX || action === undefined || action.length !== 2) return null;

  const field = SETTING_LETTERS.find((candidate) => candidate === action.slice(0, 1));
  const value = action.slice(1);
  if (field === undefined) return null;
  if (value !== '0' && value !== '1') return null;

  return { field, value: value === '1' };
}

/**
 * The moderation protocol: `ad:<action>:<case id | x>` (v0.6.3, ADR-0018).
 *
 * ── Why moderation gets its own namespace ───────────────────────────────────
 *
 * For the reason every other prefix here exists, and one more. The ids are
 * **moderation case ids**, which are neither a participant, a chat, an event nor
 * a report — a parser that accepted two of those would be one mistake away from
 * passing a case id where an event id belongs, and the service on the other side
 * of that mistake decides content.
 *
 * The one more: these buttons are the only ones in the product that appear under
 * a **staff** screen, and keeping them behind their own prefix means the bot's
 * dispatcher can answer "is this an admin action?" before it looks at anything
 * else. Every `ad:` callback resolves an admin session first and refuses without
 * one — and the refusal is the same sentence an unknown button gets, so a
 * stranger who guesses the prefix learns nothing.
 *
 * **Authorisation is not in the button**, as everywhere else and more so here:
 * `AdminOperationsService` asserts `event.moderate` in the service layer
 * (invariant 12), so a tampered id names a case the service refuses.
 *
 * `list` carries no id and spends the slot on `x`, because the three-part shape
 * is what every parser in this file expects.
 */
export const ADMIN_CALLBACK_ACTIONS = ['list', 'open'] as const;
export type AdminCallbackAction = (typeof ADMIN_CALLBACK_ACTIONS)[number];

export interface AdminCallback {
  action: AdminCallbackAction;
  /** A moderation case id for `open`; null for `list`. */
  id: string | null;
}

const ADMIN_PREFIX = 'ad';
const NO_ID = 'x';

export function encodeAdminCallback(action: AdminCallbackAction, id: string | null): string {
  const data = `${ADMIN_PREFIX}:${action}:${id ?? NO_ID}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${String(MAX_BYTES)} bytes: ${data}`);
  }
  return data;
}

export function parseAdminCallback(data: string): AdminCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action, id] = parts;
  if (prefix !== ADMIN_PREFIX || id === undefined) return null;
  if (!ADMIN_CALLBACK_ACTIONS.some((candidate) => candidate === action)) return null;

  if (action === 'list') return id === NO_ID ? { action: 'list', id: null } : null;
  return isPublicId(id) ? { action: 'open', id } : null;
}

/**
 * The code-entry protocol: `cd:<kind>:x` (v0.6.4).
 *
 * ── Why a button and not a command ──────────────────────────────────────────
 *
 * Both codes this product hands people were, until now, typed as syntax. A gift
 * code was `/gift ABCD1234` — a command with an argument, known only to somebody
 * who had read `/help` — and a referral code was worse: `?start=<code>` on a
 * link was the *only* way in, so a code read out loud, written on a flyer or
 * forwarded as plain text could not be entered at all. That is the same shape
 * the settings board was fixed out of, one step further along: not advice that
 * asks somebody to type something, but a feature that exists only if they do.
 *
 * These two buttons open the form instead. They carry no id and no code — the
 * code is typed into the wizard, not into a keyboard — so the value slot spends
 * `x` like `ad:list` does, because the three-part shape is what every parser in
 * this file expects.
 *
 * **The code is deliberately not in the callback.** A gift code is worth coins,
 * `callback_data` rides in a message that survives in the chat and in anybody's
 * screenshot of it, and a button carrying a redeemable code would be a code
 * anybody who saw the screen could spend.
 *
 * Authorisation is not in the button, as everywhere else: opening a form grants
 * nothing, and `GiftCodeService.redeem` and `ReferralService.claim` refuse on
 * their own terms — an unknown code, one already used, one that is the caller's
 * own.
 */
export const CODE_CALLBACK_KINDS = ['gift', 'ref'] as const;
export type CodeCallbackKind = (typeof CODE_CALLBACK_KINDS)[number];

const CODE_PREFIX = 'cd';

export function encodeCodeCallback(kind: CodeCallbackKind): string {
  return `${CODE_PREFIX}:${kind}:${NO_ID}`;
}

export function parseCodeCallback(data: string): CodeCallbackKind | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, kind, id] = parts;
  if (prefix !== CODE_PREFIX || id !== NO_ID) return null;
  return CODE_CALLBACK_KINDS.find((candidate) => candidate === kind) ?? null;
}

/**
 * «بررسی دوباره» on the channel-join screen (v0.6.5).
 *
 * The gate used to be a message with join links and nothing else, so a user who
 * joined every channel had no way to tell the bot they had — they had to guess
 * that repeating whatever they were doing would now work, and the membership
 * probe's cache meant that for the next couple of minutes it would not. A gate
 * with no way to clear it is a wall.
 *
 * Carries nothing. Which channels are outstanding is a question about the caller
 * and the configuration, both of which the service reads; a list in the button
 * would be a stale list the moment an operator adds one.
 */
const CHANNEL_PREFIX = 'cg';

export function encodeChannelRecheckCallback(): string {
  return `${CHANNEL_PREFIX}:recheck:${NO_ID}`;
}

export function isChannelRecheckCallback(data: string): boolean {
  return data === encodeChannelRecheckCallback();
}

// ─────────────────────────────────────────────────────────────────────────────
// The command menu (`mn:`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a menu tap goes.
 *
 * Three shapes rather than a free-form string, so a tampered payload lands on a
 * dead button instead of somewhere unintended: `mn:root` redraws the top level,
 * `mn:g:<key>` opens one group, and `mn:c:<command>` runs a command. Nothing
 * here carries a public id — the menu is about the bot, not about a row — which
 * is why this decoder validates against the two lists rather than `isPublicId`.
 */
export type MenuCallback =
  { kind: 'root' } | { kind: 'group'; key: string } | { kind: 'command'; command: string };

const MENU_PREFIX = 'mn';

export function encodeMenuRoot(): string {
  return `${MENU_PREFIX}:root`;
}

export function encodeMenuGroup(key: string): string {
  return `${MENU_PREFIX}:g:${key}`;
}

export function encodeMenuCommand(command: string): string {
  return `${MENU_PREFIX}:c:${command}`;
}

/**
 * Read a menu tap, or null.
 *
 * The command is **not** checked against `BOT_COMMANDS` here — that would make
 * this module depend on `commands.ts` and the two are imported the other way
 * round by the keyboard builder. The caller dispatches through the same `switch`
 * every typed command goes through, which already answers «این فرمان را
 * نمی‌شناسم» for anything it does not know. So an invented command reaches
 * exactly the refusal a typed one would.
 */
export function decodeMenuCallback(data: string): MenuCallback | null {
  const parts = data.split(':');
  if (parts[0] !== MENU_PREFIX) return null;

  if (parts.length === 2 && parts[1] === 'root') return { kind: 'root' };
  if (parts.length !== 3) return null;

  const value = parts[2];
  if (value === undefined || value === '' || value.length > 32) return null;
  // Same alphabet `setMyCommands` accepts, and the group keys are a subset of it.
  if (!/^[a-z0-9_]+$/.test(value)) return null;

  if (parts[1] === 'g') return { kind: 'group', key: value };
  if (parts[1] === 'c') return { kind: 'command', command: value };
  return null;
}
