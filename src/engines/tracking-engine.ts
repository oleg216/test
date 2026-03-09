import { createLogger } from '../shared/logger.js';
import type { TrackingEventType } from '../shared/types.js';

const logger = createLogger('tracking-engine');

type FetchFn = (url: string, init?: RequestInit) => Promise<{ ok: boolean }>;

export class TrackingEngine {
  private firedKeys = new Set<string>();
  private sessionId: string;
  private fetchFn: FetchFn;

  constructor(sessionId: string, fetchFn?: FetchFn) {
    this.sessionId = sessionId;
    this.fetchFn = fetchFn || ((url, init) => fetch(url, init).then(r => ({ ok: r.ok })));
  }

  async fireEvent(event: TrackingEventType, urls: string[]): Promise<void> {
    const idempotencyKey = `${this.sessionId}:${event}`;
    if (this.firedKeys.has(idempotencyKey)) {
      logger.info({ sessionId: this.sessionId, event }, 'Tracking event already fired, skipping');
      return;
    }

    this.firedKeys.add(idempotencyKey);

    // Fire sequentially with small random delays — real SDKs don't blast all URLs at once
    for (const url of urls) {
      try {
        logger.info({ sessionId: this.sessionId, event, url }, 'Firing tracking pixel');
        await this.fetchFn(url, { method: 'GET' });
      } catch (err) {
        logger.error({ sessionId: this.sessionId, event, url, err }, 'Tracking pixel failed');
      }
      // Small delay between multiple tracking URLs for the same event (20-80ms)
      if (urls.length > 1) {
        await new Promise(r => setTimeout(r, 20 + Math.random() * 60));
      }
    }
  }

  hasFired(event: TrackingEventType): boolean {
    return this.firedKeys.has(`${this.sessionId}:${event}`);
  }

  reset(): void {
    this.firedKeys.clear();
  }
}
