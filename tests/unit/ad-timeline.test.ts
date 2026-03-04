import { describe, it, expect } from 'vitest';
import { buildTimeline } from '../../src/engines/ad-timeline.js';

describe('buildTimeline', () => {
  it('creates correct quartile events for 20s ad', () => {
    const events = buildTimeline(20);
    expect(events).toEqual([
      { event: 'impression', timeMs: 0 },
      { event: 'start', timeMs: 0 },
      { event: 'firstQuartile', timeMs: 5000 },
      { event: 'midpoint', timeMs: 10000 },
      { event: 'thirdQuartile', timeMs: 15000 },
      { event: 'complete', timeMs: 20000 },
    ]);
  });

  it('creates correct events for 30s ad', () => {
    const events = buildTimeline(30);
    expect(events[2]).toEqual({ event: 'firstQuartile', timeMs: 7500 });
    expect(events[3]).toEqual({ event: 'midpoint', timeMs: 15000 });
    expect(events[4]).toEqual({ event: 'thirdQuartile', timeMs: 22500 });
    expect(events[5]).toEqual({ event: 'complete', timeMs: 30000 });
  });
});
