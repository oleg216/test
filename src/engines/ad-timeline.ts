import type { TrackingEventType } from '../shared/types.js';

export interface TimelineEntry {
  event: TrackingEventType;
  timeMs: number;
}

// Gaussian-approximation via Box-Muller — produces natural-looking drift
function gaussianRandom(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

export function buildTimeline(durationSeconds: number, completionRate: number = 0.72, clickProbability: number = 0.035): TimelineEntry[] {
  const durationMs = durationSeconds * 1000;

  // Real IMA SDK fires impression immediately, start after video.play() resolves (~200-600ms)
  const startDelay = 200 + Math.random() * 400;

  // Accumulating drift — each quartile adds buffer jitter from the previous one
  // Real video players have slight buffering variations that compound
  let drift = 0;
  const stdDev = durationMs * 0.008; // ~0.8% of duration as std deviation per quartile

  const timeline: TimelineEntry[] = [
    { event: 'impression', timeMs: 0 },
    { event: 'start', timeMs: startDelay },
  ];

  // Determine drop-off point based on completion rate
  // Weighted toward later quartiles (most users who start will watch >50%)
  const dropOffRoll = Math.random();
  let lastEvent: TrackingEventType = 'complete';
  if (dropOffRoll > completionRate) {
    // This session won't complete — pick where it drops
    const dropRoll = Math.random();
    if (dropRoll < 0.15) lastEvent = 'firstQuartile'; // 15% drop before Q1
    else if (dropRoll < 0.40) lastEvent = 'midpoint';  // 25% drop before mid
    else lastEvent = 'thirdQuartile';                    // 60% drop before Q3
  }

  const quartiles: Array<{ event: TrackingEventType; fraction: number }> = [
    { event: 'firstQuartile', fraction: 0.25 },
    { event: 'midpoint', fraction: 0.5 },
    { event: 'thirdQuartile', fraction: 0.75 },
    { event: 'complete', fraction: 1.0 },
  ];

  for (const q of quartiles) {
    drift += gaussianRandom(0, stdDev);
    const timeMs = Math.max(startDelay + 100, durationMs * q.fraction + drift);
    timeline.push({ event: q.event, timeMs });

    if (q.event === lastEvent) break;
  }

  // Click event — simulate user click on ad
  if (Math.random() < clickProbability) {
    const lastTimeMs = timeline[timeline.length - 1].timeMs;
    const clickStart = startDelay + 3000;
    const clickEnd = Math.max(clickStart + 1000, lastTimeMs - 2000);
    const clickTimeMs = clickStart + Math.random() * (clickEnd - clickStart);
    timeline.push({ event: 'click', timeMs: clickTimeMs });
    timeline.sort((a, b) => a.timeMs - b.timeMs);
  }

  return timeline;
}

export class AdTimelineScheduler {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private fired = new Set<string>();

  schedule(
    timeline: TimelineEntry[],
    onEvent: (event: TrackingEventType) => void,
  ): void {
    for (const entry of timeline) {
      const timer = setTimeout(() => {
        if (!this.fired.has(entry.event)) {
          this.fired.add(entry.event);
          onEvent(entry.event);
        }
      }, entry.timeMs);
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

  get lastEvent(): TrackingEventType | undefined {
    // Return the highest quartile event that was scheduled
    const ordered: TrackingEventType[] = ['complete', 'thirdQuartile', 'midpoint', 'firstQuartile', 'start', 'impression'];
    for (const e of ordered) {
      if (this.fired.has(e)) return e;
    }
    return undefined;
  }
}
