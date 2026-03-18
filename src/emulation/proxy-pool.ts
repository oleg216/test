import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('proxy-pool');

let proxies: string[] = [];
let nextIndex = 0;

export function loadProxyPool(filePath?: string): string[] {
  const path = filePath || resolve(process.cwd(), 'data', 'proxies.txt');
  try {
    const raw = readFileSync(path, 'utf-8');
    proxies = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    nextIndex = 0;
    logger.info({ count: proxies.length }, 'Proxy pool loaded');
    return proxies;
  } catch {
    logger.warn({ filePath: path }, 'No proxy pool file found');
    return [];
  }
}

export function getProxyPoolSize(): number {
  return proxies.length;
}

export function getNextProxy(): string | null {
  if (proxies.length === 0) return null;
  const proxy = proxies[nextIndex % proxies.length];
  nextIndex++;
  return proxy;
}

export function getRandomProxy(): string | null {
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}
