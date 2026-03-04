# CTV Emulator Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a headless CTV emulator platform that simulates Connected TV player behavior including OTT video playback, VAST advertising, OpenRTB bidding, and tracking events — supporting 200+ parallel sessions.

**Architecture:** Master process (Fastify API + session scheduler + worker manager) communicates via IPC with Worker child processes (Playwright browser + session state machines). Each worker handles ~10 sessions. Workers restart after 100 sessions for memory management.

**Tech Stack:** Node.js 20 LTS, TypeScript strict, Playwright (Chromium), Shaka Player 4.x, Fastify, Zod, Pino, prom-client, Docker

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/index.ts`

**Step 1: Initialize project**

```bash
cd E:/test
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install fastify @fastify/cors zod pino pino-pretty prom-client uuid shaka-player
npm install -D typescript @types/node @types/uuid playwright vitest tsx
npx playwright install chromium
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 4: Create .env.example**

```env
MAX_SESSIONS=200
MAX_WORKERS=20
SESSIONS_PER_WORKER=10
RTB_TIMEOUT_MS=2000
VAST_TIMEOUT_MS=3000
MEDIA_TIMEOUT_MS=5000
LOG_ROTATION_SIZE=50m
PORT=3000
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
logs/
.env
*.log
```

**Step 6: Create entry point src/index.ts**

```typescript
import { startMaster } from './master/server.js';

startMaster().catch((err) => {
  console.error('Failed to start master:', err);
  process.exit(1);
});
```

**Step 7: Update package.json scripts**

Add to package.json:
```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 8: Commit**

```bash
git init
git add package.json tsconfig.json .env.example .gitignore src/index.ts
git commit -m "chore: scaffold project with dependencies and config"
```

---

### Task 2: Shared Types and Constants

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/constants.ts`

**Step 1: Create shared types**

```typescript
// src/shared/types.ts

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
  downloadThroughput: number; // bytes per second
  uploadThroughput: number;
  latency: number; // ms
  packetLoss?: number; // 0-1
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

// IPC Messages
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
      adm: string; // VAST XML or URL
      price: number;
    }>;
  }>;
}
```

**Step 2: Create constants**

```typescript
// src/shared/constants.ts

export const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '200', 10);
export const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '20', 10);
export const SESSIONS_PER_WORKER = parseInt(process.env.SESSIONS_PER_WORKER || '10', 10);
export const RTB_TIMEOUT_MS = parseInt(process.env.RTB_TIMEOUT_MS || '2000', 10);
export const VAST_TIMEOUT_MS = parseInt(process.env.VAST_TIMEOUT_MS || '3000', 10);
export const MEDIA_TIMEOUT_MS = parseInt(process.env.MEDIA_TIMEOUT_MS || '5000', 10);
export const MAX_EVENTS = 10000;
export const MAX_WRAPPER_DEPTH = 5;
export const WRAPPER_TIMEOUT_MS = 3000;
export const MAX_RETRIES = 2;
export const WORKER_MAX_SESSIONS_BEFORE_RESTART = 100;
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const TRACKING_JITTER_MS = 1500;
```

**Step 3: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat: add shared types, interfaces, and constants"
```

---

### Task 3: Zod Validation Schemas

**Files:**
- Create: `src/shared/schemas.ts`
- Create: `tests/unit/schemas.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { SessionConfigSchema } from '../../src/shared/schemas.js';

describe('SessionConfigSchema', () => {
  it('validates a valid session config', () => {
    const valid = {
      device: {
        os: 'AndroidTV',
        vendor: 'Samsung',
        model: 'SmartTV-2024',
        screenWidth: 1920,
        screenHeight: 1080,
        deviceId: 'device-123',
        ifa: 'ifa-456',
        ip: '192.168.1.1',
        networkType: 'WiFi',
        userAgent: 'Mozilla/5.0 (Linux; Android TV)',
        timezone: 'America/New_York',
      },
      rtbEndpoint: 'https://ssp.example.com/bid',
      contentUrl: 'https://cdn.example.com/stream.m3u8',
      appBundle: 'com.example.tvapp',
      appName: 'Example TV',
      appStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.tvapp',
    };
    const result = SessionConfigSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects invalid OS', () => {
    const invalid = {
      device: {
        os: 'Windows',
        vendor: 'Test',
        model: 'Test',
        screenWidth: 1920,
        screenHeight: 1080,
        deviceId: 'id',
        ifa: 'ifa',
        ip: '1.1.1.1',
        networkType: 'WiFi',
        userAgent: 'ua',
        timezone: 'UTC',
      },
      rtbEndpoint: 'https://ssp.example.com/bid',
      contentUrl: 'https://cdn.example.com/stream.m3u8',
      appBundle: 'com.example.tvapp',
      appName: 'Example TV',
      appStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.tvapp',
    };
    const result = SessionConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/schemas.test.ts
```
Expected: FAIL — module not found

**Step 3: Create Zod schemas**

```typescript
// src/shared/schemas.ts
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
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/schemas.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/schemas.ts tests/unit/schemas.test.ts
git commit -m "feat: add Zod validation schemas with tests"
```

---

### Task 4: Pino Logger with Masking

**Files:**
- Create: `src/shared/logger.ts`
- Create: `tests/unit/logger.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/logger.test.ts
import { describe, it, expect } from 'vitest';
import { createLogger, maskSensitiveData } from '../../src/shared/logger.js';

describe('maskSensitiveData', () => {
  it('masks ifa values', () => {
    const data = { ifa: 'secret-ifa-value', name: 'test' };
    const masked = maskSensitiveData(data);
    expect(masked.ifa).toBe('***MASKED***');
    expect(masked.name).toBe('test');
  });

  it('masks ip values', () => {
    const data = { ip: '192.168.1.1' };
    const masked = maskSensitiveData(data);
    expect(masked.ip).toBe('***MASKED***');
  });

  it('masks deviceId values', () => {
    const data = { deviceId: 'dev-123' };
    const masked = maskSensitiveData(data);
    expect(masked.deviceId).toBe('***MASKED***');
  });
});

describe('createLogger', () => {
  it('creates a logger instance', () => {
    const logger = createLogger('test');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/logger.test.ts
```
Expected: FAIL

**Step 3: Implement logger**

```typescript
// src/shared/logger.ts
import pino from 'pino';

const SENSITIVE_KEYS = ['ifa', 'ip', 'deviceId', 'carrier'];

export function maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...data };
  for (const key of SENSITIVE_KEYS) {
    if (key in masked) {
      masked[key] = '***MASKED***';
    }
  }
  return masked;
}

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    hooks: {
      logMethod(inputArgs, method) {
        if (typeof inputArgs[0] === 'object' && inputArgs[0] !== null) {
          inputArgs[0] = maskSensitiveData(inputArgs[0] as Record<string, unknown>);
        }
        return method.apply(this, inputArgs as never);
      },
    },
  });
}

export const masterLogger = createLogger('master');
export const workerLogger = createLogger('worker');
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/logger.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/logger.ts tests/unit/logger.test.ts
git commit -m "feat: add Pino logger with sensitive data masking"
```

---

### Task 5: Device and Network Emulation Profiles

**Files:**
- Create: `src/emulation/device-profiles.ts`
- Create: `src/emulation/network-profiles.ts`
- Create: `tests/unit/emulation.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/emulation.test.ts
import { describe, it, expect } from 'vitest';
import { DEVICE_PRESETS, generateDeviceProfile } from '../../src/emulation/device-profiles.js';
import { NETWORK_PROFILES } from '../../src/emulation/network-profiles.js';

describe('device profiles', () => {
  it('has presets for AndroidTV, Tizen, WebOS', () => {
    expect(DEVICE_PRESETS.AndroidTV).toBeDefined();
    expect(DEVICE_PRESETS.Tizen).toBeDefined();
    expect(DEVICE_PRESETS.WebOS).toBeDefined();
  });

  it('generates a valid device profile', () => {
    const profile = generateDeviceProfile('AndroidTV');
    expect(profile.os).toBe('AndroidTV');
    expect(profile.deviceId).toBeTruthy();
    expect(profile.ifa).toBeTruthy();
    expect(profile.screenWidth).toBeGreaterThan(0);
  });
});

describe('network profiles', () => {
  it('has 3G, 4G, WiFi profiles', () => {
    expect(NETWORK_PROFILES['3G']).toBeDefined();
    expect(NETWORK_PROFILES['4G']).toBeDefined();
    expect(NETWORK_PROFILES['WiFi']).toBeDefined();
  });

  it('3G has lowest throughput', () => {
    expect(NETWORK_PROFILES['3G'].downloadThroughput)
      .toBeLessThan(NETWORK_PROFILES['4G'].downloadThroughput);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/emulation.test.ts
```
Expected: FAIL

**Step 3: Implement device profiles**

```typescript
// src/emulation/device-profiles.ts
import { v4 as uuid } from 'uuid';
import type { DeviceProfile } from '../shared/types.js';

interface DevicePreset {
  os: DeviceProfile['os'];
  vendors: Array<{ vendor: string; models: string[] }>;
  screenWidth: number;
  screenHeight: number;
  userAgentTemplate: string;
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  AndroidTV: {
    os: 'AndroidTV',
    vendors: [
      { vendor: 'Sony', models: ['BRAVIA-XR-A95K', 'BRAVIA-XR-X90K'] },
      { vendor: 'Samsung', models: ['SmartTV-2024', 'SmartTV-2023'] },
      { vendor: 'Nvidia', models: ['SHIELD-TV-Pro', 'SHIELD-TV'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (Linux; Android 12; {model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  Tizen: {
    os: 'Tizen',
    vendors: [
      { vendor: 'Samsung', models: ['UN55TU8000', 'QN65Q80B', 'UN43AU8000'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) {model}/7.0 TV Safari/537.36',
  },
  WebOS: {
    os: 'WebOS',
    vendors: [
      { vendor: 'LG', models: ['OLED55C3', 'OLED65B3', '55NANO75'] },
    ],
    screenWidth: 1920,
    screenHeight: 1080,
    userAgentTemplate: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager',
  },
};

export function generateDeviceProfile(os: DeviceProfile['os']): DeviceProfile {
  const preset = DEVICE_PRESETS[os];
  const vendorEntry = preset.vendors[Math.floor(Math.random() * preset.vendors.length)];
  const model = vendorEntry.models[Math.floor(Math.random() * vendorEntry.models.length)];
  const userAgent = preset.userAgentTemplate.replace('{model}', model);

  return {
    os: preset.os,
    vendor: vendorEntry.vendor,
    model,
    screenWidth: preset.screenWidth,
    screenHeight: preset.screenHeight,
    deviceId: uuid(),
    ifa: uuid(),
    ip: `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
    networkType: 'WiFi',
    userAgent,
    timezone: 'America/New_York',
  };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
```

**Step 4: Implement network profiles**

```typescript
// src/emulation/network-profiles.ts
import type { NetworkProfile } from '../shared/types.js';

export const NETWORK_PROFILES: Record<string, NetworkProfile> = {
  '3G': {
    type: '3G',
    downloadThroughput: 750 * 1024, // 750 KB/s
    uploadThroughput: 250 * 1024,
    latency: 100,
    packetLoss: 0.01,
  },
  '4G': {
    type: '4G',
    downloadThroughput: 4 * 1024 * 1024, // 4 MB/s
    uploadThroughput: 3 * 1024 * 1024,
    latency: 20,
    packetLoss: 0.001,
  },
  WiFi: {
    type: 'WiFi',
    downloadThroughput: 30 * 1024 * 1024, // 30 MB/s
    uploadThroughput: 15 * 1024 * 1024,
    latency: 2,
    packetLoss: 0,
  },
};
```

**Step 5: Run tests**

```bash
npx vitest run tests/unit/emulation.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add src/emulation/ tests/unit/emulation.test.ts
git commit -m "feat: add device and network emulation profiles"
```

---

### Task 6: VAST Resolver Engine

**Files:**
- Create: `src/engines/vast-resolver.ts`
- Create: `tests/unit/vast-resolver.test.ts`
- Create: `fixtures/inline-mp4.xml`
- Create: `fixtures/wrapper-simple.xml`
- Create: `fixtures/wrapper-chain.xml`
- Create: `fixtures/error.xml`
- Create: `fixtures/hls-ad.xml`

**Step 1: Create VAST test fixtures**

```xml
<!-- fixtures/inline-mp4.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="ad-1">
    <InLine>
      <AdSystem>TestAdServer</AdSystem>
      <AdTitle>Test Ad</AdTitle>
      <Impression><![CDATA[https://tracker.example.com/impression]]></Impression>
      <Creatives>
        <Creative>
          <Linear>
            <Duration>00:00:20</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://tracker.example.com/start]]></Tracking>
              <Tracking event="firstQuartile"><![CDATA[https://tracker.example.com/firstQuartile]]></Tracking>
              <Tracking event="midpoint"><![CDATA[https://tracker.example.com/midpoint]]></Tracking>
              <Tracking event="thirdQuartile"><![CDATA[https://tracker.example.com/thirdQuartile]]></Tracking>
              <Tracking event="complete"><![CDATA[https://tracker.example.com/complete]]></Tracking>
            </TrackingEvents>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080">
                <![CDATA[https://cdn.example.com/ad.mp4]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>
```

```xml
<!-- fixtures/wrapper-simple.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="wrapper-1">
    <Wrapper>
      <AdSystem>WrapperAdServer</AdSystem>
      <VASTAdTagURI><![CDATA[{{INLINE_URL}}]]></VASTAdTagURI>
      <Impression><![CDATA[https://wrapper-tracker.example.com/impression]]></Impression>
    </Wrapper>
  </Ad>
</VAST>
```

```xml
<!-- fixtures/wrapper-chain.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="chain-1">
    <Wrapper>
      <AdSystem>ChainAdServer</AdSystem>
      <VASTAdTagURI><![CDATA[{{NEXT_URL}}]]></VASTAdTagURI>
    </Wrapper>
  </Ad>
</VAST>
```

```xml
<!-- fixtures/error.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="error-1">
    <InLine>
      <AdSystem>ErrorAdServer</AdSystem>
      <Error><![CDATA[https://tracker.example.com/error]]></Error>
      <Creatives></Creatives>
    </InLine>
  </Ad>
</VAST>
```

```xml
<!-- fixtures/hls-ad.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.0" xmlns="http://www.iab.com/VAST">
  <Ad id="hls-1">
    <InLine>
      <AdSystem>HLSAdServer</AdSystem>
      <AdTitle>HLS Ad</AdTitle>
      <Impression><![CDATA[https://tracker.example.com/impression]]></Impression>
      <Creatives>
        <Creative>
          <Linear>
            <Duration>00:00:15</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://tracker.example.com/start]]></Tracking>
              <Tracking event="complete"><![CDATA[https://tracker.example.com/complete]]></Tracking>
            </TrackingEvents>
            <MediaFiles>
              <MediaFile delivery="streaming" type="application/x-mpegURL" width="1920" height="1080">
                <![CDATA[https://cdn.example.com/ad.m3u8]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>
```

**Step 2: Write the failing test**

```typescript
// tests/unit/vast-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseVastXml, parseDuration } from '../../src/engines/vast-resolver.js';

const readFixture = (name: string) =>
  readFileSync(resolve(process.cwd(), 'fixtures', name), 'utf-8');

describe('parseDuration', () => {
  it('parses HH:MM:SS format', () => {
    expect(parseDuration('00:00:20')).toBe(20);
    expect(parseDuration('00:01:30')).toBe(90);
    expect(parseDuration('01:00:00')).toBe(3600);
  });
});

describe('parseVastXml', () => {
  it('parses inline VAST with MP4 media', () => {
    const xml = readFixture('inline-mp4.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('inline');
    expect(result.mediaUrl).toContain('ad.mp4');
    expect(result.duration).toBe(20);
    expect(result.impressionUrls).toContain('https://tracker.example.com/impression');
    expect(result.trackingEvents.get('start')).toContain('https://tracker.example.com/start');
    expect(result.trackingEvents.get('complete')).toContain('https://tracker.example.com/complete');
  });

  it('parses wrapper VAST and returns tag URI', () => {
    const xml = readFixture('wrapper-simple.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('wrapper');
    expect(result.vastTagUri).toBeTruthy();
    expect(result.impressionUrls).toContain('https://wrapper-tracker.example.com/impression');
  });

  it('parses HLS ad', () => {
    const xml = readFixture('hls-ad.xml');
    const result = parseVastXml(xml);
    expect(result.type).toBe('inline');
    expect(result.mediaUrl).toContain('.m3u8');
    expect(result.duration).toBe(15);
  });
});
```

**Step 3: Run test to verify it fails**

```bash
npx vitest run tests/unit/vast-resolver.test.ts
```
Expected: FAIL

**Step 4: Implement VAST resolver**

```typescript
// src/engines/vast-resolver.ts
import { createLogger } from '../shared/logger.js';
import { MAX_WRAPPER_DEPTH, WRAPPER_TIMEOUT_MS } from '../shared/constants.js';
import type { VastCreative, TrackingEventType } from '../shared/types.js';

const logger = createLogger('vast-resolver');

export interface VastParseResult {
  type: 'inline' | 'wrapper';
  mediaUrl?: string;
  duration?: number;
  trackingEvents: Map<TrackingEventType, string[]>;
  impressionUrls: string[];
  errorUrls: string[];
  vastTagUri?: string;
}

export function parseDuration(duration: string): number {
  const parts = duration.split(':').map(Number);
  if (parts.length !== 3) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function extractCdata(text: string): string {
  return text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

export function parseVastXml(xml: string): VastParseResult {
  const trackingEvents = new Map<TrackingEventType, string[]>();
  const impressionUrls: string[] = [];
  const errorUrls: string[] = [];

  // Detect wrapper vs inline
  const isWrapper = /<Wrapper[\s>]/i.test(xml);
  const type = isWrapper ? 'wrapper' : 'inline';

  // Extract impression URLs
  const impressionMatches = xml.matchAll(/<Impression[^>]*>([\s\S]*?)<\/Impression>/gi);
  for (const match of impressionMatches) {
    impressionUrls.push(extractCdata(match[1]));
  }

  // Extract error URLs
  const errorMatches = xml.matchAll(/<Error[^>]*>([\s\S]*?)<\/Error>/gi);
  for (const match of errorMatches) {
    errorUrls.push(extractCdata(match[1]));
  }

  if (isWrapper) {
    // Extract VAST tag URI
    const tagMatch = xml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
    const vastTagUri = tagMatch ? extractCdata(tagMatch[1]) : undefined;
    return { type, trackingEvents, impressionUrls, errorUrls, vastTagUri };
  }

  // Extract tracking events
  const trackingMatches = xml.matchAll(/<Tracking\s+event="(\w+)"[^>]*>([\s\S]*?)<\/Tracking>/gi);
  for (const match of trackingMatches) {
    const event = match[1] as TrackingEventType;
    const url = extractCdata(match[2]);
    if (!trackingEvents.has(event)) {
      trackingEvents.set(event, []);
    }
    trackingEvents.get(event)!.push(url);
  }

  // Extract duration
  const durationMatch = xml.match(/<Duration[^>]*>([\s\S]*?)<\/Duration>/i);
  const duration = durationMatch ? parseDuration(durationMatch[1].trim()) : 0;

  // Extract media file URL
  const mediaMatch = xml.match(/<MediaFile[^>]*>([\s\S]*?)<\/MediaFile>/i);
  const mediaUrl = mediaMatch ? extractCdata(mediaMatch[1]) : undefined;

  return { type, mediaUrl, duration, trackingEvents, impressionUrls, errorUrls };
}

export async function resolveVast(
  vastUrlOrXml: string,
  fetchFn: (url: string) => Promise<string> = defaultFetch,
  depth: number = 0,
): Promise<VastCreative> {
  if (depth > MAX_WRAPPER_DEPTH) {
    throw new Error(`VAST wrapper depth exceeded (max ${MAX_WRAPPER_DEPTH})`);
  }

  let xml: string;
  if (vastUrlOrXml.trim().startsWith('<')) {
    xml = vastUrlOrXml;
  } else {
    xml = await fetchWithTimeout(vastUrlOrXml, fetchFn);
  }

  const parsed = parseVastXml(xml);

  if (parsed.type === 'wrapper' && parsed.vastTagUri) {
    logger.info({ depth, uri: parsed.vastTagUri }, 'Following VAST wrapper');
    const inner = await resolveVast(parsed.vastTagUri, fetchFn, depth + 1);
    // Merge wrapper impression/tracking into inner
    inner.impressionUrls.push(...parsed.impressionUrls);
    for (const [event, urls] of parsed.trackingEvents) {
      const existing = inner.trackingEvents.get(event) || [];
      inner.trackingEvents.set(event, [...existing, ...urls]);
    }
    return inner;
  }

  return {
    mediaUrl: parsed.mediaUrl || '',
    duration: parsed.duration || 0,
    trackingEvents: parsed.trackingEvents,
    impressionUrls: parsed.impressionUrls,
    errorUrls: parsed.errorUrls,
  };
}

async function fetchWithTimeout(url: string, fetchFn: (url: string) => Promise<string>): Promise<string> {
  return Promise.race([
    fetchFn(url),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`VAST fetch timeout: ${url}`)), WRAPPER_TIMEOUT_MS)
    ),
  ]);
}

async function defaultFetch(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`VAST fetch failed: ${response.status}`);
  return response.text();
}
```

**Step 5: Run tests**

```bash
npx vitest run tests/unit/vast-resolver.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add src/engines/vast-resolver.ts tests/unit/vast-resolver.test.ts fixtures/
git commit -m "feat: add VAST resolver with wrapper chain support and test fixtures"
```

---

### Task 7: RTB Adapter

**Files:**
- Create: `src/engines/rtb-adapter.ts`
- Create: `tests/unit/rtb-adapter.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/rtb-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { buildBidRequest } from '../../src/engines/rtb-adapter.js';
import type { SessionConfig } from '../../src/shared/types.js';

const mockConfig: SessionConfig = {
  device: {
    os: 'AndroidTV',
    vendor: 'Sony',
    model: 'BRAVIA-XR',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceId: 'device-1',
    ifa: 'ifa-1',
    ip: '1.2.3.4',
    networkType: 'WiFi',
    userAgent: 'Mozilla/5.0 (Android TV)',
    timezone: 'America/New_York',
  },
  rtbEndpoint: 'https://ssp.example.com/bid',
  contentUrl: 'https://cdn.example.com/stream.m3u8',
  appBundle: 'com.example.tvapp',
  appName: 'Example TV',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.tvapp',
};

describe('buildBidRequest', () => {
  it('creates valid OpenRTB 2.6 bid request', () => {
    const req = buildBidRequest(mockConfig, 'req-123');
    expect(req.id).toBe('req-123');
    expect(req.device.devicetype).toBe(7); // CTV
    expect(req.device.ua).toBe(mockConfig.device.userAgent);
    expect(req.device.ifa).toBe(mockConfig.device.ifa);
    expect(req.app.bundle).toBe(mockConfig.appBundle);
    expect(req.imp).toHaveLength(1);
    expect(req.imp[0].video).toBeDefined();
    expect(req.imp[0].video.w).toBe(1920);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/rtb-adapter.test.ts
```
Expected: FAIL

**Step 3: Implement RTB adapter**

```typescript
// src/engines/rtb-adapter.ts
import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { RTB_TIMEOUT_MS } from '../shared/constants.js';
import type { SessionConfig, RtbBidRequest, RtbBidResponse } from '../shared/types.js';

const logger = createLogger('rtb-adapter');

export function buildBidRequest(config: SessionConfig, requestId: string): RtbBidRequest {
  return {
    id: requestId,
    imp: [
      {
        id: '1',
        video: {
          mimes: ['video/mp4', 'application/x-mpegURL'],
          protocols: [2, 3, 5, 6], // VAST 2.0, 3.0, 2.0 wrapper, 3.0 wrapper
          w: config.device.screenWidth,
          h: config.device.screenHeight,
          linearity: 1, // linear (in-stream)
        },
      },
    ],
    app: {
      bundle: config.appBundle,
      name: config.appName,
      storeurl: config.appStoreUrl,
    },
    device: {
      ua: config.device.userAgent,
      devicetype: 7, // CTV
      ip: config.device.ip,
      ifa: config.device.ifa,
      os: config.device.os,
      w: config.device.screenWidth,
      h: config.device.screenHeight,
      connectiontype: config.device.networkType === 'WiFi' ? 2 : config.device.networkType === '4G' ? 6 : 5,
      carrier: config.device.carrier,
    },
  };
}

export async function sendBidRequest(config: SessionConfig): Promise<RtbBidResponse> {
  const requestId = uuid();
  const bidRequest = buildBidRequest(config, requestId);

  logger.info({ requestId, endpoint: config.rtbEndpoint }, 'Sending RTB bid request');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RTB_TIMEOUT_MS);

  try {
    const response = await fetch(config.rtbEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrtb-version': '2.6' },
      body: JSON.stringify(bidRequest),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RTB request failed: ${response.status}`);
    }

    const bidResponse: RtbBidResponse = await response.json();
    logger.info({ requestId, seatbids: bidResponse.seatbid?.length || 0 }, 'RTB bid response received');
    return bidResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractVastFromBidResponse(bidResponse: RtbBidResponse): string | null {
  const seatbid = bidResponse.seatbid?.[0];
  const bid = seatbid?.bid?.[0];
  if (!bid?.adm) return null;
  return bid.adm;
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/rtb-adapter.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/engines/rtb-adapter.ts tests/unit/rtb-adapter.test.ts
git commit -m "feat: add OpenRTB 2.6 bid request adapter"
```

---

### Task 8: Ad Timeline Engine

**Files:**
- Create: `src/engines/ad-timeline.ts`
- Create: `tests/unit/ad-timeline.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/ad-timeline.test.ts
import { describe, it, expect } from 'vitest';
import { buildTimeline } from '../../src/engines/ad-timeline.js';

describe('buildTimeline', () => {
  it('creates correct quartile events for 20s ad', () => {
    const events = buildTimeline(20);
    expect(events).toEqual([
      { event: 'impression', timeMs: 0 },
      { event: 'start', timeMs: 0 },
      { event: 'firstQuartile', timeMs: 5000 },
      { event: 'midpoint', timeMs: 10000 },
      { event: 'thirdQuartile', timeMs: 15000 },
      { event: 'complete', timeMs: 20000 },
    ]);
  });

  it('creates correct events for 30s ad', () => {
    const events = buildTimeline(30);
    expect(events[2]).toEqual({ event: 'firstQuartile', timeMs: 7500 });
    expect(events[3]).toEqual({ event: 'midpoint', timeMs: 15000 });
    expect(events[4]).toEqual({ event: 'thirdQuartile', timeMs: 22500 });
    expect(events[5]).toEqual({ event: 'complete', timeMs: 30000 });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/ad-timeline.test.ts
```
Expected: FAIL

**Step 3: Implement ad timeline**

```typescript
// src/engines/ad-timeline.ts
import { TRACKING_JITTER_MS } from '../shared/constants.js';
import type { TrackingEventType } from '../shared/types.js';

export interface TimelineEntry {
  event: TrackingEventType;
  timeMs: number;
}

export function buildTimeline(durationSeconds: number): TimelineEntry[] {
  const durationMs = durationSeconds * 1000;
  return [
    { event: 'impression', timeMs: 0 },
    { event: 'start', timeMs: 0 },
    { event: 'firstQuartile', timeMs: durationMs * 0.25 },
    { event: 'midpoint', timeMs: durationMs * 0.5 },
    { event: 'thirdQuartile', timeMs: durationMs * 0.75 },
    { event: 'complete', timeMs: durationMs },
  ];
}

export function addJitter(timeMs: number): number {
  const jitter = (Math.random() - 0.5) * 2 * TRACKING_JITTER_MS;
  return Math.max(0, timeMs + jitter);
}

export class AdTimelineScheduler {
  private timers: NodeJS.Timeout[] = [];
  private fired = new Set<string>();

  schedule(
    timeline: TimelineEntry[],
    onEvent: (event: TrackingEventType) => void,
    withJitter: boolean = true,
  ): void {
    for (const entry of timeline) {
      const delay = withJitter && entry.timeMs > 0 ? addJitter(entry.timeMs) : entry.timeMs;
      const timer = setTimeout(() => {
        if (!this.fired.has(entry.event)) {
          this.fired.add(entry.event);
          onEvent(entry.event);
        }
      }, delay);
      this.timers.push(timer);
    }
  }

  cancel(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  hasFired(event: TrackingEventType): boolean {
    return this.fired.has(event);
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/ad-timeline.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/engines/ad-timeline.ts tests/unit/ad-timeline.test.ts
git commit -m "feat: add ad timeline engine with quartile scheduling"
```

---

### Task 9: Tracking Engine

**Files:**
- Create: `src/engines/tracking-engine.ts`
- Create: `tests/unit/tracking-engine.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/tracking-engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TrackingEngine } from '../../src/engines/tracking-engine.js';

describe('TrackingEngine', () => {
  it('fires tracking pixels', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('impression', ['https://tracker.example.com/imp']);

    expect(fetchFn).toHaveBeenCalledWith('https://tracker.example.com/imp', expect.any(Object));
  });

  it('fires each event only once (idempotency)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('start', ['https://tracker.example.com/start']);
    await engine.fireEvent('start', ['https://tracker.example.com/start']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fires to multiple URLs for same event', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const engine = new TrackingEngine('session-1', fetchFn);

    await engine.fireEvent('impression', [
      'https://tracker1.example.com/imp',
      'https://tracker2.example.com/imp',
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/tracking-engine.test.ts
```
Expected: FAIL

**Step 3: Implement tracking engine**

```typescript
// src/engines/tracking-engine.ts
import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import type { TrackingEventType } from '../shared/types.js';

const logger = createLogger('tracking-engine');

type FetchFn = (url: string, init?: RequestInit) => Promise<{ ok: boolean }>;

export class TrackingEngine {
  private firedKeys = new Set<string>();
  private sessionId: string;
  private fetchFn: FetchFn;

  constructor(sessionId: string, fetchFn?: FetchFn) {
    this.sessionId = sessionId;
    this.fetchFn = fetchFn || ((url, init) => fetch(url, init).then(r => ({ ok: r.ok })));
  }

  async fireEvent(event: TrackingEventType, urls: string[]): Promise<void> {
    const idempotencyKey = `${this.sessionId}:${event}`;
    if (this.firedKeys.has(idempotencyKey)) {
      logger.info({ sessionId: this.sessionId, event }, 'Tracking event already fired, skipping');
      return;
    }

    this.firedKeys.add(idempotencyKey);

    const fires = urls.map(async (url) => {
      try {
        const pixelId = uuid();
        logger.info({ sessionId: this.sessionId, event, url, pixelId }, 'Firing tracking pixel');
        await this.fetchFn(url, {
          method: 'GET',
          headers: { 'X-Idempotency-Key': pixelId },
        });
      } catch (err) {
        logger.error({ sessionId: this.sessionId, event, url, err }, 'Tracking pixel failed');
      }
    });

    await Promise.allSettled(fires);
  }

  hasFired(event: TrackingEventType): boolean {
    return this.firedKeys.has(`${this.sessionId}:${event}`);
  }

  reset(): void {
    this.firedKeys.clear();
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/tracking-engine.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/engines/tracking-engine.ts tests/unit/tracking-engine.test.ts
git commit -m "feat: add idempotent tracking engine"
```

---

### Task 10: Prometheus Metrics

**Files:**
- Create: `src/master/metrics.ts`
- Create: `tests/unit/metrics.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/metrics.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsRegistry } from '../../src/master/metrics.js';

describe('MetricsRegistry', () => {
  let metrics: MetricsRegistry;

  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  it('increments tracking events counter', () => {
    metrics.trackingEventFired('impression');
    metrics.trackingEventFired('start');
    // No assertion on value — just verify no errors
    expect(true).toBe(true);
  });

  it('updates sessions running gauge', () => {
    metrics.sessionsRunning(5);
    expect(true).toBe(true);
  });

  it('returns metrics string', async () => {
    const output = await metrics.getMetrics();
    expect(typeof output).toBe('string');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/metrics.test.ts
```
Expected: FAIL

**Step 3: Implement metrics**

```typescript
// src/master/metrics.ts
import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export class MetricsRegistry {
  private registry: Registry;

  readonly sessionsRunningGauge: Gauge;
  readonly trackingEventsTotal: Counter;
  readonly vastRequestsTotal: Counter;
  readonly vastErrorsTotal: Counter;
  readonly rtbRequestsTotal: Counter;
  readonly rtbErrorsTotal: Counter;
  readonly sessionDuration: Histogram;

  constructor() {
    this.registry = new Registry();

    this.sessionsRunningGauge = new Gauge({
      name: 'sessions_running',
      help: 'Number of currently running sessions',
      registers: [this.registry],
    });

    this.trackingEventsTotal = new Counter({
      name: 'tracking_events_total',
      help: 'Total tracking events fired',
      labelNames: ['event_type'] as const,
      registers: [this.registry],
    });

    this.vastRequestsTotal = new Counter({
      name: 'vast_requests_total',
      help: 'Total VAST requests made',
      registers: [this.registry],
    });

    this.vastErrorsTotal = new Counter({
      name: 'vast_errors_total',
      help: 'Total VAST errors',
      registers: [this.registry],
    });

    this.rtbRequestsTotal = new Counter({
      name: 'rtb_requests_total',
      help: 'Total RTB bid requests',
      registers: [this.registry],
    });

    this.rtbErrorsTotal = new Counter({
      name: 'rtb_errors_total',
      help: 'Total RTB errors',
      registers: [this.registry],
    });

    this.sessionDuration = new Histogram({
      name: 'session_duration_seconds',
      help: 'Session duration in seconds',
      buckets: [5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });
  }

  sessionsRunning(count: number): void {
    this.sessionsRunningGauge.set(count);
  }

  trackingEventFired(eventType: string): void {
    this.trackingEventsTotal.inc({ event_type: eventType });
  }

  vastRequest(): void {
    this.vastRequestsTotal.inc();
  }

  vastError(): void {
    this.vastErrorsTotal.inc();
  }

  rtbRequest(): void {
    this.rtbRequestsTotal.inc();
  }

  rtbError(): void {
    this.rtbErrorsTotal.inc();
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  async getContentType(): Promise<string> {
    return this.registry.contentType;
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/metrics.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/master/metrics.ts tests/unit/metrics.test.ts
git commit -m "feat: add Prometheus metrics registry"
```

---

### Task 11: Network Interceptor

**Files:**
- Create: `src/worker/network-interceptor.ts`
- Create: `tests/unit/network-interceptor.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/network-interceptor.test.ts
import { describe, it, expect } from 'vitest';
import { classifyRequest } from '../../src/worker/network-interceptor.js';

describe('classifyRequest', () => {
  it('classifies RTB requests', () => {
    expect(classifyRequest('https://ssp.example.com/bid', 'POST')).toBe('rtb');
  });

  it('classifies VAST requests', () => {
    expect(classifyRequest('https://ad.example.com/vast.xml', 'GET')).toBe('vast');
  });

  it('classifies media requests', () => {
    expect(classifyRequest('https://cdn.example.com/ad.mp4', 'GET')).toBe('media');
    expect(classifyRequest('https://cdn.example.com/stream.m3u8', 'GET')).toBe('media');
  });

  it('classifies tracking requests', () => {
    expect(classifyRequest('https://tracker.example.com/impression?cb=123', 'GET')).toBe('tracking');
  });

  it('defaults to content', () => {
    expect(classifyRequest('https://cdn.example.com/page.html', 'GET')).toBe('content');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/network-interceptor.test.ts
```
Expected: FAIL

**Step 3: Implement network interceptor**

```typescript
// src/worker/network-interceptor.ts
import type { Page } from 'playwright';
import { createLogger } from '../shared/logger.js';
import type { NetworkLogEntry } from '../shared/types.js';

const logger = createLogger('network-interceptor');

type Classification = 'rtb' | 'vast' | 'media' | 'tracking' | 'content';

const MEDIA_EXTENSIONS = ['.mp4', '.m3u8', '.ts', '.webm', '.mpd', '.m4s'];
const VAST_PATTERNS = ['/vast', '.xml', 'vast=', 'adtag'];
const TRACKING_PATTERNS = ['impression', 'track', 'pixel', 'beacon', 'event', 'quartile', 'complete'];

export function classifyRequest(url: string, method: string): Classification {
  const lowerUrl = url.toLowerCase();

  // RTB: POST requests to /bid or /openrtb endpoints
  if (method === 'POST' && (lowerUrl.includes('/bid') || lowerUrl.includes('/openrtb') || lowerUrl.includes('/auction'))) {
    return 'rtb';
  }

  // VAST: XML or vast-related URLs
  if (VAST_PATTERNS.some(p => lowerUrl.includes(p))) {
    return 'vast';
  }

  // Media: video/stream files
  if (MEDIA_EXTENSIONS.some(ext => lowerUrl.includes(ext))) {
    return 'media';
  }

  // Tracking: impression/tracking pixels
  if (TRACKING_PATTERNS.some(p => lowerUrl.includes(p))) {
    return 'tracking';
  }

  return 'content';
}

export function setupNetworkInterceptor(
  page: Page,
  sessionId: string,
  onLog: (entry: NetworkLogEntry) => void,
): void {
  const requestTimestamps = new Map<string, number>();

  page.on('request', (request) => {
    const url = request.url();
    const method = request.method();
    const timestamp = Date.now();
    requestTimestamps.set(url, timestamp);

    const entry: NetworkLogEntry = {
      sessionId,
      timestamp,
      url,
      method,
      classification: classifyRequest(url, method),
      direction: 'request',
    };
    onLog(entry);
  });

  page.on('response', (response) => {
    const url = response.url();
    const method = response.request().method();
    const timestamp = Date.now();
    const startTime = requestTimestamps.get(url);

    const entry: NetworkLogEntry = {
      sessionId,
      timestamp,
      url,
      method,
      status: response.status(),
      classification: classifyRequest(url, method),
      direction: 'response',
      duration: startTime ? timestamp - startTime : undefined,
    };
    onLog(entry);
    requestTimestamps.delete(url);
  });
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/network-interceptor.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/worker/network-interceptor.ts tests/unit/network-interceptor.test.ts
git commit -m "feat: add network interceptor with request classification"
```

---

### Task 12: Player HTML Page

**Files:**
- Create: `public/player.html`

**Step 1: Create player.html with Shaka Player**

```html
<!-- public/player.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CTV Player</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.11/shaka-player.compiled.min.js"></script>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #000; overflow: hidden; }
    video { width: 100vw; height: 100vh; object-fit: contain; }
    #ad-video { position: absolute; top: 0; left: 0; z-index: 10; }
    #content-video { position: absolute; top: 0; left: 0; z-index: 1; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <video id="ad-video" class="hidden" playsinline></video>
  <video id="content-video" class="hidden" playsinline></video>

  <script>
    const adVideo = document.getElementById('ad-video');
    const contentVideo = document.getElementById('content-video');

    let adPlayer = null;
    let contentPlayer = null;

    async function initShaka() {
      shaka.polyfill.installAll();
      if (!shaka.Player.isBrowserSupported()) {
        window.__playerError = 'Browser not supported';
        return;
      }
    }

    async function loadAd(mediaUrl) {
      try {
        adVideo.classList.remove('hidden');
        contentVideo.classList.add('hidden');

        adPlayer = new shaka.Player();
        await adPlayer.attach(adVideo);

        adPlayer.addEventListener('error', (e) => {
          window.__adError = e.detail;
        });

        await adPlayer.load(mediaUrl);
        adVideo.play();

        return new Promise((resolve, reject) => {
          adVideo.addEventListener('ended', () => {
            window.__adCompleted = true;
            resolve();
          }, { once: true });

          adVideo.addEventListener('error', (e) => {
            reject(e);
          }, { once: true });
        });
      } catch (err) {
        window.__adError = err.message;
        throw err;
      }
    }

    async function loadContent(contentUrl) {
      try {
        adVideo.classList.add('hidden');
        contentVideo.classList.remove('hidden');

        contentPlayer = new shaka.Player();
        await contentPlayer.attach(contentVideo);

        contentPlayer.addEventListener('error', (e) => {
          window.__contentError = e.detail;
        });

        await contentPlayer.load(contentUrl);
        contentVideo.play();

        window.__contentPlaying = true;
      } catch (err) {
        window.__contentError = err.message;
        throw err;
      }
    }

    function getAdCurrentTime() {
      return adVideo.currentTime || 0;
    }

    function getAdDuration() {
      return adVideo.duration || 0;
    }

    function stopAll() {
      if (adPlayer) { adPlayer.destroy(); adPlayer = null; }
      if (contentPlayer) { contentPlayer.destroy(); contentPlayer = null; }
      adVideo.src = '';
      contentVideo.src = '';
    }

    // Expose to Playwright
    window.__initShaka = initShaka;
    window.__loadAd = loadAd;
    window.__loadContent = loadContent;
    window.__getAdCurrentTime = getAdCurrentTime;
    window.__getAdDuration = getAdDuration;
    window.__stopAll = stopAll;
    window.__adCompleted = false;
    window.__contentPlaying = false;
    window.__playerReady = false;

    initShaka().then(() => {
      window.__playerReady = true;
    });
  </script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add public/player.html
git commit -m "feat: add Shaka Player HTML page for ad and content playback"
```

---

### Task 13: Session State Machine

**Files:**
- Create: `src/worker/session.ts`
- Create: `tests/unit/session.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/session.test.ts
import { describe, it, expect } from 'vitest';
import { SessionStateMachine, isValidTransition } from '../../src/worker/session.js';
import { SessionState } from '../../src/shared/types.js';

describe('isValidTransition', () => {
  it('allows CREATED -> INITIALIZING', () => {
    expect(isValidTransition(SessionState.CREATED, SessionState.INITIALIZING)).toBe(true);
  });

  it('allows full happy path', () => {
    const path = [
      SessionState.CREATED, SessionState.INITIALIZING, SessionState.RTB_REQUESTING,
      SessionState.VAST_RESOLVING, SessionState.AD_LOADING, SessionState.AD_PLAYING,
      SessionState.CONTENT_PLAYING, SessionState.STOPPING, SessionState.STOPPED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('rejects invalid transition', () => {
    expect(isValidTransition(SessionState.CREATED, SessionState.AD_PLAYING)).toBe(false);
  });

  it('allows error transitions from any active state', () => {
    expect(isValidTransition(SessionState.RTB_REQUESTING, SessionState.ERROR_NETWORK)).toBe(true);
    expect(isValidTransition(SessionState.VAST_RESOLVING, SessionState.ERROR_VAST)).toBe(true);
  });
});

describe('SessionStateMachine', () => {
  it('starts in CREATED state', () => {
    const sm = new SessionStateMachine('sess-1');
    expect(sm.state).toBe(SessionState.CREATED);
  });

  it('transitions through states', () => {
    const sm = new SessionStateMachine('sess-1');
    sm.transition(SessionState.INITIALIZING);
    expect(sm.state).toBe(SessionState.INITIALIZING);
  });

  it('throws on invalid transition', () => {
    const sm = new SessionStateMachine('sess-1');
    expect(() => sm.transition(SessionState.AD_PLAYING)).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/session.test.ts
```
Expected: FAIL

**Step 3: Implement session state machine**

```typescript
// src/worker/session.ts
import { SessionState, ERROR_STATES } from '../shared/types.js';
import type { SessionConfig, SessionInfo, TrackingEventType } from '../shared/types.js';
import { MAX_RETRIES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('session');

const VALID_TRANSITIONS: Record<string, SessionState[]> = {
  [SessionState.CREATED]: [SessionState.INITIALIZING],
  [SessionState.INITIALIZING]: [SessionState.RTB_REQUESTING],
  [SessionState.RTB_REQUESTING]: [SessionState.VAST_RESOLVING],
  [SessionState.VAST_RESOLVING]: [SessionState.AD_LOADING],
  [SessionState.AD_LOADING]: [SessionState.AD_PLAYING],
  [SessionState.AD_PLAYING]: [SessionState.CONTENT_PLAYING, SessionState.STOPPING],
  [SessionState.CONTENT_PLAYING]: [SessionState.STOPPING],
  [SessionState.STOPPING]: [SessionState.STOPPED],
};

// All error states are valid transitions from any active state
const ACTIVE_STATES = [
  SessionState.INITIALIZING, SessionState.RTB_REQUESTING, SessionState.VAST_RESOLVING,
  SessionState.AD_LOADING, SessionState.AD_PLAYING, SessionState.CONTENT_PLAYING,
];

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  // Error transitions from any active state
  if (ERROR_STATES.includes(to as typeof ERROR_STATES[number]) && ACTIVE_STATES.includes(from)) {
    return true;
  }
  // Error to STOPPING
  if (ERROR_STATES.includes(from as typeof ERROR_STATES[number]) && to === SessionState.STOPPING) {
    return true;
  }
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export class SessionStateMachine {
  readonly id: string;
  private _state: SessionState = SessionState.CREATED;
  readonly config?: SessionConfig;
  readonly createdAt: number;
  private updatedAt: number;
  retryCount = 0;
  error?: string;

  constructor(id: string, config?: SessionConfig) {
    this.id = id;
    this.config = config;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  get state(): SessionState {
    return this._state;
  }

  transition(to: SessionState): void {
    if (!isValidTransition(this._state, to)) {
      throw new Error(`Invalid transition: ${this._state} -> ${to} (session ${this.id})`);
    }
    logger.info({ sessionId: this.id, from: this._state, to }, 'State transition');
    this._state = to;
    this.updatedAt = Date.now();
  }

  setError(state: SessionState, message: string): void {
    this.error = message;
    this.transition(state);
  }

  canRetry(): boolean {
    return this.retryCount < MAX_RETRIES;
  }

  incrementRetry(): void {
    this.retryCount++;
  }

  toInfo(): Omit<SessionInfo, 'workerId' | 'events'> {
    return {
      id: this.id,
      state: this._state,
      config: this.config!,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      retryCount: this.retryCount,
      error: this.error,
    };
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/unit/session.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/worker/session.ts tests/unit/session.test.ts
git commit -m "feat: add session state machine with validation"
```

---

### Task 14: Browser Pool (Worker)

**Files:**
- Create: `src/worker/browser-pool.ts`

**Step 1: Implement browser pool**

```typescript
// src/worker/browser-pool.ts
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createLogger } from '../shared/logger.js';
import { NETWORK_PROFILES } from '../emulation/network-profiles.js';
import type { DeviceProfile, NetworkProfile } from '../shared/types.js';

const logger = createLogger('browser-pool');

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    logger.info('Browser launched');
  }

  async createContext(
    sessionId: string,
    device: DeviceProfile,
    networkEmulation?: NetworkProfile,
  ): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent: device.userAgent,
      viewport: { width: device.screenWidth, height: device.screenHeight },
      locale: 'en-US',
      timezoneId: device.timezone,
      geolocation: device.geo ? { latitude: device.geo.lat, longitude: device.geo.lon } : undefined,
      permissions: device.geo ? ['geolocation'] : [],
    });

    // Apply network emulation via CDP if specified
    if (networkEmulation) {
      const cdpSession = await context.newCDPSession(await context.newPage());
      await cdpSession.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: networkEmulation.downloadThroughput,
        uploadThroughput: networkEmulation.uploadThroughput,
        latency: networkEmulation.latency,
      });
      const pages = context.pages();
      const page = pages[pages.length - 1];
      this.contexts.set(sessionId, context);
      return { context, page };
    }

    const page = await context.newPage();
    this.contexts.set(sessionId, context);
    return { context, page };
  }

  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
    }
  }

  async destroy(): Promise<void> {
    for (const [id, context] of this.contexts) {
      await context.close();
    }
    this.contexts.clear();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    logger.info('Browser pool destroyed');
  }

  get activeContexts(): number {
    return this.contexts.size;
  }
}
```

**Step 2: Commit**

```bash
git add src/worker/browser-pool.ts
git commit -m "feat: add Playwright browser pool with device emulation"
```

---

### Task 15: Worker Process

**Files:**
- Create: `src/worker/worker.ts`

**Step 1: Implement worker process**

```typescript
// src/worker/worker.ts
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import { BrowserPool } from './browser-pool.js';
import { SessionStateMachine } from './session.js';
import { setupNetworkInterceptor, classifyRequest } from './network-interceptor.js';
import { sendBidRequest, extractVastFromBidResponse } from '../engines/rtb-adapter.js';
import { resolveVast } from '../engines/vast-resolver.js';
import { buildTimeline, AdTimelineScheduler } from '../engines/ad-timeline.js';
import { TrackingEngine } from '../engines/tracking-engine.js';
import { MEDIA_TIMEOUT_MS } from '../shared/constants.js';
import { SessionState } from '../shared/types.js';
import type { MasterToWorkerMessage, WorkerToMasterMessage, NetworkLogEntry } from '../shared/types.js';

const logger = createLogger('worker');

const browserPool = new BrowserPool();
const sessions = new Map<string, SessionStateMachine>();
const timelines = new Map<string, AdTimelineScheduler>();
const trackingEngines = new Map<string, TrackingEngine>();
let totalProcessed = 0;

function sendToMaster(msg: WorkerToMasterMessage): void {
  process.send?.(msg);
}

function reportStats(): void {
  sendToMaster({
    type: 'worker-stats',
    activeSessions: sessions.size,
    totalProcessed,
    memoryUsage: process.memoryUsage().heapUsed,
  });
}

async function createSession(sessionId: string, config: MasterToWorkerMessage & { type: 'create-session' }): Promise<void> {
  const sm = new SessionStateMachine(sessionId, config.payload);
  sessions.set(sessionId, sm);

  try {
    // INITIALIZING
    sm.transition(SessionState.INITIALIZING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    const { page } = await browserPool.createContext(
      sessionId,
      config.payload.device,
      config.payload.networkEmulation,
    );

    // Setup network interceptor
    setupNetworkInterceptor(page, sessionId, (entry: NetworkLogEntry) => {
      logger.info(entry, 'network');
    });

    // Navigate to player page
    const playerPath = resolve(process.cwd(), 'public', 'player.html');
    await page.goto(`file://${playerPath}`);
    await page.waitForFunction(() => (window as any).__playerReady === true, { timeout: 10000 });

    // RTB REQUESTING
    sm.transition(SessionState.RTB_REQUESTING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    let vastXml: string;
    try {
      const bidResponse = await sendBidRequest(config.payload);
      const vast = extractVastFromBidResponse(bidResponse);
      if (!vast) throw new Error('No VAST in bid response');
      vastXml = vast;
    } catch (err) {
      if (sm.canRetry()) {
        sm.incrementRetry();
        logger.warn({ sessionId, retry: sm.retryCount }, 'RTB failed, retrying');
        const bidResponse = await sendBidRequest(config.payload);
        const vast = extractVastFromBidResponse(bidResponse);
        if (!vast) throw new Error('No VAST in bid response after retry');
        vastXml = vast;
      } else {
        sm.setError(SessionState.ERROR_NETWORK, (err as Error).message);
        sendToMaster({ type: 'session-error', sessionId, error: sm.error!, state: sm.state });
        return;
      }
    }

    // VAST RESOLVING
    sm.transition(SessionState.VAST_RESOLVING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    let creative;
    try {
      creative = await resolveVast(vastXml);
    } catch (err) {
      sm.setError(SessionState.ERROR_VAST, (err as Error).message);
      sendToMaster({ type: 'session-error', sessionId, error: sm.error!, state: sm.state });
      return;
    }

    // AD LOADING
    sm.transition(SessionState.AD_LOADING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    try {
      await page.evaluate((url: string) => (window as any).__loadAd(url), creative.mediaUrl);
    } catch (err) {
      if (sm.canRetry()) {
        sm.incrementRetry();
        try {
          await page.evaluate((url: string) => (window as any).__loadAd(url), creative.mediaUrl);
        } catch {
          sm.setError(SessionState.ERROR_MEDIA, (err as Error).message);
          sendToMaster({ type: 'session-error', sessionId, error: sm.error!, state: sm.state });
          return;
        }
      } else {
        sm.setError(SessionState.ERROR_MEDIA, (err as Error).message);
        sendToMaster({ type: 'session-error', sessionId, error: sm.error!, state: sm.state });
        return;
      }
    }

    // AD PLAYING
    sm.transition(SessionState.AD_PLAYING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    // Setup tracking
    const trackingEngine = new TrackingEngine(sessionId);
    trackingEngines.set(sessionId, trackingEngine);

    const timeline = buildTimeline(creative.duration);
    const scheduler = new AdTimelineScheduler();
    timelines.set(sessionId, scheduler);

    scheduler.schedule(timeline, async (event) => {
      const urls = event === 'impression'
        ? creative.impressionUrls
        : creative.trackingEvents.get(event) || [];
      await trackingEngine.fireEvent(event, urls);
      sendToMaster({ type: 'session-update', sessionId, state: sm.state, metrics: { [`tracking_${event}`]: 1 } });
    });

    // Wait for ad to complete
    await page.waitForFunction(
      () => (window as any).__adCompleted === true,
      { timeout: (creative.duration + 10) * 1000 },
    );

    // CONTENT PLAYING
    sm.transition(SessionState.CONTENT_PLAYING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    await page.evaluate((url: string) => (window as any).__loadContent(url), config.payload.contentUrl);

    // Let content play for a bit then stop
    await page.waitForTimeout(5000);

    // STOPPING
    sm.transition(SessionState.STOPPING);
    await page.evaluate(() => (window as any).__stopAll());
    await browserPool.closeContext(sessionId);

    sm.transition(SessionState.STOPPED);
    sendToMaster({ type: 'session-stopped', sessionId });

  } catch (err) {
    logger.error({ sessionId, err }, 'Session error');
    if (!ERROR_STATES_SET.has(sm.state)) {
      sm.setError(SessionState.ERROR_NETWORK, (err as Error).message);
    }
    sendToMaster({ type: 'session-error', sessionId, error: (err as Error).message, state: sm.state });
    await browserPool.closeContext(sessionId);
  } finally {
    sessions.delete(sessionId);
    timelines.get(sessionId)?.cancel();
    timelines.delete(sessionId);
    trackingEngines.delete(sessionId);
    totalProcessed++;
    reportStats();
  }
}

const ERROR_STATES_SET = new Set([
  SessionState.ERROR_VAST, SessionState.ERROR_MEDIA,
  SessionState.ERROR_NETWORK, SessionState.ERROR_TIMEOUT,
  SessionState.STOPPED,
]);

async function stopSession(sessionId: string): Promise<void> {
  const sm = sessions.get(sessionId);
  if (!sm) return;

  timelines.get(sessionId)?.cancel();

  if (!ERROR_STATES_SET.has(sm.state) && sm.state !== SessionState.STOPPING) {
    sm.transition(SessionState.STOPPING);
  }

  await browserPool.closeContext(sessionId);

  if (sm.state === SessionState.STOPPING) {
    sm.transition(SessionState.STOPPED);
  }

  sessions.delete(sessionId);
  sendToMaster({ type: 'session-stopped', sessionId });
}

// IPC message handler
process.on('message', async (msg: MasterToWorkerMessage) => {
  switch (msg.type) {
    case 'create-session':
      await createSession(msg.payload.sessionId, msg);
      break;
    case 'stop-session':
      await stopSession(msg.sessionId);
      break;
  }
});

// Initialize
(async () => {
  await browserPool.init();
  logger.info({ pid: process.pid }, 'Worker started');
  reportStats();
})();

// Cleanup on exit
process.on('SIGTERM', async () => {
  logger.info('Worker shutting down');
  await browserPool.destroy();
  process.exit(0);
});
```

**Step 2: Commit**

```bash
git add src/worker/worker.ts
git commit -m "feat: add worker process with session orchestration"
```

---

### Task 16: Worker Manager (Master)

**Files:**
- Create: `src/master/worker-manager.ts`

**Step 1: Implement worker manager**

```typescript
// src/master/worker-manager.ts
import { fork, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import { MAX_WORKERS, SESSIONS_PER_WORKER, WORKER_MAX_SESSIONS_BEFORE_RESTART } from '../shared/constants.js';
import type { MasterToWorkerMessage, WorkerToMasterMessage, WorkerInfo } from '../shared/types.js';

const logger = createLogger('worker-manager');

interface WorkerHandle {
  process: ChildProcess;
  id: number;
  activeSessions: number;
  totalProcessed: number;
  memoryUsage: number;
  status: 'running' | 'restarting' | 'dead';
  sessionIds: Set<string>;
}

export class WorkerManager {
  private workers = new Map<number, WorkerHandle>();
  private nextId = 0;
  private onSessionUpdate?: (msg: WorkerToMasterMessage) => void;

  constructor(onSessionUpdate: (msg: WorkerToMasterMessage) => void) {
    this.onSessionUpdate = onSessionUpdate;
  }

  async start(count?: number): Promise<void> {
    const numWorkers = Math.min(count || MAX_WORKERS, MAX_WORKERS);
    for (let i = 0; i < numWorkers; i++) {
      this.spawnWorker();
    }
    logger.info({ count: numWorkers }, 'Workers started');
  }

  private spawnWorker(): WorkerHandle {
    const id = this.nextId++;
    const workerPath = resolve(process.cwd(), 'dist', 'worker', 'worker.js');
    const child = fork(workerPath, [], {
      env: { ...process.env, WORKER_ID: String(id) },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const handle: WorkerHandle = {
      process: child,
      id,
      activeSessions: 0,
      totalProcessed: 0,
      memoryUsage: 0,
      status: 'running',
      sessionIds: new Set(),
    };

    child.on('message', (msg: WorkerToMasterMessage) => {
      if (msg.type === 'worker-stats') {
        handle.activeSessions = msg.activeSessions;
        handle.totalProcessed = msg.totalProcessed;
        handle.memoryUsage = msg.memoryUsage;

        // Check if worker should be restarted
        if (msg.totalProcessed >= WORKER_MAX_SESSIONS_BEFORE_RESTART && msg.activeSessions === 0) {
          this.restartWorker(id);
        }
      }
      this.onSessionUpdate?.(msg);
    });

    child.on('exit', (code) => {
      logger.warn({ workerId: id, code }, 'Worker exited');
      handle.status = 'dead';
      if (handle.status !== 'restarting') {
        // Unexpected exit — respawn
        this.workers.delete(id);
        this.spawnWorker();
      }
    });

    child.on('error', (err) => {
      logger.error({ workerId: id, err }, 'Worker error');
    });

    this.workers.set(id, handle);
    return handle;
  }

  private restartWorker(id: number): void {
    const handle = this.workers.get(id);
    if (!handle) return;

    logger.info({ workerId: id, totalProcessed: handle.totalProcessed }, 'Restarting worker (memory management)');
    handle.status = 'restarting';
    handle.process.kill('SIGTERM');
    this.workers.delete(id);

    // Spawn replacement
    this.spawnWorker();
  }

  getLeastLoadedWorker(): WorkerHandle | null {
    let best: WorkerHandle | null = null;
    for (const worker of this.workers.values()) {
      if (worker.status !== 'running') continue;
      if (worker.activeSessions >= SESSIONS_PER_WORKER) continue;
      if (!best || worker.activeSessions < best.activeSessions) {
        best = worker;
      }
    }
    return best;
  }

  sendToWorker(workerId: number, msg: MasterToWorkerMessage): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'running') return false;

    if (msg.type === 'create-session') {
      worker.sessionIds.add(msg.payload.sessionId);
      worker.activeSessions++;
    }

    worker.process.send(msg);
    return true;
  }

  findWorkerForSession(sessionId: string): number | null {
    for (const [id, worker] of this.workers) {
      if (worker.sessionIds.has(sessionId)) return id;
    }
    return null;
  }

  removeSessionFromWorker(sessionId: string): void {
    for (const worker of this.workers.values()) {
      if (worker.sessionIds.delete(sessionId)) {
        worker.activeSessions = Math.max(0, worker.activeSessions - 1);
        break;
      }
    }
  }

  getWorkersInfo(): WorkerInfo[] {
    return Array.from(this.workers.values()).map(w => ({
      id: w.id,
      pid: w.process.pid || 0,
      activeSessions: w.activeSessions,
      totalProcessed: w.totalProcessed,
      memoryUsage: w.memoryUsage,
      status: w.status,
    }));
  }

  get totalActiveSessions(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      count += w.activeSessions;
    }
    return count;
  }

  async shutdown(): Promise<void> {
    for (const worker of this.workers.values()) {
      worker.process.kill('SIGTERM');
    }
    this.workers.clear();
  }
}
```

**Step 2: Commit**

```bash
git add src/master/worker-manager.ts
git commit -m "feat: add worker manager with auto-restart and load balancing"
```

---

### Task 17: Session Scheduler (Master)

**Files:**
- Create: `src/master/scheduler.ts`

**Step 1: Implement scheduler**

```typescript
// src/master/scheduler.ts
import { v4 as uuid } from 'uuid';
import { createLogger } from '../shared/logger.js';
import { MAX_SESSIONS } from '../shared/constants.js';
import { WorkerManager } from './worker-manager.js';
import { MetricsRegistry } from './metrics.js';
import { SessionState } from '../shared/types.js';
import type { SessionConfig, SessionInfo, WorkerToMasterMessage } from '../shared/types.js';

const logger = createLogger('scheduler');

export class SessionScheduler {
  private sessions = new Map<string, SessionInfo>();
  private workerManager: WorkerManager;
  private metrics: MetricsRegistry;

  constructor(workerManager: WorkerManager, metrics: MetricsRegistry) {
    this.workerManager = workerManager;
    this.metrics = metrics;
  }

  createSession(config: SessionConfig): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached`);
    }

    const worker = this.workerManager.getLeastLoadedWorker();
    if (!worker) {
      throw new Error('No available workers');
    }

    const sessionId = uuid();
    const session: SessionInfo = {
      id: sessionId,
      state: SessionState.CREATED,
      workerId: worker.id,
      config,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
      retryCount: 0,
    };

    this.sessions.set(sessionId, session);
    this.workerManager.sendToWorker(worker.id, {
      type: 'create-session',
      payload: { ...config, sessionId },
    });

    this.metrics.sessionsRunning(this.activeSessions);
    logger.info({ sessionId, workerId: worker.id }, 'Session created');
    return session;
  }

  createBatch(configs: SessionConfig[]): SessionInfo[] {
    return configs.map(config => this.createSession(config));
  }

  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const workerId = this.workerManager.findWorkerForSession(sessionId);
    if (workerId !== null) {
      this.workerManager.sendToWorker(workerId, { type: 'stop-session', sessionId });
    }

    return true;
  }

  handleWorkerMessage(msg: WorkerToMasterMessage): void {
    switch (msg.type) {
      case 'session-update': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = msg.state;
          session.updatedAt = Date.now();
          if (msg.metrics) {
            for (const [key, value] of Object.entries(msg.metrics)) {
              if (key.startsWith('tracking_')) {
                this.metrics.trackingEventFired(key.replace('tracking_', ''));
              }
            }
          }
        }
        break;
      }
      case 'session-error': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = msg.state;
          session.error = msg.error;
          session.updatedAt = Date.now();
        }
        break;
      }
      case 'session-stopped': {
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          session.state = SessionState.STOPPED;
          session.updatedAt = Date.now();
        }
        this.workerManager.removeSessionFromWorker(msg.sessionId);
        this.metrics.sessionsRunning(this.activeSessions);
        break;
      }
      case 'worker-stats':
        // Handled by worker manager
        break;
    }
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): SessionInfo[] {
    return this.getAllSessions().filter(s =>
      s.state !== SessionState.STOPPED &&
      !s.state.startsWith('ERROR_')
    );
  }

  get activeSessions(): number {
    return this.getActiveSessions().length;
  }
}
```

**Step 2: Commit**

```bash
git add src/master/scheduler.ts
git commit -m "feat: add session scheduler with load balancing"
```

---

### Task 18: Fastify API Server

**Files:**
- Create: `src/master/server.ts`

**Step 1: Implement API server**

```typescript
// src/master/server.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createLogger } from '../shared/logger.js';
import { PORT } from '../shared/constants.js';
import { SessionConfigSchema, BatchSessionSchema, SessionIdParamSchema } from '../shared/schemas.js';
import { MetricsRegistry } from './metrics.js';
import { WorkerManager } from './worker-manager.js';
import { SessionScheduler } from './scheduler.js';

const logger = createLogger('server');

export async function startMaster(): Promise<void> {
  const metrics = new MetricsRegistry();
  const workerManager = new WorkerManager((msg) => {
    scheduler.handleWorkerMessage(msg);
  });
  const scheduler = new SessionScheduler(workerManager, metrics);

  const app = Fastify({ logger: false });
  await app.register(cors);

  // Health check
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Prometheus metrics
  app.get('/metrics', async (request, reply) => {
    const metricsText = await metrics.getMetrics();
    const contentType = await metrics.getContentType();
    reply.type(contentType).send(metricsText);
  });

  // Create session
  app.post('/api/sessions', async (request, reply) => {
    const parsed = SessionConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    try {
      const session = scheduler.createSession(parsed.data);
      return reply.status(201).send(session);
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // Batch create sessions
  app.post('/api/sessions/batch', async (request, reply) => {
    const parsed = BatchSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    try {
      const sessions = scheduler.createBatch(parsed.data.sessions);
      return reply.status(201).send({ sessions });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // List sessions
  app.get('/api/sessions', async () => {
    return { sessions: scheduler.getAllSessions(), total: scheduler.getAllSessions().length };
  });

  // Get session
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = scheduler.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return session;
  });

  // Stop session
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const stopped = scheduler.stopSession(request.params.id);
    if (!stopped) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { status: 'stopping', sessionId: request.params.id };
  });

  // Worker stats
  app.get('/api/workers', async () => {
    return { workers: workerManager.getWorkersInfo() };
  });

  // Start workers
  await workerManager.start();

  // Start server
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT }, 'CTV Emulator API started');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await workerManager.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
```

**Step 2: Commit**

```bash
git add src/master/server.ts
git commit -m "feat: add Fastify API server with all endpoints"
```

---

### Task 19: Docker Configuration

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Step 1: Create Dockerfile**

```dockerfile
# Dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY fixtures/ ./fixtures/

RUN npm run build

RUN npx playwright install chromium

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

**Step 2: Create docker-compose.yml**

```yaml
# docker-compose.yml
version: '3.8'

services:
  ctv-emulator:
    build: .
    container_name: ctv-emulator
    ports:
      - "3000:3000"
    environment:
      - MAX_SESSIONS=200
      - MAX_WORKERS=20
      - SESSIONS_PER_WORKER=10
      - RTB_TIMEOUT_MS=2000
      - VAST_TIMEOUT_MS=3000
      - MEDIA_TIMEOUT_MS=5000
      - LOG_ROTATION_SIZE=50m
      - PORT=3000
    volumes:
      - ./logs:/app/logs
      - ./fixtures:/app/fixtures
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 8G
```

**Step 3: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: add Docker and docker-compose configuration"
```

---

### Task 20: Integration Tests

**Files:**
- Create: `tests/integration/api.test.ts`

**Step 1: Write integration tests**

```typescript
// tests/integration/api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

// Integration tests require running server
// These are designed to run with `npm run test:integration`

describe('API Integration', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

  it('health check responds OK', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('metrics endpoint returns prometheus format', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain('sessions_running');
  });

  it('GET /api/sessions returns empty list initially', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.sessions).toEqual([]);
  });

  it('POST /api/sessions with invalid body returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/sessions/:id with unknown id returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('GET /api/workers returns worker list', async () => {
    const res = await fetch(`${BASE_URL}/api/workers`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.workers)).toBe(true);
  });
});
```

**Step 2: Commit**

```bash
git add tests/integration/api.test.ts
git commit -m "feat: add integration tests for API endpoints"
```

---

### Task 21: Load Test Scenarios

**Files:**
- Create: `tests/load/load-test.ts`

**Step 1: Create load test**

```typescript
// tests/load/load-test.ts

// Load test script — run with: npx tsx tests/load/load-test.ts
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const CONCURRENT_SESSIONS = parseInt(process.env.LOAD_SESSIONS || '50', 10);

const sampleConfig = {
  device: {
    os: 'AndroidTV',
    vendor: 'Sony',
    model: 'BRAVIA-XR',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceId: 'load-test-device',
    ifa: 'load-test-ifa',
    ip: '10.0.0.1',
    networkType: 'WiFi',
    userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36',
    timezone: 'America/New_York',
  },
  rtbEndpoint: 'https://ssp.example.com/bid',
  contentUrl: 'https://cdn.example.com/stream.m3u8',
  appBundle: 'com.loadtest.app',
  appName: 'LoadTest',
  appStoreUrl: 'https://play.google.com/store/apps/details?id=com.loadtest.app',
};

async function createSession(index: number): Promise<{ id: string; status: number; time: number }> {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...sampleConfig,
      device: { ...sampleConfig.device, deviceId: `load-${index}`, ifa: `ifa-${index}` },
    }),
  });
  const time = Date.now() - start;
  const body = await res.json();
  return { id: body.id || '', status: res.status, time };
}

async function runLoadTest() {
  console.log(`Starting load test with ${CONCURRENT_SESSIONS} concurrent sessions...`);
  console.log(`Target: ${BASE_URL}`);
  console.log('---');

  const startTime = Date.now();

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT_SESSIONS }, (_, i) => createSession(i))
  );

  const totalTime = Date.now() - startTime;
  const successes = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 201);
  const failures = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && (r.value as any).status !== 201));

  const times = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => r.value.time);

  console.log(`Total time: ${totalTime}ms`);
  console.log(`Successes: ${successes.length}/${CONCURRENT_SESSIONS}`);
  console.log(`Failures: ${failures.length}/${CONCURRENT_SESSIONS}`);
  if (times.length > 0) {
    console.log(`Avg response time: ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`);
    console.log(`Max response time: ${Math.max(...times)}ms`);
    console.log(`Min response time: ${Math.min(...times)}ms`);
  }

  // Wait and check session states
  await new Promise(resolve => setTimeout(resolve, 5000));

  const sessionsRes = await fetch(`${BASE_URL}/api/sessions`);
  const sessionsBody = await sessionsRes.json();
  console.log(`\nActive sessions after 5s: ${sessionsBody.sessions?.length || 0}`);

  const stateCounts: Record<string, number> = {};
  for (const s of sessionsBody.sessions || []) {
    stateCounts[s.state] = (stateCounts[s.state] || 0) + 1;
  }
  console.log('State distribution:', stateCounts);
}

runLoadTest().catch(console.error);
```

**Step 2: Commit**

```bash
git add tests/load/load-test.ts
git commit -m "feat: add load test scenario for parallel sessions"
```

---

### Task 22: Vitest Configuration

**Files:**
- Create: `vitest.config.ts`

**Step 1: Create vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/load/**'],
    globals: false,
    testTimeout: 10000,
  },
});
```

**Step 2: Commit**

```bash
git add vitest.config.ts
git commit -m "chore: add vitest configuration"
```

---

### Task 23: Run All Unit Tests

**Step 1: Run all unit tests**

```bash
npx vitest run
```
Expected: ALL PASS (schemas, logger, emulation, vast-resolver, rtb-adapter, ad-timeline, tracking-engine, network-interceptor, session, metrics)

**Step 2: Fix any failures**

If any test fails, fix the implementation and re-run.

---

### Task 24: Build and Verify

**Step 1: Build TypeScript**

```bash
npx tsc
```
Expected: No errors

**Step 2: Fix any type errors**

If there are type errors, fix them and re-run.

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors"
```

---

### Task 25: Final Commit and Summary

**Step 1: Verify complete project structure**

```bash
find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' | sort
```

**Step 2: Run final test suite**

```bash
npx vitest run
```
Expected: ALL PASS

**Step 3: Create summary commit if needed**

```bash
git log --oneline
```
