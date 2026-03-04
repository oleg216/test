import type { TrackingEventType } from '../shared/types.js';
export interface TimelineEntry {
    event: TrackingEventType;
    timeMs: number;
}
export declare function buildTimeline(durationSeconds: number): TimelineEntry[];
export declare function addJitter(timeMs: number): number;
export declare class AdTimelineScheduler {
    private timers;
    private fired;
    schedule(timeline: TimelineEntry[], onEvent: (event: TrackingEventType) => void, withJitter?: boolean): void;
    cancel(): void;
    hasFired(event: TrackingEventType): boolean;
}
//# sourceMappingURL=ad-timeline.d.ts.map