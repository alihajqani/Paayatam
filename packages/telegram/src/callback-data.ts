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
 * public id and `close` carries a **chat** public id — the host decides from inside
 * the conversation, which is why all three live under `chat:`.
 */

export const CHAT_CALLBACK_ACTIONS = ['accept', 'reject', 'close'] as const;
export type ChatCallbackAction = (typeof CHAT_CALLBACK_ACTIONS)[number];

export interface ChatCallback {
  action: ChatCallbackAction;
  /** A participant public id for accept/reject, a chat public id for close. */
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
