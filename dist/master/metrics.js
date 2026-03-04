import { Registry, Counter, Gauge, Histogram } from 'prom-client';
export class MetricsRegistry {
    registry;
    sessionsRunningGauge;
    trackingEventsTotal;
    vastRequestsTotal;
    vastErrorsTotal;
    rtbRequestsTotal;
    rtbErrorsTotal;
    sessionDuration;
    constructor() {
        this.registry = new Registry();
        this.sessionsRunningGauge = new Gauge({
            name: 'sessions_running',
            help: 'Number of currently running sessions',
            registers: [this.registry],
        });
        this.trackingEventsTotal = new Counter({
            name: 'tracking_events_total',
            help: 'Total tracking events fired',
            labelNames: ['event_type'],
            registers: [this.registry],
        });
        this.vastRequestsTotal = new Counter({
            name: 'vast_requests_total',
            help: 'Total VAST requests made',
            registers: [this.registry],
        });
        this.vastErrorsTotal = new Counter({
            name: 'vast_errors_total',
            help: 'Total VAST errors',
            registers: [this.registry],
        });
        this.rtbRequestsTotal = new Counter({
            name: 'rtb_requests_total',
            help: 'Total RTB bid requests',
            registers: [this.registry],
        });
        this.rtbErrorsTotal = new Counter({
            name: 'rtb_errors_total',
            help: 'Total RTB errors',
            registers: [this.registry],
        });
        this.sessionDuration = new Histogram({
            name: 'session_duration_seconds',
            help: 'Session duration in seconds',
            buckets: [5, 10, 30, 60, 120, 300],
            registers: [this.registry],
        });
    }
    sessionsRunning(count) {
        this.sessionsRunningGauge.set(count);
    }
    trackingEventFired(eventType) {
        this.trackingEventsTotal.inc({ event_type: eventType });
    }
    vastRequest() {
        this.vastRequestsTotal.inc();
    }
    vastError() {
        this.vastErrorsTotal.inc();
    }
    rtbRequest() {
        this.rtbRequestsTotal.inc();
    }
    rtbError() {
        this.rtbErrorsTotal.inc();
    }
    async getMetrics() {
        return this.registry.metrics();
    }
    async getContentType() {
        return this.registry.contentType;
    }
}
//# sourceMappingURL=metrics.js.map