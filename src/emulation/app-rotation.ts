import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('app-rotation');

export interface AppEntry {
  bundle: string;
  name: string;
  storeurl: string;
  ver: string;
}

let apps: AppEntry[] = [];
let nextIndex = 0;

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

export function loadAppRotation(filePath?: string): AppEntry[] {
  const path = filePath || resolve(process.cwd(), 'data', 'app_rotation.csv');
  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    // Skip header
    apps = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (!cols[0]) continue;
      apps.push({
        bundle: cols[0],
        name: cols[1] || cols[0],
        storeurl: cols[2] || '',
        ver: cols[3] || '1.0.0',
      });
    }
    nextIndex = 0;
    logger.info({ count: apps.length }, 'App rotation loaded');
    return apps;
  } catch {
    logger.warn({ filePath: path }, 'No app rotation file found');
    return [];
  }
}

export function getNextApp(): AppEntry | null {
  if (apps.length === 0) return null;
  const app = apps[nextIndex % apps.length];
  nextIndex++;
  return app;
}

export function getRandomApp(): AppEntry | null {
  if (apps.length === 0) return null;
  return apps[Math.floor(Math.random() * apps.length)];
}

export function getAppPoolSize(): number {
  return apps.length;
}
