import { v4 as uuid } from 'uuid';
import { createHash } from 'crypto';
import { createLogger } from '../shared/logger.js';
import { RTB_TIMEOUT_MS, DEFAULT_BIDFLOOR_VIDEO } from '../shared/constants.js';
import { lookupGeo, lookupCarrier } from '../shared/geo-lookup.js';
import { getProxyAgent } from '../shared/proxy-fetch.js';
import type { SessionConfig, RtbBidRequest, RtbBidResponse, BidResult, AuctionData } from '../shared/types.js';

const logger = createLogger('rtb-adapter');

// --- Device type mapping (oRTB 2.6 §3.2.18) ---
// 3=Connected TV, 4=Phone, 7=Set Top Box
function mapDeviceType(os: string): number {
  switch (os) {
    case 'AndroidTV':
    case 'Tizen':
    case 'WebOS':
      return 3; // Connected TV
    default:
      return 7; // Set Top Box (external devices)
  }
}

// Real devices report standardized OS names, not internal preset keys
function mapOsName(os: string): string {
  switch (os) {
    case 'AndroidTV': return 'android';
    case 'WebOS': return 'webos';
    case 'Tizen': return 'tizen';
    default: return os.toLowerCase();
  }
}

// Map networkType to oRTB connectiontype enum (spec 5.22)
function mapConnectionType(networkType: string): number {
  switch (networkType) {
    case 'Ethernet': return 1;
    case 'WiFi': return 2;
    case '4G': return 6;
    case '3G': return 5;
    default: return 0; // Unknown
  }
}

// Deterministic user ID from IP + UA (matches SSP pattern)
function generateUserId(ip: string, ua: string): string {
  return createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);
}

// Default blocked categories (illegal content)
const DEFAULT_BCAT = ['IAB26'];

export function buildBidRequest(config: SessionConfig, requestId: string): RtbBidRequest {
  const bidfloor = config.bidfloor ?? DEFAULT_BIDFLOOR_VIDEO;

  const request: RtbBidRequest = {
    id: requestId,
    at: 1, // First Price auction
    cur: ['USD'],
    ext: {},
    bcat: config.bcat ?? DEFAULT_BCAT,
    tmax: RTB_TIMEOUT_MS,
    imp: [
      {
        id: '1',
        bidfloorcur: 'USD',
        secure: 1,
        video: {
          mimes: [
            'video/mp4',
            'video/x-flv',
            'video/webm',
            'application/x-mpegURL',
            'video/ogg',
            'video/3gpp',
            'video/quicktime',
            'video/x-msvideo',
            'video/x-ms-wmv',
          ],
          w: config.device.screenWidth,
          h: config.device.screenHeight,
          protocols: [1, 2, 3, 4, 5, 6, 7, 8], // VAST 1.0-4.0 + wrappers
          minduration: 3,
          maxduration: 300,
          startdelay: 0,       // Pre-roll
          linearity: 1,        // Linear (in-stream)
          sequence: 1,
          boxingallowed: 1,
          playbackmethod: [1, 2, 5, 6], // auto-play sound on/off, mouse-over/viewport
          api: [1, 2],         // VPAID 1.0, 2.0
        },
        bidfloor,
        displaymanager: 'Google Interactive Media Ads',
        displaymanagerver: '3.30.3',
      },
    ],
    source: {},
    regs: {
      ext: {
        us_privacy: '1YNN',
      },
      coppa: 0,
    },
    app: {
      bundle: config.appBundle,
      name: config.appName,
      storeurl: config.appStoreUrl,
      ver: config.appVersion || '2.4.1',
      publisher: config.publisherId
        ? { id: config.publisherId, name: config.publisherName }
        : { id: 'pub-' + createHash('sha256').update(config.appBundle).digest('hex').slice(0, 10) },
      content: {
        language: config.device.language || 'en',
        livestream: 0,
      },
    },
    device: {
      ua: config.device.userAgent,
      devicetype: mapDeviceType(config.device.os),
      make: config.device.vendor.toLowerCase(),
      model: config.device.model,
      ip: config.device.ip,
      ifa: config.device.ifa,
      os: mapOsName(config.device.os),
      osv: config.device.osv,
      language: config.device.language || 'en',
      js: 1,
      w: config.device.screenWidth,
      h: config.device.screenHeight,
      connectiontype: mapConnectionType(config.device.networkType),
      carrier: config.device.carrier,
      ext: {
        ifa_type: 'aaid', // Android Advertising ID
      },
    },
    user: {
      id: config.userId || generateUserId(config.device.ip, config.device.userAgent),
      ext: {},
    },
  };

  // App ID — deterministic from bundle if not provided
  if (config.appId) {
    request.app.id = config.appId;
  } else {
    request.app.id = createHash('sha256').update(config.appBundle).digest('hex').slice(0, 10);
  }

  // Full geo object (matches DSP sample: country, lat, lon, region, metro, city, zip, type, accuracy, ipservice)
  if (config.device.geo) {
    request.device.geo = { ...config.device.geo };
  }

  return request;
}


/**
 * Resolve the outgoing IP of a proxy by hitting an IP-echo service through it.
 * Caches results per proxy URL for 5 minutes.
 */
const proxyIpCache = new Map<string, { ip: string; ts: number }>();
const PROXY_IP_TTL = 5 * 60 * 1000;

async function resolveProxyIp(proxyUrl: string): Promise<string | null> {
  const cached = proxyIpCache.get(proxyUrl);
  if (cached && Date.now() - cached.ts < PROXY_IP_TTL) return cached.ip;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(5000),
      dispatcher: getProxyAgent(proxyUrl) as import('undici').Dispatcher,
    } as any);
    const data = (await res.json()) as { ip: string };
    if (data.ip) {
      proxyIpCache.set(proxyUrl, { ip: data.ip, ts: Date.now() });
      logger.info({ proxyIp: data.ip }, 'Resolved proxy exit IP');
      return data.ip;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Failed to resolve proxy IP');
  }
  return null;
}

export async function sendBidRequest(config: SessionConfig): Promise<RtbBidResponse> {
  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);

  // If proxy is used, resolve exit IP and rebuild device fields to match
  if (config.proxy) {
    const proxyIp = await resolveProxyIp(config.proxy);
    if (proxyIp) {
      bidRequest.device.ip = proxyIp;

      // GeoIP lookup — fill geo from proxy IP so it matches TCP IP
      const geo = lookupGeo(proxyIp);
      if (geo) {
        bidRequest.device.geo = geo;
      } else {
        delete bidRequest.device.geo;
      }

      // Carrier/ISP from proxy IP
      const carrier = lookupCarrier(proxyIp);
      if (carrier) {
        bidRequest.device.carrier = carrier;
      }

      // Rebuild user ID from new IP
      bidRequest.user = {
        id: generateUserId(proxyIp, bidRequest.device.ua),
        ext: {},
      };
    }
  }

  // Force HTTPS for DSP endpoints — HTTP through proxy causes 301 redirect
  // which converts POST→GET and loses the body
  let endpoint = config.rtbEndpoint;
  if (config.proxy && endpoint.startsWith('http://')) {
    endpoint = endpoint.replace('http://', 'https://');
  }

  logger.info({ requestId, endpoint, proxy: config.proxy ? '***' : 'direct', deviceIp: bidRequest.device.ip }, 'Sending RTB bid request');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RTB_TIMEOUT_MS);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchOptions: any = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
    body: JSON.stringify(bidRequest),
    signal: controller.signal,
    redirect: 'error' as const, // Fail on redirect instead of silently losing POST body
  };

  if (config.proxy) {
    fetchOptions.dispatcher = getProxyAgent(config.proxy) as import('undici').Dispatcher;
  }

  try {
    const response = await fetch(endpoint, fetchOptions);

    // oRTB 2.6 §4.2.1: HTTP 204 = no-bid
    if (response.status === 204) {
      logger.info({ requestId }, 'DSP returned no-bid (204)');
      return { id: requestId, seatbid: [] };
    }

    if (!response.ok) {
      throw new Error(`RTB request failed: ${response.status}`);
    }

    const bidResponse = (await response.json()) as RtbBidResponse;
    logger.info({ requestId, seatbids: bidResponse.seatbid?.length || 0 }, 'RTB bid response received');
    return bidResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract VAST + auction context from bid response.
 * Returns BidResult with vastXml, auctionData, and notification URLs (nurl/burl/lurl).
 */
export function extractBidResult(bidResponse: RtbBidResponse, requestId?: string): BidResult | null {
  if (!bidResponse.seatbid?.length) {
    if (bidResponse.nbr != null) {
      logger.info({ requestId, nbr: bidResponse.nbr }, 'DSP returned no-bid reason');
    }
    return null;
  }

  const seatbid = bidResponse.seatbid[0];
  const bid = seatbid?.bid?.[0];
  if (!bid?.adm) {
    logger.warn({ requestId }, 'Bid has no adm field');
    return null;
  }

  // oRTB 2.6 §4.2.3: price must be positive
  if (bid.price <= 0) {
    logger.warn({ requestId, price: bid.price }, 'Bid price is zero or negative, ignoring');
    return null;
  }

  const adm = bid.adm.trim();

  // Detect non-VAST responses (banner HTML, JSON, etc.)
  if (!adm.startsWith('<')) {
    logger.warn({ requestId, admPreview: adm.slice(0, 100) }, 'adm is not XML — DSP may have returned non-VAST creative');
    return null;
  }

  // Check for VAST root element — if it's HTML (e.g. banner), reject
  const hasVast = /<VAST[\s>]/i.test(adm);
  if (!hasVast) {
    logger.warn({ requestId, admPreview: adm.slice(0, 200) }, 'adm is XML but not VAST — likely banner/HTML creative');
    return null;
  }

  const auctionData: AuctionData = {
    auctionId: bidResponse.id,
    bidId: bid.id,
    impId: bid.impid,
    seatId: seatbid.seat || '',
    adId: bid.cid || '',
    price: bid.price,
    currency: bidResponse.cur || 'USD',
  };

  logger.info(
    { requestId, price: bid.price, seat: seatbid.seat, crid: bid.crid, admBytes: adm.length },
    'VAST extracted from bid',
  );

  return {
    vastXml: adm,
    auctionData,
    nurl: bid.nurl,
    burl: bid.burl,
    lurl: bid.lurl,
  };
}

// Backward-compatible wrapper — returns just VAST XML
export function extractVastFromBidResponse(bidResponse: RtbBidResponse, requestId?: string): string | null {
  const result = extractBidResult(bidResponse, requestId);
  return result?.vastXml ?? null;
}

/**
 * Replace OpenRTB macros in URL string.
 * Supports: ${AUCTION_PRICE}, ${AUCTION_ID}, ${AUCTION_BID_ID}, etc.
 */
export function applyMacros(url: string, data: AuctionData): string {
  if (!url || !data) return url;

  const macroValues: Record<string, string> = {
    'AUCTION_ID': data.auctionId || '',
    'AUCTION_BID_ID': data.bidId || '',
    'AUCTION_IMP_ID': data.impId || '',
    'AUCTION_SEAT_ID': data.seatId || '',
    'AUCTION_AD_ID': data.adId || '',
    'AUCTION_PRICE': data.price != null ? String(data.price) : '',
    'AUCTION_CURRENCY': data.currency || '',
    'AUCTION_LOSS': data.loss != null ? String(data.loss) : '',
  };

  let result = url;
  for (const [name, value] of Object.entries(macroValues)) {
    result = result.split('${' + name + '}').join(value);
    // Base64-encoded variant: ${AUCTION_PRICE:B64}
    result = result.split('${' + name + ':B64}').join(
      value ? Buffer.from(value).toString('base64') : '',
    );
  }
  return result;
}

/**
 * Fire win notification (nurl) — fire-and-forget.
 */
export async function fireWinNotice(nurl: string, auctionData: AuctionData, proxyFetchFn?: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
  const url = applyMacros(nurl, auctionData);
  const doFetch = proxyFetchFn || fetch;
  try {
    await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    logger.info({ url: url.slice(0, 100) }, 'Win notice fired');
  } catch (err) {
    logger.warn({ url: url.slice(0, 80), err: (err as Error).message }, 'Win notice failed');
  }
}

/**
 * Fire billing notification (burl) — fire-and-forget.
 */
export async function fireBillingNotice(burl: string, auctionData: AuctionData, proxyFetchFn?: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
  const url = applyMacros(burl, auctionData);
  const doFetch = proxyFetchFn || fetch;
  try {
    await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    logger.info({ url: url.slice(0, 100) }, 'Billing notice fired');
  } catch (err) {
    logger.warn({ url: url.slice(0, 80), err: (err as Error).message }, 'Billing notice failed');
  }
}

/**
 * Fire loss notification (lurl) — fire-and-forget.
 */
export async function fireLossNotice(lurl: string, auctionData: AuctionData, proxyFetchFn?: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
  const url = applyMacros(lurl, auctionData);
  const doFetch = proxyFetchFn || fetch;
  try {
    await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    logger.info({ url: url.slice(0, 100) }, 'Loss notice fired');
  } catch (err) {
    logger.warn({ url: url.slice(0, 80), err: (err as Error).message }, 'Loss notice failed');
  }
}
