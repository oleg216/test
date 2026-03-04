import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { RTB_TIMEOUT_MS } from '../shared/constants.js';
import type { SessionConfig, RtbBidRequest, RtbBidResponse } from '../shared/types.js';

const logger = createLogger('rtb-adapter');

// oRTB 2.6 §3.2.18: 3=Connected TV, 7=Set Top Box
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

export function buildBidRequest(config: SessionConfig, requestId: string): RtbBidRequest {
  const request: RtbBidRequest = {
    id: requestId,
    at: 1, // First Price auction
    tmax: RTB_TIMEOUT_MS,
    cur: ['USD'],
    imp: [
      {
        id: '1',
        video: {
          mimes: ['video/mp4', 'application/x-mpegURL'],
          protocols: [2, 3, 5, 6], // VAST 2.0, 3.0, 2.0 wrapper, 3.0 wrapper
          w: config.device.screenWidth,
          h: config.device.screenHeight,
          linearity: 1, // Linear (in-stream)
          startdelay: 0, // Pre-roll
          plcmt: 1, // In-Stream (oRTB 2.6)
          minduration: 5,
          maxduration: 120,
        },
      },
    ],
    app: {
      bundle: config.appBundle,
      name: config.appName,
      storeurl: config.appStoreUrl,
    },
    device: {
      ua: config.device.userAgent,
      devicetype: mapDeviceType(config.device.os),
      make: config.device.vendor,
      model: config.device.model,
      ip: config.device.ip,
      ifa: config.device.ifa,
      os: config.device.os,
      w: config.device.screenWidth,
      h: config.device.screenHeight,
      connectiontype: config.device.networkType === 'WiFi' ? 2 : config.device.networkType === '4G' ? 6 : 5,
      carrier: config.device.carrier,
    },
  };

  if (config.device.geo) {
    request.device.geo = { lat: config.device.geo.lat, lon: config.device.geo.lon };
  }

  return request;
}

export async function sendBidRequest(config: SessionConfig): Promise<RtbBidResponse> {
  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);

  logger.info({ requestId, endpoint: config.rtbEndpoint }, 'Sending RTB bid request');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RTB_TIMEOUT_MS);

  try {
    const response = await fetch(config.rtbEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: JSON.stringify(bidRequest),
      signal: controller.signal,
    });

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

export function extractVastFromBidResponse(bidResponse: RtbBidResponse, requestId?: string): string | null {
  if (!bidResponse.seatbid?.length) {
    if (bidResponse.nbr != null) {
      logger.info({ nbr: bidResponse.nbr }, 'DSP returned no-bid reason');
    }
    return null;
  }

  const seatbid = bidResponse.seatbid[0];
  const bid = seatbid?.bid?.[0];
  if (!bid?.adm) return null;

  // oRTB 2.6 §4.2.3: price must be positive
  if (bid.price <= 0) {
    logger.warn({ price: bid.price }, 'Bid price is zero or negative, ignoring');
    return null;
  }

  return bid.adm;
}
