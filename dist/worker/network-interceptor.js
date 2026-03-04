import { createLogger } from '../shared/logger.js';
const logger = createLogger('network-interceptor');
const MEDIA_EXTENSIONS = ['.mp4', '.m3u8', '.ts', '.webm', '.mpd', '.m4s'];
const VAST_PATTERNS = ['/vast', '.xml', 'vast=', 'adtag'];
const TRACKING_PATTERNS = ['impression', 'track', 'pixel', 'beacon', 'event', 'quartile', 'complete'];
export function classifyRequest(url, method) {
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
export function setupNetworkInterceptor(page, sessionId, onLog) {
    const requestTimestamps = new Map();
    page.on('request', (request) => {
        const url = request.url();
        const method = request.method();
        const timestamp = Date.now();
        requestTimestamps.set(url, timestamp);
        const entry = {
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
        const entry = {
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
//# sourceMappingURL=network-interceptor.js.map