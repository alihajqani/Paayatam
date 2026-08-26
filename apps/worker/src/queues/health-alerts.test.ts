import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS } from '@payetam/platform';
import { Processors } from './processors.service';

/**
 * The two health sweeps that raise alerts on their own (M22 phase 7).
 *
 * Everything else in the alerting story reacts to something the worker was
 * already doing — a job that gave up, a campaign that tripped its breaker. These
 * two go looking, which is the whole point of them: a ledger that stopped adding
 * up and an outbox that stopped draining are both **silent**. Neither produces a
 * failed job, an error log or a user complaint until long after the fact.
 *
 * So the thing worth testing is not the arithmetic — it is that a machine notices
 * without being asked, and that noticing does not leak who it noticed it about.
 */

interface RecordedAlert {
  key: string;
  level: string;
  title: string;
  fields: Record<string, unknown>;
}

class FakeAlerts {
  readonly sent: RecordedAlert[] = [];
  alert(key: string, level: string, title: string, fields: Record<string, unknown> = {}): void {
    this.sent.push({ key, level, title, fields });
  }
}

let alerts: FakeAlerts;

/** Only the two collaborators these paths touch; the rest never runs. */
function buildProcessors(overrides: { coins?: unknown; relay?: unknown }): Processors {
  return new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    (overrides.relay ?? {}) as never,
    {} as never, // NotificationService
    {} as never, // TelegramClient
    {} as never, // ChatService
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    {} as never, // MessagingService
    {} as never, // InvitationService
    { counter: vi.fn(), observe: vi.fn() } as never,
    (overrides.coins ?? {}) as never,
    alerts as never,
  );
}

/** Reached the way the scheduled queue reaches it. */
function scheduled(processors: Processors, name: string): Promise<void> {
  return (
    processors as unknown as { onScheduled: (job: { name: string }) => Promise<void> }
  ).onScheduled({ name });
}

beforeEach(() => {
  alerts = new FakeAlerts();
});

describe('ledger reconciliation', () => {
  it('says nothing when the ledger adds up', async () => {
    const findDrift = vi.fn().mockResolvedValue([]);
    const processors = buildProcessors({ coins: { findDrift } });

    await scheduled(processors, JOBS.LEDGER_RECONCILE);

    expect(findDrift).toHaveBeenCalledOnce();
    expect(alerts.sent).toHaveLength(0);
  });

  it('raises an error alert when a balance disagrees with its ledger', async () => {
    const processors = buildProcessors({
      coins: {
        findDrift: vi.fn().mockResolvedValue([
          { userId: 'user-a', balance: 120, ledger: 100 },
          { userId: 'user-b', balance: 5, ledger: 30 },
        ]),
      },
    });

    await scheduled(processors, JOBS.LEDGER_RECONCILE);

    expect(alerts.sent).toHaveLength(1);
    const [alert] = alerts.sent;
    expect(alert?.level).toBe('error');
    expect(alert?.key).toBe('ledger.drift');
    expect(alert?.fields['accounts']).toBe(2);
    // The larger of |120-100| and |5-30|.
    expect(alert?.fields['largestGap']).toBe(25);
    // Signed, so +20 and -25 do not cancel into "nothing is wrong".
    expect(alert?.fields['totalGap']).toBe(-5);
    expect(alert?.fields['truncated']).toBe(false);
  });

  /**
   * ADR-0009 does not stop applying because the message is an alert.
   *
   * A drift report goes to an operations group, which is a Telegram chat with
   * people in it. Two accounts drifting and two thousand mean the same thing to
   * whoever reads it, and neither answer needs a name attached.
   */
  it('never puts a user id in the alert', async () => {
    const processors = buildProcessors({
      coins: {
        findDrift: vi.fn().mockResolvedValue([{ userId: 'user-secret', balance: 1, ledger: 0 }]),
      },
    });

    await scheduled(processors, JOBS.LEDGER_RECONCILE);

    expect(JSON.stringify(alerts.sent)).not.toContain('user-secret');
  });
});

describe('outbox health', () => {
  /** The backstop drains first, so these fakes cover both halves of the case. */
  function relayWith(backlog: { pending: number; oldestAgeMs: number | null }) {
    return {
      drain: vi.fn().mockResolvedValue({ processed: 0, created: 0, queued: [] }),
      backlog: vi.fn().mockResolvedValue(backlog),
    };
  }

  it('says nothing when the outbox is empty', async () => {
    const processors = buildProcessors({ relay: relayWith({ pending: 0, oldestAgeMs: null }) });

    await scheduled(processors, JOBS.OUTBOX_BACKSTOP);

    expect(alerts.sent).toHaveLength(0);
  });

  /**
   * A burst is not an incident.
   *
   * Two hundred rows a minute old is the relay working through a spike, which is
   * exactly what it is for. Alerting on the count would page somebody every time
   * the product had a good evening.
   */
  it('says nothing about a large but fresh backlog', async () => {
    const processors = buildProcessors({
      relay: relayWith({ pending: 200, oldestAgeMs: 60_000 }),
    });

    await scheduled(processors, JOBS.OUTBOX_BACKSTOP);

    expect(alerts.sent).toHaveLength(0);
  });

  it('raises an error alert when the oldest row has been waiting too long', async () => {
    const processors = buildProcessors({
      relay: relayWith({ pending: 3, oldestAgeMs: 20 * 60 * 1000 }),
    });

    await scheduled(processors, JOBS.OUTBOX_BACKSTOP);

    expect(alerts.sent).toHaveLength(1);
    const [alert] = alerts.sent;
    expect(alert?.level).toBe('error');
    expect(alert?.key).toBe('outbox.stale');
    expect(alert?.fields['pending']).toBe(3);
    expect(alert?.fields['oldestMinutes']).toBe(20);
  });

  /**
   * Three rows stuck for twenty minutes is an incident; three rows moving is not.
   *
   * Which is why the age, not the count, is the trigger — and why the drain runs
   * before the question is asked.
   */
  it('drains before deciding whether the outbox is stuck', async () => {
    const relay = relayWith({ pending: 0, oldestAgeMs: null });
    const processors = buildProcessors({ relay });

    await scheduled(processors, JOBS.OUTBOX_BACKSTOP);

    expect(relay.drain).toHaveBeenCalledOnce();
    const drainOrder = relay.drain.mock.invocationCallOrder[0] ?? 0;
    const backlogOrder = relay.backlog.mock.invocationCallOrder[0] ?? 0;
    expect(drainOrder).toBeLessThan(backlogOrder);
  });
});
