import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export class MetricsRegistry {
  private registry: Registry;

  readonly sessionsRunningGauge: Gauge;
  readonly trackingEventsTotal: Counter;
  readonly vastRequestsTotal: Counter;
  readonly vastErrorsTotal: Counter;
  readonly rtbRequestsTotal: Counter;
  readonly rtbErrorsTotal: Counter;
  readonly sessionDuration: Histogram;

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
      labelNames: ['event_type'] as const,
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

  sessionsRunning(count: number): void {
    this.sessionsRunningGauge.set(count);
  }

  trackingEventFired(eventType: string): void {
    this.trackingEventsTotal.inc({ event_type: eventType });
  }

  vastRequest(): void {
    this.vastRequestsTotal.inc();
  }

  vastError(): void {
    this.vastErrorsTotal.inc();
  }

  rtbRequest(): void {
    this.rtbRequestsTotal.inc();
  }

  rtbError(): void {
    this.rtbErrorsTotal.inc();
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  async getContentType(): Promise<string> {
    return this.registry.contentType;
  }
}
