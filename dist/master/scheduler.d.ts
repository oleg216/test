import { WorkerManager } from './worker-manager.js';
import { MetricsRegistry } from './metrics.js';
import type { SessionConfig, SessionInfo, WorkerToMasterMessage } from '../shared/types.js';
export declare class SessionScheduler {
    private sessions;
    private workerManager;
    private metrics;
    constructor(workerManager: WorkerManager, metrics: MetricsRegistry);
    createSession(config: SessionConfig): SessionInfo;
    createBatch(configs: SessionConfig[]): SessionInfo[];
    stopSession(sessionId: string): boolean;
    handleWorkerMessage(msg: WorkerToMasterMessage): void;
    getSession(sessionId: string): SessionInfo | undefined;
    getAllSessions(): SessionInfo[];
    getActiveSessions(): SessionInfo[];
    get activeSessions(): number;
}
//# sourceMappingURL=scheduler.d.ts.map