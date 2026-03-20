import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import type { DeviceProfile, FingerprintProfile, GeoData } from '../shared/types.js';

const logger = createLogger('fingerprint-loader');

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// CSV column indices (must match fingerprints_tv.csv header)
const COL = {
  os: 0, osv: 1, vendor: 2, model: 3, screenWidth: 4, screenHeight: 5,
  deviceId: 6, ifa: 7, ip: 8, carrier: 9, networkType: 10, language: 11,
  userAgent: 12, timezone: 13,
  geo_country: 14, geo_region: 15, geo_metro: 16, geo_city: 17, geo_zip: 18,
  geo_lat: 19, geo_lon: 20,
  fp_platform: 21, fp_hwConcurrency: 22, fp_deviceMemory: 23, fp_maxTouchPoints: 24,
  fp_conn_type: 25, fp_conn_downlink: 26, fp_conn_rtt: 27, fp_conn_effectiveType: 28,
  fp_screen_colorDepth: 29, fp_screen_pixelDepth: 30,
  fp_webgl_vendor: 31, fp_webgl_renderer: 32,
  fp_canvasNoiseSeed: 33, fp_audioNoiseSeed: 34,
  fp_fonts: 35, fp_plugins: 36, fp_storageQuota: 37,
};

function parseRow(cols: string[]): DeviceProfile {
  const fingerprint: FingerprintProfile = {
    platform: cols[COL.fp_platform],
    hwConcurrency: parseInt(cols[COL.fp_hwConcurrency]) || 4,
    deviceMemory: parseFloat(cols[COL.fp_deviceMemory]) || 2,
    maxTouchPoints: parseInt(cols[COL.fp_maxTouchPoints]) || 0,
    connection: {
      type: cols[COL.fp_conn_type] || 'wifi',
      downlink: parseInt(cols[COL.fp_conn_downlink]) || 25,
      rtt: parseInt(cols[COL.fp_conn_rtt]) || 30,
      effectiveType: cols[COL.fp_conn_effectiveType] || '4g',
    },
    screen: {
      colorDepth: parseInt(cols[COL.fp_screen_colorDepth]) || 24,
      pixelDepth: parseInt(cols[COL.fp_screen_pixelDepth]) || 24,
    },
    webgl: {
      vendor: cols[COL.fp_webgl_vendor] || 'ARM',
      renderer: cols[COL.fp_webgl_renderer] || 'Mali-G78',
    },
    canvasNoiseSeed: parseInt(cols[COL.fp_canvasNoiseSeed]) || 0,
    audioNoiseSeed: parseInt(cols[COL.fp_audioNoiseSeed]) || 0,
    fonts: (cols[COL.fp_fonts] || 'Roboto').split(';'),
    plugins: parseInt(cols[COL.fp_plugins]) || 0,
    storageQuota: parseInt(cols[COL.fp_storageQuota]) || 1073741824,
  };

  const geo: GeoData = {
    country: cols[COL.geo_country] || 'USA',
    region: cols[COL.geo_region] || '',
    metro: cols[COL.geo_metro] || '',
    city: cols[COL.geo_city] || '',
    zip: cols[COL.geo_zip] || '',
    type: 2,
    lat: parseFloat(cols[COL.geo_lat]) || 0,
    lon: parseFloat(cols[COL.geo_lon]) || 0,
  };

  return {
    os: cols[COL.os] as DeviceProfile['os'],
    osv: cols[COL.osv],
    vendor: cols[COL.vendor],
    model: cols[COL.model],
    screenWidth: parseInt(cols[COL.screenWidth]) || 1920,
    screenHeight: parseInt(cols[COL.screenHeight]) || 1080,
    deviceId: cols[COL.deviceId],
    ifa: cols[COL.ifa],
    ip: cols[COL.ip],
    carrier: cols[COL.carrier] || undefined,
    networkType: (cols[COL.networkType] || 'WiFi') as DeviceProfile['networkType'],
    language: cols[COL.language] || 'en',
    userAgent: cols[COL.userAgent],
    timezone: cols[COL.timezone] || 'America/New_York',
    geo,
    fingerprint,
  };
}

export function loadFingerprints(filePath?: string): DeviceProfile[] {
  const path = filePath || resolve(process.cwd(), 'data', 'fingerprints_tv.csv');
  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n');
    const result: DeviceProfile[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCSVLine(line);
      if (cols.length < 30) continue;
      result.push(parseRow(cols));
    }

    logger.info({ count: result.length }, 'Fingerprints loaded from CSV');
    return result;
  } catch (err) {
    logger.warn({ filePath: path, err: (err as Error).message }, 'Failed to load fingerprints');
    return [];
  }
}
