import { type BrowserContext, type Page } from 'playwright';
import type { DeviceProfile, NetworkProfile } from '../shared/types.js';
export declare class BrowserPool {
    private browser;
    private contexts;
    init(): Promise<void>;
    createContext(sessionId: string, device: DeviceProfile, networkEmulation?: NetworkProfile): Promise<{
        context: BrowserContext;
        page: Page;
    }>;
    closeContext(sessionId: string): Promise<void>;
    destroy(): Promise<void>;
    get activeContexts(): number;
}
//# sourceMappingURL=browser-pool.d.ts.map