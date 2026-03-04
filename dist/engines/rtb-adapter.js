import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { RTB_TIMEOUT_MS } from '../shared/constants.js';
const logger = createLogger('rtb-adapter');
export function buildBidRequest(config, requestId) {
    return {
        id: requestId,
        imp: [
            {
                id: '1',
                video: {
                    mimes: ['video/mp4', 'application/x-mpegURL'],
                    protocols: [2, 3, 5, 6],
                    w: config.device.screenWidth,
                    h: config.device.screenHeight,
                    linearity: 1,
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
            devicetype: 7,
            ip: config.device.ip,
            ifa: config.device.ifa,
            os: config.device.os,
            w: config.device.screenWidth,
            h: config.device.screenHeight,
            connectiontype: config.device.networkType === 'WiFi' ? 2 : config.device.networkType === '4G' ? 6 : 5,
            carrier: config.device.carrier,
        },
    };
}
export async function sendBidRequest(config) {
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
        if (!response.ok) {
            throw new Error(`RTB request failed: ${response.status}`);
        }
        const bidResponse = (await response.json());
        logger.info({ requestId, seatbids: bidResponse.seatbid?.length || 0 }, 'RTB bid response received');
        return bidResponse;
    }
    finally {
        clearTimeout(timeout);
    }
}
export function extractVastFromBidResponse(bidResponse) {
    const seatbid = bidResponse.seatbid?.[0];
    const bid = seatbid?.bid?.[0];
    if (!bid?.adm)
        return null;
    return bid.adm;
}
//# sourceMappingURL=rtb-adapter.js.map