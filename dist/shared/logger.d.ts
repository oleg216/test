import pino from 'pino';
export declare function maskSensitiveData(data: Record<string, unknown>): Record<string, unknown>;
export declare function createLogger(name: string): pino.Logger<never, boolean>;
export declare const masterLogger: pino.Logger<never, boolean>;
export declare const workerLogger: pino.Logger<never, boolean>;
//# sourceMappingURL=logger.d.ts.map