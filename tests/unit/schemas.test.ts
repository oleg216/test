import { describe, it, expect } from 'vitest';
import { SessionConfigSchema } from '../../src/shared/schemas.js';

describe('SessionConfigSchema', () => {
  it('validates a valid session config', () => {
    const valid = {
      device: {
        os: 'AndroidTV',
        vendor: 'Samsung',
        model: 'SmartTV-2024',
        screenWidth: 1920,
        screenHeight: 1080,
        deviceId: 'device-123',
        ifa: 'ifa-456',
        ip: '192.168.1.1',
        networkType: 'WiFi',
        userAgent: 'Mozilla/5.0 (Linux; Android TV)',
        timezone: 'America/New_York',
      },
      rtbEndpoint: 'https://ssp.example.com/bid',
      contentUrl: 'https://cdn.example.com/stream.m3u8',
      appBundle: 'com.example.tvapp',
      appName: 'Example TV',
      appStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.tvapp',
    };
    const result = SessionConfigSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects invalid OS', () => {
    const invalid = {
      device: {
        os: 'Windows',
        vendor: 'Test',
        model: 'Test',
        screenWidth: 1920,
        screenHeight: 1080,
        deviceId: 'id',
        ifa: 'ifa',
        ip: '1.1.1.1',
        networkType: 'WiFi',
        userAgent: 'ua',
        timezone: 'UTC',
      },
      rtbEndpoint: 'https://ssp.example.com/bid',
      contentUrl: 'https://cdn.example.com/stream.m3u8',
      appBundle: 'com.example.tvapp',
      appName: 'Example TV',
      appStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.tvapp',
    };
    const result = SessionConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
