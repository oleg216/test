/**
 * Run 1 session per proxy, 50 concurrent at a time.
 * Geo lookup via ip-api.com batch endpoint (max 100 per request).
 *
 * Usage: node --import tsx scripts/run-concurrent.ts <rtbEndpoint>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { generateDeviceProfile } from '../src/emulation/device-profiles.js';
import { buildBidRequest, extractBidResult } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';
import type { SessionConfig, RtbBidResponse, GeoData } from '../src/shared/types.js';

const RTB_ENDPOINT = process.argv[2];
if (!RTB_ENDPOINT) {
  console.error('Usage: node --import tsx scripts/run-concurrent.ts <rtbEndpoint>');
  process.exit(1);
}

const CONCURRENCY = 50;
const DATE_STR = new Date().toISOString().slice(0, 10);
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BASE_DIR = resolve(process.cwd(), 'logs', `concurrent-${TS}`);
const successDir = resolve(BASE_DIR, 'success');
const failedDir = resolve(BASE_DIR, 'failed');
mkdirSync(successDir, { recursive: true });
mkdirSync(failedDir, { recursive: true });

const proxies = readFileSync(resolve(process.cwd(), 'data', 'proxies.txt'), 'utf-8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

console.log(`=== Concurrent Session Runner ===`);
console.log(`Proxies: ${proxies.length}`);
console.log(`Concurrency: ${CONCURRENCY}`);
console.log(`Endpoint: ${RTB_ENDPOINT}`);
console.log(`Output: ${BASE_DIR}`);

// --- Geo cache ---
const geoCache = new Map<string, { geo: GeoData | null; carrier: string | null; timezone: string | null }>();

const DMA_MAP: Record<string, string> = {
  'New York': '501', 'Los Angeles': '803', 'Chicago': '602',
  'Philadelphia': '504', 'Dallas': '623', 'Houston': '618',
  'Atlanta': '524', 'Boston': '506', 'San Francisco': '807',
  'Phoenix': '753', 'Seattle': '819', 'Minneapolis': '613',
  'Miami': '528', 'Denver': '751', 'San Diego': '825',
  'Brooklyn': '501', 'Bronx': '501', 'Queens': '501',
  'Jersey City': '501', 'Newark': '501',
  'Aliso Viejo': '803', 'Irvine': '803', 'Laguna Niguel': '803',
  'Mission Viejo': '803', 'Lake Forest': '803', 'Rancho Santa Margarita': '803',
  'Costa Mesa': '803', 'Santa Ana': '803', 'Anaheim': '803',
  'Pasadena': '803', 'Long Beach': '803', 'Glendale': '803',
  'Laguna Hills': '803', 'Laguna Beach': '803', 'Tustin': '803',
  'Bellwood': '602', 'Maywood': '602', 'La Grange': '602',
  'Portland': '820', 'Seattle': '819', 'Sacramento': '862',
};
const ALPHA3: Record<string, string> = { US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS' };

// Batch geo lookup — ip-api.com POST /batch (max 100, no key needed)
async function batchGeoLookup(ips: string[]): Promise<void> {
  const uncached = ips.filter(ip => !geoCache.has(ip));
  if (uncached.length === 0) return;

  // Split into chunks of 100
  for (let i = 0; i < uncached.length; i += 100) {
    const batch = uncached.slice(i, i + 100);
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,query,countryCode,region,city,zip,lat,lon,timezone,isp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(ip => ({ query: ip }))),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json()) as Array<Record<string, unknown>>;
      for (const entry of data) {
        if (entry.status !== 'success') {
          geoCache.set(entry.query as string, { geo: null, carrier: null, timezone: null });
          continue;
        }
        const cc = entry.countryCode as string;
        const city = entry.city as string;
        const metro = DMA_MAP[city] || undefined;
        const geo: GeoData = {
          country: ALPHA3[cc] || cc, region: entry.region as string,
          city, zip: entry.zip as string, type: 2,
          lat: entry.lat as number, lon: entry.lon as number,
        };
        if (metro) geo.metro = metro;
        geoCache.set(entry.query as string, {
          geo, carrier: (entry.isp as string) || null, timezone: (entry.timezone as string) || null,
        });
      }
    } catch (err) {
      // On failure, mark all as unknown
      for (const ip of batch) {
        if (!geoCache.has(ip)) geoCache.set(ip, { geo: null, carrier: null, timezone: null });
      }
    }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const osList = ['AndroidTV', 'Tizen', 'WebOS'] as const;
let totalBids = 0;
let totalNoBids = 0;
let totalErrors = 0;

async function runSession(index: number): Promise<void> {
  const num = String(index + 1).padStart(3, '0');
  const proxy = proxies[index];
  const os = osList[index % osList.length];
  const device = generateDeviceProfile(os);

  // Resolve proxy IP
  let proxyIp: string | null = null;
  try {
    const proxyFetch = createProxyFetch(proxy);
    if (!proxyFetch) throw new Error('no proxy fetch');
    const ipRes = await proxyFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    const ipData = (await ipRes.json()) as { ip: string };
    proxyIp = ipData.ip || null;
  } catch (err) {
    const fileName = `${num}_${sanitize(os)}_${sanitize(device.model)}_no-ip`;
    writeFileSync(resolve(failedDir, `${fileName}.json`), JSON.stringify({
      index: index + 1, os, model: device.model, vendor: device.vendor,
      proxy: proxy.replace(/:[^:@]+@/, ':***@'),
      error: `proxy unreachable: ${(err as Error).message}`,
    }, null, 2));
    totalErrors++;
    console.log(`  [${num}] SKIP ${os} ${device.model} — proxy error`);
    return;
  }

  // Get geo from cache (pre-fetched via batch)
  const cached = geoCache.get(proxyIp);
  device.ip = proxyIp;
  if (cached?.geo) device.geo = cached.geo;
  if (cached?.carrier) device.carrier = cached.carrier;
  if (cached?.timezone) device.timezone = cached.timezone;

  const config: SessionConfig = {
    device, rtbEndpoint: RTB_ENDPOINT,
    contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    appBundle: 'tv.pluto.android', appName: 'PlutoTV: Stream Free Movies/TV',
    appStoreUrl: 'https://play.google.com/store/apps/details?id=tv.pluto.android',
    bidfloor: 0.2, proxy,
  };

  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);
  bidRequest.user = {
    id: createHash('sha256').update(proxyIp + '|' + device.userAgent).digest('hex').slice(0, 16),
    ext: {},
  };

  const proxyFetch = createProxyFetch(proxy)!;
  let endpoint = RTB_ENDPOINT;
  if (endpoint.startsWith('http://')) endpoint = endpoint.replace('http://', 'https://');

  let responseBody: unknown = null;
  let responseStatus: number | null = null;
  let error: string | null = null;
  const startTime = Date.now();

  try {
    const response = await proxyFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: JSON.stringify(bidRequest),
      signal: AbortSignal.timeout(15000),
    });
    responseStatus = response.status;
    if (response.status === 204) {
      responseBody = { nobid: true, status: 204 };
    } else {
      const text = await response.text();
      try { responseBody = JSON.parse(text); } catch { responseBody = { rawText: text }; }
    }
  } catch (err) {
    error = (err as Error).message;
  }

  const latencyMs = Date.now() - startTime;
  let bidResult = null;
  if (responseBody && typeof responseBody === 'object' && 'seatbid' in (responseBody as object)) {
    bidResult = extractBidResult(responseBody as RtbBidResponse, requestId);
  }

  const hasBid = bidResult !== null;
  const status = hasBid ? 'BID' : (responseStatus === 204 ? '204' : 'ERR');

  if (hasBid) totalBids++;
  else if (responseStatus === 204) totalNoBids++;
  else totalErrors++;

  const city = device.geo?.city || '?';
  const price = hasBid ? `$${bidResult!.auctionData.price}` : '';
  console.log(`  [${num}] ${status} ${os.padEnd(10)} ${device.vendor.padEnd(8)} ${device.model.padEnd(20)} ${proxyIp.padEnd(16)} ${city.padEnd(20)} ${latencyMs}ms ${price}`);

  const fileName = `${num}_${sanitize(os)}_${sanitize(device.vendor)}_${sanitize(device.model)}_${sanitize(proxyIp)}`;
  const dump = {
    index: index + 1, date: DATE_STR, timestamp: new Date().toISOString(), latencyMs,
    result: hasBid ? 'bid' : (responseStatus === 204 ? 'nobid' : 'error'),
    device: {
      os: device.os, osv: device.osv, vendor: device.vendor, model: device.model,
      ip: device.ip, ifa: device.ifa, userAgent: device.userAgent,
      language: device.language, networkType: device.networkType, carrier: device.carrier,
      screenWidth: device.screenWidth, screenHeight: device.screenHeight,
      timezone: device.timezone, geo: device.geo,
    },
    fingerprint: device.fingerprint,
    proxy: proxy.replace(/:[^:@]+@/, ':***@'), proxyExitIp: proxyIp,
    request: { method: 'POST', url: endpoint,
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: bidRequest },
    response: { status: responseStatus, body: responseBody, error },
    bidResult: bidResult ? {
      price: bidResult.auctionData.price, currency: bidResult.auctionData.currency,
      seatId: bidResult.auctionData.seatId, bidId: bidResult.auctionData.bidId,
      vastXmlLength: bidResult.vastXml.length, vastXml: bidResult.vastXml,
      nurl: bidResult.nurl, burl: bidResult.burl, lurl: bidResult.lurl,
    } : null,
  };

  const dir = hasBid ? successDir : failedDir;
  writeFileSync(resolve(dir, `${fileName}.json`), JSON.stringify(dump, null, 2));

  if (hasBid && bidResult) {
    writeFileSync(resolve(successDir, `${fileName}_request.json`), JSON.stringify(dump.request, null, 2));
    writeFileSync(resolve(successDir, `${fileName}_response.json`), JSON.stringify(dump.response, null, 2));
    writeFileSync(resolve(successDir, `${fileName}_vast.xml`), bidResult.vastXml);
  }
}

async function main() {
  const startTime = Date.now();

  // Phase 1: resolve all proxy IPs in parallel (50 at a time)
  console.log(`\nPhase 1: Resolving ${proxies.length} proxy IPs...`);
  const allIps: (string | null)[] = new Array(proxies.length).fill(null);

  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (proxy, j) => {
      try {
        const pf = createProxyFetch(proxy);
        if (!pf) return null;
        const res = await pf('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
        const data = (await res.json()) as { ip: string };
        return data.ip || null;
      } catch { return null; }
    }));
    results.forEach((r, j) => {
      allIps[i + j] = r.status === 'fulfilled' ? r.value : null;
    });
    const resolved = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.log(`  Batch ${Math.floor(i / CONCURRENCY) + 1}: ${resolved}/${batch.length} resolved`);
  }

  const validIps = allIps.filter(Boolean) as string[];
  const uniqueIps = [...new Set(validIps)];
  console.log(`  Total IPs resolved: ${validIps.length}/${proxies.length}, unique: ${uniqueIps.length}`);

  // Phase 2: batch geo lookup
  console.log(`\nPhase 2: Batch geo lookup for ${uniqueIps.length} IPs...`);
  await batchGeoLookup(uniqueIps);
  console.log(`  Geo cache: ${geoCache.size} entries`);

  // Phase 3: send bid requests — 50 concurrent
  console.log(`\nPhase 3: Sending ${proxies.length} bid requests (${CONCURRENCY} concurrent)...\n`);

  let cursor = 0;
  const running = new Set<Promise<void>>();

  while (cursor < proxies.length || running.size > 0) {
    // Fill up to CONCURRENCY
    while (cursor < proxies.length && running.size < CONCURRENCY) {
      const idx = cursor++;
      const p = runSession(idx).then(() => { running.delete(p); });
      running.add(p);
    }
    // Wait for at least one to finish
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`DONE in ${elapsed}s`);
  console.log(`Bids: ${totalBids} | No-Bids: ${totalNoBids} | Errors: ${totalErrors} | Total: ${proxies.length}`);
  console.log(`Fill rate: ${((totalBids / proxies.length) * 100).toFixed(1)}%`);
  console.log(`Output: ${BASE_DIR}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
