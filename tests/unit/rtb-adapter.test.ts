import { describe, it, expect } from 'vitest';
import { buildBidRequest } from '../../src/engines/rtb-adapter.js';
import type { SessionConfig } from '../../src/shared/types.js';

const mockConfig: SessionConfig = {
  device: {
    os: 'AndroidTV',
    vendor: 'Sony',
    model: 'BRAVIA-XR',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceId: 'device-1',
    ifa: 'ifa-1',
    ip: '1.2.3.4',
    networkType: 'WiFi',
    userAgent: 'Mozilla/5.0 (Android TV)',
    timezone: 'America/New_York',
    geo: { lat: 40.7128, lon: -74.006 },
  },
  rtbEndpoint: 'https://ssp.example.com/bid',
  contentUrl: 'https://cdn.example.com/stream.m3u8',
  appBundle: 'com.example.tvapp',
  appName: 'Example TV',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.tvapp',
};

describe('buildBidRequest', () => {
  it('creates valid OpenRTB 2.6 bid request', () => {
    const req = buildBidRequest(mockConfig, 'req-123');

    // Top-level required + recommended
    expect(req.id).toBe('req-123');
    expect(req.at).toBe(1);
    expect(req.tmax).toBeGreaterThan(0);
    expect(req.cur).toEqual(['USD']);

    // Imp + video
    expect(req.imp).toHaveLength(1);
    expect(req.imp[0].id).toBe('1');
    expect(req.imp[0].video.mimes).toContain('video/mp4');
    expect(req.imp[0].video.w).toBe(1920);
    expect(req.imp[0].video.h).toBe(1080);
    expect(req.imp[0].video.linearity).toBe(1);
    expect(req.imp[0].video.startdelay).toBe(0);
    expect(req.imp[0].video.plcmt).toBe(1);
    expect(req.imp[0].video.minduration).toBeDefined();
    expect(req.imp[0].video.maxduration).toBeDefined();

    // App
    expect(req.app.bundle).toBe(mockConfig.appBundle);
    expect(req.app.name).toBe(mockConfig.appName);
    expect(req.app.storeurl).toBe(mockConfig.appStoreUrl);

    // Device
    expect(req.device.devicetype).toBe(3); // Connected TV for AndroidTV
    expect(req.device.ua).toBe(mockConfig.device.userAgent);
    expect(req.device.ifa).toBe(mockConfig.device.ifa);
    expect(req.device.make).toBe('Sony');
    expect(req.device.model).toBe('BRAVIA-XR');
    expect(req.device.geo).toEqual({ lat: 40.7128, lon: -74.006 });
  });

  it('omits geo when not provided', () => {
    const configNoGeo = { ...mockConfig, device: { ...mockConfig.device, geo: undefined } };
    const req = buildBidRequest(configNoGeo, 'req-456');
    expect(req.device.geo).toBeUndefined();
  });
});
