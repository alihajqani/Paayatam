import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@payetam/config';
import { FakeClock } from '@payetam/platform';
import { TelegramLoggerService } from './telegram-logger.service';

/**
 * The bot is replaced rather than mocked at the network layer, because what
 * these tests are about is *when* a message is sent and *what is in it* — not
 * how grammY talks to Telegram. Reaching into the private field is deliberate:
 * the alternative is an injected transport interface that exists only for this
 * test, and one line of access is a smaller price than a seam nothing else uses.
 */
function withStubbedBot(service: TelegramLoggerService) {
  const sent: string[] = [];
  const sendMessage = vi.fn((_chat: string, text: string) => {
    sent.push(text);
    return Promise.resolve({ message_id: 1 });
  });
  (service as unknown as { bot: { api: unknown } | null }).bot = { api: { sendMessage } };
  return { sent, sendMessage };
}

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '1234567890:AAaaBBbbCCccDDddEEeeFFffGGgghhhh1234',
  MONITORING_CHAT_ID: '-1001234567890',
  MONITORING_ALERT_COOLDOWN_SECONDS: 300,
  // M22 phase 7. `info` here rather than the production default of `warn`, so the
  // existing cases keep exercising every level; the floor has its own tests below.
  MONITORING_ENABLED: true,
  MONITORING_MIN_LEVEL: 'info',
  MONITORING_ENVIRONMENT: 'test-env',
  NODE_ENV: 'test',
} as unknown as Env;

describe('TelegramLoggerService', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(new Date('2026-08-21T10:00:00.000Z'));
  });

  // Asserted on the constructed state rather than on a stub, because a stub
  // would have to be installed over the very field the guard reads — which is
  // how a test for "it is switched off" ends up switching it back on.
  const botOf = (service: TelegramLoggerService) => (service as unknown as { bot: unknown }).bot;

  it('builds no bot, and sends nothing, when MONITORING_CHAT_ID is unset', () => {
    // A deployment with no alerting group is a worse deployment, not a broken
    // one. Nothing else about the worker may change because of this.
    const service = new TelegramLoggerService({ ...baseEnv, MONITORING_CHAT_ID: undefined }, clock);

    expect(botOf(service)).toBeNull();
    expect(() => service.alert('k', 'error', 'boom')).not.toThrow();
  });

  it('builds no bot when the token is unset', () => {
    const service = new TelegramLoggerService({ ...baseEnv, TELEGRAM_BOT_TOKEN: undefined }, clock);

    expect(botOf(service)).toBeNull();
    expect(() => service.alert('k', 'error', 'boom')).not.toThrow();
  });

  it('treats a blank chat id the same as an absent one', () => {
    // `.env` ships MONITORING_CHAT_ID= blank, and a blank string is a value.
    const service = new TelegramLoggerService({ ...baseEnv, MONITORING_CHAT_ID: '' }, clock);

    expect(botOf(service)).toBeNull();
  });

  it('sends the first alert for a key', () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('queue:telegram-send', 'error', 'A job gave up', { queue: 'telegram-send' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('A job gave up');
    expect(sent[0]).toContain('queue: telegram-send');
    expect(sent[0]).toContain('time: 2026-08-21T10:00:00.000Z');
  });

  it('suppresses a repeat of the same key inside the cooldown', () => {
    // The failure this exists for is a queue that has started failing *every*
    // job. Without a floor the alerting path becomes the amplifier, Telegram
    // rate-limits the bot, and the next incident is the silent one.
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    for (let i = 0; i < 50; i += 1) {
      clock.advance(1000);
      service.alert('queue:telegram-send', 'error', 'A job gave up');
    }

    expect(sent).toHaveLength(1);
  });

  it('reports how many were suppressed on the next one through', () => {
    // The throttle must hide the repetition without hiding the scale — "one job
    // failed" and "nine hundred jobs failed" are different incidents.
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('q', 'error', 'A job gave up');
    for (let i = 0; i < 9; i += 1) service.alert('q', 'error', 'A job gave up');

    clock.advance(300_001);
    service.alert('q', 'error', 'A job gave up');

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('9 similar alert(s) suppressed');
  });

  it('throttles per key, so one noisy queue does not mask another', () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('queue:telegram-send', 'error', 'A job gave up');
    service.alert('queue:telegram-send', 'error', 'A job gave up');
    service.alert('queue:domain-events', 'error', 'A job gave up');

    expect(sent).toHaveLength(2);
  });

  it('sends every alert when the cooldown is zero', () => {
    const service = new TelegramLoggerService(
      { ...baseEnv, MONITORING_ALERT_COOLDOWN_SECONDS: 0 },
      clock,
    );
    const { sent } = withStubbedBot(service);

    service.alert('q', 'warn', 'one');
    service.alert('q', 'warn', 'two');

    expect(sent).toHaveLength(2);
  });

  it('redacts sensitive fields before they reach a group chat', () => {
    // The group may contain people who are not administrators of this system,
    // so an alert carrying a failed job's payload must not carry a Telegram id
    // or a token with it. Same redactor the logger uses (M15).
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('q', 'error', 'A job gave up', {
      telegramUserId: 123456789,
      token: 'secret-value-that-must-not-appear',
    });

    expect(sent[0]).not.toContain('123456789');
    expect(sent[0]).not.toContain('secret-value-that-must-not-appear');
  });

  it('truncates rather than letting Telegram refuse the message', () => {
    // A stack trace pasted into `fields` is how the 4096-character limit gets
    // hit, and it happens on exactly the alerts most worth delivering.
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('q', 'error', 'A job gave up', { detail: 'x'.repeat(9000) });

    expect(sent[0]!.length).toBeLessThanOrEqual(3920);
    expect(sent[0]).toContain('…(truncated)');
  });

  it('does not throw when the send fails', () => {
    // Alerting must never be the thing that turns a recorded job failure into
    // an unhandled rejection.
    const service = new TelegramLoggerService(baseEnv, clock);
    (service as unknown as { bot: { api: unknown } }).bot = {
      api: { sendMessage: vi.fn(() => Promise.reject(new Error('chat not found'))) },
    };

    expect(() => service.alert('q', 'error', 'boom')).not.toThrow();
  });

  it('marks the level so an operator can triage at a glance', () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('a', 'error', 'red');
    service.alert('b', 'warn', 'amber');
    service.alert('c', 'info', 'green');

    expect(sent[0]).toContain('🔴');
    expect(sent[1]).toContain('🟡');
    expect(sent[2]).toContain('🟢');
  });

  // ── M22 phase 7 ────────────────────────────────────────────────────────────

  it('carries severity, service, environment and a stable code on every alert', () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    service.alert('queue:telegram-send', 'error', 'A job gave up', { queue: 'telegram-send' });

    const text = sent[0] ?? '';
    // The five fixed lines. An alert without them is one somebody has to
    // reconstruct the context of.
    expect(text).toContain('severity: error');
    expect(text).toContain('service: worker');
    expect(text).toContain('env: test-env');
    // The throttle key doubles as the machine-readable code, so alerts about the
    // same thing are searchable across incidents.
    expect(text).toContain('code: queue:telegram-send');
    expect(text).toContain('time: 2026-08-21T10:00:00.000Z');
  });

  it('falls back to NODE_ENV when no environment is named', () => {
    const service = new TelegramLoggerService(
      { ...baseEnv, MONITORING_ENVIRONMENT: undefined },
      clock,
    );
    const { sent } = withStubbedBot(service);

    service.alert('k', 'error', 'boom');

    expect(sent[0]).toContain('env: test');
  });

  /**
   * The kill switch, distinct from "not configured". One means nobody set
   * alerting up; the other means somebody wants it off right now — and
   * collapsing them would make silencing alerts require deleting the destination.
   */
  it('builds no bot when MONITORING_ENABLED is off, even with a chat id', () => {
    const service = new TelegramLoggerService({ ...baseEnv, MONITORING_ENABLED: false }, clock);

    expect(botOf(service)).toBeNull();
    expect(() => service.alert('k', 'error', 'boom')).not.toThrow();
  });

  it('drops anything below the configured level', () => {
    const service = new TelegramLoggerService(
      { ...baseEnv, MONITORING_MIN_LEVEL: 'error' as const },
      clock,
    );
    const { sent } = withStubbedBot(service);

    service.alert('a', 'info', 'quiet');
    service.alert('b', 'warn', 'medium');
    service.alert('c', 'error', 'loud');

    // The two below the floor stay in the structured log, which is where an
    // informational line belongs.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('loud');
  });

  /**
   * The per-key throttle bounds one noisy source. This bounds the other shape: a
   * hundred *different* keys failing at once, which is what a database outage
   * looks like from here.
   */
  it('stops after the global budget, and reports the overflow next window', () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    const { sent } = withStubbedBot(service);

    for (let index = 0; index < 25; index += 1) {
      service.alert(`key-${String(index)}`, 'error', `failure ${String(index)}`);
    }

    expect(sent).toHaveLength(20);

    // Past the window: the first alert through carries what the budget dropped.
    clock.set(new Date('2026-08-21T10:06:00.000Z'));
    service.alert('key-next', 'error', 'after the window');

    expect(sent).toHaveLength(21);
    expect(sent[20]).toContain('5 alert(s) dropped by the budget in the previous window');
  });

  /**
   * Rule 5. A Telegram outage that produced a Telegram alert per failed Telegram
   * alert would be an unbounded loop pointed at the dependency that is already
   * unwell — so the catch block calls the logger and nothing else.
   */
  it('never turns a delivery failure into another alert', async () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    const sendMessage = vi.fn(() => Promise.reject(new Error('telegram is down')));
    (service as unknown as { bot: { api: unknown } }).bot = { api: { sendMessage } };

    service.alert('k', 'error', 'boom');
    await Promise.resolve();
    await Promise.resolve();

    // One attempt, and no second message describing the first one failing.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not fail its caller when delivery throws', async () => {
    const service = new TelegramLoggerService(baseEnv, clock);
    (service as unknown as { bot: { api: unknown } }).bot = {
      api: { sendMessage: () => Promise.reject(new Error('nope')) },
    };

    expect(() => service.alert('k', 'error', 'boom')).not.toThrow();
    await Promise.resolve();
  });
});
