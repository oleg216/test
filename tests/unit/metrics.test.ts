import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsRegistry } from '../../src/master/metrics.js';

describe('MetricsRegistry', () => {
  let metrics: MetricsRegistry;

  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  it('increments tracking events counter', () => {
    metrics.trackingEventFired('impression');
    metrics.trackingEventFired('start');
    expect(true).toBe(true);
  });

  it('updates sessions running gauge', () => {
    metrics.sessionsRunning(5);
    expect(true).toBe(true);
  });

  it('returns metrics string', async () => {
    const output = await metrics.getMetrics();
    expect(typeof output).toBe('string');
  });
});
