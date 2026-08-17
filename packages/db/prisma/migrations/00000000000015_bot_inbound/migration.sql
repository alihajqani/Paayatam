-- Migration 0015: the bot's inbound half.
--
-- One index. Everything else the inbound handlers need already exists — which is
-- itself the finding: `/start`, the `callback_query` decisions, the `message:text`
-- relay, `edited_message` propagation and block detection are all built out of
-- tables and columns M2 and M8 wrote for exactly this purpose, and the reason none
-- of them worked is that nothing was wired to the webhook.
--
-- **What this index answers.** A user typing into the bot's DM names no chat: they
-- have one Telegram conversation standing in for all of theirs. Replying to a
-- relayed message does name one, implicitly — the quoted message is one we sent, and
-- `markSent` recorded what Telegram called it. So the lookup is "which notification
-- of this user's was Telegram message N?", and it runs once per inbound reply.
--
-- Scoped by `user_id` first, which is also the authorisation: an id from somebody
-- else's conversation finds nothing here, so a forged `reply_to_message` cannot
-- address a chat the sender is not in. `chat_message_source_idx` (M8) is the mirror
-- of this on the other direction, for edits.

CREATE INDEX "notification_delivered_idx"
    ON "notification" ("user_id", "telegram_message_id");
