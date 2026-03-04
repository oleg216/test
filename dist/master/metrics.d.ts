import { Counter, Gauge, Histogram } from 'prom-client';
export declare class MetricsRegistry {
    private registry;
    readonly sessionsRunningGauge: Gauge;
    readonly trackingEventsTotal: Counter;
    readonly vastRequestsTotal: Counter;
    readonly vastErrorsTotal: Counter;
    readonly rtbRequestsTotal: Counter;
    readonly rtbErrorsTotal: Counter;
    readonly sessionDuration: Histogram;
    constructor();
    sessionsRunning(count: number): void;
    trackingEventFired(eventType: string): void;
    vastRequest(): void;
    vastError(): void;
    rtbRequest(): void;
    rtbError(): void;
    getMetrics(): Promise<string>;
    getContentType(): Promise<string>;
}
//# sourceMappingURL=metrics.d.ts.map