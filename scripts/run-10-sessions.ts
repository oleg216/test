/**
 * Launch 10 sessions, each on a separate proxy from data/proxies.txt.
 * Dump full RTB bid request + response to individual JSON files.
 * File naming: {OS}_{Model}_{Date}_session-{NN}.json
 *
 * Usage: node --import tsx scripts/run-10-sessions.ts <rtbEndpoint>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { generateDeviceProfile } from '../src/emulation/device-profiles.js';
import { buildBidRequest, extractBidResult } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';
import { RTB_TIMEOUT_MS, DEFAULT_BIDFLOOR_VIDEO } from '../src/shared/constants.js';
import type { SessionConfig, RtbBidResponse, DeviceProfile, GeoData } from '../src/shared/types.js';

const RTB_ENDPOINT = process.argv[2];
if (!RTB_ENDPOINT) {
  console.error('Usage: node --import tsx scripts/run-10-sessions.ts <rtbEndpoint>');
  process.exit(1);
}

const SESSIONS_COUNT = 10;
const DATE_STR = new Date().toISOString().slice(0, 10); // 2026-03-19
const OUT_DIR = resolve(process.cwd(), 'logs', 'sessions-dump');

// Load proxies
const proxiesPath = resolve(process.cwd(), 'data', 'proxies.txt');
const proxies = readFileSync(proxiesPath, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

if (proxies.length < SESSIONS_COUNT) {
  console.error(`Need at least ${SESSIONS_COUNT} proxies, found ${proxies.length}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const osList: Array<DeviceProfile['os']> = ['AndroidTV', 'Tizen', 'WebOS'];

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

    // First get IP via HTTPS, then get geo without proxy (ip-api free tier is HTTP only)
    const ipRes = await proxyFetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(10000),
    });
    const ipData = (await ipRes.json()) as { ip: string };
    const ip = ipData.ip;
    if (!ip) return null;

    // ip-api.com free tier — call directly (no proxy needed for geo lookup)
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,query,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as Record<string, unknown>;

    if (data.status !== 'success') {
      console.error(`  ip-api error: ${JSON.stringify(data)}`);
      return null;
    }

    // Map country code to alpha-3 for OpenRTB
    const ALPHA3: Record<string, string> = {
      US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS', DE: 'DEU', FR: 'FRA',
      NL: 'NLD', JP: 'JPN', BR: 'BRA', IN: 'IND', MX: 'MEX', IT: 'ITA',
    };
    const cc = data.countryCode as string;
    const region = data.region as string;
    const city = data.city as string;

    // Nielsen DMA metro codes for major US markets
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
      'La Grange': '602', 'Cicero': '602', 'Oak Park': '602',
      'Evanston': '602', 'Schaumburg': '602', 'Naperville': '602',
      'Aurora': '602', 'Joliet': '602', 'Elgin': '602',
      'Pasadena': '803', 'Brooklyn': '501', 'Bronx': '501',
      'Queens': '501', 'Manhattan': '501',
    };
    const metro = DMA_MAP[city] || undefined;

    const geo: GeoData = {
      country: ALPHA3[cc] || cc,
      region,
      city,
      zip: data.zip as string,
      type: 2,
      lat: data.lat as number,
      lon: data.lon as number,
    };
    if (metro) geo.metro = metro;

    return {
      ip: data.query as string,
      geo,
      carrier: (data.isp as string) || null,
      timezone: (data.timezone as string) || null,
    };
  } catch (err) {
    console.error(`  Failed to resolve proxy info: ${(err as Error).message}`);
    return null;
  }
}

async function runSession(index: number) {
  const sessionNum = String(index + 1).padStart(2, '0');
  const proxy = proxies[index];
  const os = osList[index % osList.length];
  const device = generateDeviceProfile(os);

  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`Session ${sessionNum} | ${os} | ${device.vendor} ${device.model}`);
  console.log(`Proxy: ${proxy.replace(/:[^:@]+@/, ':***@')}`);

  // Resolve proxy exit IP + geo + carrier via ip-api.com
  const proxyInfo = await resolveProxyInfo(proxy);
  if (!proxyInfo) {
    console.error(`  SKIP — cannot resolve proxy info`);
    const fileName = `${sanitize(os)}_${sanitize(device.model)}_${DATE_STR}_session-${sessionNum}.json`;
    writeFileSync(resolve(OUT_DIR, fileName), JSON.stringify({
      session: parseInt(sessionNum),
      date: DATE_STR,
      os,
      model: device.model,
      vendor: device.vendor,
      proxy: proxy.replace(/:[^:@]+@/, ':***@'),
      error: 'Failed to resolve proxy info',
    }, null, 2));
    return;
  }

  const proxyIp = proxyInfo.ip;
  console.log(`  Proxy exit IP: ${proxyIp}`);

  // Override device IP + geo + carrier from real proxy data
  device.ip = proxyIp;
  if (proxyInfo.geo) {
    device.geo = proxyInfo.geo;
    console.log(`  Geo: ${proxyInfo.geo.city}, ${proxyInfo.geo.region}, ${proxyInfo.geo.country} (lat=${proxyInfo.geo.lat}, lon=${proxyInfo.geo.lon})`);
  }
  if (proxyInfo.carrier) {
    device.carrier = proxyInfo.carrier;
    console.log(`  ISP: ${proxyInfo.carrier}`);
  }
  if (proxyInfo.timezone) {
    device.timezone = proxyInfo.timezone;
  }

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

  // Build bid request — device already has correct IP/geo/carrier
  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);

  // Rebuild user ID from proxy IP (same logic as sendBidRequest)
  bidRequest.user = {
    id: createHash('sha256').update(proxyIp + '|' + device.userAgent).digest('hex').slice(0, 16),
    ext: {},
  };

  console.log(`  Request ID: ${requestId}`);
  console.log(`  Device IP: ${bidRequest.device.ip}`);
  console.log(`  Geo: ${bidRequest.device.geo?.city}, ${bidRequest.device.geo?.region}, ${bidRequest.device.geo?.country}`);

  // Send request via proxy
  const proxyFetch = createProxyFetch(proxy)!;
  let endpoint = RTB_ENDPOINT;
  if (endpoint.startsWith('http://')) {
    endpoint = endpoint.replace('http://', 'https://');
  }

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
    body: JSON.stringify(bidRequest),
    signal: AbortSignal.timeout(15000), // network timeout (tmax in body is for DSP)
  };

  let response: Response | null = null;
  let responseBody: unknown = null;
  let responseStatus: number | null = null;
  let error: string | null = null;

  const startTime = Date.now();

  try {
    response = await proxyFetch(endpoint, fetchOptions);
    responseStatus = response.status;

    if (response.status === 204) {
      responseBody = { nobid: true, status: 204 };
      console.log(`  Response: 204 No-Bid`);
    } else {
      const text = await response.text();
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = { rawText: text };
      }
      console.log(`  Response: ${response.status} (${text.length} bytes)`);
    }
  } catch (err) {
    error = (err as Error).message;
    console.error(`  ERROR: ${error}`);
  }

  const latencyMs = Date.now() - startTime;
  console.log(`  Latency: ${latencyMs}ms`);

  // Extract bid result if available
  let bidResult = null;
  if (responseBody && typeof responseBody === 'object' && 'seatbid' in (responseBody as object)) {
    bidResult = extractBidResult(responseBody as RtbBidResponse, requestId);
    if (bidResult) {
      console.log(`  Bid: $${bidResult.auctionData.price} | seat=${bidResult.auctionData.seatId}`);
      console.log(`  VAST: ${bidResult.vastXml.length} bytes`);
      if (bidResult.nurl) console.log(`  nurl: ${bidResult.nurl.slice(0, 80)}...`);
      if (bidResult.burl) console.log(`  burl: ${bidResult.burl.slice(0, 80)}...`);
    } else {
      console.log(`  No valid bid extracted`);
    }
  }

  // Write dump file
  const fileName = `${sanitize(os)}_${sanitize(device.model)}_${DATE_STR}_session-${sessionNum}.json`;
  const dump = {
    session: parseInt(sessionNum),
    date: DATE_STR,
    timestamp: new Date().toISOString(),
    latencyMs,

    device: {
      os: device.os,
      osv: device.osv,
      vendor: device.vendor,
      model: device.model,
      ip: device.ip,
      ifa: device.ifa,
      userAgent: device.userAgent,
      language: device.language,
      networkType: device.networkType,
      carrier: device.carrier,
      screenWidth: device.screenWidth,
      screenHeight: device.screenHeight,
      timezone: device.timezone,
      geo: device.geo,
    },

    fingerprint: device.fingerprint,

    proxy: proxy.replace(/:[^:@]+@/, ':***@'),
    proxyExitIp: proxyIp,

    request: {
      method: 'POST',
      url: endpoint,
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: bidRequest,
    },

    response: {
      status: responseStatus,
      body: responseBody,
      error,
    },

    bidResult: bidResult ? {
      price: bidResult.auctionData.price,
      currency: bidResult.auctionData.currency,
      seatId: bidResult.auctionData.seatId,
      bidId: bidResult.auctionData.bidId,
      vastXmlLength: bidResult.vastXml.length,
      vastXml: bidResult.vastXml,
      nurl: bidResult.nurl,
      burl: bidResult.burl,
      lurl: bidResult.lurl,
    } : null,
  };

  const filePath = resolve(OUT_DIR, fileName);
  writeFileSync(filePath, JSON.stringify(dump, null, 2));
  console.log(`  Saved: ${fileName}`);
}

async function main() {
  console.log('CTV Session Runner');
  console.log(`Date: ${DATE_STR}`);
  console.log(`Endpoint: ${RTB_ENDPOINT}`);
  console.log(`Proxies: ${proxies.length}`);
  console.log(`Output: ${OUT_DIR}`);

  for (let i = 0; i < SESSIONS_COUNT; i++) {
    await runSession(i);
    // ip-api.com rate limit: 45 req/min — small delay between sessions
    if (i < SESSIONS_COUNT - 1) await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done. ${SESSIONS_COUNT} sessions saved to ${OUT_DIR}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
