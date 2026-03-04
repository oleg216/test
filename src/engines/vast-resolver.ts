import { createLogger } from '../shared/logger.js';
import { MAX_WRAPPER_DEPTH, WRAPPER_TIMEOUT_MS } from '../shared/constants.js';
import type { VastCreative, TrackingEventType } from '../shared/types.js';

const logger = createLogger('vast-resolver');

export interface VastParseResult {
  type: 'inline' | 'wrapper';
  mediaUrl?: string;
  duration?: number;
  trackingEvents: Map<TrackingEventType, string[]>;
  impressionUrls: string[];
  errorUrls: string[];
  vastTagUri?: string;
}

export function parseDuration(duration: string): number {
  const parts = duration.split(':').map(Number);
  if (parts.length !== 3) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function extractCdata(text: string): string {
  return text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

export function parseVastXml(xml: string): VastParseResult {
  const trackingEvents = new Map<TrackingEventType, string[]>();
  const impressionUrls: string[] = [];
  const errorUrls: string[] = [];

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
    const event = match[1] as TrackingEventType;
    const url = extractCdata(match[2]);
    if (!trackingEvents.has(event)) {
      trackingEvents.set(event, []);
    }
    trackingEvents.get(event)!.push(url);
  }

  const durationMatch = xml.match(/<Duration[^>]*>([\s\S]*?)<\/Duration>/i);
  const duration = durationMatch ? parseDuration(durationMatch[1].trim()) : 0;

  const mediaMatch = xml.match(/<MediaFile[^>]*>([\s\S]*?)<\/MediaFile>/i);
  const mediaUrl = mediaMatch ? extractCdata(mediaMatch[1]) : undefined;

  return { type, mediaUrl, duration, trackingEvents, impressionUrls, errorUrls };
}

export async function resolveVast(
  vastUrlOrXml: string,
  fetchFn: (url: string) => Promise<string> = defaultFetch,
  depth: number = 0,
): Promise<VastCreative> {
  if (depth > MAX_WRAPPER_DEPTH) {
    throw new Error(`VAST wrapper depth exceeded (max ${MAX_WRAPPER_DEPTH})`);
  }

  let xml: string;
  if (vastUrlOrXml.trim().startsWith('<')) {
    xml = vastUrlOrXml;
  } else {
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

async function fetchWithTimeout(url: string, fetchFn: (url: string) => Promise<string>): Promise<string> {
  return Promise.race([
    fetchFn(url),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`VAST fetch timeout: ${url}`)), WRAPPER_TIMEOUT_MS)
    ),
  ]);
}

async function defaultFetch(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`VAST fetch failed: ${response.status}`);
  return response.text();
}
