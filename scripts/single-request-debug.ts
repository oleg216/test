/**
 * Single bid request with full verbose logging of every step.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import { createHash } from 'node:crypto';
import { loadFingerprints } from '../src/emulation/fingerprint-loader.js';
import { loadAppRotation, getNextApp } from '../src/emulation/app-rotation.js';
import { buildBidRequest } from '../src/engines/rtb-adapter.js';
import { createProxyFetch } from '../src/shared/proxy-fetch.js';

const RTB_ENDPOINT = process.argv[2] || 'http://rtb.pixelimpact.live/?pid=f6ea8478bf1a826ebf9a53f3dc58fb31';
const BIDFLOOR = parseFloat(process.env.BIDFLOOR || '0.2');

function ts(): string {
  return new Date().toISOString();
}

async function main() {
  console.log(`\n[${ts()}] ====== SINGLE REQUEST DEBUG ======\n`);

  // 1. Load fingerprint
  console.log(`[${ts()}] STEP 1: Loading fingerprints...`);
  const fingerprints = loadFingerprints();
  console.log(`[${ts()}]   Loaded ${fingerprints.length} fingerprints`);
  const device = { ...fingerprints[0] };
  if (device.geo) device.geo = { ...device.geo };
  console.log(`[${ts()}]   Selected device:`);
  console.log(`    OS:         ${device.os}`);
  console.log(`    OSV:        ${device.osv}`);
  console.log(`    Vendor:     ${device.vendor}`);
  console.log(`    Model:      ${device.model}`);
  console.log(`    UA:         ${device.userAgent}`);
  console.log(`    Screen:     ${device.screenWidth}x${device.screenHeight}`);
  console.log(`    Language:   ${device.language}`);
  console.log(`    Network:    ${device.networkType}`);
  console.log(`    IFA:        ${device.ifa}`);

  // 2. Load proxy
  console.log(`\n[${ts()}] STEP 2: Loading proxy...`);
  const proxies = readFileSync(resolve(process.cwd(), 'data', 'proxies.txt'), 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.includes('://') ? l : `socks5://${l}`);
  console.log(`[${ts()}]   Loaded ${proxies.length} proxies`);
  const proxy = proxies[0];
  console.log(`[${ts()}]   Selected proxy: ${proxy.replace(/:[^:@]+@/, ':***@')}`);

  // 3. Resolve proxy IP
  console.log(`\n[${ts()}] STEP 3: Resolving proxy exit IP...`);
  const proxyFetch = createProxyFetch(proxy);
  if (!proxyFetch) {
    console.error(`[${ts()}]   FAILED: Could not create proxy fetch`);
    process.exit(1);
  }
  let proxyIp: string;
  try {
    const ipRes = await proxyFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
    const ipData = (await ipRes.json()) as { ip: string };
    proxyIp = ipData.ip;
    console.log(`[${ts()}]   Proxy exit IP: ${proxyIp}`);
  } catch (err) {
    console.error(`[${ts()}]   FAILED: ${(err as Error).message}`);
    process.exit(1);
  }

  // 4. Geo lookup
  console.log(`\n[${ts()}] STEP 4: Geo lookup for ${proxyIp}...`);
  try {
    const geoRes = await fetch(`http://ip-api.com/json/${proxyIp}?fields=status,query,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as`, {
      signal: AbortSignal.timeout(10000),
    });
    const geoData = await geoRes.json() as Record<string, unknown>;
    console.log(`[${ts()}]   Geo result:`);
    for (const [k, v] of Object.entries(geoData)) {
      console.log(`    ${k}: ${v}`);
    }
    if (geoData.status === 'success') {
      device.ip = proxyIp;
      device.geo = {
        country: (geoData.countryCode as string) === 'US' ? 'USA' : (geoData.countryCode as string),
        region: geoData.region as string,
        city: geoData.city as string,
        zip: geoData.zip as string,
        type: 2,
        lat: geoData.lat as number,
        lon: geoData.lon as number,
      };
      device.carrier = geoData.isp as string;
      device.timezone = geoData.timezone as string;
    }
  } catch (err) {
    console.log(`[${ts()}]   Geo lookup failed: ${(err as Error).message}`);
    device.ip = proxyIp;
  }

  // 5. Load app
  console.log(`\n[${ts()}] STEP 5: Loading app rotation...`);
  const apps = loadAppRotation();
  const app = getNextApp() || { bundle: 'tv.pluto.android', name: 'Pluto TV', storeurl: 'https://play.google.com/store/apps/details?id=tv.pluto.android', ver: '5.40.1' };
  console.log(`[${ts()}]   Apps loaded: ${apps.length}`);
  console.log(`[${ts()}]   Selected app:`);
  console.log(`    Bundle:   ${app.bundle}`);
  console.log(`    Name:     ${app.name}`);
  console.log(`    Store:    ${app.storeurl}`);
  console.log(`    Version:  ${app.ver}`);

  // 6. Build bid request
  console.log(`\n[${ts()}] STEP 6: Building OpenRTB 2.6 bid request...`);
  const requestId = uuid();
  const config = {
    device,
    rtbEndpoint: RTB_ENDPOINT,
    contentUrl: '',
    appBundle: app.bundle,
    appName: app.name,
    appStoreUrl: app.storeurl,
    appVersion: app.ver,
    bidfloor: BIDFLOOR,
    proxy,
  };
  const bidRequest = buildBidRequest(config, requestId);
  // Override user ID from proxy IP
  bidRequest.user = {
    id: createHash('sha256').update(proxyIp + '|' + device.userAgent).digest('hex').slice(0, 16),
    ext: {},
  };
  console.log(`[${ts()}]   Request ID: ${requestId}`);
  console.log(`[${ts()}]   Bidfloor: $${BIDFLOOR}`);
  console.log(`[${ts()}]   Endpoint: ${RTB_ENDPOINT}`);
  console.log(`\n[${ts()}] === FULL REQUEST BODY ===`);
  console.log(JSON.stringify(bidRequest, null, 2));

  // 7. Send request
  let endpoint = RTB_ENDPOINT;
  if (endpoint.startsWith('http://')) endpoint = endpoint.replace('http://', 'https://');
  console.log(`\n[${ts()}] STEP 7: Sending bid request to ${endpoint}...`);
  console.log(`[${ts()}]   Method: POST`);
  console.log(`[${ts()}]   Headers: Content-Type: application/json, x-openrtb-version: 2.6`);
  console.log(`[${ts()}]   Via proxy: ${proxy.replace(/:[^:@]+@/, ':***@')}`);

  const startTime = Date.now();
  try {
    const response = await proxyFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: JSON.stringify(bidRequest),
      signal: AbortSignal.timeout(15000),
    });
    const latency = Date.now() - startTime;

    console.log(`\n[${ts()}] STEP 8: Response received (${latency}ms)`);
    console.log(`[${ts()}]   Status: ${response.status} ${response.statusText}`);
    console.log(`[${ts()}]   Headers:`);
    response.headers.forEach((v, k) => {
      console.log(`    ${k}: ${v}`);
    });

    if (response.status === 204) {
      console.log(`\n[${ts()}]   RESULT: NO BID (HTTP 204)`);
      console.log(`[${ts()}]   The DSP returned empty response — no matching campaign for this request.`);
    } else {
      const text = await response.text();
      console.log(`\n[${ts()}]   Response body (${text.length} bytes):`);
      try {
        const json = JSON.parse(text);
        console.log(JSON.stringify(json, null, 2));
        if (json.seatbid?.length) {
          console.log(`\n[${ts()}]   RESULT: BID RECEIVED!`);
          const bid = json.seatbid[0]?.bid?.[0];
          if (bid) {
            console.log(`    Price:  $${bid.price}`);
            console.log(`    BidID:  ${bid.id}`);
            console.log(`    CRID:   ${bid.crid}`);
            console.log(`    ADM:    ${bid.adm ? bid.adm.slice(0, 200) + '...' : 'none'}`);
            console.log(`    NURL:   ${bid.nurl || 'none'}`);
            console.log(`    BURL:   ${bid.burl || 'none'}`);
          }
        } else {
          console.log(`\n[${ts()}]   RESULT: NO BID (empty seatbid)`);
        }
      } catch {
        console.log(text.slice(0, 2000));
      }
    }
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`\n[${ts()}] STEP 8: Request FAILED after ${latency}ms`);
    console.error(`[${ts()}]   Error: ${(err as Error).message}`);
    console.error(`[${ts()}]   Stack: ${(err as Error).stack}`);
  }

  console.log(`\n[${ts()}] ====== END ======\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
