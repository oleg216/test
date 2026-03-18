import pino from 'pino';

const SENSITIVE_KEYS = ['ifa', 'ip', 'deviceId', 'carrier', 'userAgent'];

export function maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...data };
  for (const key of SENSITIVE_KEYS) {
    if (key in masked) {
      masked[key] = '***MASKED***';
    }
  }
  return masked;
}

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL || 'info',
  });
}

export const masterLogger = createLogger('master');
export const workerLogger = createLogger('worker');
