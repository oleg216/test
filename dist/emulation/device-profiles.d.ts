import type { DeviceProfile } from '../shared/types.js';
interface DevicePreset {
    os: DeviceProfile['os'];
    vendors: Array<{
        vendor: string;
        models: string[];
    }>;
    screenWidth: number;
    screenHeight: number;
    userAgentTemplate: string;
}
export declare const DEVICE_PRESETS: Record<string, DevicePreset>;
export declare function generateDeviceProfile(os: DeviceProfile['os']): DeviceProfile;
export {};
//# sourceMappingURL=device-profiles.d.ts.map