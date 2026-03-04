import { createLogger } from '../shared/logger.js';
import { MAX_WRAPPER_DEPTH, WRAPPER_TIMEOUT_MS } from '../shared/constants.js';
const logger = createLogger('vast-resolver');
export function parseDuration(duration) {
    const parts = duration.split(':').map(Number);
    if (parts.length !== 3)
        return 0;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
function extractCdata(text) {
    return text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}
export function parseVastXml(xml) {
    const trackingEvents = new Map();
    const impressionUrls = [];
    const errorUrls = [];
    const isWrapper = /<Wrapper[\s>]/i.test(xml);
    const type = isWrapper ? 'wrapper' : 'inline';
    const impressionMatches = xml.matchAll(/<Impression[^>]*>([\s\S]*?)<\/Impression>/gi);
    for (const match of impressionMatches) {
        impressionUrls.push(extractCdata(match[1]));
    }
    const errorMatches = xml.matchAll(/<Error[^>]*>([\s\S]*?)<\/Error>/gi);
    for (const match of errorMatches) {
        errorUrls.push(extractCdata(match[1]));
    }
    if (isWrapper) {
        const tagMatch = xml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
        const vastTagUri = tagMatch ? extractCdata(tagMatch[1]) : undefined;
        return { type, trackingEvents, impressionUrls, errorUrls, vastTagUri };
    }
    const trackingMatches = xml.matchAll(/<Tracking\s+event="(\w+)"[^>]*>([\s\S]*?)<\/Tracking>/gi);
    for (const match of trackingMatches) {
        const event = match[1];
        const url = extractCdata(match[2]);
        if (!trackingEvents.has(event)) {
            trackingEvents.set(event, []);
        }
        trackingEvents.get(event).push(url);
    }
    const durationMatch = xml.match(/<Duration[^>]*>([\s\S]*?)<\/Duration>/i);
    const duration = durationMatch ? parseDuration(durationMatch[1].trim()) : 0;
    const mediaMatch = xml.match(/<MediaFile\s[^>]*>([\s\S]*?)<\/MediaFile>/i);
    const mediaUrl = mediaMatch ? extractCdata(mediaMatch[1]) : undefined;
    return { type, mediaUrl, duration, trackingEvents, impressionUrls, errorUrls };
}
export async function resolveVast(vastUrlOrXml, fetchFn = defaultFetch, depth = 0) {
    if (depth > MAX_WRAPPER_DEPTH) {
        throw new Error(`VAST wrapper depth exceeded (max ${MAX_WRAPPER_DEPTH})`);
    }
    let xml;
    if (vastUrlOrXml.trim().startsWith('<')) {
        xml = vastUrlOrXml;
    }
    else {
        xml = await fetchWithTimeout(vastUrlOrXml, fetchFn);
    }
    const parsed = parseVastXml(xml);
    if (parsed.type === 'wrapper' && parsed.vastTagUri) {
        logger.info({ depth, uri: parsed.vastTagUri }, 'Following VAST wrapper');
        const inner = await resolveVast(parsed.vastTagUri, fetchFn, depth + 1);
        inner.impressionUrls.push(...parsed.impressionUrls);
        for (const [event, urls] of parsed.trackingEvents) {
            const existing = inner.trackingEvents.get(event) || [];
            inner.trackingEvents.set(event, [...existing, ...urls]);
        }
        return inner;
    }
    return {
        mediaUrl: parsed.mediaUrl || '',
        duration: parsed.duration || 0,
        trackingEvents: parsed.trackingEvents,
        impressionUrls: parsed.impressionUrls,
        errorUrls: parsed.errorUrls,
    };
}
async function fetchWithTimeout(url, fetchFn) {
    return Promise.race([
        fetchFn(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`VAST fetch timeout: ${url}`)), WRAPPER_TIMEOUT_MS)),
    ]);
}
async function defaultFetch(url) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`VAST fetch failed: ${response.status}`);
    return response.text();
}
//# sourceMappingURL=vast-resolver.js.map