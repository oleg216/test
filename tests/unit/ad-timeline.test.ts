import { describe, it, expect } from 'vitest';
import { buildTimeline } from '../../src/engines/ad-timeline.js';

describe('buildTimeline', () => {
  it('always starts with impression at 0 and start shortly after', () => {
    const events = buildTimeline(20, 1.0); // 100% completion for deterministic test
    expect(events[0]).toEqual({ event: 'impression', timeMs: 0 });
    expect(events[1].event).toBe('start');
    expect(events[1].timeMs).toBeGreaterThanOrEqual(200);
    expect(events[1].timeMs).toBeLessThanOrEqual(600);
  });

  it('includes all quartile events when completionRate=1.0', () => {
    const events = buildTimeline(20, 1.0);
    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain('impression');
    expect(eventNames).toContain('start');
    expect(eventNames).toContain('firstQuartile');
    expect(eventNames).toContain('midpoint');
    expect(eventNames).toContain('thirdQuartile');
    expect(eventNames).toContain('complete');
  });

  it('quartile times are approximately correct with drift', () => {
    const events = buildTimeline(20, 1.0);
    const q1 = events.find(e => e.event === 'firstQuartile')!;
    const mid = events.find(e => e.event === 'midpoint')!;
    const q3 = events.find(e => e.event === 'thirdQuartile')!;
    const complete = events.find(e => e.event === 'complete')!;

    // Allow ±2s drift from exact quartile positions
    expect(q1.timeMs).toBeGreaterThan(3000);
    expect(q1.timeMs).toBeLessThan(7000);
    expect(mid.timeMs).toBeGreaterThan(8000);
    expect(mid.timeMs).toBeLessThan(12000);
    expect(q3.timeMs).toBeGreaterThan(13000);
    expect(q3.timeMs).toBeLessThan(17000);
    expect(complete.timeMs).toBeGreaterThan(18000);
    expect(complete.timeMs).toBeLessThan(22000);
  });

  it('completionRate=0 always produces incomplete timeline', () => {
    // Run 20 times to ensure statistical behavior
    for (let i = 0; i < 20; i++) {
      const events = buildTimeline(30, 0);
      const eventNames = events.map(e => e.event);
      expect(eventNames).not.toContain('complete');
    }
  });

  it('events are in chronological order', () => {
    const events = buildTimeline(30, 1.0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timeMs).toBeGreaterThanOrEqual(events[i - 1].timeMs);
    }
  });

  it('includes click event when clickProbability=1', () => {
    const events = buildTimeline(20, 1.0, 1.0);
    const clickEvent = events.find(e => e.event === 'click');
    expect(clickEvent).toBeDefined();
    // Click should be between start+3s and lastQuartile-2s
    expect(clickEvent!.timeMs).toBeGreaterThanOrEqual(3200);
  });

  it('never includes click event when clickProbability=0', () => {
    for (let i = 0; i < 20; i++) {
      const events = buildTimeline(20, 1.0, 0);
      const clickEvent = events.find(e => e.event === 'click');
      expect(clickEvent).toBeUndefined();
    }
  });

  it('click events maintain chronological order', () => {
    const events = buildTimeline(30, 1.0, 1.0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timeMs).toBeGreaterThanOrEqual(events[i - 1].timeMs);
    }
  });
});
