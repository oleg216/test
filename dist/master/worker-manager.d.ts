import { type ChildProcess } from 'child_process';
import type { MasterToWorkerMessage, WorkerToMasterMessage, WorkerInfo } from '../shared/types.js';
interface WorkerHandle {
    process: ChildProcess;
    id: number;
    activeSessions: number;
    totalProcessed: number;
    memoryUsage: number;
    status: 'running' | 'restarting' | 'dead';
    sessionIds: Set<string>;
}
export declare class WorkerManager {
    private workers;
    private nextId;
    private onSessionUpdate?;
    constructor(onSessionUpdate: (msg: WorkerToMasterMessage) => void);
    start(count?: number): Promise<void>;
    private spawnWorker;
    private restartWorker;
    getLeastLoadedWorker(): WorkerHandle | null;
    sendToWorker(workerId: number, msg: MasterToWorkerMessage): boolean;
    findWorkerForSession(sessionId: string): number | null;
    removeSessionFromWorker(sessionId: string): void;
    getWorkersInfo(): WorkerInfo[];
    get totalActiveSessions(): number;
    shutdown(): Promise<void>;
}
export {};
//# sourceMappingURL=worker-manager.d.ts.map