import { TRACKING_JITTER_MS } from '../shared/constants.js';
export function buildTimeline(durationSeconds) {
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
export function addJitter(timeMs) {
    const jitter = (Math.random() - 0.5) * 2 * TRACKING_JITTER_MS;
    return Math.max(0, timeMs + jitter);
}
export class AdTimelineScheduler {
    timers = [];
    fired = new Set();
    schedule(timeline, onEvent, withJitter = true) {
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
    cancel() {
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers = [];
    }
    hasFired(event) {
        return this.fired.has(event);
    }
}
//# sourceMappingURL=ad-timeline.js.map