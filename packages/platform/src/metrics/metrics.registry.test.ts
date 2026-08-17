import { beforeEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from './metrics.registry';

/**
 * The metrics registry (plan §9 M16).
 *
 * Two things are worth testing here and one is not. The exposition format matters,
 * because a scrape that Prometheus silently rejects is indistinguishable from a
 * process producing no metrics — the graph is empty either way. And the histogram
 * arithmetic matters, because it is what `histogram_quantile` reads to produce the
 * p95 the plan asks for, and a cumulative bucket off by one produces a plausible
 * wrong number rather than an error.
 *
 * What is *not* tested is that the numbers themselves are correct — a counter that
 * counts is not an interesting property. The interesting one is that the labels can
 * never grow without bound, and that lives in the call sites.
 */

let metrics: MetricsRegistry;

beforeEach(() => {
  metrics = new MetricsRegistry();
});

/** `name{labels} value` → the value, or undefined when the series is absent. */
function valueOf(rendered: string, series: string): string | undefined {
  const line = rendered.split('\n').find((candidate) => candidate.startsWith(series));
  return line?.slice(series.length).trim();
}

describe('counters', () => {
  it('accumulates', async () => {
    metrics.counter('test_total', 'help', { code: 'A' });
    metrics.counter('test_total', 'help', { code: 'A' });
    metrics.counter('test_total', 'help', { code: 'B' });

    const rendered = await metrics.render();
    expect(valueOf(rendered, 'test_total{code="A"}')).toBe('2');
    expect(valueOf(rendered, 'test_total{code="B"}')).toBe('1');
  });

  it('emits HELP and TYPE, which a scraper needs to accept the series', async () => {
    metrics.counter('test_total', 'a description', {});

    const rendered = await metrics.render();
    expect(rendered).toContain('# HELP test_total a description');
    expect(rendered).toContain('# TYPE test_total counter');
  });

  /** Otherwise `{a="1",b="2"}` and `{b="2",a="1"}` become two series for one thing. */
  it('sorts labels so the same labels are the same series', async () => {
    metrics.counter('test_total', 'help', { b: '2', a: '1' });
    metrics.counter('test_total', 'help', { a: '1', b: '2' });

    expect(valueOf(await metrics.render(), 'test_total{a="1",b="2"}')).toBe('2');
  });

  it('escapes a label value that would otherwise break the format', async () => {
    metrics.counter('test_total', 'help', { route: 'a"b\\c' });

    expect(await metrics.render()).toContain('route="a\\"b\\\\c"');
  });

  it('renders an unlabelled counter without braces', async () => {
    metrics.counter('test_total', 'help');

    expect(valueOf(await metrics.render(), 'test_total 1')).toBe('');
  });
});

describe('histograms', () => {
  /**
   * Prometheus histogram buckets are **cumulative**: `le="0.5"` counts everything at
   * or below 0.5, not everything between 0.25 and 0.5. Getting this wrong produces a
   * quantile that is plausible and wrong, which is worse than one that is missing.
   */
  it('fills every bucket at or above the observation', async () => {
    metrics.observe('test_seconds', 'help', 0.03);

    const rendered = await metrics.render();
    expect(valueOf(rendered, 'test_seconds_bucket{le="0.005"}')).toBeUndefined();
    expect(valueOf(rendered, 'test_seconds_bucket{le="0.05"}')).toBe('1');
    expect(valueOf(rendered, 'test_seconds_bucket{le="1"}')).toBe('1');
    expect(valueOf(rendered, 'test_seconds_bucket{le="+Inf"}')).toBe('1');
  });

  it('counts an observation past the last bucket in +Inf only', async () => {
    metrics.observe('test_seconds', 'help', 120);

    const rendered = await metrics.render();
    expect(valueOf(rendered, 'test_seconds_bucket{le="10"}')).toBeUndefined();
    expect(valueOf(rendered, 'test_seconds_bucket{le="+Inf"}')).toBe('1');
  });

  it('emits _sum and _count', async () => {
    metrics.observe('test_seconds', 'help', 0.1);
    metrics.observe('test_seconds', 'help', 0.3);

    const rendered = await metrics.render();
    expect(Number(valueOf(rendered, 'test_seconds_sum'))).toBeCloseTo(0.4);
    expect(valueOf(rendered, 'test_seconds_count')).toBe('2');
  });

  it('keeps separate series per label set', async () => {
    metrics.observe('test_seconds', 'help', 0.1, { route: '/a' });
    metrics.observe('test_seconds', 'help', 0.1, { route: '/b' });

    const rendered = await metrics.render();
    expect(valueOf(rendered, 'test_seconds_count{route="/a"}')).toBe('1');
    expect(valueOf(rendered, 'test_seconds_count{route="/b"}')).toBe('1');
  });
});

describe('collectors', () => {
  it('asks for a gauge value at scrape time', async () => {
    let asked = 0;
    metrics.registerCollector('test_depth', 'help', () => {
      asked += 1;
      return Promise.resolve([[{ queue: 'q' }, 7]]);
    });

    expect(valueOf(await metrics.render(), 'test_depth{queue="q"}')).toBe('7');
    await metrics.render();
    expect(asked).toBe(2);
  });

  it('replaces the previous values rather than accumulating them', async () => {
    let depth = 3;
    metrics.registerCollector('test_depth', 'help', () =>
      Promise.resolve([[{ queue: 'q' }, depth]] as Array<[Record<string, string>, number]>),
    );

    await metrics.render();
    depth = 1;
    expect(valueOf(await metrics.render(), 'test_depth{queue="q"}')).toBe('1');
  });

  /**
   * The behaviour that matters at three in the morning. A failing collector must
   * produce **no series**, because an absent series makes a graph go blank and an
   * `absent()` alert fire, while a zero says "the queue is empty" — which is the
   * single most misleading thing a queue-depth metric can say when the truth is that
   * Redis is unreachable.
   */
  it('emits no series when a collector throws, rather than zero', async () => {
    metrics.registerCollector('test_depth', 'help', () => {
      throw new Error('redis is down');
    });

    const rendered = await metrics.render();
    expect(rendered).toContain('# TYPE test_depth gauge');
    expect(rendered).not.toMatch(/^test_depth/m);
  });

  it('does not let one failing collector suppress another', async () => {
    metrics.registerCollector('broken', 'help', () => Promise.reject(new Error('nope')));
    metrics.registerCollector('working', 'help', () => Promise.resolve([[{}, 5]]));

    expect(valueOf(await metrics.render(), 'working 5')).toBe('');
  });
});

describe('the rendered document', () => {
  it('ends with a newline, which the format requires', async () => {
    metrics.counter('test_total', 'help');

    expect(await metrics.render()).toMatch(/\n$/);
  });

  it('is empty but well-formed when nothing has been recorded', async () => {
    expect(await metrics.render()).toBe('\n');
  });
});
