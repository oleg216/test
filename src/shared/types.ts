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

export interface DeviceProfile {
  os: 'AndroidTV' | 'Tizen' | 'WebOS';
  vendor: string;
  model: string;
  screenWidth: number;
  screenHeight: number;
  deviceId: string;
  ifa: string;
  ip: string;
  carrier?: string;
  networkType: '3G' | '4G' | 'WiFi';
  userAgent: string;
  timezone: string;
  geo?: { lat: number; lon: number };
}

export interface SessionConfig {
  device: DeviceProfile;
  rtbEndpoint: string;
  contentUrl: string;
  appBundle: string;
  appName: string;
  appStoreUrl: string;
  networkEmulation?: NetworkProfile;
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
  | 'error';

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
  | { type: 'worker-stats'; activeSessions: number; totalProcessed: number; memoryUsage: number };

export interface WorkerInfo {
  id: number;
  pid: number;
  activeSessions: number;
  totalProcessed: number;
  memoryUsage: number;
  status: 'running' | 'restarting' | 'dead';
}

export interface VastCreative {
  mediaUrl: string;
  duration: number;
  trackingEvents: Map<TrackingEventType, string[]>;
  impressionUrls: string[];
  errorUrls: string[];
}

export interface RtbBidRequest {
  id: string;
  imp: Array<{
    id: string;
    video: {
      mimes: string[];
      protocols: number[];
      w: number;
      h: number;
      linearity: number;
    };
  }>;
  app: {
    bundle: string;
    name: string;
    storeurl: string;
  };
  device: {
    ua: string;
    devicetype: number;
    ip: string;
    ifa: string;
    os: string;
    osv?: string;
    w: number;
    h: number;
    connectiontype?: number;
    carrier?: string;
  };
}

export interface RtbBidResponse {
  id: string;
  seatbid: Array<{
    bid: Array<{
      id: string;
      adm: string;
      price: number;
    }>;
  }>;
}
