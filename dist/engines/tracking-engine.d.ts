import type { TrackingEventType } from '../shared/types.js';
type FetchFn = (url: string, init?: RequestInit) => Promise<{
    ok: boolean;
}>;
export declare class TrackingEngine {
    private firedKeys;
    private sessionId;
    private fetchFn;
    constructor(sessionId: string, fetchFn?: FetchFn);
    fireEvent(event: TrackingEventType, urls: string[]): Promise<void>;
    hasFired(event: TrackingEventType): boolean;
    reset(): void;
}
export {};
//# sourceMappingURL=tracking-engine.d.ts.map