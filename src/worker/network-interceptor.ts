import type { Page } from 'playwright';
import { createLogger } from '../shared/logger.js';
import type { NetworkLogEntry } from '../shared/types.js';

const logger = createLogger('network-interceptor');

type Classification = 'rtb' | 'vast' | 'media' | 'tracking' | 'content';

const MEDIA_EXTENSIONS = ['.mp4', '.m3u8', '.ts', '.webm', '.mpd', '.m4s'];
const VAST_PATTERNS = ['/vast', '.xml', 'vast=', 'adtag'];
const TRACKING_PATTERNS = ['impression', 'track', 'pixel', 'beacon', 'event', 'quartile', 'complete'];

export function classifyRequest(url: string, method: string): Classification {
  const lowerUrl = url.toLowerCase();

  if (method === 'POST' && (lowerUrl.includes('/bid') || lowerUrl.includes('/openrtb') || lowerUrl.includes('/auction'))) {
    return 'rtb';
  }

  if (VAST_PATTERNS.some(p => lowerUrl.includes(p))) {
    return 'vast';
  }

  if (MEDIA_EXTENSIONS.some(ext => lowerUrl.includes(ext))) {
    return 'media';
  }

  if (TRACKING_PATTERNS.some(p => lowerUrl.includes(p))) {
    return 'tracking';
  }

  return 'content';
}

export function setupNetworkInterceptor(
  page: Page,
  sessionId: string,
  onLog: (entry: NetworkLogEntry) => void,
): void {
  const requestTimestamps = new Map<string, number>();

  page.on('request', (request) => {
    const url = request.url();
    const method = request.method();
    const timestamp = Date.now();
    requestTimestamps.set(url, timestamp);

    const entry: NetworkLogEntry = {
      sessionId,
      timestamp,
      url,
      method,
      classification: classifyRequest(url, method),
      direction: 'request',
    };
    onLog(entry);
  });

  page.on('response', (response) => {
    const url = response.url();
    const method = response.request().method();
    const timestamp = Date.now();
    const startTime = requestTimestamps.get(url);

    const entry: NetworkLogEntry = {
      sessionId,
      timestamp,
      url,
      method,
      status: response.status(),
      classification: classifyRequest(url, method),
      direction: 'response',
      duration: startTime ? timestamp - startTime : undefined,
    };
    onLog(entry);
    requestTimestamps.delete(url);
  });
}
