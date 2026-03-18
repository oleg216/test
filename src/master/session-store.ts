import Database from 'better-sqlite3';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import type { SessionLogEntry } from './metrics.js';

const logger = createLogger('session-store');

export class SessionStore {
  private db: Database.Database;
  private insertStmt!: Database.Statement;
  private upsertStmt!: Database.Statement;

  constructor(dbPath?: string) {
    const path = dbPath || resolve(process.cwd(), 'logs', 'sessions.db');
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
    logger.info({ path }, 'Session store initialized');
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL,
        app_bundle TEXT,
        app_name TEXT,
        device_os TEXT,
        device_model TEXT,
        geo TEXT,
        city TEXT,
        ip TEXT,
        bid_price REAL,
        bid_seat TEXT,
        latency_ms INTEGER,
        error TEXT,
        events TEXT,
        duration_ms INTEGER,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
      CREATE INDEX IF NOT EXISTS idx_sessions_geo ON sessions(geo);
      CREATE INDEX IF NOT EXISTS idx_sessions_app ON sessions(app_bundle);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, created_at, state, app_bundle, app_name, device_os, device_model, geo, city, ip, events)
      VALUES (@id, @created_at, @state, @app_bundle, @app_name, @device_os, @device_model, @geo, @city, @ip, @events)
    `);

    this.upsertStmt = this.db.prepare(`
      UPDATE sessions SET
        state = @state,
        bid_price = COALESCE(@bid_price, bid_price),
        bid_seat = COALESCE(@bid_seat, bid_seat),
        latency_ms = COALESCE(@latency_ms, latency_ms),
        error = COALESCE(@error, error),
        events = COALESCE(@events, events),
        duration_ms = COALESCE(@duration_ms, duration_ms),
        updated_at = datetime('now')
      WHERE id = @id
    `);
  }

  insertSession(entry: SessionLogEntry): void {
    try {
      this.insertStmt.run({
        id: entry.sessionId,
        created_at: entry.createdAt,
        state: entry.state,
        app_bundle: entry.appBundle,
        app_name: entry.appName,
        device_os: entry.deviceOs,
        device_model: entry.deviceModel,
        geo: entry.geo,
        city: entry.city,
        ip: entry.ip,
        events: JSON.stringify(entry.events),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId: entry.sessionId }, 'Failed to insert session');
    }
  }

  updateSession(sessionId: string, update: Partial<SessionLogEntry>): void {
    try {
      this.upsertStmt.run({
        id: sessionId,
        state: update.state || null,
        bid_price: update.bidPrice ?? null,
        bid_seat: update.bidSeat ?? null,
        latency_ms: update.latencyMs ?? null,
        error: update.error ?? null,
        events: update.events ? JSON.stringify(update.events) : null,
        duration_ms: update.durationMs ?? null,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId }, 'Failed to update session');
    }
  }

  getRecentSessions(limit = 100, offset = 0): SessionLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as SessionRow[];
    return rows.map(rowToEntry);
  }

  getSessionsByDate(date: string, limit = 500): SessionLogEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions WHERE created_at >= ? AND created_at < datetime(?, '+1 day') ORDER BY created_at DESC LIMIT ?",
    ).all(date, date, limit) as SessionRow[];
    return rows.map(rowToEntry);
  }

  getDailyStats(days = 7): DailyStat[] {
    return this.db.prepare(`
      SELECT
        date(created_at) as day,
        COUNT(*) as total,
        SUM(CASE WHEN state = 'STOPPED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN state LIKE 'ERROR_%' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN bid_price > 0 THEN 1 ELSE 0 END) as bids,
        COALESCE(SUM(bid_price), 0) as revenue,
        COALESCE(AVG(CASE WHEN bid_price > 0 THEN bid_price END), 0) as avg_bid,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        SUM(CASE WHEN events LIKE '%impression%' THEN 1 ELSE 0 END) as impressions,
        SUM(CASE WHEN events LIKE '%complete%' THEN 1 ELSE 0 END) as completes
      FROM sessions
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY day DESC
    `).all(days) as DailyStat[];
  }

  getTotalCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number }).cnt;
  }

  getAggregateStats(): AggregateStats {
    return this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'STOPPED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN state LIKE 'ERROR_%' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN state NOT IN ('STOPPED') AND state NOT LIKE 'ERROR_%' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN bid_price > 0 THEN 1 ELSE 0 END) as bids,
        SUM(CASE WHEN bid_price IS NULL OR bid_price = 0 THEN 1 ELSE 0 END) as no_bids,
        COALESCE(SUM(bid_price), 0) as revenue,
        COALESCE(AVG(CASE WHEN bid_price > 0 THEN bid_price END), 0) as avg_bid,
        COALESCE(AVG(CASE WHEN latency_ms > 0 THEN latency_ms END), 0) as avg_latency,
        SUM(CASE WHEN events LIKE '%impression%' THEN 1 ELSE 0 END) as impressions,
        SUM(CASE WHEN events LIKE '%start%' THEN 1 ELSE 0 END) as starts,
        SUM(CASE WHEN events LIKE '%firstQuartile%' THEN 1 ELSE 0 END) as first_quartiles,
        SUM(CASE WHEN events LIKE '%midpoint%' THEN 1 ELSE 0 END) as midpoints,
        SUM(CASE WHEN events LIKE '%thirdQuartile%' THEN 1 ELSE 0 END) as third_quartiles,
        SUM(CASE WHEN events LIKE '%complete%' THEN 1 ELSE 0 END) as completes,
        SUM(CASE WHEN events LIKE '%click%' THEN 1 ELSE 0 END) as clicks,
        SUM(CASE WHEN error LIKE '%resolve proxy%' THEN 1 ELSE 0 END) as err_proxy,
        SUM(CASE WHEN error LIKE '%No VAST%' OR error LIKE '%no-bid%' THEN 1 ELSE 0 END) as err_nobid,
        SUM(CASE WHEN error LIKE '%timeout%' OR error LIKE '%aborted%' THEN 1 ELSE 0 END) as err_timeout,
        SUM(CASE WHEN error LIKE '%VAST%' AND error NOT LIKE '%No VAST%' THEN 1 ELSE 0 END) as err_vast
      FROM sessions
    `).get() as AggregateStats;
  }

  getErrorBreakdown(): ErrorBreakdown[] {
    return this.db.prepare(`
      SELECT error, COUNT(*) as count
      FROM sessions
      WHERE error IS NOT NULL AND error != ''
      GROUP BY error
      ORDER BY count DESC
      LIMIT 20
    `).all() as ErrorBreakdown[];
  }

  close(): void {
    this.db.close();
  }
}

interface SessionRow {
  id: string;
  created_at: string;
  state: string;
  app_bundle: string;
  app_name: string;
  device_os: string;
  device_model: string;
  geo: string;
  city: string;
  ip: string;
  bid_price: number | null;
  bid_seat: string | null;
  latency_ms: number | null;
  error: string | null;
  events: string | null;
  duration_ms: number | null;
}

export interface DailyStat {
  day: string;
  total: number;
  completed: number;
  failed: number;
  bids: number;
  revenue: number;
  avg_bid: number;
  avg_latency: number;
  impressions: number;
  completes: number;
}

export interface AggregateStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
  bids: number;
  no_bids: number;
  revenue: number;
  avg_bid: number;
  avg_latency: number;
  impressions: number;
  starts: number;
  first_quartiles: number;
  midpoints: number;
  third_quartiles: number;
  completes: number;
  clicks: number;
  err_proxy: number;
  err_nobid: number;
  err_timeout: number;
  err_vast: number;
}

export interface ErrorBreakdown {
  error: string;
  count: number;
}

function rowToEntry(row: SessionRow): SessionLogEntry {
  return {
    sessionId: row.id,
    createdAt: row.created_at,
    state: row.state,
    appBundle: row.app_bundle,
    appName: row.app_name,
    deviceOs: row.device_os,
    deviceModel: row.device_model,
    geo: row.geo,
    city: row.city,
    ip: row.ip,
    bidPrice: row.bid_price ?? undefined,
    bidSeat: row.bid_seat ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    error: row.error ?? undefined,
    events: row.events ? JSON.parse(row.events) : [],
    durationMs: row.duration_ms ?? undefined,
  };
}
