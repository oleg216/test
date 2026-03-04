import type { VastCreative, TrackingEventType } from '../shared/types.js';
export interface VastParseResult {
    type: 'inline' | 'wrapper';
    mediaUrl?: string;
    duration?: number;
    trackingEvents: Map<TrackingEventType, string[]>;
    impressionUrls: string[];
    errorUrls: string[];
    vastTagUri?: string;
}
export declare function parseDuration(duration: string): number;
export declare function parseVastXml(xml: string): VastParseResult;
export declare function resolveVast(vastUrlOrXml: string, fetchFn?: (url: string) => Promise<string>, depth?: number): Promise<VastCreative>;
//# sourceMappingURL=vast-resolver.d.ts.map