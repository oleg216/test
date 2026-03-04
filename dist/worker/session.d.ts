import { SessionState } from '../shared/types.js';
import type { SessionConfig, SessionInfo } from '../shared/types.js';
export declare function isValidTransition(from: SessionState, to: SessionState): boolean;
export declare class SessionStateMachine {
    readonly id: string;
    private _state;
    readonly config?: SessionConfig;
    readonly createdAt: number;
    private updatedAt;
    retryCount: number;
    error?: string;
    constructor(id: string, config?: SessionConfig);
    get state(): SessionState;
    transition(to: SessionState): void;
    setError(state: SessionState, message: string): void;
    canRetry(): boolean;
    incrementRetry(): void;
    toInfo(): Omit<SessionInfo, 'workerId' | 'events'>;
}
//# sourceMappingURL=session.d.ts.map