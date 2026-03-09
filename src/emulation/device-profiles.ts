import { v4 as uuid } from 'uuid';
import { createHash } from 'crypto';
import type { DeviceProfile, FingerprintProfile, GeoData } from '../shared/types.js';

interface DevicePreset {
  os: DeviceProfile['os'];
  osVersions: string[];
  vendors: Array<{ vendor: string; models: string[] }>;
  screenWidth: number;
  screenHeight: number;
  userAgentTemplate: string;
}

// Samsung TVs run Tizen — NEVER list Samsung under AndroidTV
export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  AndroidTV: {
    os: 'AndroidTV',
    osVersions: ['12', '13', '14'],
    vendors: [
      { vendor: 'Sony', models: ['BRAVIA XR-55A95K', 'BRAVIA XR-65X90K', 'BRAVIA XR-75X95K'] },
      { vendor: 'Nvidia', models: ['SHIELD Android TV Pro', 'SHIELD Android TV'] },
      { vendor: 'Xiaomi', models: ['MITV-MSSP1', 'MITV-MSSQ1'] },
      { vendor: 'TCL', models: ['55S546', '65S546', '75S546'] },
      { vendor: 'Hisense', models: ['55A6H', '65A6H', '75A6H'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    // Real Android TV user agents use current Chrome version
    userAgentTemplate: 'Mozilla/5.0 (Linux; Android {osv}; {model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  Tizen: {
    os: 'Tizen',
    osVersions: ['7.0', '8.0'],
    vendors: [
      { vendor: 'Samsung', models: ['UN55TU8000', 'QN65Q80B', 'UN43AU8000', 'QN55S95B', 'UN50CU7000'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen {osv}) AppleWebKit/537.36 (KHTML, like Gecko) {model}/{osv} TV Safari/537.36',
  },
  WebOS: {
    os: 'WebOS',
    osVersions: ['23', '24'],
    vendors: [
      { vendor: 'LG', models: ['OLED55C3PUA', 'OLED65B3PSA', '55NANO75UQA', 'OLED55G3PUA', '65QNED80URA'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (webOS; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager',
  },
};

// Fingerprint presets per OS — realistic CTV hardware fingerprints
interface FingerprintPreset {
  platform: string;
  hwConcurrency: number;
  deviceMemory: number;
  webgl: { vendor: string; renderer: string };
}

export const FINGERPRINT_PRESETS: Record<string, FingerprintPreset> = {
  AndroidTV: {
    platform: 'Linux armv8l',
    hwConcurrency: 4,
    deviceMemory: 2,
    webgl: { vendor: 'ARM', renderer: 'Mali-G78' },
  },
  Tizen: {
    platform: 'Linux armv7l',
    hwConcurrency: 2,
    deviceMemory: 1.5,
    webgl: { vendor: 'ARM', renderer: 'Mali-400 MP' },
  },
  WebOS: {
    platform: 'Linux armv7l',
    hwConcurrency: 4,
    deviceMemory: 2,
    webgl: { vendor: 'ARM', renderer: 'Mali-T860' },
  },
};

function hashToSeed(input: string): number {
  const hash = createHash('sha256').update(input).digest();
  return hash.readUInt32BE(0);
}

function generateFingerprint(os: string, deviceId: string, screenWidth: number, screenHeight: number): FingerprintProfile {
  const preset = FINGERPRINT_PRESETS[os] || FINGERPRINT_PRESETS.AndroidTV;
  const connectionTypes = [
    { type: 'wifi', downlink: 25, rtt: 30, effectiveType: '4g' },
    { type: 'wifi', downlink: 50, rtt: 20, effectiveType: '4g' },
    { type: 'ethernet', downlink: 100, rtt: 10, effectiveType: '4g' },
  ];
  const conn = connectionTypes[hashToSeed('conn:' + deviceId) % connectionTypes.length];

  return {
    platform: preset.platform,
    hwConcurrency: preset.hwConcurrency,
    deviceMemory: preset.deviceMemory,
    maxTouchPoints: 0,
    connection: conn,
    screen: { colorDepth: 24, pixelDepth: 24 },
    webgl: preset.webgl,
    canvasNoiseSeed: hashToSeed('canvas:' + deviceId),
    audioNoiseSeed: hashToSeed('audio:' + deviceId),
    fonts: ['Roboto', 'Noto Sans', 'Droid Sans'],
    plugins: 0,
    storageQuota: 1073741824, // 1 GB
  };
}

// Full US geo regions with OpenRTB-compatible fields (country, region, metro, city, zip)
// Matches DSP sample format: country="USA", type=2, ipservice=3
interface GeoRegion {
  timezone: string;
  lat: number;
  lon: number;
  latJitter: number;
  lonJitter: number;
  languages: string[];
  country: string;
  region: string;    // ISO subdivision code (US state)
  metro: string;     // Nielsen DMA code
  city: string;
  zip: string;
  accuracy: number;  // Accuracy radius in km
}

const GEO_REGIONS: GeoRegion[] = [
  // New York Metro
  { timezone: 'America/New_York', lat: 40.7128, lon: -74.006, latJitter: 0.5, lonJitter: 0.5, languages: ['en'], country: 'USA', region: 'NY', metro: '501', city: 'New York', zip: '10001', accuracy: 20 },
  { timezone: 'America/New_York', lat: 40.6782, lon: -73.9442, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'NY', metro: '501', city: 'Brooklyn', zip: '11201', accuracy: 15 },
  // Chicago
  { timezone: 'America/Chicago', lat: 41.8781, lon: -87.6298, latJitter: 0.5, lonJitter: 0.5, languages: ['en'], country: 'USA', region: 'IL', metro: '602', city: 'Chicago', zip: '60601', accuracy: 20 },
  // Los Angeles
  { timezone: 'America/Los_Angeles', lat: 34.0522, lon: -118.2437, latJitter: 0.5, lonJitter: 0.5, languages: ['en'], country: 'USA', region: 'CA', metro: '803', city: 'Los Angeles', zip: '90001', accuracy: 20 },
  { timezone: 'America/Los_Angeles', lat: 34.1478, lon: -118.1445, latJitter: 0.2, lonJitter: 0.2, languages: ['en'], country: 'USA', region: 'CA', metro: '803', city: 'Pasadena', zip: '91101', accuracy: 10 },
  // Dallas-Fort Worth
  { timezone: 'America/Chicago', lat: 32.7767, lon: -96.797, latJitter: 0.5, lonJitter: 0.5, languages: ['en'], country: 'USA', region: 'TX', metro: '623', city: 'Dallas', zip: '75201', accuracy: 20 },
  // Houston
  { timezone: 'America/Chicago', lat: 29.7604, lon: -95.3698, latJitter: 0.5, lonJitter: 0.5, languages: ['en', 'es'], country: 'USA', region: 'TX', metro: '618', city: 'Houston', zip: '77001', accuracy: 20 },
  // Miami
  { timezone: 'America/New_York', lat: 25.7617, lon: -80.1918, latJitter: 0.3, lonJitter: 0.3, languages: ['en', 'es'], country: 'USA', region: 'FL', metro: '528', city: 'Miami', zip: '33101', accuracy: 15 },
  // Atlanta
  { timezone: 'America/New_York', lat: 33.749, lon: -84.388, latJitter: 0.5, lonJitter: 0.5, languages: ['en'], country: 'USA', region: 'GA', metro: '524', city: 'Atlanta', zip: '30301', accuracy: 20 },
  // Denver
  { timezone: 'America/Denver', lat: 39.7392, lon: -104.9903, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'CO', metro: '751', city: 'Denver', zip: '80201', accuracy: 15 },
  // Phoenix
  { timezone: 'America/Phoenix', lat: 33.4484, lon: -112.074, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'AZ', metro: '753', city: 'Phoenix', zip: '85001', accuracy: 15 },
  // Philadelphia
  { timezone: 'America/New_York', lat: 39.9526, lon: -75.1652, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'PA', metro: '504', city: 'Philadelphia', zip: '19101', accuracy: 15 },
  // Minneapolis
  { timezone: 'America/Chicago', lat: 44.9778, lon: -93.265, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'MN', metro: '613', city: 'Minneapolis', zip: '55401', accuracy: 15 },
  // Seattle
  { timezone: 'America/Los_Angeles', lat: 47.6062, lon: -122.3321, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'WA', metro: '819', city: 'Seattle', zip: '98101', accuracy: 15 },
  // South Carolina (matches DSP sample)
  { timezone: 'America/New_York', lat: 34.9446, lon: -82.2214, latJitter: 0.2, lonJitter: 0.2, languages: ['en'], country: 'USA', region: 'SC', metro: '567', city: 'Greer', zip: '29651', accuracy: 20 },
  // Boston
  { timezone: 'America/New_York', lat: 42.3601, lon: -71.0589, latJitter: 0.3, lonJitter: 0.3, languages: ['en'], country: 'USA', region: 'MA', metro: '506', city: 'Boston', zip: '02101', accuracy: 15 },
];

// US residential carrier names (matches ISP ranges)
const US_CARRIERS = [
  'AT&T Internet', 'Comcast Cable', 'Verizon Fios', 'Spectrum',
  'Cox Communications', 'T-Mobile USA', 'CenturyLink', 'Frontier',
];

export function generateDeviceProfile(os: DeviceProfile['os']): DeviceProfile {
  const preset = DEVICE_PRESETS[os];
  const vendorEntry = preset.vendors[Math.floor(Math.random() * preset.vendors.length)];
  const model = vendorEntry.models[Math.floor(Math.random() * vendorEntry.models.length)];
  const osv = preset.osVersions[Math.floor(Math.random() * preset.osVersions.length)];

  const userAgent = preset.userAgentTemplate
    .replace('{model}', model)
    .replace('{osv}', osv)
    .replace('{osv}', osv); // Tizen template has two {osv}

  const region = GEO_REGIONS[Math.floor(Math.random() * GEO_REGIONS.length)];
  const language = region.languages[Math.floor(Math.random() * region.languages.length)];

  // ~85% WiFi, ~15% Ethernet for CTV
  const networkType: DeviceProfile['networkType'] = Math.random() < 0.85 ? 'WiFi' : 'Ethernet';

  // Pick a carrier
  const carrier = US_CARRIERS[Math.floor(Math.random() * US_CARRIERS.length)];

  const deviceId = uuid();

  // Build full OpenRTB geo object
  const geo: GeoData = {
    country: region.country,
    lat: round(region.lat + (Math.random() - 0.5) * 2 * region.latJitter, 4),
    lon: round(region.lon + (Math.random() - 0.5) * 2 * region.lonJitter, 4),
    region: region.region,
    metro: region.metro,
    city: region.city,
    zip: region.zip,
    type: 2,           // IP-based
    accuracy: region.accuracy,
    ipservice: 3,      // MaxMind
  };

  return {
    os: preset.os,
    osv,
    vendor: vendorEntry.vendor,
    model,
    screenWidth: preset.screenWidth,
    screenHeight: preset.screenHeight,
    deviceId,
    ifa: uuid(),
    ip: generateResidentialIp(),
    carrier,
    networkType,
    language,
    userAgent,
    timezone: region.timezone,
    geo,
    fingerprint: generateFingerprint(os, deviceId, preset.screenWidth, preset.screenHeight),
  };
}

// Generate IPs in common US residential ISP ranges, avoiding datacenter/cloud ranges
function generateResidentialIp(): string {
  // Common US residential ISP first octets (Comcast, AT&T, Verizon, Spectrum, Cox)
  const residentialPrefixes = [
    [24, 0, 255], [47, 0, 255], [50, 0, 255], [66, 0, 255],
    [68, 0, 255], [69, 0, 255], [71, 0, 255], [72, 0, 255],
    [73, 0, 255], [74, 0, 255], [75, 0, 255], [76, 0, 255],
    [96, 0, 255], [97, 0, 255], [98, 0, 255], [99, 0, 255],
    [107, 0, 255], [108, 0, 255], [174, 0, 255], [184, 0, 255],
    [192, 0, 255], [209, 0, 255],
  ];
  const prefix = residentialPrefixes[Math.floor(Math.random() * residentialPrefixes.length)];
  return `${prefix[0]}.${randInt(prefix[1], prefix[2])}.${randInt(0, 255)}.${randInt(1, 254)}`;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
