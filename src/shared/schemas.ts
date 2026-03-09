import { z } from 'zod';

export const NetworkProfileSchema = z.object({
  type: z.enum(['3G', '4G', 'WiFi']),
  downloadThroughput: z.number().positive(),
  uploadThroughput: z.number().positive(),
  latency: z.number().nonnegative(),
  packetLoss: z.number().min(0).max(1).optional(),
});

export const GeoDataSchema = z.object({
  country: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  region: z.string().optional(),
  metro: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  type: z.number().optional(),
  accuracy: z.number().optional(),
  ipservice: z.number().optional(),
  utcoffset: z.number().optional(),
});

export const DeviceProfileSchema = z.object({
  os: z.enum(['AndroidTV', 'Tizen', 'WebOS']),
  osv: z.string().min(1).default('12'),
  vendor: z.string().min(1),
  model: z.string().min(1),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  deviceId: z.string().min(1),
  ifa: z.string().min(1),
  ip: z.string().min(1),
  carrier: z.string().optional(),
  networkType: z.enum(['3G', '4G', 'WiFi', 'Ethernet']),
  language: z.string().min(1).default('en'),
  userAgent: z.string().min(1),
  timezone: z.string().min(1),
  geo: GeoDataSchema.optional(),
  fingerprint: z.object({
    platform: z.string(),
    hwConcurrency: z.number().positive(),
    deviceMemory: z.number().positive(),
    maxTouchPoints: z.number().nonnegative(),
    connection: z.object({
      type: z.string(),
      downlink: z.number(),
      rtt: z.number(),
      effectiveType: z.string(),
    }),
    screen: z.object({
      colorDepth: z.number(),
      pixelDepth: z.number(),
    }),
    webgl: z.object({
      vendor: z.string(),
      renderer: z.string(),
    }),
    canvasNoiseSeed: z.number(),
    audioNoiseSeed: z.number(),
    fonts: z.array(z.string()),
    plugins: z.number().nonnegative(),
    storageQuota: z.number().positive(),
  }).optional(),
});

export const SessionConfigSchema = z.object({
  device: DeviceProfileSchema,
  rtbEndpoint: z.string().url(),
  contentUrl: z.string().url(),
  appBundle: z.string().min(1),
  appName: z.string().min(1),
  appStoreUrl: z.string().url(),
  appVersion: z.string().optional(),
  appId: z.string().optional(),
  publisherId: z.string().optional(),
  publisherName: z.string().optional(),
  bidfloor: z.number().nonnegative().optional(),
  networkEmulation: NetworkProfileSchema.optional(),
  bcat: z.array(z.string()).optional(),
  userId: z.string().optional(),
  proxy: z.string().optional(),
});

export const BatchSessionSchema = z.object({
  sessions: z.array(SessionConfigSchema).min(1).max(50),
});

export const SessionIdParamSchema = z.object({
  id: z.string().uuid(),
});
