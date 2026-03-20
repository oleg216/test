/**
 * Launch 5 rounds × 10 sessions, each on a separate proxy.
 * Logs saved to logs/batch-YYYY-MM-DD/round-NN/success/ and failed/
 * File naming: {OS}_{Model}_{IP}_session-{NN}.json
 * Success files also get separate request.json, response.json, vast.xml
 *
 * Usage: node --import tsx scripts/run-batch-sessions.ts <rtbEndpoint>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { generateDeviceProfile } from '../src/emulation/device-profiles.js';
import { buildBidRequest, extractBidResult } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';
import { RTB_TIMEOUT_MS } from '../src/shared/constants.js';
import type { SessionConfig, RtbBidResponse, DeviceProfile, GeoData } from '../src/shared/types.js';

const RTB_ENDPOINT = process.argv[2];
if (!RTB_ENDPOINT) {
  console.error('Usage: node --import tsx scripts/run-batch-sessions.ts <rtbEndpoint>');
  process.exit(1);
}

const ROUNDS = 5;
const SESSIONS_PER_ROUND = 10;
const DATE_STR = new Date().toISOString().slice(0, 10);
const BASE_DIR = resolve(process.cwd(), 'logs', `batch-${DATE_STR}`);

const proxiesPath = resolve(process.cwd(), 'data', 'proxies.txt');
const allProxies = readFileSync(proxiesPath, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

const totalNeeded = ROUNDS * SESSIONS_PER_ROUND;
if (allProxies.length < totalNeeded) {
  console.error(`Need at least ${totalNeeded} proxies, found ${allProxies.length}`);
  process.exit(1);
}

const osList: Array<DeviceProfile['os']> = ['AndroidTV', 'Tizen', 'WebOS'];

// --- DMA map ---
const DMA_MAP: Record<string, string> = {
  'New York': '501', 'Los Angeles': '803', 'Chicago': '602',
  'Philadelphia': '504', 'Dallas': '623', 'Houston': '618',
  'Atlanta': '524', 'Boston': '506', 'San Francisco': '807',
  'Phoenix': '753', 'Seattle': '819', 'Minneapolis': '613',
  'Miami': '528', 'Denver': '751', 'Cleveland': '510',
  'Sacramento': '862', 'Portland': '820', 'Pittsburgh': '508',
  'Charlotte': '517', 'Indianapolis': '527', 'San Diego': '825',
  'Nashville': '659', 'Kansas City': '616', 'Columbus': '535',
  'Milwaukee': '617', 'Las Vegas': '839', 'San Antonio': '641',
  'Buffalo Grove': '602', 'Bellwood': '602', 'Maywood': '602',
  'La Grange': '602', 'Brooklyn': '501', 'Bronx': '501',
  'Queens': '501', 'Manhattan': '501', 'Jersey City': '501',
  'Newark': '501', 'Yonkers': '501', 'Hoboken': '501',
};

const ALPHA3: Record<string, string> = {
  US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS', DE: 'DEU', FR: 'FRA',
  NL: 'NLD', JP: 'JPN', BR: 'BRA', IN: 'IND', MX: 'MEX', IT: 'ITA',
};

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface ProxyInfo {
  ip: string;
  geo: GeoData | null;
  carrier: string | null;
  timezone: string | null;
}

async function resolveProxyInfo(proxy: string): Promise<ProxyInfo | null> {
  try {
    const proxyFetch = createProxyFetch(proxy);
    if (!proxyFetch) return null;

    const ipRes = await proxyFetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(10000),
    });
    const ipData = (await ipRes.json()) as { ip: string };
    const ip = ipData.ip;
    if (!ip) return null;

    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,query,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status !== 'success') return null;

    const cc = data.countryCode as string;
    const city = data.city as string;
    const metro = DMA_MAP[city] || undefined;

    const geo: GeoData = {
      country: ALPHA3[cc] || cc,
      region: data.region as string,
      city,
      zip: data.zip as string,
      type: 2,
      lat: data.lat as number,
      lon: data.lon as number,
    };
    if (metro) geo.metro = metro;

    return {
      ip,
      geo,
      carrier: (data.isp as string) || null,
      timezone: (data.timezone as string) || null,
    };
  } catch (err) {
    console.error(`  Failed to resolve proxy: ${(err as Error).message}`);
    return null;
  }
}

interface SessionResult {
  success: boolean;
  fileName: string;
  dump: Record<string, unknown>;
  vastXml?: string;
}

async function runSession(
  proxy: string,
  sessionIndex: number,
  globalIndex: number,
): Promise<SessionResult> {
  const sessionNum = String(sessionIndex + 1).padStart(2, '0');
  const os = osList[globalIndex % osList.length];
  const device = generateDeviceProfile(os);

  console.log(`\n  [Session ${sessionNum}] ${os} | ${device.vendor} ${device.model}`);

  // Resolve proxy
  const proxyInfo = await resolveProxyInfo(proxy);
  const baseFileName = `${sanitize(os)}_${sanitize(device.model)}_${sanitize(proxyInfo?.ip || 'no-ip')}_session-${sessionNum}`;

  if (!proxyInfo) {
    console.error(`    SKIP — proxy unreachable`);
    return {
      success: false,
      fileName: baseFileName,
      dump: {
        session: sessionIndex + 1, date: DATE_STR, os,
        model: device.model, vendor: device.vendor,
        proxy: proxy.replace(/:[^:@]+@/, ':***@'),
        error: 'Failed to resolve proxy',
      },
    };
  }

  const proxyIp = proxyInfo.ip;
  console.log(`    IP: ${proxyIp} | ${proxyInfo.geo?.city}, ${proxyInfo.geo?.region}`);

  device.ip = proxyIp;
  if (proxyInfo.geo) device.geo = proxyInfo.geo;
  if (proxyInfo.carrier) device.carrier = proxyInfo.carrier;
  if (proxyInfo.timezone) device.timezone = proxyInfo.timezone;

  const config: SessionConfig = {
    device,
    rtbEndpoint: RTB_ENDPOINT,
    contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    appBundle: 'com.tubitv',
    appName: 'Tubi: Free Movies & Live TV',
    appStoreUrl: 'https://play.google.com/store/apps/details?id=com.tubitv',
    bidfloor: 0.7,
    proxy,
  };

  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);
  bidRequest.user = {
    id: createHash('sha256').update(proxyIp + '|' + device.userAgent).digest('hex').slice(0, 16),
    ext: {},
  };

  const proxyFetch = createProxyFetch(proxy)!;
  let endpoint = RTB_ENDPOINT;
  if (endpoint.startsWith('http://')) {
    endpoint = endpoint.replace('http://', 'https://');
  }

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
    body: JSON.stringify(bidRequest),
    signal: AbortSignal.timeout(15000),
  };

  let responseBody: unknown = null;
  let responseStatus: number | null = null;
  let error: string | null = null;
  const startTime = Date.now();

  try {
    const response = await proxyFetch(endpoint, fetchOptions);
    responseStatus = response.status;
    if (response.status === 204) {
      responseBody = { nobid: true, status: 204 };
      console.log(`    204 No-Bid`);
    } else {
      const text = await response.text();
      try { responseBody = JSON.parse(text); } catch { responseBody = { rawText: text }; }
      console.log(`    ${response.status} (${text.length} bytes)`);
    }
  } catch (err) {
    error = (err as Error).message;
    console.error(`    ERROR: ${error}`);
  }

  const latencyMs = Date.now() - startTime;

  let bidResult = null;
  if (responseBody && typeof responseBody === 'object' && 'seatbid' in (responseBody as object)) {
    bidResult = extractBidResult(responseBody as RtbBidResponse, requestId);
    if (bidResult) {
      console.log(`    BID $${bidResult.auctionData.price} | seat=${bidResult.auctionData.seatId} | VAST ${bidResult.vastXml.length}b`);
    }
  }

  const hasBid = bidResult !== null;

  const dump = {
    session: sessionIndex + 1,
    date: DATE_STR,
    timestamp: new Date().toISOString(),
    latencyMs,
    result: hasBid ? 'bid' : (responseStatus === 204 ? 'nobid' : 'error'),
    device: {
      os: device.os, osv: device.osv, vendor: device.vendor, model: device.model,
      ip: device.ip, ifa: device.ifa, userAgent: device.userAgent,
      language: device.language, networkType: device.networkType, carrier: device.carrier,
      screenWidth: device.screenWidth, screenHeight: device.screenHeight,
      timezone: device.timezone, geo: device.geo,
    },
    fingerprint: device.fingerprint,
    proxy: proxy.replace(/:[^:@]+@/, ':***@'),
    proxyExitIp: proxyIp,
    request: {
      method: 'POST', url: endpoint,
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: bidRequest,
    },
    response: { status: responseStatus, body: responseBody, error },
    bidResult: bidResult ? {
      price: bidResult.auctionData.price, currency: bidResult.auctionData.currency,
      seatId: bidResult.auctionData.seatId, bidId: bidResult.auctionData.bidId,
      vastXmlLength: bidResult.vastXml.length, vastXml: bidResult.vastXml,
      nurl: bidResult.nurl, burl: bidResult.burl, lurl: bidResult.lurl,
    } : null,
  };

  return {
    success: hasBid,
    fileName: baseFileName,
    dump,
    vastXml: bidResult?.vastXml,
  };
}

async function main() {
  console.log('=== CTV Batch Session Runner ===');
  console.log(`Date: ${DATE_STR}`);
  console.log(`Endpoint: ${RTB_ENDPOINT}`);
  console.log(`Rounds: ${ROUNDS} × ${SESSIONS_PER_ROUND} sessions = ${totalNeeded} total`);
  console.log(`Proxies available: ${allProxies.length}`);
  console.log(`Output: ${BASE_DIR}`);

  let totalBids = 0;
  let totalNoBids = 0;
  let totalErrors = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const roundNum = String(round + 1).padStart(2, '0');
    const roundDir = resolve(BASE_DIR, `round-${roundNum}`);
    const successDir = resolve(roundDir, 'success');
    const failedDir = resolve(roundDir, 'failed');
    mkdirSync(successDir, { recursive: true });
    mkdirSync(failedDir, { recursive: true });

    console.log(`\n${'#'.repeat(60)}`);
    console.log(`# ROUND ${roundNum}`);
    console.log(`${'#'.repeat(60)}`);

    let roundBids = 0;
    let roundNoBids = 0;
    let roundErrors = 0;

    for (let i = 0; i < SESSIONS_PER_ROUND; i++) {
      const proxyIndex = round * SESSIONS_PER_ROUND + i;
      const proxy = allProxies[proxyIndex];

      const result = await runSession(proxy, i, proxyIndex);

      if (result.success) {
        // Save full dump
        const dumpPath = resolve(successDir, `${result.fileName}.json`);
        writeFileSync(dumpPath, JSON.stringify(result.dump, null, 2));

        // Save request separately
        writeFileSync(
          resolve(successDir, `${result.fileName}_request.json`),
          JSON.stringify((result.dump as any).request, null, 2),
        );

        // Save response separately
        writeFileSync(
          resolve(successDir, `${result.fileName}_response.json`),
          JSON.stringify((result.dump as any).response, null, 2),
        );

        // Save VAST separately
        if (result.vastXml) {
          writeFileSync(
            resolve(successDir, `${result.fileName}_vast.xml`),
            result.vastXml,
          );
        }

        roundBids++;
      } else {
        writeFileSync(
          resolve(failedDir, `${result.fileName}.json`),
          JSON.stringify(result.dump, null, 2),
        );

        if ((result.dump as any).response?.status === 204 || (result.dump as any).result === 'nobid') {
          roundNoBids++;
        } else {
          roundErrors++;
        }
      }

      // ip-api.com rate limit
      if (i < SESSIONS_PER_ROUND - 1) await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`\n  Round ${roundNum} summary: ${roundBids} bids | ${roundNoBids} no-bids | ${roundErrors} errors`);
    totalBids += roundBids;
    totalNoBids += roundNoBids;
    totalErrors += roundErrors;

    // Pause between rounds
    if (round < ROUNDS - 1) {
      console.log(`  Waiting 3s before next round...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL: ${totalBids} bids | ${totalNoBids} no-bids | ${totalErrors} errors`);
  console.log(`Fill rate: ${((totalBids / totalNeeded) * 100).toFixed(1)}%`);
  console.log(`Output: ${BASE_DIR}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
