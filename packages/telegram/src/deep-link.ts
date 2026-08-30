/**
 * The bot's own deep links: `https://t.me/<bot>?start=<action>_<public id>`.
 *
 * ── Why the channel needed a protocol of its own ────────────────────────────
 *
 * A channel post is read by people who may never have started the bot, and it is
 * the one surface in this product with **no session behind it**. A callback
 * button there is answerable — Telegram delivers `callback_query` from a channel
 * post to an admin bot — but the bot cannot *message* somebody who has never
 * opened a chat with it, so the acknowledgement, the host's notification and
 * every refusal would land nowhere. A `?start=` link cannot have that problem:
 * following one opens the chat, which is what makes the reply deliverable.
 *
 * It also survives the case the callback cannot: a post forwarded out of the
 * channel keeps working, because the link carries everything and the message
 * carries nothing.
 *
 * ── The charset is Telegram's, and it is checked ────────────────────────────
 *
 * `start` accepts 1–64 characters of `A-Za-z0-9_-` and nothing else. A UUID is
 * 36 of them including its hyphens, so `join_<uuid>` is 41 — comfortably inside.
 * `encodeStartPayload` throws rather than emit something Telegram would refuse,
 * for the same reason `encodeChatCallback` does: a button that fails at send
 * time is a post nobody can act on, discovered by a reader rather than by us.
 *
 * ── Authorisation is not in the link ────────────────────────────────────────
 *
 * Exactly as with `callback_data`: the payload arrives from a client and names a
 * **public** id, so the worst a tamperer can do is name a resource the service
 * layer refuses on its own — an unpublished event, a full one, their own. What
 * the link decides is which screen opens, never who may open it.
 */

/**
 * What a `?start=` payload can ask for.
 *
 * `event` opens the activity in the bot; `join` asks to join it. Two actions
 * rather than one screen with a button, because the channel post's «شرکت
 * می‌کنم» is a decision the reader has already made — sending them to a detail
 * screen to press a second button would be the detour the button exists to
 * remove.
 */
export const START_ACTIONS = ['event', 'join'] as const;
export type StartAction = (typeof START_ACTIONS)[number];

export interface StartLink {
  action: StartAction;
  /** An event public id. Both actions are about an event. */
  id: string;
}

/** Telegram's own rule for `start`: 1–64 of these characters. */
const START_PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;

/** Public ids are UUIDs; anything else is a tampered or truncated link. */
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeStartPayload(action: StartAction, publicId: string): string {
  const payload = `${action}_${publicId}`;
  if (!START_PAYLOAD.test(payload)) {
    throw new Error(`start payload is not a payload Telegram accepts: ${payload}`);
  }
  return payload;
}

/** The full link, for a button's `url`. */
export function botStartUrl(botUsername: string, payload: string): string {
  return `https://t.me/${botUsername}?start=${payload}`;
}

/**
 * A `/start` payload, or null when it is not one of ours.
 *
 * Null rather than a throw, and null for **anything unrecognised**: `/start`
 * also carries referral codes, which are a different alphabet entirely, and the
 * caller tries this first and falls through to the referral claim. A payload
 * that is neither is somebody's old link, and the honest answer to it is the
 * welcome.
 */
export function parseStartPayload(payload: string): StartLink | null {
  const separator = payload.indexOf('_');
  if (separator < 0) return null;

  const action = START_ACTIONS.find((candidate) => candidate === payload.slice(0, separator));
  if (action === undefined) return null;

  const id = payload.slice(separator + 1);
  return PUBLIC_ID.test(id) ? { action, id } : null;
}
