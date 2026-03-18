import { fork, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import { MAX_WORKERS, SESSIONS_PER_WORKER, WORKER_MAX_SESSIONS_BEFORE_RESTART } from '../shared/constants.js';
import type { MasterToWorkerMessage, WorkerToMasterMessage, WorkerInfo } from '../shared/types.js';

const logger = createLogger('worker-manager');

interface WorkerHandle {
  process: ChildProcess;
  id: number;
  activeSessions: number;
  totalProcessed: number;
  memoryUsage: number;
  status: 'starting' | 'running' | 'restarting' | 'dead';
  sessionIds: Set<string>;
}

export class WorkerManager {
  private workers = new Map<number, WorkerHandle>();
  private sessionToWorker = new Map<string, number>();
  private nextId = 0;
  private _shuttingDown = false;
  private onSessionUpdate?: (msg: WorkerToMasterMessage) => void;

  constructor(onSessionUpdate: (msg: WorkerToMasterMessage) => void) {
    this.onSessionUpdate = onSessionUpdate;
  }

  async start(count?: number): Promise<void> {
    const numWorkers = Math.min(count || MAX_WORKERS, MAX_WORKERS);
    const readyPromises: Promise<void>[] = [];
    for (let i = 0; i < numWorkers; i++) {
      readyPromises.push(this.spawnWorker());
    }
    await Promise.all(readyPromises);
    logger.info({ count: numWorkers }, 'All workers ready');
  }

  private spawnWorker(): Promise<void> {
    const id = this.nextId++;
    const workerPath = resolve(process.cwd(), 'dist', 'worker', 'worker.js');
    const child = fork(workerPath, [], {
      env: { ...process.env, WORKER_ID: String(id) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const handle: WorkerHandle = {
      process: child,
      id,
      activeSessions: 0,
      totalProcessed: 0,
      memoryUsage: 0,
      status: 'starting',
      sessionIds: new Set(),
    };

    const readyPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn({ workerId: id }, 'Worker ready timeout, marking as running');
        handle.status = 'running';
        resolve();
      }, 30000);

      child.on('message', function onReady(msg: WorkerToMasterMessage) {
        if (msg.type === 'worker-ready') {
          clearTimeout(timeout);
          handle.status = 'running';
          logger.info({ workerId: id }, 'Worker ready');
          child.removeListener('message', onReady);
          resolve();
        }
      });
    });

    child.on('message', (msg: WorkerToMasterMessage) => {
      if (msg.type === 'worker-ready') return; // handled above
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
      if (currentHandle && currentHandle.status !== 'restarting' && !this._shuttingDown) {
        currentHandle.status = 'dead';
        this.cleanupWorkerSessions(currentHandle);
        this.workers.delete(id);
        this.spawnWorker();
      }
    });

    child.on('error', (err) => {
      logger.error({ workerId: id, err }, 'Worker error');
    });

    this.workers.set(id, handle);
    return readyPromise;
  }

  private cleanupWorkerSessions(handle: WorkerHandle): void {
    for (const sessionId of handle.sessionIds) {
      this.sessionToWorker.delete(sessionId);
    }
  }

  private restartWorker(id: number): void {
    const handle = this.workers.get(id);
    if (!handle) return;

    logger.info({ workerId: id, totalProcessed: handle.totalProcessed }, 'Restarting worker (memory management)');
    handle.status = 'restarting';
    this.cleanupWorkerSessions(handle);
    handle.process.kill('SIGTERM');
    this.workers.delete(id);
    this.spawnWorker();
  }

  getLeastLoadedWorker(): WorkerHandle | null {
    let best: WorkerHandle | null = null;
    for (const worker of this.workers.values()) {
      if (worker.status !== 'running') continue;
      if (worker.activeSessions >= SESSIONS_PER_WORKER) continue;
      if (!best || worker.activeSessions < best.activeSessions) {
        best = worker;
      }
    }
    return best;
  }

  sendToWorker(workerId: number, msg: MasterToWorkerMessage): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'running') return false;

    if (msg.type === 'create-session') {
      worker.sessionIds.add(msg.payload.sessionId);
      worker.activeSessions++;
      this.sessionToWorker.set(msg.payload.sessionId, workerId);
    }

    worker.process.send(msg);
    return true;
  }

  findWorkerForSession(sessionId: string): number | null {
    return this.sessionToWorker.get(sessionId) ?? null;
  }

  removeSessionFromWorker(sessionId: string): void {
    const workerId = this.sessionToWorker.get(sessionId);
    if (workerId === undefined) return;
    this.sessionToWorker.delete(sessionId);
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.sessionIds.delete(sessionId);
      worker.activeSessions = Math.max(0, worker.activeSessions - 1);
    }
  }

  getWorkersInfo(): WorkerInfo[] {
    return Array.from(this.workers.values()).map(w => ({
      id: w.id,
      pid: w.process.pid || 0,
      activeSessions: w.activeSessions,
      totalProcessed: w.totalProcessed,
      memoryUsage: w.memoryUsage,
      status: w.status,
    }));
  }

  get totalActiveSessions(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      count += w.activeSessions;
    }
    return count;
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this._shuttingDown = true;
    const exitPromises = Array.from(this.workers.values()).map(worker =>
      new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          logger.warn({ workerId: worker.id }, 'Worker did not exit in time, killing');
          worker.process.kill('SIGKILL');
          resolve();
        }, timeoutMs);
        worker.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        worker.process.kill('SIGTERM');
      }),
    );
    await Promise.all(exitPromises);
    this.workers.clear();
    this.sessionToWorker.clear();
  }
}
