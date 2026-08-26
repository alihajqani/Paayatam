import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, GrammyError } from 'grammy';
import type { Env } from '@payetam/config';
import { CLOCK, type Clock, ENV, redact } from '@payetam/platform';

/** How loud an alert is. Chooses the marker, and whether it is sent at all. */
export type AlertLevel = 'info' | 'warn' | 'error';

/** Ordered, so `MONITORING_MIN_LEVEL` is a comparison rather than a list. */
const LEVEL_RANK: Record<AlertLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * Operational alerts, into a Telegram group (M20, extended in M22 phase 7).
 *
 * The problem it solves is narrow and real: this deployment is one VPS with no
 * log aggregator and no pager. Structured JSON on stdout is the right thing to
 * write and nobody reads it at 3 a.m. — so the small number of events that
 * genuinely need a human are pushed to a group the operators are already in.
 *
 * ── Six rules, and each one is load-bearing ──────────────────────────────────
 *
 * **1. It is not a log sink.** Only things a person should act on: a job that
 * exhausted its retries, a campaign that paused itself, a coin ledger that no
 * longer reconciles, a failed backup. Everything else stays in the structured
 * log, where it can be searched without also being an interruption. A channel
 * that fires on the ordinary is a channel people mute, and a muted alert channel
 * is worse than none — it looks like coverage.
 *
 * **2. Every alert is throttled per key.** The failure this exists for is a queue
 * that has started failing *every* job: without a floor, the alerting path becomes
 * the amplifier, the group fills with one repeated line, Telegram rate limits the
 * bot, and the next incident is the one nobody hears about. The suppressed count
 * rides along on the next alert, so the throttle hides the repetition without
 * hiding the scale.
 *
 * **3. It sends directly, not through the queue.** Every other outbound Telegram
 * call in this product goes through `telegram-send` and its rate limiter
 * (ADR-0005, invariant 11), and that is right for user-facing messages. It is
 * exactly wrong here: the most important alert this will ever send is *"the queue
 * is broken"*, and routing it through the queue means it is not delivered
 * precisely when it is needed. The volume is bounded by the throttle above, so it
 * cannot meaningfully compete for Telegram's budget.
 *
 * **4. It cannot fail its caller.** Every path returns rather than throws. An
 * alert that turned a recorded job failure into an unhandled rejection would make
 * monitoring the outage.
 *
 * **5. It cannot alert about itself, and it cannot flood.** A delivery failure is
 * written to the local log and never re-entered as an alert — a Telegram outage
 * that generated a Telegram alert per failed Telegram alert is an unbounded loop
 * pointed at the one dependency that is already unwell. That much is structural:
 * `send`'s catch block calls the logger and nothing else. On top of it sits a
 * **global budget** — at most `GLOBAL_ALERT_BUDGET` alerts per window across every
 * key — because the per-key throttle bounds one noisy source and not a hundred
 * quiet ones failing at once (M22 phase 7).
 *
 * **6. What it sends is structured and redacted.** Severity, service,
 * environment, timestamp and correlation id on every alert, `redact()` over every
 * field, and no raw request body — the group may have people in it who are not
 * administrators of this system.
 *
 * Disabled — silently, and with no other behaviour changed — when
 * `MONITORING_CHAT_ID` is unset, the bot token is unset, or `MONITORING_ENABLED`
 * is off. In every one of those cases the alert is **written to the local log
 * instead**, so nothing is lost: a deployment without an alerting group is a worse
 * deployment, not a blind one.
 */
@Injectable()
export class TelegramLoggerService {
  private readonly logger = new Logger(TelegramLoggerService.name);
  private readonly bot: Bot | null;
  private readonly chatId: string | undefined;
  private readonly cooldownMs: number;
  private readonly minLevel: AlertLevel;
  private readonly environment: string;
  private readonly service: string;

  /**
   * The global budget, and what it has turned away.
   *
   * The per-key throttle answers "one queue is failing every job". This answers
   * the other shape: **a hundred different keys firing at once**, which is what a
   * database outage looks like from here — every sweep, every job and every health
   * check failing for the same reason under a different name. Without a ceiling
   * the group fills, Telegram rate-limits the bot, and the next incident is the
   * one nobody hears about.
   *
   * Overflow is counted rather than dropped silently, and reported on the first
   * alert of the next window.
   */
  private budget = { startedAt: 0, sent: 0, overflowed: 0 };

  /**
   * When each key last got through, and what has been suppressed since.
   *
   * A plain `Map`, deliberately not Redis. Redis is one of the dependencies whose
   * failure this is most needed to report, and a throttle that needs the broken
   * thing in order to complain about it is not a throttle. The cost of keeping it
   * in memory is that two replicas would each send once per window — which is the
   * correct trade here, and there is one worker anyway.
   */
  private readonly lastSent = new Map<string, { at: number; suppressed: number }>();

  constructor(
    @Inject(ENV) env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.chatId = env.MONITORING_CHAT_ID;
    this.cooldownMs = env.MONITORING_ALERT_COOLDOWN_SECONDS * 1000;
    this.minLevel = env.MONITORING_MIN_LEVEL;
    this.environment = env.MONITORING_ENVIRONMENT ?? env.NODE_ENV;
    this.service = 'worker';

    const token = env.TELEGRAM_BOT_TOKEN;
    const configured =
      token !== undefined && token !== '' && this.chatId !== undefined && this.chatId !== '';

    if (!configured || !env.MONITORING_ENABLED) {
      this.bot = null;
      // Logged once at construction rather than on every suppressed alert, so the
      // absence is discoverable without being noise. The two reasons are reported
      // separately because they have different fixes.
      this.logger.log(
        env.MONITORING_ENABLED
          ? 'Telegram alerting is off (MONITORING_CHAT_ID or the bot token is unset) — alerts go to the local log'
          : 'Telegram alerting is switched off (MONITORING_ENABLED=0) — alerts go to the local log',
      );
      return;
    }

    /**
     * Its own `Bot`, not the `TelegramClient` the queues use.
     *
     * `TelegramClient` carries the `auto-retry` plugin, which sleeps for however
     * long a 429 asks for. That is right for a notification somebody is waiting on
     * and wrong for an alert: an alert that arrives eleven minutes late has
     * already been overtaken by the incident. This one tries once and gives up.
     */
    this.bot = new Bot(token);
    this.logger.log(`Telegram alerting is on (min level ${this.minLevel})`);
  }

  /**
   * Send one alert, unless the same key was alerted about recently.
   *
   * @param key   what is being alerted about — `queue:telegram-send`, not the
   *              message text. Two different failures of the same thing share a
   *              key on purpose; that is what makes the throttle work.
   * @param level chooses the marker, and is compared against `MONITORING_MIN_LEVEL`
   * @param title one short line
   * @param fields optional detail, redacted before it is sent
   */
  alert(key: string, level: AlertLevel, title: string, fields: Record<string, unknown> = {}): void {
    // Below the floor: it stays in the structured log, which is where an
    // informational line belongs.
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const now = this.clock.now().getTime();
    const previous = this.lastSent.get(key);

    if (previous !== undefined && now - previous.at < this.cooldownMs) {
      previous.suppressed += 1;
      return;
    }

    const suppressed = previous?.suppressed ?? 0;
    this.lastSent.set(key, { at: now, suppressed: 0 });

    const overflowed = this.claimBudget(now);
    if (overflowed === null) {
      // Over the ceiling. Logged locally, counted, and reported on the first alert
      // of the next window — the budget hides volume, never the fact of it.
      this.logger.error(`Alert budget exhausted; not sent (${key}): ${title}`);
      return;
    }

    const text = this.compose(key, level, title, fields, suppressed, overflowed);

    if (this.bot === null || this.chatId === undefined) {
      // Not configured, or switched off. **Logged locally rather than dropped** —
      // an alert that vanishes because nobody set up a group is an incident nobody
      // hears about (M22 phase 7).
      this.logger[level === 'error' ? 'error' : 'warn'](text.replaceAll('\n', ' | '));
      return;
    }

    // Fire and forget, with the rejection handled inside. `void` on a promise
    // whose failure is unhandled is how a monitoring call takes down the process
    // it was monitoring.
    void this.send(text);
  }

  /**
   * The message body.
   *
   * `redact()` is the same function the logger runs everything through (M15), so
   * an alert carrying a failed job's payload cannot put a Telegram id or a token
   * into a group chat. That matters more here than in the log: the group may have
   * people in it who are not administrators of this system.
   *
   * The five structured lines are fixed and always present (M22 phase 7):
   * severity, service, environment, the key as a stable error code, and the time.
   * A correlation id is added when the caller has one. An alert without those is
   * an alert somebody has to reconstruct the context of.
   *
   * Plain text, never HTML or Markdown. An error message containing `<` would be
   * rejected by Telegram's parser — which is to say the parse mode would fail
   * exactly on the alerts that are most worth delivering.
   */
  private compose(
    key: string,
    level: AlertLevel,
    title: string,
    fields: Record<string, unknown>,
    suppressed: number,
    overflowed: number,
  ): string {
    const marker = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : '🟢';
    const lines = [
      `${marker} ${title}`,
      `severity: ${level}`,
      `service: ${this.service}`,
      `env: ${this.environment}`,
      // The throttle key doubles as the stable, machine-readable code for what
      // this is — searchable across alerts, and never free text.
      `code: ${key}`,
    ];

    const safe = redact(fields) as Record<string, unknown>;
    for (const [name, value] of Object.entries(safe)) {
      lines.push(`${name}: ${format(value)}`);
    }

    lines.push(`time: ${this.clock.now().toISOString()}`);
    if (suppressed > 0) {
      // The throttle hides repetition, not scale.
      lines.push(`(${String(suppressed)} similar alert(s) suppressed since the last one)`);
    }
    if (overflowed > 0) {
      lines.push(`(${String(overflowed)} alert(s) dropped by the budget in the previous window)`);
    }

    // Telegram refuses anything over 4096 characters, and a truncated alert beats
    // a rejected one — a stack trace in `fields` is how that limit is hit.
    const text = lines.join('\n');
    return text.length > 3900 ? `${text.slice(0, 3900)}\n…(truncated)` : text;
  }

  /**
   * Take one from the global budget, or refuse.
   *
   * Returns how many the *previous* window dropped, so the first alert through
   * carries the number — and `null` when this one is over the ceiling.
   */
  private claimBudget(now: number): number | null {
    if (now - this.budget.startedAt >= GLOBAL_BUDGET_WINDOW_MS) {
      const overflowed = this.budget.overflowed;
      this.budget = { startedAt: now, sent: 1, overflowed: 0 };
      return overflowed;
    }

    if (this.budget.sent >= GLOBAL_ALERT_BUDGET) {
      this.budget.overflowed += 1;
      return null;
    }

    this.budget.sent += 1;
    return 0;
  }

  private async send(text: string): Promise<void> {
    if (this.bot === null || this.chatId === undefined) return;

    try {
      await this.bot.api.sendMessage(this.chatId, text, {
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      // Warn, not error, and with a reason a reader can act on. The two that
      // actually happen are a chat id that is wrong (400) and a bot that was never
      // added to the group (403), and both are configuration rather than incidents.
      //
      // **Never re-raised as an alert** (rule 5): the alert about a failed alert
      // would fail the same way, forever.
      const reason =
        error instanceof GrammyError
          ? `${String(error.error_code)}: ${error.description}`
          : String(error);
      this.logger.warn(`Could not deliver an alert to ${this.chatId}: ${reason}`);
      // The alert itself, locally, so the incident is not lost with its delivery.
      // **`this.logger`, never `this.alert`** — that is rule 5, and it is the whole
      // of the loop protection that matters.
      this.logger.warn(text.replaceAll('\n', ' | '));
    }
  }
}

/**
 * The ceiling, and the window it applies over.
 *
 * Twenty in five minutes. A real incident produces a handful of distinct alerts;
 * twenty distinct ones in five minutes means something systemic, and at that point
 * the group has already been told — more messages add volume rather than
 * information, and the risk of the bot being rate-limited outweighs the
 * twenty-first line.
 */
const GLOBAL_ALERT_BUDGET = 20;
const GLOBAL_BUDGET_WINDOW_MS = 5 * 60 * 1000;

/** One field, on one line. Objects are JSON so a nested payload stays readable. */
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      // `JSON.stringify` returns undefined for a bare function or a symbol,
      // which would print the word "undefined" where a field used to be.
      return JSON.stringify(value) ?? '[unserialisable]';
    } catch {
      // A circular payload. Reachable: a failed job's data can hold anything.
      return '[unserialisable]';
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // A symbol or a function. Named rather than stringified, because
  // `String(Symbol())` throws and `String(fn)` prints the source.
  return `[${typeof value}]`;
}
