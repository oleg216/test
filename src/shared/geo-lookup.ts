import { resolve } from 'path';
import maxmind, { CityResponse, AsnResponse, Reader } from 'maxmind';
import { createLogger } from './logger.js';
import type { GeoData } from './types.js';

const logger = createLogger('geo-lookup');

const COUNTRY_MAP: Record<string, string> = {
  US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS', DE: 'DEU',
  FR: 'FRA', NL: 'NLD', JP: 'JPN', KR: 'KOR', BR: 'BRA',
  IN: 'IND', SG: 'SGP', NZ: 'NZL', SE: 'SWE', IT: 'ITA',
  ES: 'ESP', MX: 'MEX', AR: 'ARG', CL: 'CHL', CO: 'COL',
  IE: 'IRL', NO: 'NOR', DK: 'DNK', FI: 'FIN', PL: 'POL',
  AT: 'AUT', CH: 'CHE', BE: 'BEL', PT: 'PRT', CZ: 'CZE',
};

let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;

export async function initGeoDb(): Promise<void> {
  const dataDir = resolve(process.cwd(), 'data');

  try {
    cityReader = await maxmind.open<CityResponse>(resolve(dataDir, 'GeoLite2-City.mmdb'));
    logger.info('GeoLite2-City loaded');
  } catch {
    logger.warn('GeoLite2-City.mmdb not found — geo lookup disabled');
  }

  try {
    asnReader = await maxmind.open<AsnResponse>(resolve(dataDir, 'GeoLite2-ASN.mmdb'));
    logger.info('GeoLite2-ASN loaded');
  } catch {
    logger.warn('GeoLite2-ASN.mmdb not found — carrier lookup disabled');
  }
}

export function lookupGeo(ip: string): GeoData | null {
  if (!ip || !cityReader) return null;

  try {
    const result = cityReader.get(ip);
    if (!result?.country?.iso_code) return null;

    const alpha2 = result.country.iso_code;
    const geo: GeoData = {
      country: COUNTRY_MAP[alpha2] || alpha2,
      type: 2,
      ipservice: 3,
    };

    if (result.subdivisions?.[0]?.iso_code) {
      geo.region = result.subdivisions[0].iso_code;
    }
    if (result.city?.names?.en) {
      geo.city = result.city.names.en;
    }
    if (result.location) {
      if (result.location.latitude != null && result.location.longitude != null) {
        geo.lat = result.location.latitude;
        geo.lon = result.location.longitude;
      }
      if (result.location.accuracy_radius) {
        geo.accuracy = result.location.accuracy_radius;
      }
      if (result.location.metro_code) {
        geo.metro = String(result.location.metro_code);
      }
    }
    if (result.postal?.code) {
      geo.zip = result.postal.code;
    }

    return geo;
  } catch {
    return null;
  }
}

export function lookupCarrier(ip: string): string | null {
  if (!ip || !asnReader) return null;

  try {
    const result = asnReader.get(ip);
    return result?.autonomous_system_organization || null;
  } catch {
    return null;
  }
}

export function isGeoReady(): boolean {
  return cityReader !== null;
}
