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
export const EVENT_CALLBACK_ACTIONS = ['join', 'cancel'] as const;
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
