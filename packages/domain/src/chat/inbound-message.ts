/**
 * The shape of an inbound Telegram text message, narrowed to what the relay is
 * allowed to look at.
 *
 * Deliberately *not* Telegram's `Message` type. A grammY `Message` carries
 * `from.id`, `from.username`, `forward_from`, `reply_to_message.from` and a dozen
 * other identity-bearing fields, and the single most dangerous thing this module
 * could do is pass one of those through to a recipient. Declaring the narrow
 * shape here means the relay physically cannot read a field nobody chose to give
 * it — the anonymity boundary becomes a type, not a discipline.
 *
 * Whoever adapts a real Telegram update into this shape (the bot, M13) is
 * therefore the one place that touches the wide object, and it hands over four
 * fields.
 */
export interface InboundTextMessage {
  /** The raw text as the sender typed it. */
  text: string;
  /**
   * Telegram's entity annotations.
   *
   * Carried only so they can be *examined and dropped*. `text_mention` is the
   * reason they cannot simply be ignored: it holds a `user` object with a raw
   * Telegram id, and it is the one entity whose payload is not recoverable from
   * the text.
   */
  entities?: readonly MessageEntity[];
  /**
   * Telegram's own message id, for edit and delete propagation (D10).
   *
   * Optional because the Mini App composes messages that have no Telegram
   * message behind them. Both surfaces go through the same sanitizer and the
   * same relay — that identity is what makes "the bot and the Mini App behave
   * the same" true by construction (plan §3.3) rather than by two code paths
   * being kept in step.
   */
  telegramMessageId?: number;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  /** Present on `text_link`. */
  url?: string;
  /** Present on `text_mention` — a whole user object, id included. */
  user?: { id: number; username?: string; first_name?: string };
}
