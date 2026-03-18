import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { MAX_SESSIONS } from '../shared/constants.js';
import { WorkerManager } from './worker-manager.js';
import { MetricsRegistry } from './metrics.js';
import { SessionState } from '../shared/types.js';
import type { SessionConfig, SessionInfo, WorkerToMasterMessage } from '../shared/types.js';
import { SessionStore } from './session-store.js';

const logger = createLogger('scheduler');
const SESSION_CLEANUP_DELAY_MS = 60_000;

export class SessionScheduler {
  private sessions = new Map<string, SessionInfo>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private workerManager: WorkerManager;
  private metrics: MetricsRegistry;
  private store: SessionStore;

  constructor(workerManager: WorkerManager, metrics: MetricsRegistry, store: SessionStore) {
    this.workerManager = workerManager;
    this.metrics = metrics;
    this.store = store;
  }

  createSession(config: SessionConfig): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached`);
    }

    const worker = this.workerManager.getLeastLoadedWorker();
    if (!worker) {
      throw new Error('No available workers');
    }

    const sessionId = uuid();
    const session: SessionInfo = {
      id: sessionId,
      state: SessionState.CREATED,
      workerId: worker.id,
      config,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
      retryCount: 0,
    };

    this.sessions.set(sessionId, session);
    this.workerManager.sendToWorker(worker.id, {
      type: 'create-session',
      payload: { ...config, sessionId },
    });

    this.metrics.sessionsRunning(this.activeSessions);
    this.metrics.sessionCreated();

    // Add to session log for dashboard
    const logEntry = {
      sessionId,
      createdAt: new Date().toISOString(),
      state: SessionState.CREATED,
      appBundle: config.appBundle,
      appName: config.appName,
      deviceOs: config.device.os,
      deviceModel: config.device.model,
      geo: config.device.geo?.country || '',
      city: config.device.geo?.city || '',
      ip: config.device.ip,
      events: [] as string[],
    };
    this.metrics.addSessionLog(logEntry);
    this.store.insertSession(logEntry);

    logger.info({ sessionId, workerId: worker.id }, 'Session created');
    return session;
  }

  createBatch(configs: SessionConfig[]): SessionInfo[] {
    return configs.map(config => this.createSession(config));
  }

  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const workerId = this.workerManager.findWorkerForSession(sessionId);
    if (workerId !== null) {
      this.workerManager.sendToWorker(workerId, { type: 'stop-session', sessionId });
    }

    return true;
  }

  handleWorkerMessage(msg: WorkerToMasterMessage): void {
    switch (msg.type) {
      case 'session-update': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = msg.state;
          session.updatedAt = Date.now();

          if (msg.state === SessionState.RTB_REQUESTING) {
            this.metrics.rtbRequest();
            this.metrics.rtbRequestWithContext(
              session.config.device.geo?.country,
              session.config.appBundle,
              session.config.device.os,
            );
          }
          if (msg.state === SessionState.VAST_RESOLVING) this.metrics.vastRequest();

          // Track bid price from metrics payload
          if (msg.metrics) {
            for (const key of Object.keys(msg.metrics)) {
              if (key.startsWith('tracking_')) {
                const eventType = key.replace('tracking_', '');
                this.metrics.trackingEventFired(eventType);

                // Track impression with geo context
                if (eventType === 'impression') {
                  this.metrics.impressionWithGeo(
                    session.config.device.geo?.country,
                    session.config.appBundle,
                  );
                }

                // Update session log events
                this.metrics.updateSessionLog(msg.sessionId, {
                  state: msg.state,
                  events: [...(this.getSessionLogEvents(msg.sessionId) || []), eventType],
                });
              }
              if (key === 'bid_price') {
                this.metrics.bidReceived(
                  msg.metrics[key],
                  session.config.device.geo?.country,
                  session.config.appBundle,
                  session.config.device.os,
                );
                this.metrics.updateSessionLog(msg.sessionId, { bidPrice: msg.metrics[key] });
              }
              if (key === 'bid_seat') {
                this.metrics.updateSessionLog(msg.sessionId, { bidSeat: String(msg.metrics[key]) });
              }
              if (key === 'rtb_latency_ms') {
                this.metrics.recordLatency(msg.metrics[key]);
                this.metrics.updateSessionLog(msg.sessionId, { latencyMs: msg.metrics[key] });
              }
              if (key === 'no_bid') {
                this.metrics.rtbNoBid();
              }
            }
          }

          this.metrics.updateSessionLog(msg.sessionId, { state: msg.state });
          // Persist final metrics snapshot to DB
          const currentEntry = this.metrics.getSessionLogEntry(msg.sessionId);
          if (currentEntry) {
            this.store.updateSession(msg.sessionId, currentEntry);
          }
        }
        break;
      }
      case 'session-error': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = msg.state;
          session.error = msg.error;
          session.updatedAt = Date.now();
          if (msg.state === SessionState.ERROR_VAST) this.metrics.vastError();
          if (msg.state === SessionState.ERROR_NETWORK) this.metrics.rtbError();
          this.metrics.sessionFailed();
          this.metrics.updateSessionLog(msg.sessionId, {
            state: msg.state,
            error: msg.error,
          });
          this.store.updateSession(msg.sessionId, { state: msg.state, error: msg.error });
        }
        this.workerManager.removeSessionFromWorker(msg.sessionId);
        this.metrics.sessionsRunning(this.activeSessions);
        this.scheduleCleanup(msg.sessionId);
        break;
      }
      case 'session-stopped': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = SessionState.STOPPED;
          session.updatedAt = Date.now();
          const durationMs = session.updatedAt - session.createdAt;
          const durationSec = durationMs / 1000;
          this.metrics.sessionDuration.observe(durationSec);
          this.metrics.sessionCompleted();
          this.metrics.updateSessionLog(msg.sessionId, {
            state: SessionState.STOPPED,
            durationMs,
          });
          const finalEntry = this.metrics.getSessionLogEntry(msg.sessionId);
          if (finalEntry) {
            this.store.updateSession(msg.sessionId, finalEntry);
          }
        }
        this.workerManager.removeSessionFromWorker(msg.sessionId);
        this.metrics.sessionsRunning(this.activeSessions);
        this.scheduleCleanup(msg.sessionId);
        break;
      }
      case 'worker-stats':
        break;
    }
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): SessionInfo[] {
    return this.getAllSessions().filter(s =>
      s.state !== SessionState.STOPPED &&
      !s.state.startsWith('ERROR_')
    );
  }

  get activeSessions(): number {
    return this.getActiveSessions().length;
  }

  private getSessionLogEvents(sessionId: string): string[] | undefined {
    return this.metrics.getSessionLogEntry(sessionId)?.events;
  }

  shutdown(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.sessions.clear();
    this.store.close();
  }

  private scheduleCleanup(sessionId: string): void {
    if (this.cleanupTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.sessions.delete(sessionId);
      this.cleanupTimers.delete(sessionId);
      logger.debug({ sessionId }, 'Session cleaned up from memory');
    }, SESSION_CLEANUP_DELAY_MS);
    this.cleanupTimers.set(sessionId, timer);
  }
}
