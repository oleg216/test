import { z } from 'zod';
export declare const NetworkProfileSchema: z.ZodObject<{
    type: z.ZodEnum<{
        "3G": "3G";
        "4G": "4G";
        WiFi: "WiFi";
    }>;
    downloadThroughput: z.ZodNumber;
    uploadThroughput: z.ZodNumber;
    latency: z.ZodNumber;
    packetLoss: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const DeviceProfileSchema: z.ZodObject<{
    os: z.ZodEnum<{
        AndroidTV: "AndroidTV";
        Tizen: "Tizen";
        WebOS: "WebOS";
    }>;
    vendor: z.ZodString;
    model: z.ZodString;
    screenWidth: z.ZodNumber;
    screenHeight: z.ZodNumber;
    deviceId: z.ZodString;
    ifa: z.ZodString;
    ip: z.ZodString;
    carrier: z.ZodOptional<z.ZodString>;
    networkType: z.ZodEnum<{
        "3G": "3G";
        "4G": "4G";
        WiFi: "WiFi";
    }>;
    userAgent: z.ZodString;
    timezone: z.ZodString;
    geo: z.ZodOptional<z.ZodObject<{
        lat: z.ZodNumber;
        lon: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SessionConfigSchema: z.ZodObject<{
    device: z.ZodObject<{
        os: z.ZodEnum<{
            AndroidTV: "AndroidTV";
            Tizen: "Tizen";
            WebOS: "WebOS";
        }>;
        vendor: z.ZodString;
        model: z.ZodString;
        screenWidth: z.ZodNumber;
        screenHeight: z.ZodNumber;
        deviceId: z.ZodString;
        ifa: z.ZodString;
        ip: z.ZodString;
        carrier: z.ZodOptional<z.ZodString>;
        networkType: z.ZodEnum<{
            "3G": "3G";
            "4G": "4G";
            WiFi: "WiFi";
        }>;
        userAgent: z.ZodString;
        timezone: z.ZodString;
        geo: z.ZodOptional<z.ZodObject<{
            lat: z.ZodNumber;
            lon: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    rtbEndpoint: z.ZodString;
    contentUrl: z.ZodString;
    appBundle: z.ZodString;
    appName: z.ZodString;
    appStoreUrl: z.ZodString;
    networkEmulation: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<{
            "3G": "3G";
            "4G": "4G";
            WiFi: "WiFi";
        }>;
        downloadThroughput: z.ZodNumber;
        uploadThroughput: z.ZodNumber;
        latency: z.ZodNumber;
        packetLoss: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const BatchSessionSchema: z.ZodObject<{
    sessions: z.ZodArray<z.ZodObject<{
        device: z.ZodObject<{
            os: z.ZodEnum<{
                AndroidTV: "AndroidTV";
                Tizen: "Tizen";
                WebOS: "WebOS";
            }>;
            vendor: z.ZodString;
            model: z.ZodString;
            screenWidth: z.ZodNumber;
            screenHeight: z.ZodNumber;
            deviceId: z.ZodString;
            ifa: z.ZodString;
            ip: z.ZodString;
            carrier: z.ZodOptional<z.ZodString>;
            networkType: z.ZodEnum<{
                "3G": "3G";
                "4G": "4G";
                WiFi: "WiFi";
            }>;
            userAgent: z.ZodString;
            timezone: z.ZodString;
            geo: z.ZodOptional<z.ZodObject<{
                lat: z.ZodNumber;
                lon: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        rtbEndpoint: z.ZodString;
        contentUrl: z.ZodString;
        appBundle: z.ZodString;
        appName: z.ZodString;
        appStoreUrl: z.ZodString;
        networkEmulation: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<{
                "3G": "3G";
                "4G": "4G";
                WiFi: "WiFi";
            }>;
            downloadThroughput: z.ZodNumber;
            uploadThroughput: z.ZodNumber;
            latency: z.ZodNumber;
            packetLoss: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const SessionIdParamSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
//# sourceMappingURL=schemas.d.ts.map