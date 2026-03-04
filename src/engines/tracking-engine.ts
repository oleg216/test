import { v4 as uuid } from 'uuid';
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

    const fires = urls.map(async (url) => {
      try {
        const pixelId = uuid();
        logger.info({ sessionId: this.sessionId, event, url, pixelId }, 'Firing tracking pixel');
        await this.fetchFn(url, {
          method: 'GET',
          headers: { 'X-Idempotency-Key': pixelId },
        });
      } catch (err) {
        logger.error({ sessionId: this.sessionId, event, url, err }, 'Tracking pixel failed');
      }
    });

    await Promise.allSettled(fires);
  }

  hasFired(event: TrackingEventType): boolean {
    return this.firedKeys.has(`${this.sessionId}:${event}`);
  }

  reset(): void {
    this.firedKeys.clear();
  }
}
