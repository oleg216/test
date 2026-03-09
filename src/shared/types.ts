export enum SessionState {
  CREATED = 'CREATED',
  INITIALIZING = 'INITIALIZING',
  RTB_REQUESTING = 'RTB_REQUESTING',
  VAST_RESOLVING = 'VAST_RESOLVING',
  AD_LOADING = 'AD_LOADING',
  AD_PLAYING = 'AD_PLAYING',
  CONTENT_PLAYING = 'CONTENT_PLAYING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  ERROR_VAST = 'ERROR_VAST',
  ERROR_MEDIA = 'ERROR_MEDIA',
  ERROR_NETWORK = 'ERROR_NETWORK',
  ERROR_TIMEOUT = 'ERROR_TIMEOUT',
}

export const ERROR_STATES = [
  SessionState.ERROR_VAST,
  SessionState.ERROR_MEDIA,
  SessionState.ERROR_NETWORK,
  SessionState.ERROR_TIMEOUT,
] as const;

export interface FingerprintProfile {
  platform: string;
  hwConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  connection: { type: string; downlink: number; rtt: number; effectiveType: string };
  screen: { colorDepth: number; pixelDepth: number };
  webgl: { vendor: string; renderer: string };
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  fonts: string[];
  plugins: number;
  storageQuota: number;
}

// OpenRTB-compatible geo object (matches DSP sample format)
export interface GeoData {
  country?: string;   // ISO alpha-3 (e.g. "USA")
  lat?: number;
  lon?: number;
  region?: string;    // ISO subdivision (e.g. "SC" for South Carolina)
  metro?: string;     // Nielsen DMA code (e.g. "567")
  city?: string;      // City name (e.g. "Greer")
  zip?: string;       // Postal code (e.g. "29651")
  type?: number;      // 2 = IP-based
  accuracy?: number;  // Accuracy radius in km
  ipservice?: number; // IP geo provider (3 = MaxMind)
  utcoffset?: number; // UTC offset in minutes
}

export interface DeviceProfile {
  os: 'AndroidTV' | 'Tizen' | 'WebOS';
  osv: string;
  vendor: string;
  model: string;
  screenWidth: number;
  screenHeight: number;
  deviceId: string;
  ifa: string;
  ip: string;
  carrier?: string;
  networkType: '3G' | '4G' | 'WiFi' | 'Ethernet';
  language: string;
  userAgent: string;
  timezone: string;
  geo?: GeoData;
  fingerprint?: FingerprintProfile;
}

export interface SessionConfig {
  device: DeviceProfile;
  rtbEndpoint: string;
  contentUrl: string;
  appBundle: string;
  appName: string;
  appStoreUrl: string;
  appVersion?: string;
  appId?: string;
  publisherId?: string;
  publisherName?: string;
  bidfloor?: number;
  networkEmulation?: NetworkProfile;
  bcat?: string[];
  userId?: string;
  proxy?: string; // http://user:pass@host:port or socks5://user:pass@host:port
}

export interface NetworkProfile {
  type: '3G' | '4G' | 'WiFi';
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
  packetLoss?: number;
}

export interface SessionInfo {
  id: string;
  state: SessionState;
  workerId: number;
  config: SessionConfig;
  createdAt: number;
  updatedAt: number;
  events: TrackingEvent[];
  retryCount: number;
  error?: string;
}

export interface TrackingEvent {
  type: TrackingEventType;
  url: string;
  firedAt?: number;
  idempotencyKey: string;
}

export type TrackingEventType =
  | 'impression'
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'error'
  | 'click';

export interface NetworkLogEntry {
  sessionId: string;
  timestamp: number;
  url: string;
  method: string;
  status?: number;
  classification: 'rtb' | 'vast' | 'media' | 'tracking' | 'content';
  direction: 'request' | 'response';
  duration?: number;
  size?: number;
}

export type MasterToWorkerMessage =
  | { type: 'create-session'; payload: SessionConfig & { sessionId: string } }
  | { type: 'stop-session'; sessionId: string };

export type WorkerToMasterMessage =
  | { type: 'session-update'; sessionId: string; state: SessionState; metrics?: Record<string, number> }
  | { type: 'session-error'; sessionId: string; error: string; state: SessionState }
  | { type: 'session-stopped'; sessionId: string }
  | { type: 'worker-stats'; activeSessions: number; totalProcessed: number; memoryUsage: number }
  | { type: 'worker-ready' };

export interface WorkerInfo {
  id: number;
  pid: number;
  activeSessions: number;
  totalProcessed: number;
  memoryUsage: number;
  status: 'starting' | 'running' | 'restarting' | 'dead';
}

export interface VastCreative {
  mediaUrl: string;
  duration: number;
  trackingEvents: Map<TrackingEventType, string[]>;
  impressionUrls: string[];
  errorUrls: string[];
  clickThroughUrl?: string;
  clickTrackingUrls: string[];
}

export interface RtbBidRequest {
  id: string;
  at?: number;
  tmax?: number;
  cur?: string[];
  ext?: Record<string, unknown>;
  bcat?: string[];
  imp: Array<{
    id: string;
    video: {
      mimes: string[];
      protocols: number[];
      w: number;
      h: number;
      linearity: number;
      startdelay: number;
      plcmt?: number;
      minduration?: number;
      maxduration?: number;
      sequence?: number;
      boxingallowed?: number;
      playbackmethod?: number[];
      api?: number[];
    };
    bidfloor?: number;
    bidfloorcur?: string;
    secure?: number;
    displaymanager?: string;
    displaymanagerver?: string;
  }>;
  app: {
    id?: string;
    bundle: string;
    name: string;
    storeurl: string;
    ver?: string;
    publisher?: { id: string; name?: string };
    content?: { language?: string; livestream?: number };
  };
  device: {
    ua: string;
    devicetype: number;
    make?: string;
    model?: string;
    ip: string;
    ifa: string;
    os: string;
    osv?: string;
    language?: string;
    js?: number;
    w: number;
    h: number;
    connectiontype?: number;
    carrier?: string;
    geo?: GeoData;
    ext?: Record<string, unknown>;
  };
  user?: {
    id: string;
    ext?: Record<string, unknown>;
  };
  source?: Record<string, unknown>;
  regs?: {
    coppa?: number;
    ext?: {
      gdpr?: number;
      us_privacy?: string;
    };
  };
}

// Extended bid response with nurl/burl/lurl support
export interface RtbBidResponse {
  id: string;
  seatbid?: Array<{
    seat?: string;
    bid: Array<{
      id: string;
      impid: string;
      adm: string;
      price: number;
      nurl?: string;
      burl?: string;
      lurl?: string;
      adomain?: string[];
      crid?: string;
      cid?: string;
      cat?: string[];
      w?: number;
      h?: number;
      ext?: Record<string, unknown>;
    }>;
  }>;
  cur?: string;
  nbr?: number;
}

// Auction data for macro substitution in nurl/burl/lurl
export interface AuctionData {
  auctionId: string;
  bidId: string;
  impId: string;
  seatId: string;
  adId: string;
  price: number;
  currency: string;
  loss?: number;
}

// Result of bid extraction — includes VAST + auction context for notifications
export interface BidResult {
  vastXml: string;
  auctionData: AuctionData;
  nurl?: string;
  burl?: string;
  lurl?: string;
}
