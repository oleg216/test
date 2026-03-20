/**
 * Single-app launcher — all proxies, one app.
 * Successful bids saved to separate bids/ folder with full JSON + VAST.
 *
 * Usage:
 *   npx tsx scripts/run-single-app.ts [rtb_endpoint]
 *   APP_BUNDLE=com.tubitv APP_NAME=Tubi npx tsx scripts/run-single-app.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { loadFingerprints } from '../src/emulation/fingerprint-loader.js';
import { buildBidRequest, extractBidResult } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';
import type { DeviceProfile, RtbBidResponse, GeoData } from '../src/shared/types.js';

const RTB_ENDPOINT = process.argv[2] || 'http://rtb.pixelimpact.live/?pid=f6ea8478bf1a826ebf9a53f3dc58fb31';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '200', 10);
const BIDFLOOR = parseFloat(process.env.BIDFLOOR || '0.7');

const APP = {
  bundle: process.env.APP_BUNDLE || 'com.gameloft.android.ANMP.GloftA8HM',
  name: process.env.APP_NAME || 'Asphalt 8',
  storeurl: process.env.APP_STORE || 'https://play.google.com/store/apps/details?id=com.gameloft.android.ANMP.GloftA8HM',
  ver: process.env.APP_VER || '7.4.0',
};

const fingerprints = loadFingerprints();
if (fingerprints.length === 0) { console.error('No fingerprints'); process.exit(1); }

const proxies = readFileSync(resolve(process.cwd(), 'data', 'proxies.txt'), 'utf-8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => l.includes('://') ? l : `socks5://${l}`);
if (proxies.length === 0) { console.error('No proxies'); process.exit(1); }

const totalSessions = proxies.length;

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BASE_DIR = resolve(process.cwd(), 'logs', `single-app-${TS}`);
const BIDS_DIR = resolve(BASE_DIR, 'bids');
mkdirSync(BIDS_DIR, { recursive: true });

const bidsCsv = createWriteStream(resolve(BASE_DIR, 'bids.csv'));
bidsCsv.write('index,timestamp,os,vendor,model,proxy_ip,carrier,city,region,country,bid_price,seat_id,vast_length,latency_ms,user_agent\n');

const summaryStream = createWriteStream(resolve(BASE_DIR, 'summary.log'));

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  summaryStream.write(line + '\n');
}

function csvEsc(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) return '"' + val.replace(/"/g, '""') + '"';
  return val;
}

function sanitize(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }

const geoCache = new Map<string, { geo: GeoData | null; carrier: string | null; timezone: string | null }>();
const DMA_MAP: Record<string, string> = {
  'New York': '501', 'Los Angeles': '803', 'Chicago': '602', 'Philadelphia': '504',
  'Dallas': '623', 'Houston': '618', 'Atlanta': '524', 'Boston': '506',
  'San Francisco': '807', 'Phoenix': '753', 'Seattle': '819', 'Miami': '528',
  'Denver': '751', 'Brooklyn': '501', 'Portland': '820', 'San Diego': '825',
  'Nashville': '659', 'Las Vegas': '839', 'Charlotte': '517',
};
const ALPHA3: Record<string, string> = { US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS' };

async function batchGeoLookup(ips: string[]): Promise<void> {
  const uncached = ips.filter(ip => !geoCache.has(ip));
  for (let i = 0; i < uncached.length; i += 100) {
    const batch = uncached.slice(i, i + 100);
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,query,countryCode,region,city,zip,lat,lon,timezone,isp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(ip => ({ query: ip }))),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json()) as Array<Record<string, unknown>>;
      for (const e of data) {
        if (e.status !== 'success') { geoCache.set(e.query as string, { geo: null, carrier: null, timezone: null }); continue; }
        const cc = e.countryCode as string, city = e.city as string, metro = DMA_MAP[city] || undefined;
        const geo: GeoData = { country: ALPHA3[cc] || cc, region: e.region as string, city, zip: e.zip as string, type: 2, lat: e.lat as number, lon: e.lon as number };
        if (metro) geo.metro = metro;
        geoCache.set(e.query as string, { geo, carrier: (e.isp as string) || null, timezone: (e.timezone as string) || null });
      }
    } catch { for (const ip of batch) if (!geoCache.has(ip)) geoCache.set(ip, { geo: null, carrier: null, timezone: null }); }
    if (i + 100 < uncached.length) await new Promise(r => setTimeout(r, 1200));
  }
}

let totalBids = 0, totalNoBids = 0, totalErrors = 0, totalProxyFails = 0, completedSessions = 0;

async function runSession(index: number): Promise<void> {
  const num = String(index + 1).padStart(5, '0');
  const proxy = proxies[index];
  const device: DeviceProfile = { ...fingerprints[index % fingerprints.length] };
  if (device.geo) device.geo = { ...device.geo };
  if (device.fingerprint) device.fingerprint = {
    ...device.fingerprint, connection: { ...device.fingerprint.connection },
    screen: { ...device.fingerprint.screen }, webgl: { ...device.fingerprint.webgl },
    fonts: [...device.fingerprint.fonts],
  };

  let proxyIp: string | null = null;
  let proxyFetch: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  try {
    proxyFetch = createProxyFetch(proxy);
    if (!proxyFetch) throw new Error('no proxy');
    const r = await proxyFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    const d = (await r.json()) as { ip: string };
    proxyIp = d.ip || null;
  } catch {
    totalProxyFails++; totalErrors++; completedSessions++;
    log(`  [${num}] PROXY_FAIL`);
    return;
  }

  device.ip = proxyIp!;
  const cached = geoCache.get(proxyIp!);
  if (cached?.geo) device.geo = cached.geo;
  if (cached?.carrier) device.carrier = cached.carrier;
  if (cached?.timezone) device.timezone = cached.timezone;

  const config = { device, rtbEndpoint: RTB_ENDPOINT, contentUrl: '', appBundle: APP.bundle, appName: APP.name, appStoreUrl: APP.storeurl, appVersion: APP.ver, bidfloor: BIDFLOOR, proxy };
  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);
  bidRequest.user = { id: createHash('sha256').update(proxyIp + '|' + device.userAgent).digest('hex').slice(0, 16), ext: {} };

  let endpoint = RTB_ENDPOINT;
  if (endpoint.startsWith('http://')) endpoint = endpoint.replace('http://', 'https://');

  let responseBody: unknown = null, responseStatus: number | null = null, error: string | null = null;
  const startTime = Date.now();

  try {
    const response = await proxyFetch!(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: JSON.stringify(bidRequest), signal: AbortSignal.timeout(15000),
    });
    responseStatus = response.status;
    if (response.status === 204) { responseBody = { nobid: true }; }
    else { const text = await response.text(); try { responseBody = JSON.parse(text); } catch { responseBody = { rawText: text }; } }
  } catch (err) { error = (err as Error).message; }

  const latencyMs = Date.now() - startTime;
  let bidResult = null;
  if (responseBody && typeof responseBody === 'object' && 'seatbid' in (responseBody as object))
    bidResult = extractBidResult(responseBody as RtbBidResponse, requestId);

  const hasBid = bidResult !== null;
  const status = hasBid ? 'BID' : (responseStatus === 204 ? 'NOBID' : 'ERR');
  if (hasBid) totalBids++; else if (responseStatus === 204) totalNoBids++; else totalErrors++;
  completedSessions++;

  const city = device.geo?.city || '?', region = device.geo?.region || '?', country = device.geo?.country || '?';
  const price = hasBid ? `$${bidResult!.auctionData.price}` : '';
  log(`  [${num}] ${status.padEnd(6)} ${device.os.padEnd(10)} ${proxyIp!.padEnd(16)} ${city.padEnd(16)} ${latencyMs}ms ${price}`);

  if (hasBid && bidResult) {
    bidsCsv.write([num, new Date().toISOString(), device.os, device.vendor, device.model, proxyIp,
      csvEsc(device.carrier || ''), city, region, country,
      bidResult.auctionData.price.toFixed(4), bidResult.auctionData.seatId,
      String(bidResult.vastXml.length), String(latencyMs), csvEsc(device.userAgent)].join(',') + '\n');

    const fn = `${num}_BID_${sanitize(proxyIp!)}`;
    writeFileSync(resolve(BIDS_DIR, `${fn}.json`), JSON.stringify({
      index: index + 1, status, timestamp: new Date().toISOString(), latencyMs,
      app: APP,
      device: { os: device.os, osv: device.osv, vendor: device.vendor, model: device.model,
        ip: proxyIp, ifa: device.ifa, userAgent: device.userAgent, carrier: device.carrier,
        screenWidth: device.screenWidth, screenHeight: device.screenHeight, timezone: device.timezone, geo: device.geo },
      proxy: proxy.replace(/:[^:@]+@/, ':***@'),
      request: { method: 'POST', url: endpoint, body: bidRequest },
      response: { status: responseStatus, body: responseBody, error },
      bidResult: { price: bidResult.auctionData.price, currency: bidResult.auctionData.currency,
        seatId: bidResult.auctionData.seatId, bidId: bidResult.auctionData.bidId,
        vastXmlLength: bidResult.vastXml.length, nurl: bidResult.nurl, burl: bidResult.burl, lurl: bidResult.lurl },
    }, null, 2));
    writeFileSync(resolve(BIDS_DIR, `${fn}_vast.xml`), bidResult.vastXml);
  }
}

async function main(): Promise<void> {
  const startTime = Date.now();
  log('═══════════════════════════════════════════════════════════════');
  log(`  SINGLE APP LAUNCHER — ${APP.name} (${APP.bundle})`);
  log('═══════════════════════════════════════════════════════════════');
  log(`  Proxies: ${proxies.length} | Concurrency: ${CONCURRENCY} | Bidfloor: $${BIDFLOOR}`);
  log(`  Output: ${BASE_DIR}`);
  log(`  Bids folder: ${BIDS_DIR}`);
  log('───────────────────────────────────────────────────────────────');

  log(`\nPhase 1: Resolving ${totalSessions} proxy IPs (${CONCURRENCY} concurrent)...`);
  const allIps: (string | null)[] = new Array(totalSessions).fill(null);
  for (let i = 0; i < totalSessions; i += CONCURRENCY) {
    const batch = proxies.slice(i, Math.min(i + CONCURRENCY, totalSessions));
    const results = await Promise.allSettled(batch.map(async proxy => {
      try {
        const pf = createProxyFetch(proxy); if (!pf) return null;
        const r = await pf('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
        const d = (await r.json()) as { ip: string }; return d.ip || null;
      } catch { return null; }
    }));
    results.forEach((r, j) => { allIps[i + j] = r.status === 'fulfilled' ? r.value : null; });
    const resolved = results.filter(r => r.status === 'fulfilled' && r.value).length;
    log(`  Batch ${Math.floor(i / CONCURRENCY) + 1}: ${resolved}/${batch.length}`);
  }
  const validIps = allIps.filter(Boolean) as string[];
  const uniqueIps = [...new Set(validIps)];
  log(`  Resolved: ${validIps.length}/${totalSessions}, unique: ${uniqueIps.length}`);

  log(`\nPhase 2: Geo lookup for ${uniqueIps.length} IPs...`);
  await batchGeoLookup(uniqueIps);
  log(`  Geo cache: ${geoCache.size}`);

  log(`\nPhase 3: Running ${totalSessions} bid requests...\n`);
  let cursor = 0;
  const running = new Set<Promise<void>>();
  while (cursor < totalSessions || running.size > 0) {
    while (cursor < totalSessions && running.size < CONCURRENCY) {
      const idx = cursor++;
      const p = runSession(idx).catch(() => { totalErrors++; completedSessions++; }).then(() => { running.delete(p); });
      running.add(p);
    }
    if (running.size > 0) await Promise.race(running);
    if (completedSessions > 0 && completedSessions % 500 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      log(`  ── Progress: ${completedSessions}/${totalSessions} | Bids: ${totalBids} | NoBids: ${totalNoBids} | Errors: ${totalErrors} | ${elapsed}s ──`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('\n═══════════════════════════════════════════════════════════════');
  log('  RESULTS');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Total: ${totalSessions} | Bids: ${totalBids} | NoBids: ${totalNoBids} | Errors: ${totalErrors} | ProxyFails: ${totalProxyFails}`);
  log(`  Fill rate: ${(totalBids / totalSessions * 100).toFixed(2)}%`);
  log(`  Duration: ${elapsed}s`);
  log(`  Bids CSV: ${resolve(BASE_DIR, 'bids.csv')}`);
  log(`  Bids folder: ${BIDS_DIR}`);
  log('═══════════════════════════════════════════════════════════════');
  bidsCsv.end(); summaryStream.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
