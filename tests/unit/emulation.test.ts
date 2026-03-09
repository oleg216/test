import { describe, it, expect } from 'vitest';
import { DEVICE_PRESETS, generateDeviceProfile } from '../../src/emulation/device-profiles.js';
import { NETWORK_PROFILES } from '../../src/emulation/network-profiles.js';

describe('device profiles', () => {
  it('has presets for AndroidTV, Tizen, WebOS', () => {
    expect(DEVICE_PRESETS.AndroidTV).toBeDefined();
    expect(DEVICE_PRESETS.Tizen).toBeDefined();
    expect(DEVICE_PRESETS.WebOS).toBeDefined();
  });

  it('Samsung is only in Tizen, not AndroidTV', () => {
    const androidVendors = DEVICE_PRESETS.AndroidTV.vendors.map(v => v.vendor);
    const tizenVendors = DEVICE_PRESETS.Tizen.vendors.map(v => v.vendor);
    expect(androidVendors).not.toContain('Samsung');
    expect(tizenVendors).toContain('Samsung');
  });

  it('generates a valid device profile with all required fields', () => {
    const profile = generateDeviceProfile('AndroidTV');
    expect(profile.os).toBe('AndroidTV');
    expect(profile.osv).toBeTruthy();
    expect(profile.language).toBeTruthy();
    expect(profile.deviceId).toBeTruthy();
    expect(profile.ifa).toBeTruthy();
    expect(profile.screenWidth).toBeGreaterThan(0);
    expect(profile.geo).toBeDefined();
    expect(profile.timezone).toBeTruthy();
  });

  it('generates varied network types', () => {
    const types = new Set<string>();
    for (let i = 0; i < 100; i++) {
      types.add(generateDeviceProfile('AndroidTV').networkType);
    }
    expect(types.has('WiFi')).toBe(true);
    // Ethernet should appear in ~15% of 100 samples
    expect(types.has('Ethernet')).toBe(true);
  });

  it('generates varied timezones', () => {
    const tzs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tzs.add(generateDeviceProfile('Tizen').timezone);
    }
    expect(tzs.size).toBeGreaterThan(1);
  });
});

describe('network profiles', () => {
  it('has 3G, 4G, WiFi profiles', () => {
    expect(NETWORK_PROFILES['3G']).toBeDefined();
    expect(NETWORK_PROFILES['4G']).toBeDefined();
    expect(NETWORK_PROFILES['WiFi']).toBeDefined();
  });

  it('3G has lowest throughput', () => {
    expect(NETWORK_PROFILES['3G'].downloadThroughput)
      .toBeLessThan(NETWORK_PROFILES['4G'].downloadThroughput);
  });
});
