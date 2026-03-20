import pino from 'pino';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

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

// When LOG_DIR is set, all pino logs go to per-process files:
//   LOG_DIR/master.log   (master process)
//   LOG_DIR/worker-0.log (worker 0)
//   LOG_DIR/worker-1.log (worker 1)
//   ...
let cachedDest: pino.DestinationStream | null = null;
let destResolved = false;

function getFileDest(): pino.DestinationStream | null {
  if (destResolved) return cachedDest;
  destResolved = true;

  const logDir = process.env.LOG_DIR;
  if (!logDir) return null;

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const workerId = process.env.WORKER_ID;
  const fileName = workerId != null ? `worker-${workerId}.log` : 'master.log';
  cachedDest = pino.destination(resolve(logDir, fileName));
  return cachedDest;
}

export function createLogger(name: string) {
  const level = process.env.LOG_LEVEL || 'info';
  const dest = getFileDest();
  return dest ? pino({ name, level }, dest) : pino({ name, level });
}

export const masterLogger = createLogger('master');
export const workerLogger = createLogger('worker');
