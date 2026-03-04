import type { Page } from 'playwright';
import type { NetworkLogEntry } from '../shared/types.js';
type Classification = 'rtb' | 'vast' | 'media' | 'tracking' | 'content';
export declare function classifyRequest(url: string, method: string): Classification;
export declare function setupNetworkInterceptor(page: Page, sessionId: string, onLog: (entry: NetworkLogEntry) => void): void;
export {};
//# sourceMappingURL=network-interceptor.d.ts.map