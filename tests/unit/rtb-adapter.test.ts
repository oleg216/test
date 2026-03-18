import { describe, it, expect } from 'vitest';
import { buildBidRequest, extractBidResult, extractVastFromBidResponse, applyMacros } from '../../src/engines/rtb-adapter.js';
import type { SessionConfig, RtbBidResponse, AuctionData } from '../../src/shared/types.js';

const mockConfig: SessionConfig = {
  device: {
    os: 'AndroidTV',
    osv: '14',
    vendor: 'Sony',
    model: 'BRAVIA XR-55A95K',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceId: 'device-1',
    ifa: 'c75583e2-4f09-4ec8-8717-7cf1b4a48b9f',
    ip: '99.118.13.216',
    carrier: 'AT&T Internet',
    networkType: 'WiFi',
    language: 'en',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; BRAVIA XR-55A95K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    timezone: 'America/New_York',
    geo: {
      country: 'USA',
      lat: 34.9446,
      lon: -82.2214,
      region: 'SC',
      metro: '567',
      city: 'Greer',
      zip: '29651',
      type: 2,
      accuracy: 20,
      ipservice: 3,
    },
  },
  rtbEndpoint: 'http://rtb.pixelimpact.live/?pid=test',
  contentUrl: 'https://cdn.example.com/stream.m3u8',
  appBundle: 'com.decor.life',
  appName: 'Decor Life - Home Design Game',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.decor.life',
  publisherId: '915c610a4a',
};

describe('buildBidRequest', () => {
  it('creates DSP-compatible OpenRTB bid request', () => {
    const req = buildBidRequest(mockConfig, 'req-123');

    // Top-level
    expect(req.id).toBe('req-123');
    expect(req.at).toBe(1);
    expect(req.tmax).toBeGreaterThan(0);
    expect(req.cur).toEqual(['USD']);
    expect(req.ext).toEqual({});
    expect(req.bcat).toEqual(['IAB26']);

    // Imp
    expect(req.imp).toHaveLength(1);
    expect(req.imp[0].id).toBe('1');
    expect(req.imp[0].secure).toBe(1);
    expect(req.imp[0].bidfloorcur).toBe('USD');

    // Video — full format matching DSP sample
    const v = req.imp[0].video;
    expect(v.mimes).toContain('video/mp4');
    expect(v.mimes).toContain('video/x-flv');
    expect(v.mimes).toContain('video/webm');
    expect(v.mimes).toContain('application/x-mpegURL');
    expect(v.mimes.length).toBe(9);
    expect(v.protocols).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.w).toBe(1920);
    expect(v.h).toBe(1080);
    expect(v.minduration).toBe(3);
    expect(v.maxduration).toBe(300);
    expect(v.startdelay).toBe(0);
    expect(v.linearity).toBe(1);
    expect(v.sequence).toBe(1);
    expect(v.boxingallowed).toBe(1);
    expect(v.playbackmethod).toEqual([1, 2, 5, 6]);
    expect(v.api).toEqual([1, 2]);

    // Source
    expect(req.source).toEqual({});

    // Regs
    expect(req.regs).toBeDefined();
    expect(req.regs!.coppa).toBe(0);
    expect(req.regs!.ext!.us_privacy).toBe('1YNN');

    // App — with auto-generated id
    expect(req.app.bundle).toBe(mockConfig.appBundle);
    expect(req.app.name).toBe(mockConfig.appName);
    expect(req.app.storeurl).toBe(mockConfig.appStoreUrl);
    expect(req.app.id).toBeDefined();
    expect(req.app.publisher).toEqual({ id: '915c610a4a' });
    expect(req.app.content).toEqual({ language: 'en', livestream: 0 });

    // Device
    expect(req.device.os).toBe('android'); // lowercase
    expect(req.device.osv).toBe('14');
    expect(req.device.devicetype).toBe(3); // Connected TV
    expect(req.device.ua).toBe(mockConfig.device.userAgent);
    expect(req.device.ifa).toBe(mockConfig.device.ifa);
    expect(req.device.make).toBe('sony'); // lowercase
    expect(req.device.model).toBe('BRAVIA XR-55A95K');
    expect(req.device.language).toBe('en');
    expect(req.device.js).toBe(1);
    expect(req.device.connectiontype).toBe(2); // WiFi
    expect(req.device.carrier).toBe('AT&T Internet');
    expect(req.device.ext).toEqual({ ifa_type: 'aaid' });

    // Full geo object
    expect(req.device.geo).toEqual({
      country: 'USA',
      lat: 34.9446,
      lon: -82.2214,
      region: 'SC',
      metro: '567',
      city: 'Greer',
      zip: '29651',
      type: 2,
      accuracy: 20,
      ipservice: 3,
    });

    // User
    expect(req.user).toBeDefined();
    expect(req.user!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(req.user!.ext).toEqual({});
  });

  it('maps OS names to lowercase', () => {
    const tizenConfig = { ...mockConfig, device: { ...mockConfig.device, os: 'Tizen' as const, osv: '7.0' } };
    const webosConfig = { ...mockConfig, device: { ...mockConfig.device, os: 'WebOS' as const, osv: '23' } };

    expect(buildBidRequest(tizenConfig, 'r1').device.os).toBe('tizen');
    expect(buildBidRequest(webosConfig, 'r2').device.os).toBe('webos');
  });

  it('maps connection types correctly', () => {
    const ethernet = { ...mockConfig, device: { ...mockConfig.device, networkType: 'Ethernet' as const } };
    const fourG = { ...mockConfig, device: { ...mockConfig.device, networkType: '4G' as const } };

    expect(buildBidRequest(ethernet, 'r1').device.connectiontype).toBe(1);
    expect(buildBidRequest(fourG, 'r2').device.connectiontype).toBe(6);
  });

  it('omits geo when not provided', () => {
    const configNoGeo = { ...mockConfig, device: { ...mockConfig.device, geo: undefined } };
    const req = buildBidRequest(configNoGeo, 'req-456');
    expect(req.device.geo).toBeUndefined();
  });

  it('auto-generates publisher id when not provided', () => {
    const configNoPub = { ...mockConfig, publisherId: undefined, publisherName: undefined };
    const req = buildBidRequest(configNoPub, 'req-789');
    expect(req.app.publisher).toBeDefined();
    expect(req.app.publisher!.id).toMatch(/^pub-[0-9a-f]{10}$/);
  });

  it('uses custom bcat when provided', () => {
    const configBcat = { ...mockConfig, bcat: ['IAB25', 'IAB26'] };
    const req = buildBidRequest(configBcat, 'r1');
    expect(req.bcat).toEqual(['IAB25', 'IAB26']);
  });

  it('uses custom userId when provided', () => {
    const configUser = { ...mockConfig, userId: 'custom-user-123' };
    const req = buildBidRequest(configUser, 'r1');
    expect(req.user!.id).toBe('custom-user-123');
  });
});

describe('extractBidResult', () => {
  const vastXml = '<?xml version="1.0"?><VAST version="3.0"><Ad><Wrapper></Wrapper></Ad></VAST>';

  it('extracts VAST + auction context from valid response', () => {
    const response: RtbBidResponse = {
      id: 'resp-1',
      seatbid: [{
        seat: '276',
        bid: [{
          id: 'bid-1',
          impid: '1',
          price: 0.158,
          adm: vastXml,
          nurl: 'http://dsp.example.com/win?b=bid-1&price=${AUCTION_PRICE}',
          burl: 'http://dsp.example.com/bill?b=bid-1&price=${AUCTION_PRICE}',
          lurl: 'http://dsp.example.com/loss?b=bid-1&lossreason=${AUCTION_LOSS}',
          cid: '143150',
          crid: '143150|127',
          cat: ['IAB3'],
        }],
      }],
      cur: 'USD',
    };

    const result = extractBidResult(response);
    expect(result).not.toBeNull();
    expect(result!.vastXml).toBe(vastXml);
    expect(result!.auctionData.auctionId).toBe('resp-1');
    expect(result!.auctionData.bidId).toBe('bid-1');
    expect(result!.auctionData.impId).toBe('1');
    expect(result!.auctionData.seatId).toBe('276');
    expect(result!.auctionData.price).toBe(0.158);
    expect(result!.auctionData.currency).toBe('USD');
    expect(result!.nurl).toContain('win');
    expect(result!.burl).toContain('bill');
    expect(result!.lurl).toContain('loss');
  });

  it('returns null for empty seatbid', () => {
    expect(extractBidResult({ id: 'r1', seatbid: [] })).toBeNull();
  });

  it('returns null for zero price', () => {
    const response: RtbBidResponse = {
      id: 'r1',
      seatbid: [{ bid: [{ id: 'b1', impid: '1', price: 0, adm: vastXml }] }],
    };
    expect(extractBidResult(response)).toBeNull();
  });

  it('rejects non-VAST adm (HTML banner)', () => {
    const response: RtbBidResponse = {
      id: 'r1',
      seatbid: [{ bid: [{ id: 'b1', impid: '1', price: 1.5, adm: '<div>banner ad</div>' }] }],
    };
    expect(extractBidResult(response)).toBeNull();
  });

  // Backward compatibility
  it('extractVastFromBidResponse still works', () => {
    const response: RtbBidResponse = {
      id: 'r1',
      seatbid: [{ bid: [{ id: 'b1', impid: '1', price: 1.5, adm: vastXml }] }],
    };
    expect(extractVastFromBidResponse(response)).toBe(vastXml);
  });
});

describe('applyMacros', () => {
  const data: AuctionData = {
    auctionId: 'auction-123',
    bidId: 'bid-456',
    impId: '1',
    seatId: '276',
    adId: 'ad-789',
    price: 0.158,
    currency: 'USD',
  };

  it('replaces AUCTION_PRICE macro', () => {
    const url = 'http://dsp.example.com/win?price=${AUCTION_PRICE}';
    expect(applyMacros(url, data)).toBe('http://dsp.example.com/win?price=0.158');
  });

  it('replaces multiple macros', () => {
    const url = 'http://dsp.example.com/win?b=${AUCTION_BID_ID}&price=${AUCTION_PRICE}&seat=${AUCTION_SEAT_ID}';
    expect(applyMacros(url, data)).toBe('http://dsp.example.com/win?b=bid-456&price=0.158&seat=276');
  });

  it('replaces B64 variant', () => {
    const url = 'http://dsp.example.com/win?price=${AUCTION_PRICE:B64}';
    const result = applyMacros(url, data);
    expect(result).toContain(Buffer.from('0.158').toString('base64'));
  });

  it('handles AUCTION_LOSS macro', () => {
    const dataWithLoss = { ...data, loss: 7 };
    const url = 'http://dsp.example.com/loss?reason=${AUCTION_LOSS}';
    expect(applyMacros(url, dataWithLoss)).toBe('http://dsp.example.com/loss?reason=7');
  });
});
