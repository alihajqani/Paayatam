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
  /**
   * Any other `/command`. Named so it is never relayed into somebody's chat.
   *
   * `argument` is whatever followed the command name, trimmed, or null. It was
   * parsed and thrown away until `/gift <code>` needed it — `/start` kept its
   * payload and nothing else could take one, so redeeming a code had no way to
   * carry the code. Null rather than an empty string, so «they typed nothing»
   * and «they typed spaces» are the same case for every handler.
   */
  | {
      kind: 'COMMAND';
      from: BotSender;
      command: string;
      argument: string | null;
      /**
       * The user's own message, so a handler can take it back out of the chat.
       *
       * One reader: `/event_…`, whose detail screen carries a «بازگشت به فهرست»
       * that deletes the activity *and the command that opened it*, so the list
       * becomes the last thing in the conversation again. Nothing else in the
       * update names that message, and the button that will delete it is built
       * before the message could be looked up any other way.
       */
      messageId?: number;
    }
  /** Plain text in the bot's DM: a chat message, once we know which chat. */
  | { kind: 'TEXT'; from: BotSender; message: BotInboundText; replyToMessageId: number | null }
  /** The sender edited a message they had already sent (D10). */
  | { kind: 'EDITED_TEXT'; from: BotSender; message: BotInboundText }
  /**
   * A photo, in a private chat.
   *
   * Split out of `UNSUPPORTED` in v0.6.5 for exactly one consumer: the
   * bug-report form, whose whole value is the screenshot attached to it. Every
   * other surface still refuses a photo — `BotService` answers `UNSUPPORTED`'s
   * Persian sentence when no bug report is open — so criterion 11 is unchanged
   * for the chat relay, which is what it was written about.
   *
   * `fileId` is Telegram's handle for the **largest** rendition it offered. The
   * bytes are never fetched: they stay on Telegram's servers and the product
   * stores a handle scoped to its own bot token.
   */
  | { kind: 'PHOTO'; from: BotSender; fileId: string; caption?: string }
  /** A sticker, a voice note, a document — anything this version refuses (criterion 11). */
  | { kind: 'UNSUPPORTED'; from: BotSender }
  /**
   * An inline-keyboard tap. `data` is opaque here; `callback-data.ts` reads it.
   *
   * `messageId` is the message the keyboard is attached to, when Telegram sent
   * one — it omits the field for a button on a message too old to be edited, and
   * for an inline-mode result. It is what lets a handler **redraw** the screen
   * that was tapped instead of sending another one below it, which is how the
   * discovery filters stopped producing a new list per tap.
   */
  | {
      kind: 'CALLBACK';
      from: BotSender;
      callbackQueryId: string;
      data: string;
      messageId?: number;
    }
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

/**
 * One rendition of a photo. Telegram sends several sizes of the same image.
 *
 * Only the id and the pixel count are parsed: `file_size` and `file_unique_id`
 * are not needed to choose between them, and a field that is read is a field
 * that has to be kept true.
 */
const photoSize = z.object({
  file_id: z.string().min(1),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});

const message = z.object({
  message_id: z.number().int(),
  from: sender.optional(),
  chat,
  text: z.string().optional(),
  entities: z.array(entity).optional(),
  /** Every rendition Telegram offered, smallest first. See `largestPhoto`. */
  photo: z.array(photoSize).optional(),
  /** The words under a photo, when the sender wrote any. */
  caption: z.string().optional(),
  /** Only the id. Who wrote it is answered from our own rows, not from Telegram's. */
  reply_to_message: z.object({ message_id: z.number().int() }).optional(),
});

/**
 * The biggest rendition Telegram offered, or null.
 *
 * Biggest rather than first, because the array is ordered smallest-first and a
 * thumbnail is not a screenshot anybody can read a button label off. Compared by
 * area rather than by position, so the choice does not depend on an ordering
 * Telegram documents but does not guarantee.
 */
function largestPhoto(sizes: readonly z.infer<typeof photoSize>[]): string | null {
  let best: z.infer<typeof photoSize> | null = null;
  for (const size of sizes) {
    if (best === null || size.width * size.height > best.width * best.height) best = size;
  }
  return best?.file_id ?? null;
}

const update = z.object({
  update_id: z.number().int(),
  message: message.optional(),
  edited_message: message.optional(),
  callback_query: z
    .object({
      id: z.string().min(1),
      from: sender,
      data: z.string().optional(),
      /**
       * Only the id and the chat type. The rest of the message is the bot's own
       * text coming back to it, and re-reading it would be trusting Telegram's
       * copy of something this process wrote.
       */
      message: z.object({ message_id: z.number().int(), chat: chat.optional() }).optional(),
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
    const messageId = parsed.callback_query.message?.message_id;
    return {
      kind: 'CALLBACK',
      from,
      callbackQueryId: parsed.callback_query.id,
      data: parsed.callback_query.data,
      ...(messageId !== undefined ? { messageId } : {}),
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

    /**
     * A photo, before the text branch, because a photo message carries no
     * `text` — it carries a `caption` — and would otherwise fall straight into
     * `UNSUPPORTED` and be refused.
     */
    if (parsed.message.photo !== undefined && parsed.message.photo.length > 0) {
      const fileId = largestPhoto(parsed.message.photo);
      if (fileId === null) return { kind: 'UNSUPPORTED', from };
      const caption = parsed.message.caption?.trim();
      return {
        kind: 'PHOTO',
        from,
        fileId,
        ...(caption !== undefined && caption !== '' ? { caption } : {}),
      };
    }

    const text = parsed.message.text;
    if (text === undefined) return { kind: 'UNSUPPORTED', from };

    const command = COMMAND.exec(text);
    if (command) {
      const name = command[1] ?? '';
      const rest = command[2]?.trim();
      const argument = rest === undefined || rest === '' ? null : rest;
      if (name.toLowerCase() !== 'start') {
        return {
          kind: 'COMMAND',
          from,
          command: name,
          argument,
          messageId: parsed.message.message_id,
        };
      }
      return { kind: 'START', from, payload: argument };
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
