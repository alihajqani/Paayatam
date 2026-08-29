/**
 * The wizard button protocol (ADR-0017).
 *
 * Telegram allows **64 bytes** of `callback_data`, and this shares that budget
 * with `chat:` under a separate prefix. The shape is `wz:<action>:<value>`, and
 * the encoder throws rather than emit something Telegram would refuse — a button
 * that fails to send is a step a user cannot get past.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 *
 * **No draft id.** A wizard callback names a step and a value and nothing else;
 * the draft is looked up by the authenticated sender's own id, because
 * `conversation_state.user_id` is UNIQUE. So the question "can user A advance
 * user B's wizard?" is answered by there being nothing in the button that could
 * name B. That is stronger than checking ownership after decoding, which is the
 * check people forget to write.
 *
 * `callback_data` is untrusted input either way: a tampered value must fail the
 * parse rather than reach a service, and `chat:`'s rule that authorisation is
 * never in the button is unchanged here.
 *
 * ── The widest value ─────────────────────────────────────────────────────────
 *
 * `wz:city:<uuid>` is 45 bytes, the longest this protocol emits. Step keys are
 * chosen short for the same reason.
 */

const PREFIX = 'wz';
const MAX_BYTES = 64;

/**
 * Control actions, which every step may emit, versus data actions, which carry a
 * value chosen at that step.
 *
 * One namespace because they arrive through one `callback_query`, and splitting
 * them would mean two parsers agreeing on a prefix.
 */
export const WIZARD_CONTROLS = [
  'back',
  'skip',
  'cancel',
  'confirm',
  'goto',
  'page',
  /** The consent gate's two verbs: «می‌پذیرم» and «بررسی دوباره». */
  'agree',
  'recheck',
  /** «افزودن جزئیات بیشتر» on a summary. */
  'details',
] as const;
export type WizardControl = (typeof WIZARD_CONTROLS)[number];

export interface WizardCallback {
  /** A control action, or the key of the step this value answers. */
  action: string;
  /** Empty for controls that carry nothing, such as `back`. */
  value: string;
}

/** Step keys and control names: short, lowercase, no separator collision. */
const TOKEN = /^[a-z0-9_]{1,16}$/;

/**
 * Values a button may carry.
 *
 * Permissive by shape rather than by meaning — a uuid, a date, a slug, an
 * integer — because the *step* knows which of those it expects and validates
 * there. What this refuses is anything that could break the encoding or the
 * 64-byte budget: a colon would make the decode ambiguous.
 */
const VALUE = /^[A-Za-z0-9_\-.]{0,40}$/;

export function encodeWizardCallback(callback: WizardCallback): string {
  const { action, value } = callback;
  if (!TOKEN.test(action)) throw new Error(`wizard callback action is not a token: ${action}`);
  if (!VALUE.test(value)) throw new Error(`wizard callback value is not encodable: ${value}`);

  const encoded = `${PREFIX}:${action}:${value}`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) {
    throw new Error(`wizard callback exceeds ${String(MAX_BYTES)} bytes: ${encoded}`);
  }
  return encoded;
}

/**
 * Decode, or null.
 *
 * Null for anything that is not ours — the chat protocol's buttons arrive at the
 * same handler — and for anything malformed, which is the same answer a tampered
 * value gets. The caller says «این دکمه دیگر کار نمی‌کند», true for both an old
 * build's button and a forged one, and indistinguishable to whoever pressed it.
 */
export function parseWizardCallback(data: string): WizardCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;

  const [prefix, action, value] = parts as [string, string, string];
  if (prefix !== PREFIX) return null;
  if (!TOKEN.test(action) || !VALUE.test(value)) return null;

  return { action, value };
}

/** Whether a decoded action is one of the control verbs rather than a step key. */
export function isWizardControl(action: string): action is WizardControl {
  return (WIZARD_CONTROLS as readonly string[]).includes(action);
}
