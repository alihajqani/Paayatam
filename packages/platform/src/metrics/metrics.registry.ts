import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The metrics the plan names, and nothing else (§9 M16).
 *
 * **Hand-rolled rather than `prom-client`.** The plan asks for four numbers: queue
 * depth, job failures, p95 latency, and the join-conflict rate. Three are counters
 * and one is a histogram, and the Prometheus text format is a documented handful of
 * lines. A metrics library earns its place when you need exemplars, native
 * histograms, or a registry shared across libraries that each register their own
 * collectors — none of which is true here, and the dependency would bring its own
 * default collectors that emit fifty process-level series nobody asked for.
 *
 * **Cardinality is capped by construction.** Every label value below comes from a
 * closed set — a queue name, an error code, a route *pattern*. Nothing takes a
 * user id, an event id, or a raw URL. That is the one mistake in metrics that
 * cannot be walked back: a series per user is a memory leak that looks like
 * observability, and by the time it hurts, the dashboards depend on it.
 */

/** A counter's labels, kept to a closed set — see the note on cardinality. */
export type Labels = Readonly<Record<string, string>>;

interface Series {
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, number>;
}

/**
 * Latency buckets, in seconds.
 *
 * Chosen around what the product actually promises: §10 asks that a published
 * event appear in discovery within five seconds and that the API stay responsive
 * on a phone over a mobile network. The dense range is 50 ms–1 s because that is
 * where a regression is still fixable; past two seconds the only question is *how*
 * bad, not how much worse.
 */
const LATENCY_BUCKETS = [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class MetricsRegistry {
  private readonly series = new Map<string, Series>();

  /**
   * Gauges read at scrape time rather than pushed.
   *
   * Queue depth is the reason this exists: it is a *question for Redis*, not a
   * number the process accumulates, and a gauge the API updated on every enqueue
   * would drift the moment the worker consumed anything.
   */
  private readonly collectors = new Map<string, () => Promise<Array<[Labels, number]>>>();

  counter(name: string, help: string, labels: Labels = {}, by = 1): void {
    const series = this.ensure(name, help, 'counter');
    const key = encodeLabels(labels);
    series.values.set(key, (series.values.get(key) ?? 0) + by);
  }

  /**
   * Record one observation into a histogram.
   *
   * Stored as cumulative bucket counts plus a sum and a count, which is exactly
   * what Prometheus's `histogram_quantile` needs to produce the p95 the plan asks
   * for. Computing the quantile here instead would fix it to this process's
   * lifetime and make it un-aggregatable across instances — a p95 that cannot be
   * summed over two API containers is a p95 of one container.
   */
  observe(name: string, help: string, value: number, labels: Labels = {}): void {
    const series = this.ensure(name, help, 'histogram');

    for (const bucket of LATENCY_BUCKETS) {
      if (value <= bucket) {
        const key = encodeLabels({ ...labels, le: formatBucket(bucket) });
        series.values.set(key, (series.values.get(key) ?? 0) + 1);
      }
    }
    const infKey = encodeLabels({ ...labels, le: '+Inf' });
    series.values.set(infKey, (series.values.get(infKey) ?? 0) + 1);

    const base = encodeLabels(labels);
    series.values.set(`\u0000sum${base}`, (series.values.get(`\u0000sum${base}`) ?? 0) + value);
    series.values.set(`\u0000count${base}`, (series.values.get(`\u0000count${base}`) ?? 0) + 1);
  }

  /** Register a gauge that is asked for its value when `/metrics` is scraped. */
  registerCollector(
    name: string,
    help: string,
    collect: () => Promise<Array<[Labels, number]>>,
  ): void {
    this.ensure(name, help, 'gauge');
    this.collectors.set(name, collect);
  }

  /**
   * Render the Prometheus text exposition format.
   *
   * A failing collector produces **no series** rather than a zero. The difference
   * matters at three in the morning: an absent series makes a graph go blank and an
   * alert fire on `absent()`, while a zero says "the queue is empty" — which is the
   * single most misleading thing a queue-depth metric can say when the truth is
   * that Redis is unreachable.
   */
  async render(): Promise<string> {
    const lines: string[] = [];

    for (const [name, collect] of this.collectors) {
      const series = this.series.get(name);
      if (!series) continue;
      series.values.clear();
      try {
        for (const [labels, value] of await collect()) {
          series.values.set(encodeLabels(labels), value);
        }
      } catch {
        // Left empty on purpose. See the note above.
      }
    }

    for (const [name, series] of this.series) {
      lines.push(`# HELP ${name} ${series.help}`, `# TYPE ${name} ${series.type}`);

      for (const [key, value] of series.values) {
        if (key.startsWith('\u0000sum')) {
          lines.push(`${name}_sum${key.slice(4)} ${String(value)}`);
        } else if (key.startsWith('\u0000count')) {
          lines.push(`${name}_count${key.slice(6)} ${String(value)}`);
        } else if (series.type === 'histogram') {
          lines.push(`${name}_bucket${key} ${String(value)}`);
        } else {
          lines.push(`${name}${key} ${String(value)}`);
        }
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /** Testing seam: forget everything recorded so far. */
  reset(): void {
    this.series.clear();
    this.collectors.clear();
  }

  private ensure(name: string, help: string, type: Series['type']): Series {
    const existing = this.series.get(name);
    if (existing) return existing;

    const created: Series = { help, type, values: new Map() };
    this.series.set(name, created);
    return created;
  }
}

/** `{a="1",b="2"}`, or an empty string. Sorted, so the same labels give one series. */
function encodeLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';

  const rendered = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `{${rendered}}`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** `1` rather than `1e+0` — Prometheus accepts both, humans read one of them. */
function formatBucket(bucket: number): string {
  return String(bucket);
}

/** The names, in one place, so a dashboard query and the code that feeds it agree. */
export const METRICS = {
  HTTP_DURATION: 'payetam_http_request_duration_seconds',
  HTTP_TOTAL: 'payetam_http_requests_total',
  JOIN_CONFLICTS: 'payetam_join_conflicts_total',
  QUEUE_DEPTH: 'payetam_queue_depth',
  JOB_FAILURES: 'payetam_job_failures_total',
  JOB_DURATION: 'payetam_job_duration_seconds',
  OUTBOX_BACKLOG: 'payetam_outbox_unprocessed',
  /**
   * Economy grants that a user initiated, by outcome (M18).
   *
   * The ledger already records every grant that *succeeded* — that is what
   * ADR-0007 is for, and a counter would be a worse copy of it. What the ledger
   * cannot show is the refusals: a burst of `invalid` against codes that do not
   * exist is what a brute-force attempt looks like, and it leaves no row
   * anywhere. Hence a counter labelled by result rather than a gauge of totals.
   */
  GIFT_CODE_REDEMPTIONS: 'payetam_gift_code_redemptions_total',
  REFERRAL_CLAIMS: 'payetam_referral_claims_total',
  /**
   * Requests a bucket refused, by endpoint class (M19).
   *
   * Labelled by class and by nothing else — never by subject, which would be a
   * series per user and is the metrics mistake that cannot be walked back. Who
   * was refused is a question for `audit_log`, which records the first crossing
   * of each window; how much refusing is happening is this.
   */
  RATE_LIMITED: 'payetam_rate_limited_total',
} as const;

@Global()
@Module({
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
