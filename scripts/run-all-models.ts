/**
 * Run each TCL + Xiaomi + Redmi model on a unique proxy.
 * One session per model, each with its real hardware fingerprint.
 *
 * Usage: node --import tsx scripts/run-all-models.ts <rtbEndpoint>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { DEVICE_PRESETS, generateDeviceProfile, FINGERPRINT_PRESETS } from '../src/emulation/device-profiles.js';
import { buildBidRequest, extractBidResult } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';
import type { SessionConfig, RtbBidResponse, DeviceProfile, GeoData } from '../src/shared/types.js';

const RTB_ENDPOINT = process.argv[2];
if (!RTB_ENDPOINT) {
  console.error('Usage: node --import tsx scripts/run-all-models.ts <rtbEndpoint>');
  process.exit(1);
}

const DATE_STR = new Date().toISOString().slice(0, 10);
const BASE_DIR = resolve(process.cwd(), 'logs', `models-${DATE_STR}`);
const successDir = resolve(BASE_DIR, 'success');
const failedDir = resolve(BASE_DIR, 'failed');
mkdirSync(successDir, { recursive: true });
mkdirSync(failedDir, { recursive: true });

// Load proxies
const proxies = readFileSync(resolve(process.cwd(), 'data', 'proxies.txt'), 'utf-8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

// Collect all TCL + Xiaomi + Redmi models
const TARGET_VENDORS = ['TCL', 'Xiaomi', 'Redmi'];
const models: Array<{ vendor: string; model: string }> = [];
for (const v of DEVICE_PRESETS.AndroidTV.vendors) {
  if (TARGET_VENDORS.includes(v.vendor)) {
    for (const m of v.models) {
      models.push({ vendor: v.vendor, model: m });
    }
  }
}

if (proxies.length < models.length) {
  console.error(`Need ${models.length} proxies, have ${proxies.length}`);
  process.exit(1);
}

// DMA + geo helpers
const DMA_MAP: Record<string, string> = {
  'New York': '501', 'Los Angeles': '803', 'Chicago': '602',
  'Philadelphia': '504', 'Dallas': '623', 'Houston': '618',
  'Atlanta': '524', 'Boston': '506', 'San Francisco': '807',
  'Phoenix': '753', 'Seattle': '819', 'Minneapolis': '613',
  'Miami': '528', 'Denver': '751', 'San Diego': '825',
  'Brooklyn': '501', 'Bronx': '501', 'Queens': '501',
  'Jersey City': '501', 'Newark': '501', 'Yonkers': '501',
  'Aliso Viejo': '803', 'Irvine': '803', 'Laguna Beach': '803',
  'Mission Viejo': '803', 'Lake Forest': '803', 'Tustin': '803',
  'Costa Mesa': '803', 'Santa Ana': '803', 'Anaheim': '803',
  'Pasadena': '803', 'Long Beach': '803', 'Glendale': '803',
};
const ALPHA3: Record<string, string> = {
  US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS', DE: 'DEU',
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
    const ipRes = await proxyFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    const ipData = (await ipRes.json()) as { ip: string };
    const ip = ipData.ip;
    if (!ip) return null;

    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,query,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status !== 'success') return null;

    const cc = data.countryCode as string;
    const city = data.city as string;
    const metro = DMA_MAP[city] || undefined;
    const geo: GeoData = {
      country: ALPHA3[cc] || cc, region: data.region as string,
      city, zip: data.zip as string, type: 2,
      lat: data.lat as number, lon: data.lon as number,
    };
    if (metro) geo.metro = metro;

    return { ip, geo, carrier: (data.isp as string) || null, timezone: (data.timezone as string) || null };
  } catch (err) {
    console.error(`    proxy error: ${(err as Error).message}`);
    return null;
  }
}

async function runModel(index: number, vendor: string, model: string, proxy: string) {
  const num = String(index + 1).padStart(2, '0');
  console.log(`\n[${num}/${models.length}] ${vendor} ${model}`);

  // Generate a full device profile then override the model
  const device = generateDeviceProfile('AndroidTV');
  // Force vendor/model to the target
  (device as any).vendor = vendor;
  (device as any).model = model;
  // Regenerate UA with correct model
  const osv = device.osv;
  (device as any).userAgent = `Mozilla/5.0 (Linux; Android ${osv}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;

  // Resolve proxy
  const proxyInfo = await resolveProxyInfo(proxy);
  const ip = proxyInfo?.ip || 'unknown';
  const fileName = `${num}_${sanitize(vendor)}_${sanitize(model)}_${sanitize(ip)}`;

  if (!proxyInfo) {
    console.log(`  SKIP — proxy unreachable`);
    writeFileSync(resolve(failedDir, `${fileName}.json`), JSON.stringify({
      index: index + 1, vendor, model, proxy: proxy.replace(/:[^:@]+@/, ':***@'),
      error: 'proxy unreachable',
    }, null, 2));
    return;
  }

  console.log(`  IP: ${proxyInfo.ip} | ${proxyInfo.geo?.city}, ${proxyInfo.geo?.region} | ISP: ${proxyInfo.carrier}`);

  device.ip = proxyInfo.ip;
  if (proxyInfo.geo) device.geo = proxyInfo.geo;
  if (proxyInfo.carrier) device.carrier = proxyInfo.carrier;
  if (proxyInfo.timezone) device.timezone = proxyInfo.timezone;

  const config: SessionConfig = {
    device, rtbEndpoint: RTB_ENDPOINT,
    contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    appBundle: 'com.tubitv', appName: 'Tubi: Free Movies & Live TV',
    appStoreUrl: 'https://play.google.com/store/apps/details?id=com.tubitv',
    bidfloor: 0.7, proxy,
  };

  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);
  bidRequest.user = {
    id: createHash('sha256').update(proxyInfo.ip + '|' + device.userAgent).digest('hex').slice(0, 16),
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
      console.log(`  204 No-Bid`);
    } else {
      const text = await response.text();
      try { responseBody = JSON.parse(text); } catch { responseBody = { rawText: text }; }
      console.log(`  ${response.status} (${text.length} bytes)`);
    }
  } catch (err) {
    error = (err as Error).message;
    console.error(`  ERROR: ${error}`);
  }

  const latencyMs = Date.now() - startTime;
  let bidResult = null;
  if (responseBody && typeof responseBody === 'object' && 'seatbid' in (responseBody as object)) {
    bidResult = extractBidResult(responseBody as RtbBidResponse, requestId);
    if (bidResult) {
      console.log(`  BID $${bidResult.auctionData.price} | seat=${bidResult.auctionData.seatId} | VAST ${bidResult.vastXml.length}b`);
    }
  }

  const hasBid = bidResult !== null;
  const dump = {
    index: index + 1, date: DATE_STR, timestamp: new Date().toISOString(), latencyMs,
    result: hasBid ? 'bid' : (responseStatus === 204 ? 'nobid' : 'error'),
    device: {
      os: device.os, osv: device.osv, vendor, model,
      ip: device.ip, ifa: device.ifa, userAgent: device.userAgent,
      language: device.language, networkType: device.networkType, carrier: device.carrier,
      screenWidth: device.screenWidth, screenHeight: device.screenHeight,
      timezone: device.timezone, geo: device.geo,
    },
    fingerprint: device.fingerprint,
    proxy: proxy.replace(/:[^:@]+@/, ':***@'), proxyExitIp: proxyInfo.ip,
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

  const dir = hasBid ? successDir : failedDir;
  writeFileSync(resolve(dir, `${fileName}.json`), JSON.stringify(dump, null, 2));

  if (hasBid && bidResult) {
    writeFileSync(resolve(successDir, `${fileName}_request.json`), JSON.stringify(dump.request, null, 2));
    writeFileSync(resolve(successDir, `${fileName}_response.json`), JSON.stringify(dump.response, null, 2));
    writeFileSync(resolve(successDir, `${fileName}_vast.xml`), bidResult.vastXml);
  }
}

async function main() {
  console.log('=== All TCL + Xiaomi + Redmi Models Test ===');
  console.log(`Models: ${models.length}`);
  console.log(`Proxies: ${proxies.length}`);
  console.log(`Endpoint: ${RTB_ENDPOINT}`);
  console.log(`Output: ${BASE_DIR}`);

  let bids = 0, nobids = 0, errors = 0;

  for (let i = 0; i < models.length; i++) {
    const { vendor, model } = models[i];
    await runModel(i, vendor, model, proxies[i]);

    // ip-api.com rate limit: 45/min
    if (i < models.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  // Count results
  const { readdirSync } = await import('node:fs');
  bids = readdirSync(successDir).filter(f => f.endsWith('.json') && !f.includes('_request') && !f.includes('_response')).length;
  const failedFiles = readdirSync(failedDir).filter(f => f.endsWith('.json'));
  nobids = failedFiles.length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`DONE: ${bids} bids | ${nobids} no-bids/errors | ${models.length} total`);
  console.log(`Fill rate: ${((bids / models.length) * 100).toFixed(1)}%`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
