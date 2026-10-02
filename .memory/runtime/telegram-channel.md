# The production channel — what the bot is allowed to do there

**Scope:** the channel `TELEGRAM_CHANNEL_ID` names, where the worker posts.
**Read when:** a channel post will not come down or will not update, the panel's
«انتشار در کانال» warning (`BOT_CANNOT_DELETE`) is up, or a change relies on
deleting or editing channel messages.

## Rights, as observed

On 2026-09-14 and again on 2026-10-02 the bot was an **administrator** of the
production channel with `can_post_messages`, `can_edit_messages` and
`can_delete_messages` all `true`, and `TELEGRAM_CHANNEL_ID` was set in the
production `.env`
`[validated: cmd getChatMember(<channel>, <bot id>) from the production host, 2026-10-02]`.

## The 48-hour limit holds even with «Delete messages»

**`can_delete_messages` does not lift it.** A bot cannot `deleteMessage` a channel
post older than 48 hours, admin or not: in production every post taken down past
that age was refused (`channel.post_undeletable`, youngest refused 54.5 h) and
every one under it was deleted (30 posts, 0 refused)
`[validated: cmd channel_post ⋈ audit_log on the production host, 2026-10-02]`.
Paid posts go up at registration, days before the activity, so a refused delete
is the **ordinary** case. An earlier version of this entry said the opposite;
through v0.22.0 the sweep marked such rows taken down and left the post — with its
«پایتم» button — in the channel.

`editMessageText` has no age limit (the capacity sweep edits two-week-old posts
with zero `UNEDITABLE`), so the sweep now edits a post it cannot delete into
`renderClosedChannelPost` — ended / re-published / withdrawn, no keyboard — and
only a post that refuses the edit too raises `BOT_CANNOT_DELETE`. That warning
therefore means the bot lost its rights or the channel, not age
`[validated: apps/worker/src/queues/processors.service.ts syncChannel]`.
Rows closed before the fix keep `deleted_at` and are not revisited.

## The required channels are a different question

`TELEGRAM_CHANNEL_ID` is where the bot **posts**; `required_channel` rows are what
users must **join**, and the bot needs to be an administrator of *each* of those
too, or `getChatMember` answers «member list is inaccessible» and the gate fails
open for that channel. On 2026-09-15 production had the requirement on over
`@paayatam` (bot admin) and `@paayatam_news` (bot **not** admin), so only the
first was enforced `[validated: cmd getChatMember(<each channel>, <bot id>) from
the production host, 2026-09-15]`. Since v0.16.0 the panel shows
`BOT_CANNOT_VERIFY` naming such channels, and the API logs a fail-open warning
once per channel per ten minutes `[validated: apps/api/src/telegram/membership.probe.ts]`.
Re-check with the command below, substituting each `chat_identifier` for `C`.

## Seats-line edits (v0.16.0)

The post's seats line counts accepted + PENDING and is edited whenever that
count changes, by `channel-capacity-sync` every minute with at most 8 edits per
pass — a burst on one activity is one edit, because the sweep compares counts
rather than replaying changes. `channel_post.rendered_taken` NULL (posts from
before 0058) means "edit once into the current format"
`[validated: packages/domain/src/channel/channel.service.ts findStaleCapacity]`.

## Re-checking without printing a secret

Run on the production host, from the deployment directory, reading both values
out of `.env` inside the command so neither reaches a terminal or a log:

```bash
T=$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- | tr -d "\"'")
C=$(grep -E '^TELEGRAM_CHANNEL_ID=' .env | cut -d= -f2- | tr -d "\"'")
curl -s "https://api.telegram.org/bot${T}/getChatMember" \
  --data-urlencode "chat_id=${C}" --data-urlencode "user_id=${T%%:*}" |
  python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",{}); print({k: r.get(k) for k in ("status","can_post_messages","can_edit_messages","can_delete_messages")})'
```

Read-only. Print the rights, never the response's `user` object wholesale into a
document, and never the token.
