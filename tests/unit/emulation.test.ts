import { describe, it, expect } from 'vitest';
import { DEVICE_PRESETS, generateDeviceProfile } from '../../src/emulation/device-profiles.js';
import { NETWORK_PROFILES } from '../../src/emulation/network-profiles.js';

describe('device profiles', () => {
  it('has presets for AndroidTV, Tizen, WebOS', () => {
    expect(DEVICE_PRESETS.AndroidTV).toBeDefined();
    expect(DEVICE_PRESETS.Tizen).toBeDefined();
    expect(DEVICE_PRESETS.WebOS).toBeDefined();
  });

  it('generates a valid device profile', () => {
    const profile = generateDeviceProfile('AndroidTV');
    expect(profile.os).toBe('AndroidTV');
    expect(profile.deviceId).toBeTruthy();
    expect(profile.ifa).toBeTruthy();
    expect(profile.screenWidth).toBeGreaterThan(0);
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
