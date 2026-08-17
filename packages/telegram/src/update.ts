import { z } from 'zod';

/**
 * The one place in the product that touches a raw Telegram update (plan §6).
 *
 * `packages/domain/chat/inbound-message.ts` states the rule this file exists to
 * obey: *"Whoever adapts a real Telegram update into this shape is therefore the
 * one place that touches the wide object, and it hands over four fields."* An
 * update carries `from.id`, `from.username`, `forward_from`,
 * `reply_to_message.from`, `sender_chat`, `via_bot` and a dozen more
 * identity-bearing fields, and the single most dangerous thing the relay could do
 * is let one of them through to a recipient.
 *
 * **The narrowing is done by a parser, not by a cast.** Zod's default object
 * behaviour strips unknown keys, so every field not named below is *removed by
 * parsing* rather than merely left unread. `forward_from` cannot leak because it
 * does not survive `parseUpdate`, and the same is true of the next field Telegram
 * adds. A cast would have compiled to nothing and protected nothing.
 *
 * Note what is deliberately absent from the schema: `reply_to_message.from`. The
 * reply target is resolved by looking its id up in our own `notification` rows,
 * so knowing *who* the quoted message came from is unnecessary — and a field
 * nobody needs is a field that cannot leak.
 */

/**
 * The sender, narrowed to what identity creation needs.
 *
 * Structurally identical to `InitDataUser`, so `findOrCreateByTelegram` takes it
 * directly. Not imported from `@payetam/domain`: this package is depended on by
 * the worker and the API and depends on neither, and inverting that to borrow one
 * interface would drag Nest and Prisma into the message catalogue.
 */
export interface BotSender {
  telegramUserId: bigint;
  firstName?: string;
  username?: string;
  languageCode?: string;
}

/** Telegram's entity annotations, carried only so the sanitizer can drop them. */
export interface BotMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: { id: number; username?: string; first_name?: string };
}

/**
 * An inbound text, in the shape `ChatService.send` accepts.
 *
 * Field-for-field identical to the domain's `InboundTextMessage` and assignable to
 * it structurally, which is what keeps the anonymity boundary a type rather than a
 * convention.
 */
export interface BotInboundText {
  text: string;
  entities?: BotMessageEntity[];
  telegramMessageId?: number;
}

/**
 * What an update turned out to mean.
 *
 * A closed union rather than a `Message`: the API's handler switches on `kind` and
 * the compiler refuses a case it has not covered, so a new inbound surface cannot
 * be added and silently left unhandled.
 */
export type BotIntent =
  /** `/start`, with the deep-link payload when there is one. */
  | { kind: 'START'; from: BotSender; payload: string | null }
  /** Any other `/command`. Named so it is never relayed into somebody's chat. */
  | { kind: 'COMMAND'; from: BotSender; command: string }
  /** Plain text in the bot's DM: a chat message, once we know which chat. */
  | { kind: 'TEXT'; from: BotSender; message: BotInboundText; replyToMessageId: number | null }
  /** The sender edited a message they had already sent (D10). */
  | { kind: 'EDITED_TEXT'; from: BotSender; message: BotInboundText }
  /** A photo, sticker, voice note — anything this version refuses (criterion 11). */
  | { kind: 'UNSUPPORTED'; from: BotSender }
  /** An inline-keyboard tap. `data` is opaque here; `callback-data.ts` reads it. */
  | { kind: 'CALLBACK'; from: BotSender; callbackQueryId: string; data: string }
  /** The user blocked or unblocked the bot. */
  | { kind: 'BLOCK_CHANGED'; from: BotSender; blocked: boolean };

export interface ParsedUpdate {
  /**
   * Telegram's own update id.
   *
   * Monotonic and unique per bot, which makes it the natural idempotency key for
   * anything an update causes — Telegram redelivers an update whose webhook call
   * did not answer 200.
   */
  updateId: number;
  intent: BotIntent;
}

const sender = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

const chat = z.object({
  id: z.number().int(),
  type: z.string(),
});

const entity = z.object({
  type: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  url: z.string().optional(),
  user: z
    .object({
      id: z.number(),
      username: z.string().optional(),
      first_name: z.string().optional(),
    })
    .optional(),
});

const message = z.object({
  message_id: z.number().int(),
  from: sender.optional(),
  chat,
  text: z.string().optional(),
  entities: z.array(entity).optional(),
  /** Only the id. Who wrote it is answered from our own rows, not from Telegram's. */
  reply_to_message: z.object({ message_id: z.number().int() }).optional(),
});

const update = z.object({
  update_id: z.number().int(),
  message: message.optional(),
  edited_message: message.optional(),
  callback_query: z
    .object({
      id: z.string().min(1),
      from: sender,
      data: z.string().optional(),
    })
    .optional(),
  my_chat_member: z
    .object({
      chat,
      from: sender,
      new_chat_member: z.object({ status: z.string() }),
    })
    .optional(),
});

/** `/start payload` — the command, an optional bot mention, then the rest. */
const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;

/**
 * Narrow a webhook body into an intent, or return null.
 *
 * **Null is the common case and is not an error.** Telegram sends updates for
 * things this product has no opinion about — a post in our own channel, a poll
 * answer, a member joining a group somebody added the bot to — and every one of
 * them must be ignored quietly, because the webhook's contract is to answer 200
 * whatever it decides (ADR-0004).
 *
 * Takes `unknown`. The body arrives as parsed JSON from a request that proved it
 * knows two secrets, which is authentication and not validation: a malformed or
 * hostile update must produce null rather than a thrown error inside a handler.
 */
export function parseUpdate(raw: unknown): ParsedUpdate | null {
  const result = update.safeParse(raw);
  if (!result.success) return null;

  const parsed = result.data;
  const intent = intentOf(parsed);
  return intent === null ? null : { updateId: parsed.update_id, intent };
}

function intentOf(parsed: z.infer<typeof update>): BotIntent | null {
  if (parsed.callback_query) {
    const from = senderOf(parsed.callback_query.from);
    if (from === null || parsed.callback_query.data === undefined) return null;
    return {
      kind: 'CALLBACK',
      from,
      callbackQueryId: parsed.callback_query.id,
      data: parsed.callback_query.data,
    };
  }

  if (parsed.my_chat_member) {
    const from = senderOf(parsed.my_chat_member.from);
    // The bot is also a member of its own channel (M14), and that membership
    // changing is not somebody blocking us.
    if (from === null || parsed.my_chat_member.chat.type !== 'private') return null;
    // Telegram reports a block as the bot being kicked from the private chat.
    const status = parsed.my_chat_member.new_chat_member.status;
    if (status !== 'kicked' && status !== 'member') return null;
    return { kind: 'BLOCK_CHANGED', from, blocked: status === 'kicked' };
  }

  if (parsed.edited_message) {
    const from = senderOf(parsed.edited_message.from);
    if (from === null || parsed.edited_message.chat.type !== 'private') return null;
    // An edit that removed the text — a caption edit on a photo — has nothing to
    // propagate, and refusing it here is what keeps `editBySourceMessage` from
    // being asked to store an empty message.
    if (parsed.edited_message.text === undefined) return null;
    return { kind: 'EDITED_TEXT', from, message: inboundOf(parsed.edited_message) };
  }

  if (parsed.message) {
    const from = senderOf(parsed.message.from);
    if (from === null || parsed.message.chat.type !== 'private') return null;

    const text = parsed.message.text;
    if (text === undefined) return { kind: 'UNSUPPORTED', from };

    const command = COMMAND.exec(text);
    if (command) {
      const name = command[1] ?? '';
      if (name.toLowerCase() !== 'start') return { kind: 'COMMAND', from, command: name };
      const payload = command[2]?.trim();
      return {
        kind: 'START',
        from,
        payload: payload === undefined || payload === '' ? null : payload,
      };
    }

    return {
      kind: 'TEXT',
      from,
      message: inboundOf(parsed.message),
      replyToMessageId: parsed.message.reply_to_message?.message_id ?? null,
    };
  }

  return null;
}

/**
 * The sender, or null when there is nobody to attribute the update to.
 *
 * Another bot is refused rather than ignored later: a bot cannot have consented to
 * anything, and creating a user row for one would put an account in the product
 * that no human can be asked about.
 */
function senderOf(from: z.infer<typeof sender> | undefined): BotSender | null {
  if (from === undefined || from.is_bot === true) return null;
  return {
    telegramUserId: BigInt(from.id),
    ...(from.first_name !== undefined ? { firstName: from.first_name } : {}),
    ...(from.username !== undefined ? { username: from.username } : {}),
    ...(from.language_code !== undefined ? { languageCode: from.language_code } : {}),
  };
}

function inboundOf(parsed: z.infer<typeof message>): BotInboundText {
  return {
    text: parsed.text ?? '',
    ...(parsed.entities !== undefined ? { entities: parsed.entities.map(entityOf) } : {}),
    telegramMessageId: parsed.message_id,
  };
}

/**
 * One entity, rebuilt field by field.
 *
 * Absent keys are *omitted* rather than set to `undefined`, which is what
 * `exactOptionalPropertyTypes` asks for and what keeps this shape assignable to the
 * domain's `MessageEntity` without a cast. The `user` object is rebuilt for the
 * same reason it exists at all: a `text_mention` carries a third party's raw
 * Telegram id, and the sanitizer needs to see it in order to drop it.
 */
function entityOf(parsed: z.infer<typeof entity>): BotMessageEntity {
  return {
    type: parsed.type,
    offset: parsed.offset,
    length: parsed.length,
    ...(parsed.url !== undefined ? { url: parsed.url } : {}),
    ...(parsed.user !== undefined
      ? {
          user: {
            id: parsed.user.id,
            ...(parsed.user.username !== undefined ? { username: parsed.user.username } : {}),
            ...(parsed.user.first_name !== undefined ? { first_name: parsed.user.first_name } : {}),
          },
        }
      : {}),
  };
}
