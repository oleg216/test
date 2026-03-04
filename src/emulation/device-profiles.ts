import { v4 as uuid } from 'uuid';
import type { DeviceProfile } from '../shared/types.js';

interface DevicePreset {
  os: DeviceProfile['os'];
  vendors: Array<{ vendor: string; models: string[] }>;
  screenWidth: number;
  screenHeight: number;
  userAgentTemplate: string;
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  AndroidTV: {
    os: 'AndroidTV',
    vendors: [
      { vendor: 'Sony', models: ['BRAVIA-XR-A95K', 'BRAVIA-XR-X90K'] },
      { vendor: 'Samsung', models: ['SmartTV-2024', 'SmartTV-2023'] },
      { vendor: 'Nvidia', models: ['SHIELD-TV-Pro', 'SHIELD-TV'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (Linux; Android 12; {model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  Tizen: {
    os: 'Tizen',
    vendors: [
      { vendor: 'Samsung', models: ['UN55TU8000', 'QN65Q80B', 'UN43AU8000'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) {model}/7.0 TV Safari/537.36',
  },
  WebOS: {
    os: 'WebOS',
    vendors: [
      { vendor: 'LG', models: ['OLED55C3', 'OLED65B3', '55NANO75'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager',
  },
};

export function generateDeviceProfile(os: DeviceProfile['os']): DeviceProfile {
  const preset = DEVICE_PRESETS[os];
  const vendorEntry = preset.vendors[Math.floor(Math.random() * preset.vendors.length)];
  const model = vendorEntry.models[Math.floor(Math.random() * vendorEntry.models.length)];
  const userAgent = preset.userAgentTemplate.replace('{model}', model);

  return {
    os: preset.os,
    vendor: vendorEntry.vendor,
    model,
    screenWidth: preset.screenWidth,
    screenHeight: preset.screenHeight,
    deviceId: uuid(),
    ifa: uuid(),
    ip: `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
    networkType: 'WiFi',
    userAgent,
    timezone: 'America/New_York',
  };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
