import { TRACKING_JITTER_MS } from '../shared/constants.js';
import type { TrackingEventType } from '../shared/types.js';

export interface TimelineEntry {
  event: TrackingEventType;
  timeMs: number;
}

export function buildTimeline(durationSeconds: number): TimelineEntry[] {
  const durationMs = durationSeconds * 1000;
  return [
    { event: 'impression', timeMs: 0 },
    { event: 'start', timeMs: 0 },
    { event: 'firstQuartile', timeMs: durationMs * 0.25 },
    { event: 'midpoint', timeMs: durationMs * 0.5 },
    { event: 'thirdQuartile', timeMs: durationMs * 0.75 },
    { event: 'complete', timeMs: durationMs },
  ];
}

export function addJitter(timeMs: number): number {
  const jitter = (Math.random() - 0.5) * 2 * TRACKING_JITTER_MS;
  return Math.max(0, timeMs + jitter);
}

export class AdTimelineScheduler {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private fired = new Set<string>();

  schedule(
    timeline: TimelineEntry[],
    onEvent: (event: TrackingEventType) => void,
    withJitter: boolean = true,
  ): void {
    for (const entry of timeline) {
      const delay = withJitter && entry.timeMs > 0 ? addJitter(entry.timeMs) : entry.timeMs;
      const timer = setTimeout(() => {
        if (!this.fired.has(entry.event)) {
          this.fired.add(entry.event);
          onEvent(entry.event);
        }
      }, delay);
      this.timers.push(timer);
    }
  }

  cancel(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  hasFired(event: TrackingEventType): boolean {
    return this.fired.has(event);
  }
}
