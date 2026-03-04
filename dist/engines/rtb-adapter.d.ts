import type { SessionConfig, RtbBidRequest, RtbBidResponse } from '../shared/types.js';
export declare function buildBidRequest(config: SessionConfig, requestId: string): RtbBidRequest;
export declare function sendBidRequest(config: SessionConfig): Promise<RtbBidResponse>;
export declare function extractVastFromBidResponse(bidResponse: RtbBidResponse): string | null;
//# sourceMappingURL=rtb-adapter.d.ts.map