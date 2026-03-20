/**
 * Sequential bid test — one app per proxy, cycling through app list.
 *
 * Proxy 1 → App 1
 * Proxy 2 → App 2
 * ...
 * Proxy 86 → App 86
 * Proxy 87 → App 1 (cycle)
 * ...until proxies run out.
 *
 * Full dump per session: device, request, response, bid result + VAST.
 * Output: logs/app-per-proxy-<ts>/
 *
 * Usage:
 *   npx tsx scripts/run-app-per-proxy.ts [rtb_endpoint]
 *   CONCURRENCY=50 BIDFLOOR=0.7 npx tsx scripts/run-app-per-proxy.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { loadFingerprints } from '../src/emulation/fingerprint-loader.js';
import { loadAppRotation } from '../src/emulation/app-rotation.js';
import { buildBidRequest, extractBidResult } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';
import type { DeviceProfile, SessionConfig, RtbBidResponse, GeoData } from '../src/shared/types.js';

// ── Config ──
const RTB_ENDPOINT = process.argv[2] || 'http://rtb.pixelimpact.live/?pid=f6ea8478bf1a826ebf9a53f3dc58fb31';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '200', 10);
const BIDFLOOR = parseFloat(process.env.BIDFLOOR || '0.7');

// ── Load resources ──
const fingerprints = loadFingerprints();
if (fingerprints.length === 0) { console.error('ERROR: No fingerprints'); process.exit(1); }

const proxies = readFileSync(resolve(process.cwd(), 'data', 'proxies.txt'), 'utf-8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => l.includes('://') ? l : `socks5://${l}`);
if (proxies.length === 0) { console.error('ERROR: No proxies'); process.exit(1); }

const apps = loadAppRotation();
if (apps.length === 0) { console.error('ERROR: No apps'); process.exit(1); }

const totalSessions = proxies.length;

// ── Output ──
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BASE_DIR = resolve(process.cwd(), 'logs', `app-per-proxy-${TS}`);
const SESSION_DIR = resolve(BASE_DIR, 'sessions');
mkdirSync(SESSION_DIR, { recursive: true });

// All sessions CSV
const allCsv = createWriteStream(resolve(BASE_DIR, 'all.csv'));
allCsv.write('index,timestamp,status,app_bundle,app_name,os,vendor,model,proxy_ip,carrier,city,region,country,bid_price,latency_ms,error\n');

// Bids only CSV
const bidsCsv = createWriteStream(resolve(BASE_DIR, 'bids.csv'));
bidsCsv.write('index,timestamp,app_bundle,app_name,store_url,os,vendor,model,proxy_ip,carrier,user_agent,bid_price,seat_id,vast_length,city,region,country\n');

const summaryStream = createWriteStream(resolve(BASE_DIR, 'summary.log'));

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  summaryStream.write(line + '\n');
}

function csvEsc(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Geo cache ──
const geoCache = new Map<string, { geo: GeoData | null; carrier: string | null; timezone: string | null }>();
const DMA_MAP: Record<string, string> = {
  'New York': '501', 'Los Angeles': '803', 'Chicago': '602',
  'Philadelphia': '504', 'Dallas': '623', 'Houston': '618',
  'Atlanta': '524', 'Boston': '506', 'San Francisco': '807',
  'Phoenix': '753', 'Seattle': '819', 'Minneapolis': '613',
  'Miami': '528', 'Denver': '751', 'San Diego': '825',
  'Brooklyn': '501', 'Bronx': '501', 'Queens': '501',
  'Jersey City': '501', 'Newark': '501', 'Portland': '820',
  'Sacramento': '862', 'Charlotte': '517', 'Indianapolis': '527',
  'Nashville': '659', 'Kansas City': '616', 'Columbus': '535',
  'Milwaukee': '617', 'Las Vegas': '839', 'San Antonio': '641',
};
const ALPHA3: Record<string, string> = { US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS' };

async function batchGeoLookup(ips: string[]): Promise<void> {
  const uncached = ips.filter(ip => !geoCache.has(ip));
  if (uncached.length === 0) return;
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
    } catch {
      for (const ip of batch) {
        if (!geoCache.has(ip)) geoCache.set(ip, { geo: null, carrier: null, timezone: null });
      }
    }
    if (i + 100 < uncached.length) await new Promise(r => setTimeout(r, 1200));
  }
}

// ── Counters ──
let totalBids = 0;
let totalNoBids = 0;
let totalErrors = 0;
let totalProxyFails = 0;
let completedSessions = 0;

// ── Session runner ──
async function runSession(index: number): Promise<void> {
  const num = String(index + 1).padStart(5, '0');
  const app = apps[index % apps.length];
  const proxy = proxies[index];

  const fpIdx = index % fingerprints.length;
  const device: DeviceProfile = { ...fingerprints[fpIdx] };
  if (device.geo) device.geo = { ...device.geo };
  if (device.fingerprint) device.fingerprint = {
    ...device.fingerprint,
    connection: { ...device.fingerprint.connection },
    screen: { ...device.fingerprint.screen },
    webgl: { ...device.fingerprint.webgl },
    fonts: [...device.fingerprint.fonts],
  };

  // Resolve proxy IP
  let proxyIp: string | null = null;
  let proxyFetch: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  try {
    proxyFetch = createProxyFetch(proxy);
    if (!proxyFetch) throw new Error('no proxy fetch');
    const ipRes = await proxyFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    const ipData = (await ipRes.json()) as { ip: string };
    proxyIp = ipData.ip || null;
  } catch (err) {
    totalProxyFails++;
    totalErrors++;
    completedSessions++;
    allCsv.write([num, new Date().toISOString(), 'PROXY_FAIL', app.bundle, csvEsc(app.name),
      device.os, device.vendor, device.model, '', '', '', '', '', '', '0',
      (err as Error).message].join(',') + '\n');
    log(`  [${num}] PROXY_FAIL ${app.bundle}`);
    return;
  }

  // Apply geo
  device.ip = proxyIp!;
  const cached = geoCache.get(proxyIp!);
  if (cached?.geo) device.geo = cached.geo;
  if (cached?.carrier) device.carrier = cached.carrier;
  if (cached?.timezone) device.timezone = cached.timezone;

  // Build request
  const config: SessionConfig = {
    device,
    rtbEndpoint: RTB_ENDPOINT,
    contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    appBundle: app.bundle,
    appName: app.name,
    appStoreUrl: app.storeurl,
    appVersion: app.ver,
    bidfloor: BIDFLOOR,
    proxy,
  };

  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);
  bidRequest.user = {
    id: createHash('sha256').update(proxyIp + '|' + device.userAgent).digest('hex').slice(0, 16),
    ext: {},
  };

  let endpoint = RTB_ENDPOINT;
  if (endpoint.startsWith('http://')) endpoint = endpoint.replace('http://', 'https://');

  let responseBody: unknown = null;
  let responseStatus: number | null = null;
  let error: string | null = null;
  const startTime = Date.now();

  try {
    const response = await proxyFetch!(endpoint, {
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
  const status = hasBid ? 'BID' : (responseStatus === 204 ? 'NOBID' : 'ERR');

  if (hasBid) totalBids++;
  else if (responseStatus === 204) totalNoBids++;
  else totalErrors++;
  completedSessions++;

  const city = device.geo?.city || '?';
  const region = device.geo?.region || '?';
  const country = device.geo?.country || '?';
  const price = hasBid ? `$${bidResult!.auctionData.price}` : '';

  log(`  [${num}] ${status.padEnd(6)} ${app.bundle.padEnd(50)} ${device.os.padEnd(10)} ${proxyIp!.padEnd(16)} ${city.padEnd(16)} ${latencyMs}ms ${price}`);

  // All sessions CSV
  allCsv.write([num, new Date().toISOString(), status, app.bundle, csvEsc(app.name),
    device.os, device.vendor, device.model, proxyIp,
    csvEsc(device.carrier || ''), city, region, country,
    hasBid ? bidResult!.auctionData.price.toFixed(4) : '',
    String(latencyMs), csvEsc(error || '')].join(',') + '\n');

  // Bids CSV
  if (hasBid && bidResult) {
    bidsCsv.write([num, new Date().toISOString(), app.bundle, csvEsc(app.name), app.storeurl,
      device.os, device.vendor, device.model, proxyIp,
      csvEsc(device.carrier || ''), csvEsc(device.userAgent),
      bidResult.auctionData.price.toFixed(4), bidResult.auctionData.seatId,
      String(bidResult.vastXml.length), city, region, country].join(',') + '\n');
  }

  // Full JSON dump per session
  const fileName = `${num}_${status}_${sanitize(app.bundle)}_${sanitize(proxyIp!)}`;
  const dump = {
    index: index + 1, status, timestamp: new Date().toISOString(), latencyMs,
    app: { bundle: app.bundle, name: app.name, storeurl: app.storeurl, ver: app.ver },
    device: {
      os: device.os, osv: device.osv, vendor: device.vendor, model: device.model,
      ip: proxyIp, ifa: device.ifa, userAgent: device.userAgent,
      language: device.language, networkType: device.networkType,
      carrier: device.carrier, screenWidth: device.screenWidth, screenHeight: device.screenHeight,
      timezone: device.timezone, geo: device.geo,
    },
    proxy: proxy.replace(/:[^:@]+@/, ':***@'),
    request: { method: 'POST', url: endpoint, body: bidRequest },
    response: { status: responseStatus, body: responseBody, error },
    bidResult: bidResult ? {
      price: bidResult.auctionData.price, currency: bidResult.auctionData.currency,
      seatId: bidResult.auctionData.seatId, bidId: bidResult.auctionData.bidId,
      vastXmlLength: bidResult.vastXml.length,
      nurl: bidResult.nurl, burl: bidResult.burl, lurl: bidResult.lurl,
    } : null,
  };
  writeFileSync(resolve(SESSION_DIR, `${fileName}.json`), JSON.stringify(dump, null, 2));

  if (hasBid && bidResult) {
    writeFileSync(resolve(SESSION_DIR, `${fileName}_vast.xml`), bidResult.vastXml);
  }
}

// ── Main ──
async function main(): Promise<void> {
  const startTime = Date.now();

  log('═══════════════════════════════════════════════════════════════');
  log('  CTV APP-PER-PROXY LAUNCHER');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Fingerprints:   ${fingerprints.length}`);
  log(`  Proxies:        ${proxies.length}`);
  log(`  Apps:           ${apps.length} (cycling)`);
  log(`  Total sessions: ${totalSessions} (1 per proxy)`);
  log(`  Concurrency:    ${CONCURRENCY}`);
  log(`  Endpoint:       ${RTB_ENDPOINT}`);
  log(`  Bidfloor:       $${BIDFLOOR}`);
  log(`  Output:         ${BASE_DIR}`);
  log('───────────────────────────────────────────────────────────────');

  // Phase 1: Resolve proxy IPs
  log(`\nPhase 1: Resolving ${totalSessions} proxy IPs (${CONCURRENCY} concurrent)...`);
  const allIps: (string | null)[] = new Array(totalSessions).fill(null);

  for (let i = 0; i < totalSessions; i += CONCURRENCY) {
    const batch = proxies.slice(i, Math.min(i + CONCURRENCY, totalSessions));
    const results = await Promise.allSettled(batch.map(async (proxy) => {
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
    log(`  Batch ${Math.floor(i / CONCURRENCY) + 1}: ${resolved}/${batch.length} resolved`);
  }

  const validIps = allIps.filter(Boolean) as string[];
  const uniqueIps = [...new Set(validIps)];
  log(`  Total resolved: ${validIps.length}/${totalSessions}, unique: ${uniqueIps.length}`);

  // Phase 2: Geo lookup
  log(`\nPhase 2: Geo lookup for ${uniqueIps.length} IPs...`);
  await batchGeoLookup(uniqueIps);
  log(`  Geo cache: ${geoCache.size} entries`);

  // Phase 3: Run sessions
  log(`\nPhase 3: Running ${totalSessions} sessions (${CONCURRENCY} concurrent)...\n`);

  let cursor = 0;
  const running = new Set<Promise<void>>();

  while (cursor < totalSessions || running.size > 0) {
    while (cursor < totalSessions && running.size < CONCURRENCY) {
      const idx = cursor++;
      const p = runSession(idx).catch(err => {
        log(`  [${String(idx + 1).padStart(5, '0')}] FATAL: ${(err as Error).message}`);
        totalErrors++;
        completedSessions++;
      }).then(() => { running.delete(p); });
      running.add(p);
    }
    if (running.size > 0) await Promise.race(running);

    if (completedSessions > 0 && completedSessions % 200 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = (completedSessions / totalSessions * 100).toFixed(1);
      log(`  ── Progress: ${completedSessions}/${totalSessions} (${pct}%) | Bids: ${totalBids} | NoBids: ${totalNoBids} | Errors: ${totalErrors} | ProxyFails: ${totalProxyFails} | ${elapsed}s ──`);
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const fillRate = totalSessions > 0 ? ((totalBids / totalSessions) * 100).toFixed(2) : '0';

  log('\n═══════════════════════════════════════════════════════════════');
  log('  RESULTS');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Total sessions:  ${totalSessions}`);
  log(`  Bids:            ${totalBids}`);
  log(`  No-Bids:         ${totalNoBids}`);
  log(`  Errors:          ${totalErrors}`);
  log(`  Proxy failures:  ${totalProxyFails}`);
  log(`  Fill rate:       ${fillRate}%`);
  log(`  Duration:        ${elapsed}s`);
  log(`  All sessions:    ${resolve(BASE_DIR, 'all.csv')}`);
  log(`  Bids only:       ${resolve(BASE_DIR, 'bids.csv')}`);
  log(`  Session dumps:   ${SESSION_DIR}`);
  log('═══════════════════════════════════════════════════════════════');

  allCsv.end();
  bidsCsv.end();
  summaryStream.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
