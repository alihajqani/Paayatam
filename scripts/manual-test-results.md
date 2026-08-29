# Manual test — v0.4.0 conversation wizards

**Date:** 2026-08-29, 08:45 Tehran
**Branch:** `feature/bot-commands` @ `08475b2`
**Verdict: NOT READY FOR MERGE — one human step outstanding.** See §4.

---

## 1. The test that was asked for, and why it was not run

The release process asks for `make tunnel` + `make webhook`, then walking the
flows by hand in Telegram.

**That could not be run, and running it would have caused an incident.** The
`TELEGRAM_BOT_TOKEN` in `.env` is the **production** bot:

```
$ ./scripts/set-webhook.sh --info
==> Registered host      : app.paayatam.online
==> Pending updates      : 0
```

`make webhook` calls `setWebhook` on whatever token `.env` holds. It would have
re-pointed the live bot at a local tunnel — delivering real users' messages to a
laptop — and `scripts/set-webhook.sh` documents that a *failed* `setWebhook`
deletes the previous registration, which would leave production deaf until
somebody noticed.

A genuine manual test needs **a second bot, created in BotFather**, with its
token in a local `.env`. Creating one is a human action; nothing in this
repository can do it.

## 2. What was run instead

`pnpm bot-walkthrough` — a new tool (`tools/bot-walkthrough.ts`) that drives the
**real** step machine through the **real** renderer and prints the exact `text`
and inline keyboard of every screen. No database, no network.

Screens walked:

| Flow | Steps |
|---|---|
| Consent gate | the review screen, «می‌پذیرم», no «انصراف» |
| Jalali calendar | current month and next, with past days blanked |
| `/create_event` | all eleven core steps, then the summary |
| A refusal | a two-character title, re-rendered above the question |
| `/edit_profile` | name → gender → birth year, including the Jalali-year refusal |
| Templates | `BOT_CONSENT_ACCEPTED`, `BOT_EVENT_CREATED`, `BOT_HELP` as the worker sends them |

## 3. Bugs found and fixed

Both were found on the first run, and neither was visible to the 2672 automated
tests — which is the argument for the tool.

**1. The calendar's first row was seven blank buttons.** On the 7th of a month,
every day of the first week is in the past and rendered as a filler, so the
keyboard opened with a row of dead squares above the days you can actually pick.
Leading all-past weeks are now dropped. A keyboard row that answers nothing
teaches the reader that this keyboard has parts that do not work.

**2. Validation messages used Latin digits.** «نام فعالیت باید دست‌کم **3** نویسه
باشد» rendered directly beneath «گام ۱ از ۱۱». Every other number the product
shows a user is Persian. The unit test covering it was asserting the `3` — it had
encoded the bug — and now asserts «۳» *and* that no Latin digit appears.

Both fixed in `08475b2`. Suites re-run after: 1310 unit/component, 86 integration
across the two wizard files.

## 4. What is verified, and what is not

**Verified by the walkthrough and the automated suites:**

- Jalali conversion (Nowruz 1405 → 21 March 2026; Shahrivar 31 days, Mehr 30;
  the Tehran rollover at 21:00 UTC), the week beginning on شنبه, past days
  unselectable, month navigation both directions
- City paging over thirty options, «بعدی»/«قبلی» appearing only where they lead
  somewhere
- The summary's content, the fast path staying at eleven steps, the optional half
  behind «افزودن جزئیات بیشتر»
- Refusals rendered above the question in the same message
- The consent gate opening in place of a refused write, and one acceptance per
  redelivered tap
- `/edit_event` writing only fields the host answered — the 22:45→22:00 case
- Persian throughout, RTL text content, Persian digits

**Not verified, and not verifiable without a second bot:**

- How Telegram *draws* any of it: button wrapping on a narrow phone, whether a
  three-column keyboard reads right-to-left the way it does in this transcript,
  whether the calendar is thumb-sized
- That `editMessageText` actually lands on the right message and looks like an
  update rather than a new message
- Real tap latency, and whether the answer-then-redraw ordering feels right
- Any Telegram-side rejection the local renderer cannot predict

## 5. Verdict

**NOT READY FOR MERGE** — on the process as written, which requires a human
walkthrough in Telegram.

Everything that can be checked without a live bot has been checked and is green.
The outstanding step is one person, one BotFather token, twenty minutes:

```bash
# with a NEW bot's token in .env — never the production one
make dev && make tunnel && make webhook
# then in Telegram: /start → /create_event → walk it → /edit_event → /terms
```

If that walk is clean, this becomes READY and the merge can proceed. The
alternative — merging on the strength of the walkthrough alone — is a defensible
call, but it is a call about risk appetite and it is not mine to make.
