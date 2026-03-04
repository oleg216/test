import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { MAX_SESSIONS } from '../shared/constants.js';
import { SessionState } from '../shared/types.js';
const logger = createLogger('scheduler');
export class SessionScheduler {
    sessions = new Map();
    workerManager;
    metrics;
    constructor(workerManager, metrics) {
        this.workerManager = workerManager;
        this.metrics = metrics;
    }
    createSession(config) {
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached`);
        }
        const worker = this.workerManager.getLeastLoadedWorker();
        if (!worker) {
            throw new Error('No available workers');
        }
        const sessionId = uuid();
        const session = {
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
    createBatch(configs) {
        return configs.map(config => this.createSession(config));
    }
    stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        const workerId = this.workerManager.findWorkerForSession(sessionId);
        if (workerId !== null) {
            this.workerManager.sendToWorker(workerId, { type: 'stop-session', sessionId });
        }
        return true;
    }
    handleWorkerMessage(msg) {
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
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    getAllSessions() {
        return Array.from(this.sessions.values());
    }
    getActiveSessions() {
        return this.getAllSessions().filter(s => s.state !== SessionState.STOPPED &&
            !s.state.startsWith('ERROR_'));
    }
    get activeSessions() {
        return this.getActiveSessions().length;
    }
}
//# sourceMappingURL=scheduler.js.map