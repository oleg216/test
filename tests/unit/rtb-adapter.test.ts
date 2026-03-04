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
    expect(req.id).toBe('req-123');
    expect(req.device.devicetype).toBe(7);
    expect(req.device.ua).toBe(mockConfig.device.userAgent);
    expect(req.device.ifa).toBe(mockConfig.device.ifa);
    expect(req.app.bundle).toBe(mockConfig.appBundle);
    expect(req.imp).toHaveLength(1);
    expect(req.imp[0].video).toBeDefined();
    expect(req.imp[0].video.w).toBe(1920);
  });
});
