import { fork } from 'child_process';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import { MAX_WORKERS, SESSIONS_PER_WORKER, WORKER_MAX_SESSIONS_BEFORE_RESTART } from '../shared/constants.js';
const logger = createLogger('worker-manager');
export class WorkerManager {
    workers = new Map();
    nextId = 0;
    onSessionUpdate;
    constructor(onSessionUpdate) {
        this.onSessionUpdate = onSessionUpdate;
    }
    async start(count) {
        const numWorkers = Math.min(count || MAX_WORKERS, MAX_WORKERS);
        for (let i = 0; i < numWorkers; i++) {
            this.spawnWorker();
        }
        logger.info({ count: numWorkers }, 'Workers started');
    }
    spawnWorker() {
        const id = this.nextId++;
        const workerPath = resolve(process.cwd(), 'dist', 'worker', 'worker.js');
        const child = fork(workerPath, [], {
            env: { ...process.env, WORKER_ID: String(id) },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        });
        const handle = {
            process: child,
            id,
            activeSessions: 0,
            totalProcessed: 0,
            memoryUsage: 0,
            status: 'running',
            sessionIds: new Set(),
        };
        child.on('message', (msg) => {
            if (msg.type === 'worker-stats') {
                handle.activeSessions = msg.activeSessions;
                handle.totalProcessed = msg.totalProcessed;
                handle.memoryUsage = msg.memoryUsage;
                if (msg.totalProcessed >= WORKER_MAX_SESSIONS_BEFORE_RESTART && msg.activeSessions === 0) {
                    this.restartWorker(id);
                }
            }
            this.onSessionUpdate?.(msg);
        });
        child.on('exit', (code) => {
            logger.warn({ workerId: id, code }, 'Worker exited');
            const currentHandle = this.workers.get(id);
            if (currentHandle && currentHandle.status !== 'restarting') {
                currentHandle.status = 'dead';
                this.workers.delete(id);
                this.spawnWorker();
            }
        });
        child.on('error', (err) => {
            logger.error({ workerId: id, err }, 'Worker error');
        });
        this.workers.set(id, handle);
        return handle;
    }
    restartWorker(id) {
        const handle = this.workers.get(id);
        if (!handle)
            return;
        logger.info({ workerId: id, totalProcessed: handle.totalProcessed }, 'Restarting worker (memory management)');
        handle.status = 'restarting';
        handle.process.kill('SIGTERM');
        this.workers.delete(id);
        this.spawnWorker();
    }
    getLeastLoadedWorker() {
        let best = null;
        for (const worker of this.workers.values()) {
            if (worker.status !== 'running')
                continue;
            if (worker.activeSessions >= SESSIONS_PER_WORKER)
                continue;
            if (!best || worker.activeSessions < best.activeSessions) {
                best = worker;
            }
        }
        return best;
    }
    sendToWorker(workerId, msg) {
        const worker = this.workers.get(workerId);
        if (!worker || worker.status !== 'running')
            return false;
        if (msg.type === 'create-session') {
            worker.sessionIds.add(msg.payload.sessionId);
            worker.activeSessions++;
        }
        worker.process.send(msg);
        return true;
    }
    findWorkerForSession(sessionId) {
        for (const [id, worker] of this.workers) {
            if (worker.sessionIds.has(sessionId))
                return id;
        }
        return null;
    }
    removeSessionFromWorker(sessionId) {
        for (const worker of this.workers.values()) {
            if (worker.sessionIds.delete(sessionId)) {
                worker.activeSessions = Math.max(0, worker.activeSessions - 1);
                break;
            }
        }
    }
    getWorkersInfo() {
        return Array.from(this.workers.values()).map(w => ({
            id: w.id,
            pid: w.process.pid || 0,
            activeSessions: w.activeSessions,
            totalProcessed: w.totalProcessed,
            memoryUsage: w.memoryUsage,
            status: w.status,
        }));
    }
    get totalActiveSessions() {
        let count = 0;
        for (const w of this.workers.values()) {
            count += w.activeSessions;
        }
        return count;
    }
    async shutdown() {
        for (const worker of this.workers.values()) {
            worker.process.kill('SIGTERM');
        }
        this.workers.clear();
    }
}
//# sourceMappingURL=worker-manager.js.map