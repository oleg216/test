import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import type { DeviceProfile } from '../shared/types.js';
import { generateDeviceProfile } from './device-profiles.js';

const logger = createLogger('user-pool');

export interface PoolUser {
  ip: string;
  country: string;      // ISO alpha-2 from CSV (AU)
  countryAlpha3: string; // ISO alpha-3 for OpenRTB (AUS)
  region: string;        // State/region
  city: string;
  connectionType: string; // WiFi | Cellular
  isp: string;
  userAgent: string;
  language: string;
  osVersion: string;
  browser: string;
  deviceType: string;
  deviceModel: string;
}

// ISO alpha-2 → alpha-3 mapping for common countries
const COUNTRY_MAP: Record<string, string> = {
  AU: 'AUS', US: 'USA', GB: 'GBR', CA: 'CAN', DE: 'DEU',
  FR: 'FRA', NZ: 'NZL', IN: 'IND', BR: 'BRA', JP: 'JPN',
  KR: 'KOR', SG: 'SGP', NL: 'NLD', SE: 'SWE', IT: 'ITA',
};

// Australian city → approximate coordinates
const AU_CITY_GEO: Record<string, { lat: number; lon: number; region: string; metro: string; zip: string }> = {
  Sydney:     { lat: -33.8688, lon: 151.2093, region: 'NSW', metro: '75101', zip: '2000' },
  Melbourne:  { lat: -37.8136, lon: 144.9631, region: 'VIC', metro: '75102', zip: '3000' },
  Brisbane:   { lat: -27.4698, lon: 153.0251, region: 'QLD', metro: '75103', zip: '4000' },
  Perth:      { lat: -31.9505, lon: 115.8605, region: 'WA',  metro: '75104', zip: '6000' },
  Adelaide:   { lat: -34.9285, lon: 138.6007, region: 'SA',  metro: '75105', zip: '5000' },
  Canberra:   { lat: -35.2809, lon: 149.1300, region: 'ACT', metro: '75106', zip: '2600' },
  Hobart:     { lat: -42.8821, lon: 147.3272, region: 'TAS', metro: '75107', zip: '7000' },
  Darwin:     { lat: -12.4634, lon: 130.8456, region: 'NT',  metro: '75108', zip: '0800' },
  Ryde:       { lat: -33.8150, lon: 151.1050, region: 'NSW', metro: '75101', zip: '2112' },
  Chatswood:  { lat: -33.7969, lon: 151.1833, region: 'NSW', metro: '75101', zip: '2067' },
  Mandurah:   { lat: -32.5269, lon: 115.7473, region: 'WA',  metro: '75104', zip: '6210' },
  Chowey:     { lat: -28.1820, lon: 152.0020, region: 'QLD', metro: '75103', zip: '4370' },
};

let poolUsers: PoolUser[] = [];

/**
 * Parse semicolon-delimited CSV from tracker export.
 * Header: "Event id";"Date and time";IP;"Camp. ID";Offer;...
 */
export function loadUserPool(csvPath?: string): PoolUser[] {
  const filePath = csvPath || resolve(process.cwd(), 'data', 'users.csv');

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      logger.warn('User pool CSV is empty');
      return [];
    }

    // Parse header to find column indices
    const header = parseCsvLine(lines[0]);
    const idx = {
      ip: header.indexOf('IP'),
      country: header.indexOf('Country'),
      region: header.indexOf('State/region'),
      city: header.indexOf('City'),
      connType: header.indexOf('Connection type'),
      isp: header.indexOf('ISP'),
      ua: header.indexOf('User agent'),
      language: header.indexOf('Language'),
      os: header.indexOf('OS version'),
      browser: header.indexOf('Browser'),
      deviceType: header.indexOf('Device type'),
      deviceModel: header.indexOf('Device model'),
    };

    const users: PoolUser[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const ip = cols[idx.ip];
      if (!ip) continue;

      const countryName = cols[idx.country] || '';
      // Map full name → alpha-2 code, then → alpha-3
      const alpha2 = countryNameToAlpha2(countryName);

      users.push({
        ip,
        country: alpha2,
        countryAlpha3: COUNTRY_MAP[alpha2] || alpha2,
        region: cols[idx.region] || '',
        city: cols[idx.city] || '',
        connectionType: cols[idx.connType] || 'WiFi',
        isp: cols[idx.isp] || '',
        userAgent: cols[idx.ua] || '',
        language: cols[idx.language] || 'English',
        osVersion: cols[idx.os] || '10',
        browser: cols[idx.browser] || '',
        deviceType: cols[idx.deviceType] || '',
        deviceModel: cols[idx.deviceModel] || '',
      });
    }

    poolUsers = users;
    logger.info({ count: users.length }, 'User pool loaded');
    return users;
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to load user pool CSV');
    return [];
  }
}

function parseCsvLine(line: string): string[] {
  return line.split(';').map(f => f.replace(/^"|"$/g, '').trim());
}

function countryNameToAlpha2(name: string): string {
  const map: Record<string, string> = {
    Australia: 'AU', 'United States': 'US', 'United Kingdom': 'GB',
    Canada: 'CA', Germany: 'DE', France: 'FR', 'New Zealand': 'NZ',
    India: 'IN', Brazil: 'BR', Japan: 'JP', Singapore: 'SG',
  };
  if (map[name]) return map[name];
  logger.warn({ country: name }, 'Unknown country name, defaulting to AU');
  return 'AU';
}

export function getPoolSize(): number {
  return poolUsers.length;
}

export function getRandomPoolUser(): PoolUser | null {
  if (poolUsers.length === 0) return null;
  return poolUsers[Math.floor(Math.random() * poolUsers.length)];
}

/**
 * Build a DeviceProfile from a pool user entry.
 * Reuses generateDeviceProfile() for CTV device/fingerprint, then overrides
 * IP, geo, carrier, and language from the real pool user data.
 */
export function buildDeviceFromPoolUser(user: PoolUser, os: DeviceProfile['os']): DeviceProfile {
  const device = generateDeviceProfile(os);

  // Override with real pool data
  device.ip = user.ip;
  device.carrier = user.isp || undefined;
  device.networkType = user.connectionType === 'Cellular' ? '4G' : 'WiFi';
  device.language = user.language === 'English' ? 'en' : user.language.toLowerCase().slice(0, 2);
  device.timezone = getTimezoneForRegion(user.region);

  // Build geo from pool user's city/region
  const cityKey = Object.keys(AU_CITY_GEO).find(k => k.toLowerCase() === user.city.toLowerCase());
  const cityGeo = cityKey ? AU_CITY_GEO[cityKey] : null;

  device.geo = {
    country: user.countryAlpha3,
    region: cityGeo?.region || stateToCode(user.region),
    city: user.city,
    zip: cityGeo?.zip,
    metro: cityGeo?.metro,
    lat: cityGeo ? round(cityGeo.lat + (Math.random() - 0.5) * 0.1, 4) : undefined,
    lon: cityGeo ? round(cityGeo.lon + (Math.random() - 0.5) * 0.1, 4) : undefined,
    type: 2,
    accuracy: 20,
    ipservice: 3,
  };

  return device;
}

function stateToCode(stateName: string): string {
  const map: Record<string, string> = {
    'New South Wales': 'NSW', 'Victoria': 'VIC', 'Queensland': 'QLD',
    'Western Australia': 'WA', 'South Australia': 'SA',
    'Tasmania': 'TAS', 'Northern Territory': 'NT',
    'Australian Capital Territory': 'ACT',
  };
  return map[stateName] || stateName;
}

function getTimezoneForRegion(region: string): string {
  const map: Record<string, string> = {
    'New South Wales': 'Australia/Sydney', 'Victoria': 'Australia/Melbourne',
    'Queensland': 'Australia/Brisbane', 'Western Australia': 'Australia/Perth',
    'South Australia': 'Australia/Adelaide', 'Tasmania': 'Australia/Hobart',
    'Northern Territory': 'Australia/Darwin', 'Australian Capital Territory': 'Australia/Sydney',
  };
  return map[region] || 'Australia/Sydney';
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
