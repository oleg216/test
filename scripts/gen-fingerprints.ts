/**
 * Generate 10 000 realistic CTV fingerprints based on device-profiles.ts presets.
 * Output: data/fingerprints_tv.csv
 */
import { createHash, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNT = 10_000;

// ── Device presets (mirrored from src/emulation/device-profiles.ts) ──

interface Vendor { vendor: string; models: string[] }
interface Preset {
  os: string;
  osVersions: string[];
  vendors: Vendor[];
  screenWidth: number;
  screenHeight: number;
  uaTemplate: string;
}

const PRESETS: Record<string, Preset> = {
  AndroidTV: {
    os: 'AndroidTV', osVersions: ['12', '13', '14'],
    vendors: [
      { vendor: 'Sony', models: ['BRAVIA XR-55A95K', 'BRAVIA XR-65X90K', 'BRAVIA XR-75X95K'] },
      { vendor: 'Nvidia', models: ['SHIELD Android TV Pro', 'SHIELD Android TV'] },
      { vendor: 'Xiaomi', models: [
        'L65M9-SP','L75M9-SP','L85M9-SP','L100M9-SP',
        'L55M9-S','L65M9-S','L75M9-S',
        'L55M8-AP','L65M8-AP','L75M8-AP','L85M8-AP','L100M8-AP',
        'L55M8-A','L65M8-A','L50M8-A','L70M8-A',
        'L55M7-P1E','L43M7-P1E','L50M7-P1E',
        'L55M6-6AEU','L50M6-6AEU','L43M6-6AEU',
        'L65M6-ESG','L55M6-5ASP',
      ]},
      { vendor: 'Redmi', models: [
        'L75MA-RA','L70MA-RA','L65MA-RA','L55MA-RA','L50MA-RA',
        'L55M6-RK','L65M6-RK','L50M6-RK',
      ]},
      { vendor: 'TCL', models: [
        '55EC780','60EP660','43EP660','50EP660','55EP660','65EP660','75EP660',
        '65DC760','55DC760',
        '60P66','50P66',
        '43P6','50P6','55P6','65P6','75P6',
        '65X3','55X3','65X1',
      ]},
      { vendor: 'Hisense', models: ['55A6H','65A6H','75A6H'] },
    ],
    screenWidth: 1920, screenHeight: 1080,
    uaTemplate: 'Mozilla/5.0 (Linux; Android {osv}; {model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  Tizen: {
    os: 'Tizen', osVersions: ['7.0', '8.0'],
    vendors: [
      { vendor: 'Samsung', models: ['UN55TU8000','QN65Q80B','UN43AU8000','QN55S95B','UN50CU7000'] },
    ],
    screenWidth: 1920, screenHeight: 1080,
    uaTemplate: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen {osv}) AppleWebKit/537.36 (KHTML, like Gecko) {model}/{osv} TV Safari/537.36',
  },
  WebOS: {
    os: 'WebOS', osVersions: ['23', '24'],
    vendors: [
      { vendor: 'LG', models: ['OLED55C3PUA','OLED65B3PSA','55NANO75UQA','OLED55G3PUA','65QNED80URA'] },
    ],
    screenWidth: 1920, screenHeight: 1080,
    uaTemplate: 'Mozilla/5.0 (webOS; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager',
  },
};

// OS distribution weights: AndroidTV 60%, Tizen 25%, WebOS 15%
const OS_WEIGHTS: [string, number][] = [['AndroidTV', 0.60], ['Tizen', 0.25], ['WebOS', 0.15]];

// ── Fingerprint presets ──

interface FPPreset { platform: string; hwConcurrency: number; deviceMemory: number; webglVendor: string; webglRenderer: string }

const FP_DEFAULTS: Record<string, FPPreset> = {
  AndroidTV: { platform: 'Linux armv8l', hwConcurrency: 4, deviceMemory: 2, webglVendor: 'ARM', webglRenderer: 'Mali-G78' },
  Tizen:     { platform: 'Linux armv7l', hwConcurrency: 2, deviceMemory: 1.5, webglVendor: 'ARM', webglRenderer: 'Mali-400 MP' },
  WebOS:     { platform: 'Linux armv7l', hwConcurrency: 4, deviceMemory: 2, webglVendor: 'ARM', webglRenderer: 'Mali-T860' },
};

const MODEL_HW: Array<{ match: (m: string) => boolean; spec: Partial<FPPreset> }> = [
  { match: m => /^(55EC780|\d+EP660)$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-470 MP3' }},
  { match: m => /^\d+DC760$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2.5, webglVendor:'ARM', webglRenderer:'Mali-T860 MP2' }},
  { match: m => /^\d+(P66|P6|X3|X1)$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-T860 MP2' }},
  { match: m => /^L\d+M9-SP$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:4, webglVendor:'ARM', webglRenderer:'Mali-G52 MC1' }},
  { match: m => /^L\d+M9-S$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:3, webglVendor:'ARM', webglRenderer:'Mali-G52 MC1' }},
  { match: m => m === 'L100M8-AP', spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:4, webglVendor:'ARM', webglRenderer:'Mali-G52 MC1' }},
  { match: m => /^L\d+M8-AP$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-G52 MC1' }},
  { match: m => /^L\d+M8-A$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:1.5, webglVendor:'ARM', webglRenderer:'Mali-G31 MP2' }},
  { match: m => /^L\d+M7-P1E$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-G52' }},
  { match: m => /^L\d+M6-6AEU$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-G52 MP2' }},
  { match: m => m === 'L65M6-ESG', spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-G52 MP2' }},
  { match: m => m === 'L55M6-5ASP', spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-450 MP3' }},
  { match: m => /^L(65|70|75)MA-RA$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-G31 MP2' }},
  { match: m => /^L(50|55)MA-RA$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:1.5, webglVendor:'ARM', webglRenderer:'Mali-G31 MP2' }},
  { match: m => /^L\d+M6-RK$/.test(m), spec: { platform:'Linux armv8l', hwConcurrency:4, deviceMemory:2, webglVendor:'ARM', webglRenderer:'Mali-G51 MP3' }},
];

// ── Connections ──
const CONNECTIONS = [
  { type: 'wifi', downlink: 25, rtt: 30, effectiveType: '4g' },
  { type: 'wifi', downlink: 50, rtt: 20, effectiveType: '4g' },
  { type: 'ethernet', downlink: 100, rtt: 10, effectiveType: '4g' },
];

// ── Fonts per OS ──
const FONTS: Record<string, string[]> = {
  AndroidTV: ['Roboto', 'Noto Sans', 'Droid Sans'],
  Tizen: ['SamsungOneUI', 'Roboto', 'Noto Sans CJK'],
  WebOS: ['LG Smart UI', 'Roboto', 'Noto Sans'],
};

// ── Geo regions ──
const REGIONS = [
  { tz:'America/New_York', lat:40.7128, lon:-74.006, jLat:0.5, jLon:0.5, langs:['en'], country:'USA', region:'NY', metro:'501', city:'New York', zip:'10001' },
  { tz:'America/New_York', lat:40.6782, lon:-73.9442, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'NY', metro:'501', city:'Brooklyn', zip:'11201' },
  { tz:'America/Chicago', lat:41.8781, lon:-87.6298, jLat:0.5, jLon:0.5, langs:['en'], country:'USA', region:'IL', metro:'602', city:'Chicago', zip:'60601' },
  { tz:'America/Los_Angeles', lat:34.0522, lon:-118.2437, jLat:0.5, jLon:0.5, langs:['en'], country:'USA', region:'CA', metro:'803', city:'Los Angeles', zip:'90001' },
  { tz:'America/Los_Angeles', lat:34.1478, lon:-118.1445, jLat:0.2, jLon:0.2, langs:['en'], country:'USA', region:'CA', metro:'803', city:'Pasadena', zip:'91101' },
  { tz:'America/Chicago', lat:32.7767, lon:-96.797, jLat:0.5, jLon:0.5, langs:['en'], country:'USA', region:'TX', metro:'623', city:'Dallas', zip:'75201' },
  { tz:'America/Chicago', lat:29.7604, lon:-95.3698, jLat:0.5, jLon:0.5, langs:['en','es'], country:'USA', region:'TX', metro:'618', city:'Houston', zip:'77001' },
  { tz:'America/New_York', lat:25.7617, lon:-80.1918, jLat:0.3, jLon:0.3, langs:['en','es'], country:'USA', region:'FL', metro:'528', city:'Miami', zip:'33101' },
  { tz:'America/New_York', lat:33.749, lon:-84.388, jLat:0.5, jLon:0.5, langs:['en'], country:'USA', region:'GA', metro:'524', city:'Atlanta', zip:'30301' },
  { tz:'America/Denver', lat:39.7392, lon:-104.9903, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'CO', metro:'751', city:'Denver', zip:'80201' },
  { tz:'America/Phoenix', lat:33.4484, lon:-112.074, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'AZ', metro:'753', city:'Phoenix', zip:'85001' },
  { tz:'America/New_York', lat:39.9526, lon:-75.1652, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'PA', metro:'504', city:'Philadelphia', zip:'19101' },
  { tz:'America/Chicago', lat:44.9778, lon:-93.265, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'MN', metro:'613', city:'Minneapolis', zip:'55401' },
  { tz:'America/Los_Angeles', lat:47.6062, lon:-122.3321, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'WA', metro:'819', city:'Seattle', zip:'98101' },
  { tz:'America/New_York', lat:34.9446, lon:-82.2214, jLat:0.2, jLon:0.2, langs:['en'], country:'USA', region:'SC', metro:'567', city:'Greer', zip:'29651' },
  { tz:'America/New_York', lat:42.3601, lon:-71.0589, jLat:0.3, jLon:0.3, langs:['en'], country:'USA', region:'MA', metro:'506', city:'Boston', zip:'02101' },
];

const CARRIERS = ['AT&T Internet','Comcast Cable','Verizon Fios','Spectrum','Cox Communications','T-Mobile USA','CenturyLink','Frontier'];

const RESIDENTIAL_PREFIXES = [
  24,47,50,66,68,69,71,72,73,74,75,76,96,97,98,99,107,108,174,184,209,
];

// ── Helpers ──

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function round4(n: number) { return Math.round(n * 10000) / 10000; }

function hashToSeed(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0);
}

function genIp(): string {
  const p = pick(RESIDENTIAL_PREFIXES);
  return `${p}.${randInt(0,255)}.${randInt(0,255)}.${randInt(1,254)}`;
}

function getHW(model: string, os: string): FPPreset {
  const base = FP_DEFAULTS[os] || FP_DEFAULTS.AndroidTV;
  for (const entry of MODEL_HW) {
    if (entry.match(model)) return { ...base, ...entry.spec } as FPPreset;
  }
  return base;
}

function getResolution(vendor: string): { w: number; h: number } {
  if (['TCL','Xiaomi','Redmi'].includes(vendor)) return { w: 3840, h: 2160 };
  return { w: 1920, h: 1080 };
}

// ── Pick OS based on weight ──

function pickOs(): string {
  const r = Math.random();
  let cum = 0;
  for (const [os, w] of OS_WEIGHTS) {
    cum += w;
    if (r < cum) return os;
  }
  return 'AndroidTV';
}

// ── CSV escaping ──
function esc(v: string | number): string {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ── Generate ──

const HEADER = [
  'os','osv','vendor','model','screenWidth','screenHeight',
  'deviceId','ifa','ip','carrier','networkType','language','userAgent','timezone',
  'geo_country','geo_region','geo_metro','geo_city','geo_zip','geo_lat','geo_lon',
  'fp_platform','fp_hwConcurrency','fp_deviceMemory','fp_maxTouchPoints',
  'fp_conn_type','fp_conn_downlink','fp_conn_rtt','fp_conn_effectiveType',
  'fp_screen_colorDepth','fp_screen_pixelDepth',
  'fp_webgl_vendor','fp_webgl_renderer',
  'fp_canvasNoiseSeed','fp_audioNoiseSeed',
  'fp_fonts','fp_plugins','fp_storageQuota',
].join(',');

const lines: string[] = [HEADER];

for (let i = 0; i < COUNT; i++) {
  const osKey = pickOs();
  const preset = PRESETS[osKey];
  const vendorEntry = pick(preset.vendors);
  const model = pick(vendorEntry.models);
  const osv = pick(preset.osVersions);
  const region = pick(REGIONS);
  const lang = pick(region.langs);
  const networkType = Math.random() < 0.85 ? 'WiFi' : 'Ethernet';
  const carrier = pick(CARRIERS);
  const deviceId = randomUUID();
  const ifa = randomUUID();
  const ip = genIp();

  const ua = preset.uaTemplate
    .replace('{model}', model)
    .replace('{osv}', osv)
    .replace('{osv}', osv);

  const res = getResolution(vendorEntry.vendor);
  const screenW = res.w;
  const screenH = res.h;

  const geoLat = round4(region.lat + (Math.random() - 0.5) * 2 * region.jLat);
  const geoLon = round4(region.lon + (Math.random() - 0.5) * 2 * region.jLon);

  // Fingerprint
  const hw = getHW(model, osKey);
  const conn = CONNECTIONS[hashToSeed('conn:' + deviceId) % CONNECTIONS.length];
  const fonts = (FONTS[osKey] || FONTS.AndroidTV).join(';');

  const row = [
    osKey, osv, vendorEntry.vendor, model, screenW, screenH,
    deviceId, ifa, ip, carrier, networkType, lang, ua, region.tz,
    region.country, region.region, region.metro, region.city, region.zip, geoLat, geoLon,
    hw.platform, hw.hwConcurrency, hw.deviceMemory, 0,
    conn.type, conn.downlink, conn.rtt, conn.effectiveType,
    24, 24,
    hw.webglVendor, hw.webglRenderer,
    hashToSeed('canvas:' + deviceId), hashToSeed('audio:' + deviceId),
    fonts, 0, 1073741824,
  ].map(v => esc(v));

  lines.push(row.join(','));
}

const outPath = resolve(__dirname, '..', 'data', 'fingerprints_tv.csv');
writeFileSync(outPath, lines.join('\n'), 'utf-8');
console.log(`Done: ${COUNT} fingerprints → ${outPath}`);
