import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { MAX_SESSIONS } from '../shared/constants.js';
import { WorkerManager } from './worker-manager.js';
import { MetricsRegistry } from './metrics.js';
import { SessionState } from '../shared/types.js';
import type { SessionConfig, SessionInfo, WorkerToMasterMessage } from '../shared/types.js';

const logger = createLogger('scheduler');

export class SessionScheduler {
  private sessions = new Map<string, SessionInfo>();
  private workerManager: WorkerManager;
  private metrics: MetricsRegistry;

  constructor(workerManager: WorkerManager, metrics: MetricsRegistry) {
    this.workerManager = workerManager;
    this.metrics = metrics;
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
          if (msg.metrics) {
            for (const [key] of Object.entries(msg.metrics)) {
              if (key.startsWith('tracking_')) {
                this.metrics.trackingEventFired(key.replace('tracking_', ''));
              }
            }
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
        }
        break;
      }
      case 'session-stopped': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = SessionState.STOPPED;
          session.updatedAt = Date.now();
        }
        this.workerManager.removeSessionFromWorker(msg.sessionId);
        this.metrics.sessionsRunning(this.activeSessions);
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
}
