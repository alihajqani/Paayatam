import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, GrammyError } from 'grammy';
import type { Env } from '@payetam/config';
import { CLOCK, type Clock, ENV, redact } from '@payetam/platform';

/** How loud an alert is. Chooses the marker and nothing else. */
export type AlertLevel = 'info' | 'warn' | 'error';

/**
 * Operational alerts, into a Telegram group (M20).
 *
 * The problem it solves is narrow and real: this deployment is one VPS with no
 * log aggregator and no pager. Structured JSON on stdout is the right thing to
 * write and nobody reads it at 3 a.m. — so the small number of events that
 * genuinely need a human are pushed to a group the operators are already in.
 *
 * ── Four rules, and each one is load-bearing ─────────────────────────────────
 *
 * **1. It is not a log sink.** Only things a person should act on: a job that
 * exhausted its retries, a failed backup, a deploy that did not come back
 * healthy. Everything else stays in the structured log, where it can be searched
 * without also being an interruption. A channel that fires on the ordinary is a
 * channel people mute, and a muted alert channel is worse than none — it looks
 * like coverage.
 *
 * **2. Every alert is throttled per key.** The failure this exists for is a
 * queue that has started failing *every* job: without a floor, the alerting path
 * becomes the amplifier, the group fills with one repeated line, Telegram rate
 * limits the bot, and the next incident is the one nobody hears about. The
 * suppressed count rides along on the next alert, so the throttle hides the
 * repetition without hiding the scale.
 *
 * **3. It sends directly, not through the queue.** Every other outbound Telegram
 * call in this product goes through `telegram-send` and its rate limiter
 * (ADR-0005, invariant 11), and that is right for user-facing messages. It is
 * exactly wrong here: the most important alert this will ever send is *"the
 * queue is broken"*, and routing it through the queue means it is not delivered
 * precisely when it is needed. The volume is bounded by the throttle above, so
 * it cannot meaningfully compete for Telegram's budget.
 *
 * **4. It cannot fail its caller.** Every path returns rather than throws. An
 * alert that turned a recorded job failure into an unhandled rejection would
 * make monitoring the outage.
 *
 * Disabled — silently, and with no other behaviour changed — when
 * `MONITORING_CHAT_ID` or the bot token is unset. A deployment without an
 * alerting group is a worse deployment, not a broken one.
 */
@Injectable()
export class TelegramLoggerService {
  private readonly logger = new Logger(TelegramLoggerService.name);
  private readonly bot: Bot | null;
  private readonly chatId: string | undefined;
  private readonly cooldownMs: number;

  /**
   * When each key last got through, and what has been suppressed since.
   *
   * A plain `Map`, deliberately not Redis. Redis is one of the dependencies
   * whose failure this is most needed to report, and a throttle that needs the
   * broken thing in order to complain about it is not a throttle. The cost of
   * keeping it in memory is that two replicas would each send once per window —
   * which is the correct trade here, and there is one worker anyway.
   */
  private readonly lastSent = new Map<string, { at: number; suppressed: number }>();

  constructor(
    @Inject(ENV) env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.chatId = env.MONITORING_CHAT_ID;
    this.cooldownMs = env.MONITORING_ALERT_COOLDOWN_SECONDS * 1000;

    const token = env.TELEGRAM_BOT_TOKEN;
    if (token === undefined || token === '' || this.chatId === undefined || this.chatId === '') {
      this.bot = null;
      // Logged once at construction rather than on every suppressed alert, so
      // the absence is discoverable without being noise.
      this.logger.log('Telegram alerting is off (MONITORING_CHAT_ID or the bot token is unset)');
      return;
    }

    /**
     * Its own `Bot`, not the `TelegramClient` the queues use.
     *
     * `TelegramClient` carries the `auto-retry` plugin, which sleeps for however
     * long a 429 asks for. That is right for a notification somebody is waiting
     * on and wrong for an alert: an alert that arrives eleven minutes late has
     * already been overtaken by the incident. This one tries once and gives up.
     */
    this.bot = new Bot(token);
    this.logger.log('Telegram alerting is on');
  }

  /**
   * Send one alert, unless the same key was alerted about recently.
   *
   * @param key   what is being alerted about — `queue:telegram-send`, not the
   *              message text. Two different failures of the same thing share a
   *              key on purpose; that is what makes the throttle work.
   * @param level chooses the marker
   * @param title one short line
   * @param fields optional detail, redacted before it is sent
   */
  alert(key: string, level: AlertLevel, title: string, fields: Record<string, unknown> = {}): void {
    if (this.bot === null || this.chatId === undefined) return;

    const now = this.clock.now().getTime();
    const previous = this.lastSent.get(key);

    if (previous !== undefined && now - previous.at < this.cooldownMs) {
      previous.suppressed += 1;
      return;
    }

    const suppressed = previous?.suppressed ?? 0;
    this.lastSent.set(key, { at: now, suppressed: 0 });

    // Fire and forget, with the rejection handled here. `void` on a promise
    // whose failure is unhandled is how a monitoring call takes down the process
    // it was monitoring.
    void this.send(this.compose(level, title, fields, suppressed));
  }

  /**
   * The message body.
   *
   * `redact()` is the same function the logger runs everything through (M15), so
   * an alert carrying a failed job's payload cannot put a Telegram id or a token
   * into a group chat. That matters more here than in the log: the group may
   * have people in it who are not administrators of this system.
   *
   * Plain text, never HTML or Markdown. An error message containing `<` would be
   * rejected by Telegram's parser — which is to say the parse mode would fail
   * exactly on the alerts that are most worth delivering.
   */
  private compose(
    level: AlertLevel,
    title: string,
    fields: Record<string, unknown>,
    suppressed: number,
  ): string {
    const marker = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : '🟢';
    const lines = [`${marker} ${title}`];

    const safe = redact(fields) as Record<string, unknown>;
    for (const [name, value] of Object.entries(safe)) {
      lines.push(`${name}: ${format(value)}`);
    }

    lines.push(`time: ${this.clock.now().toISOString()}`);
    if (suppressed > 0) {
      // The throttle hides repetition, not scale.
      lines.push(`(${String(suppressed)} similar alert(s) suppressed since the last one)`);
    }

    // Telegram refuses anything over 4096 characters, and a truncated alert
    // beats a rejected one — a stack trace in `fields` is how that limit is hit.
    const text = lines.join('\n');
    return text.length > 3900 ? `${text.slice(0, 3900)}\n…(truncated)` : text;
  }

  private async send(text: string): Promise<void> {
    if (this.bot === null || this.chatId === undefined) return;

    try {
      await this.bot.api.sendMessage(this.chatId, text, {
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      // Warn, not error, and with a reason a reader can act on. The two that
      // actually happen are a chat id that is wrong (400) and a bot that was
      // never added to the group (403), and both are configuration rather than
      // incidents.
      const reason =
        error instanceof GrammyError
          ? `${String(error.error_code)}: ${error.description}`
          : String(error);
      this.logger.warn(`Could not deliver an alert to ${this.chatId}: ${reason}`);
    }
  }
}

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
