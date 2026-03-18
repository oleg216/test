function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for env ${name}: "${raw}"`);
  }
  return parsed;
}

function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid float for env ${name}: "${raw}"`);
  }
  return parsed;
}

export const MAX_SESSIONS = parseIntEnv('MAX_SESSIONS', 200);
export const MAX_WORKERS = parseIntEnv('MAX_WORKERS', 20);
export const SESSIONS_PER_WORKER = parseIntEnv('SESSIONS_PER_WORKER', 10);
export const RTB_TIMEOUT_MS = parseIntEnv('RTB_TIMEOUT_MS', 2000);
export const VAST_TIMEOUT_MS = parseIntEnv('VAST_TIMEOUT_MS', 3000);
export const MEDIA_TIMEOUT_MS = parseIntEnv('MEDIA_TIMEOUT_MS', 5000);
export const MAX_WRAPPER_DEPTH = 5;
export const WRAPPER_TIMEOUT_MS = 3000;
export const MAX_RETRIES = 2;
export const WORKER_MAX_SESSIONS_BEFORE_RESTART = 100;
export const DEFAULT_BIDFLOOR_VIDEO = 2.0;
export const PORT = parseIntEnv('PORT', 3080);
export const DEFAULT_CLICK_PROBABILITY = 0.035;
export const PIXALATE_API_KEY = process.env.PIXALATE_API_KEY || '';
export const PIXALATE_BASE_URL = process.env.PIXALATE_BASE_URL || 'https://api.pixalate.com';
export const PIXALATE_THRESHOLD = parseFloatEnv('PIXALATE_THRESHOLD', 0.25);
export const DEFAULT_PROXY = process.env.RTB_PROXY || '';
