/**
 * Full Playwright cycle — single app, all proxies.
 *
 * Pipeline per session:
 *   bid request → VAST resolve → video playback → tracking pixels
 *   (impression, start, Q1, midpoint, Q3, complete, click)
 *
 * Output:
 *   logs/full-single-<ts>/analytics.csv
 *   logs/full-single-<ts>/bids.csv       — successful bids only
 *   logs/full-single-<ts>/bids/          — full JSON + VAST per bid
 *   logs/full-single-<ts>/summary.log
 *   logs/full-single-<ts>/sessions.db
 *   logs/full-single-<ts>/worker-logs/
 *
 * Usage:
 *   WORKERS=8 BIDFLOOR=1.7 npx tsx scripts/launch-single-app-full.ts
 *   ROUNDS=4 npx tsx scripts/launch-single-app-full.ts  # 4x all proxies
 *   TOTAL=200000 npx tsx scripts/launch-single-app-full.ts
 */

process.env.MAX_SESSIONS = '999999';
process.env.MAX_WORKERS = process.env.WORKERS || '8';
process.env.SESSIONS_PER_WORKER = process.env.PER_WORKER || '10';

import { mkdirSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';

const WORKERS = parseInt(process.env.MAX_WORKERS!, 10);
const PER_WORKER = parseInt(process.env.SESSIONS_PER_WORKER!, 10);
const CONCURRENCY = WORKERS * PER_WORKER;
const BIDFLOOR = parseFloat(process.env.BIDFLOOR || '1.7');
const RTB_ENDPOINT = process.argv[2] || 'http://rtb.pixelimpact.live/?pid=f6ea8478bf1a826ebf9a53f3dc58fb31';

const APP = {
  bundle: process.env.APP_BUNDLE || 'com.gameloft.android.ANMP.GloftA8HM',
  name: process.env.APP_NAME || 'Asphalt 8',
  storeurl: process.env.APP_STORE || 'https://play.google.com/store/apps/details?id=com.gameloft.android.ANMP.GloftA8HM',
  ver: process.env.APP_VER || '7.4.0',
};

const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = resolve(process.cwd(), 'logs', `full-single-${RUN_TS}`);
const BIDS_DIR = resolve(RUN_DIR, 'bids');

process.env.LOG_DIR = resolve(RUN_DIR, 'worker-logs');

import { initGeoDb } from '../src/shared/geo-lookup.js';
import { loadProxyPool, getProxyPoolSize } from '../src/emulation/proxy-pool.js';
import { loadFingerprints } from '../src/emulation/fingerprint-loader.js';
import { MetricsRegistry } from '../src/master/metrics.js';
import { WorkerManager } from '../src/master/worker-manager.js';
import { SessionScheduler } from '../src/master/scheduler.js';
import { SessionStore } from '../src/master/session-store.js';
import { SessionState } from '../src/shared/types.js';
import type { SessionConfig } from '../src/shared/types.js';

const fingerprints = loadFingerprints();
const proxies = loadProxyPool();

if (fingerprints.length === 0) { console.error('ERROR: No fingerprints'); process.exit(1); }
if (proxies.length === 0) { console.error('ERROR: No proxies'); process.exit(1); }

const ROUNDS = parseInt(process.env.ROUNDS || '1', 10);
const TOTAL_OVERRIDE = process.env.TOTAL ? parseInt(process.env.TOTAL, 10) : 0;
const totalSessions = TOTAL_OVERRIDE || proxies.length * ROUNDS;

mkdirSync(BIDS_DIR, { recursive: true });

const analyticsCsv = createWriteStream(resolve(RUN_DIR, 'analytics.csv'));
analyticsCsv.write('session_id,timestamp,os,vendor,model,proxy_index,carrier,user_agent,result,bid_price,events_fired,duration_ms,error\n');

const bidsCsv = createWriteStream(resolve(RUN_DIR, 'bids.csv'));
bidsCsv.write('session_id,timestamp,os,vendor,model,ip,carrier,bid_price,events_fired,duration_ms,geo_city,geo_region,geo_country,proxy_index\n');

const summaryStream = createWriteStream(resolve(RUN_DIR, 'summary.log'));

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  summaryStream.write(line + '\n');
}

function csvEsc(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) return '"' + val.replace(/"/g, '""') + '"';
  return val;
}

function sanitize(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }

interface SessionTracker {
  config: SessionConfig;
  proxyIdx: number;
  bidPrice: number;
  events: Set<string>;
  error?: string;
  state: string;
}

const trackers = new Map<string, SessionTracker>();

let totalBids = 0, totalNoBids = 0, totalErrors = 0;
let totalImpressions = 0, totalCompletes = 0, totalClicks = 0;
let totalRevenue = 0;
let completedCount = 0;
let queueCursor = 0;

// Build queue: cycle proxies for totalSessions
const queue: { config: SessionConfig; proxyIdx: number }[] = [];
for (let i = 0; i < totalSessions; i++) {
  const p = i % proxies.length;
  const fpIdx = i % fingerprints.length;
  const device = { ...fingerprints[fpIdx] };
  if (device.geo) device.geo = { ...device.geo };
  if (device.fingerprint) device.fingerprint = {
    ...device.fingerprint,
    connection: { ...device.fingerprint.connection },
    screen: { ...device.fingerprint.screen },
    webgl: { ...device.fingerprint.webgl },
    fonts: [...device.fingerprint.fonts],
  };

  queue.push({
    proxyIdx: p,
    config: {
      device,
      rtbEndpoint: RTB_ENDPOINT,
      contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
      appBundle: APP.bundle,
      appName: APP.name,
      appStoreUrl: APP.storeurl,
      appVersion: APP.ver,
      bidfloor: BIDFLOOR,
      proxy: proxies[p],
    },
  });
}

let scheduler: SessionScheduler;

function feedQueue(): void {
  let fed = 0;
  while (queueCursor < queue.length) {
    try {
      const entry = queue[queueCursor];
      const session = scheduler.createSession(entry.config);
      trackers.set(session.id, {
        config: entry.config,
        proxyIdx: entry.proxyIdx,
        bidPrice: 0,
        events: new Set(),
        state: 'CREATED',
      });
      queueCursor++;
      fed++;
    } catch { break; }
  }
  if (fed > 0) log(`  [feedQueue] fed ${fed}, cursor ${queueCursor}/${queue.length}`);
}

function writeAnalytics(sessionId: string, durationMs: number): void {
  const t = trackers.get(sessionId);
  if (!t) return;
  const result = t.bidPrice > 0 ? 'BID' : (t.error ? 'ERROR' : 'NOBID');
  analyticsCsv.write([sessionId, new Date().toISOString(),
    t.config.device.os, t.config.device.vendor, t.config.device.model,
    String(t.proxyIdx), csvEsc(t.config.device.carrier || ''), csvEsc(t.config.device.userAgent),
    result, t.bidPrice > 0 ? t.bidPrice.toFixed(4) : '', [...t.events].join(';'),
    String(durationMs), csvEsc(t.error || '')].join(',') + '\n');
}

function writeBid(sessionId: string, durationMs: number): void {
  const t = trackers.get(sessionId);
  if (!t || t.bidPrice <= 0) return;
  bidsCsv.write([sessionId, new Date().toISOString(),
    t.config.device.os, t.config.device.vendor, t.config.device.model,
    t.config.device.ip, csvEsc(t.config.device.carrier || ''),
    t.bidPrice.toFixed(4), [...t.events].join(';'), String(durationMs),
    t.config.device.geo?.city || '', t.config.device.geo?.region || '',
    t.config.device.geo?.country || '', String(t.proxyIdx)].join(',') + '\n');

  // Save full bid to bids/ folder
  const fn = `${String(t.proxyIdx + 1).padStart(5, '0')}_BID_${sanitize(t.config.device.ip || 'unknown')}`;
  writeFileSync(resolve(BIDS_DIR, `${fn}.json`), JSON.stringify({
    sessionId, proxyIndex: t.proxyIdx, timestamp: new Date().toISOString(), durationMs,
    app: APP,
    device: {
      os: t.config.device.os, osv: t.config.device.osv, vendor: t.config.device.vendor,
      model: t.config.device.model, ip: t.config.device.ip, ifa: t.config.device.ifa,
      userAgent: t.config.device.userAgent, carrier: t.config.device.carrier,
      geo: t.config.device.geo,
    },
    bidPrice: t.bidPrice,
    events: [...t.events],
  }, null, 2));
}

function checkDone(): void {
  if (completedCount >= totalSessions) finishAndExit();
}

let startTime: number;

async function main(): Promise<void> {
  startTime = Date.now();

  log('═══════════════════════════════════════════════════════════════');
  log(`  FULL SINGLE APP — ${APP.name} (${APP.bundle})`);
  log('═══════════════════════════════════════════════════════════════');
  log(`  Fingerprints:   ${fingerprints.length}`);
  log(`  Proxies:        ${proxies.length}`);
  log(`  Total sessions: ${totalSessions}`);
  log(`  Workers:        ${WORKERS} × ${PER_WORKER} = ${CONCURRENCY} concurrent`);
  log(`  Endpoint:       ${RTB_ENDPOINT}`);
  log(`  Bidfloor:       $${BIDFLOOR}`);
  log(`  Output:         ${RUN_DIR}`);
  log(`  Bids folder:    ${BIDS_DIR}`);
  log('───────────────────────────────────────────────────────────────');

  await initGeoDb();

  const metrics = new MetricsRegistry();
  const store = new SessionStore(resolve(RUN_DIR, 'sessions.db'));

  const workerManager = new WorkerManager((msg) => {
    scheduler.handleWorkerMessage(msg);
  });

  scheduler = new SessionScheduler(workerManager, metrics, store, {
    onBid(sessionId, price, config) {
      const t = trackers.get(sessionId);
      if (t) t.bidPrice = price;
      totalBids++;
      totalRevenue += price;
      log(`  BID  $${price.toFixed(2)} | ${config.device.os} ${config.device.model} | ${config.device.ip}`);
    },

    onTrackingEvent(sessionId, event) {
      const t = trackers.get(sessionId);
      if (t) t.events.add(event);
      if (event === 'impression') totalImpressions++;
      else if (event === 'complete') totalCompletes++;
      else if (event === 'click') totalClicks++;
    },

    onSessionComplete(sessionId, config, durationMs) {
      const t = trackers.get(sessionId);
      if (t) t.state = 'STOPPED';
      if (t && t.bidPrice === 0 && !t.error) totalNoBids++;

      writeAnalytics(sessionId, durationMs);
      writeBid(sessionId, durationMs);
      completedCount++;

      if (completedCount % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = (completedCount / totalSessions * 100).toFixed(1);
        log(`  ── ${completedCount}/${totalSessions} (${pct}%) | Bids: ${totalBids} | Imp: ${totalImpressions} | Complete: ${totalCompletes} | $${totalRevenue.toFixed(2)} | ${elapsed}s ──`);
      }

      trackers.delete(sessionId);
      feedQueue();
      checkDone();
    },

    onSessionError(sessionId, error, state, config) {
      const t = trackers.get(sessionId);
      if (t) { t.error = error; t.state = state; }
      totalErrors++;

      writeAnalytics(sessionId, Date.now() - (scheduler.getSession(sessionId)?.createdAt || Date.now()));
      completedCount++;

      trackers.delete(sessionId);
      feedQueue();
      checkDone();
    },
  });

  log('\nStarting workers...');
  await workerManager.start();
  log(`Workers ready (${WORKERS})\n`);

  feedQueue();
  log(`Fed initial batch, cursor at ${queueCursor}/${totalSessions}\n`);

  const keepAlive = setInterval(() => {
    if (completedCount >= totalSessions) clearInterval(keepAlive);
  }, 5000);

  process.on('SIGINT', finishAndExit);
  process.on('SIGTERM', finishAndExit);
}

function finishAndExit(): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const fillRate = totalSessions > 0 ? (totalBids / totalSessions * 100).toFixed(2) : '0';
  const completionRate = totalImpressions > 0 ? (totalCompletes / totalImpressions * 100).toFixed(1) : '0';

  log('\n═══════════════════════════════════════════════════════════════');
  log('  RESULTS');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Total sessions:   ${totalSessions}`);
  log(`  Bids:             ${totalBids}`);
  log(`  No-Bids:          ${totalNoBids}`);
  log(`  Errors:           ${totalErrors}`);
  log(`  Fill rate:        ${fillRate}%`);
  log(`  Total revenue:    $${totalRevenue.toFixed(4)}`);
  log(`  Avg bid price:    $${totalBids > 0 ? (totalRevenue / totalBids).toFixed(4) : '0'}`);
  log(`  Impressions:      ${totalImpressions}`);
  log(`  Completions:      ${totalCompletes}`);
  log(`  Clicks:           ${totalClicks}`);
  log(`  Completion rate:  ${completionRate}%`);
  log(`  Duration:         ${elapsed}s`);
  log('───────────────────────────────────────────────────────────────');
  log(`  Analytics:    ${resolve(RUN_DIR, 'analytics.csv')}`);
  log(`  Bids CSV:     ${resolve(RUN_DIR, 'bids.csv')}`);
  log(`  Bids folder:  ${BIDS_DIR}`);
  log(`  Sessions DB:  ${resolve(RUN_DIR, 'sessions.db')}`);
  log('═══════════════════════════════════════════════════════════════');

  analyticsCsv.end();
  bidsCsv.end();
  summaryStream.end();
  scheduler.shutdown();
  workerManager.shutdown().then(() => process.exit(0));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
