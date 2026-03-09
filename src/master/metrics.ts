import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export interface StatsSnapshot {
  uptime: number;
  sessionsRunning: number;
  sessionsTotal: number;
  sessionsCompleted: number;
  sessionsFailed: number;
  rtbRequests: number;
  rtbErrors: number;
  rtbNoBids: number;
  bidsReceived: number;
  winRate: string;          // "45.2%"
  vastRequests: number;
  vastErrors: number;
  bidRevenue: number;       // sum of all bid prices
  avgBidPrice: number;
  avgCPM: number;
  impressions: number;
  starts: number;
  firstQuartiles: number;
  midpoints: number;
  thirdQuartiles: number;
  completes: number;
  clicks: number;
  completionRate: string;   // "72.0%"
  avgLatencyMs: number;
  byGeo: Record<string, { requests: number; bids: number; impressions: number }>;
  byApp: Record<string, { requests: number; bids: number; impressions: number }>;
  byDevice: Record<string, { requests: number; bids: number }>;
}

export class MetricsRegistry {
  private registry: Registry;

  // Prometheus metrics
  readonly sessionsRunningGauge: Gauge;
  readonly trackingEventsTotal: Counter;
  readonly vastRequestsTotal: Counter;
  readonly vastErrorsTotal: Counter;
  readonly rtbRequestsTotal: Counter;
  readonly rtbErrorsTotal: Counter;
  readonly sessionDuration: Histogram;

  // In-memory aggregated counters for dashboard
  private _sessionsTotal = 0;
  private _sessionsCompleted = 0;
  private _sessionsFailed = 0;
  private _rtbRequests = 0;
  private _rtbErrors = 0;
  private _rtbNoBids = 0;
  private _bidsReceived = 0;
  private _vastRequests = 0;
  private _vastErrors = 0;
  private _bidRevenue = 0;
  private _impressions = 0;
  private _starts = 0;
  private _firstQuartiles = 0;
  private _midpoints = 0;
  private _thirdQuartiles = 0;
  private _completes = 0;
  private _clicks = 0;
  private _latencySum = 0;
  private _latencyCount = 0;
  private _currentRunning = 0;

  private _byGeo = new Map<string, { requests: number; bids: number; impressions: number }>();
  private _byApp = new Map<string, { requests: number; bids: number; impressions: number }>();
  private _byDevice = new Map<string, { requests: number; bids: number }>();

  // Recent session log for dashboard table (ring buffer)
  private _recentSessions: SessionLogEntry[] = [];
  private readonly RECENT_MAX = 500;

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

  // --- Prometheus-compatible methods ---
  sessionsRunning(count: number): void {
    this._currentRunning = count;
    this.sessionsRunningGauge.set(count);
  }

  trackingEventFired(eventType: string): void {
    this.trackingEventsTotal.inc({ event_type: eventType });
    switch (eventType) {
      case 'impression': this._impressions++; break;
      case 'start': this._starts++; break;
      case 'firstQuartile': this._firstQuartiles++; break;
      case 'midpoint': this._midpoints++; break;
      case 'thirdQuartile': this._thirdQuartiles++; break;
      case 'complete': this._completes++; break;
      case 'click': this._clicks++; break;
    }
  }

  vastRequest(): void { this.vastRequestsTotal.inc(); this._vastRequests++; }
  vastError(): void { this.vastErrorsTotal.inc(); this._vastErrors++; }
  rtbRequest(): void { this.rtbRequestsTotal.inc(); this._rtbRequests++; }
  rtbError(): void { this.rtbErrorsTotal.inc(); this._rtbErrors++; }

  // --- Extended stats methods ---
  sessionCreated(): void { this._sessionsTotal++; }
  sessionCompleted(): void { this._sessionsCompleted++; }
  sessionFailed(): void { this._sessionsFailed++; }
  rtbNoBid(): void { this._rtbNoBids++; }

  bidReceived(price: number, geo?: string, appBundle?: string, deviceOs?: string): void {
    this._bidsReceived++;
    this._bidRevenue += price;

    if (geo) {
      const g = this._byGeo.get(geo) || { requests: 0, bids: 0, impressions: 0 };
      g.bids++;
      this._byGeo.set(geo, g);
    }
    if (appBundle) {
      const a = this._byApp.get(appBundle) || { requests: 0, bids: 0, impressions: 0 };
      a.bids++;
      this._byApp.set(appBundle, a);
    }
    if (deviceOs) {
      const d = this._byDevice.get(deviceOs) || { requests: 0, bids: 0 };
      d.bids++;
      this._byDevice.set(deviceOs, d);
    }
  }

  rtbRequestWithContext(geo?: string, appBundle?: string, deviceOs?: string): void {
    if (geo) {
      const g = this._byGeo.get(geo) || { requests: 0, bids: 0, impressions: 0 };
      g.requests++;
      this._byGeo.set(geo, g);
    }
    if (appBundle) {
      const a = this._byApp.get(appBundle) || { requests: 0, bids: 0, impressions: 0 };
      a.requests++;
      this._byApp.set(appBundle, a);
    }
    if (deviceOs) {
      const d = this._byDevice.get(deviceOs) || { requests: 0, bids: 0 };
      d.requests++;
      this._byDevice.set(deviceOs, d);
    }
  }

  impressionWithGeo(geo?: string, appBundle?: string): void {
    if (geo) {
      const g = this._byGeo.get(geo) || { requests: 0, bids: 0, impressions: 0 };
      g.impressions++;
      this._byGeo.set(geo, g);
    }
    if (appBundle) {
      const a = this._byApp.get(appBundle) || { requests: 0, bids: 0, impressions: 0 };
      a.impressions++;
      this._byApp.set(appBundle, a);
    }
  }

  recordLatency(ms: number): void {
    this._latencySum += ms;
    this._latencyCount++;
  }

  addSessionLog(entry: SessionLogEntry): void {
    this._recentSessions.unshift(entry);
    if (this._recentSessions.length > this.RECENT_MAX) {
      this._recentSessions.length = this.RECENT_MAX;
    }
  }

  updateSessionLog(sessionId: string, update: Partial<SessionLogEntry>): void {
    const entry = this._recentSessions.find(e => e.sessionId === sessionId);
    if (entry) Object.assign(entry, update);
  }

  getRecentSessions(limit = 100): SessionLogEntry[] {
    return this._recentSessions.slice(0, limit);
  }

  // --- Snapshot for dashboard ---
  getStats(): StatsSnapshot {
    const winRate = this._rtbRequests > 0
      ? ((this._bidsReceived / this._rtbRequests) * 100).toFixed(1) + '%'
      : '0%';
    const completionRate = this._starts > 0
      ? ((this._completes / this._starts) * 100).toFixed(1) + '%'
      : '0%';
    const avgBidPrice = this._bidsReceived > 0 ? this._bidRevenue / this._bidsReceived : 0;
    const avgCPM = avgBidPrice * 1000;
    const avgLatencyMs = this._latencyCount > 0 ? Math.round(this._latencySum / this._latencyCount) : 0;

    const byGeo: StatsSnapshot['byGeo'] = {};
    for (const [k, v] of this._byGeo) byGeo[k] = { ...v };

    const byApp: StatsSnapshot['byApp'] = {};
    for (const [k, v] of this._byApp) byApp[k] = { ...v };

    const byDevice: StatsSnapshot['byDevice'] = {};
    for (const [k, v] of this._byDevice) byDevice[k] = { ...v };

    return {
      uptime: process.uptime(),
      sessionsRunning: this._currentRunning,
      sessionsTotal: this._sessionsTotal,
      sessionsCompleted: this._sessionsCompleted,
      sessionsFailed: this._sessionsFailed,
      rtbRequests: this._rtbRequests,
      rtbErrors: this._rtbErrors,
      rtbNoBids: this._rtbNoBids,
      bidsReceived: this._bidsReceived,
      winRate,
      vastRequests: this._vastRequests,
      vastErrors: this._vastErrors,
      bidRevenue: +this._bidRevenue.toFixed(6),
      avgBidPrice: +avgBidPrice.toFixed(6),
      avgCPM: +avgCPM.toFixed(2),
      impressions: this._impressions,
      starts: this._starts,
      firstQuartiles: this._firstQuartiles,
      midpoints: this._midpoints,
      thirdQuartiles: this._thirdQuartiles,
      completes: this._completes,
      clicks: this._clicks,
      completionRate,
      avgLatencyMs,
      byGeo,
      byApp,
      byDevice,
    };
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  async getContentType(): Promise<string> {
    return this.registry.contentType;
  }
}

export interface SessionLogEntry {
  sessionId: string;
  createdAt: string;     // ISO
  state: string;
  appBundle: string;
  appName: string;
  deviceOs: string;
  deviceModel: string;
  geo: string;           // country code (e.g. "USA")
  city: string;
  ip: string;
  bidPrice?: number;
  bidSeat?: string;
  bidCrid?: string;
  latencyMs?: number;
  error?: string;
  events: string[];      // tracking events fired
  durationMs?: number;
}
