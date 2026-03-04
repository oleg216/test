import { z } from 'zod';
export const NetworkProfileSchema = z.object({
    type: z.enum(['3G', '4G', 'WiFi']),
    downloadThroughput: z.number().positive(),
    uploadThroughput: z.number().positive(),
    latency: z.number().nonnegative(),
    packetLoss: z.number().min(0).max(1).optional(),
});
export const DeviceProfileSchema = z.object({
    os: z.enum(['AndroidTV', 'Tizen', 'WebOS']),
    vendor: z.string().min(1),
    model: z.string().min(1),
    screenWidth: z.number().int().positive(),
    screenHeight: z.number().int().positive(),
    deviceId: z.string().min(1),
    ifa: z.string().min(1),
    ip: z.string().min(1),
    carrier: z.string().optional(),
    networkType: z.enum(['3G', '4G', 'WiFi']),
    userAgent: z.string().min(1),
    timezone: z.string().min(1),
    geo: z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
    }).optional(),
});
export const SessionConfigSchema = z.object({
    device: DeviceProfileSchema,
    rtbEndpoint: z.string().url(),
    contentUrl: z.string().url(),
    appBundle: z.string().min(1),
    appName: z.string().min(1),
    appStoreUrl: z.string().url(),
    networkEmulation: NetworkProfileSchema.optional(),
});
export const BatchSessionSchema = z.object({
    sessions: z.array(SessionConfigSchema).min(1).max(50),
});
export const SessionIdParamSchema = z.object({
    id: z.string().uuid(),
});
//# sourceMappingURL=schemas.js.map