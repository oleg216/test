/**
 * CTV Test Launcher — Full Playwright cycle with analytics.
 *
 * Full pipeline: bid → VAST → video playback → tracking pixels (impression, Q1-Q4, complete)
 * Uses: fingerprints from CSV, proxy per session, app rotation.
 * Purpose: collect analytics on which apps get bids, fill rates, completion rates.
 *
 * Output:
 *   logs/test-<ts>/analytics.csv   — per-session results
 *   logs/test-<ts>/app-summary.csv — per-app aggregated stats
 *   logs/test-<ts>/summary.log     — overall progress log
 *   logs/test-<ts>/sessions.db     — SQLite with full session data
 *
 * Usage:
 *   npm run build && npm run test:live
 *   npm run build && CONCURRENCY=100 WORKERS=10 tsx scripts/launch-test.ts
 */

// ENV MUST be set before ANY import — ES module imports are hoisted
// so we use a synchronous top-level assignment trick
process.env.MAX_SESSIONS = '50000';
process.env.MAX_WORKERS = process.env.WORKERS || '20';
process.env.SESSIONS_PER_WORKER = process.env.PER_WORKER || '10';

import { mkdirSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';

// ── Config ──
const WORKERS = parseInt(process.env.MAX_WORKERS!, 10);
const PER_WORKER = parseInt(process.env.SESSIONS_PER_WORKER!, 10);
const CONCURRENCY = WORKERS * PER_WORKER;
const BIDFLOOR = parseFloat(process.env.BIDFLOOR || '0.5');
const RTB_ENDPOINT = process.argv[2] || 'http://rtb.pixelimpact.live/?pid=f6ea8478bf1a826ebf9a53f3dc58fb31';

// Shared timestamp for all output dirs
const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = resolve(process.cwd(), 'logs', `test-${RUN_TS}`);

// Per-worker log files — set before any module imports logger
process.env.LOG_DIR = resolve(RUN_DIR, 'worker-logs');

// ── Now import project modules (after env is set) ──
import { initGeoDb } from '../src/shared/geo-lookup.js';
import { loadProxyPool, getProxyPoolSize } from '../src/emulation/proxy-pool.js';
import { loadFingerprints } from '../src/emulation/fingerprint-loader.js';
import { loadAppRotation, getNextApp } from '../src/emulation/app-rotation.js';
import { MetricsRegistry } from '../src/master/metrics.js';
import { WorkerManager } from '../src/master/worker-manager.js';
import { SessionScheduler } from '../src/master/scheduler.js';
import { SessionStore } from '../src/master/session-store.js';
import { SessionState } from '../src/shared/types.js';
import type { SessionConfig } from '../src/shared/types.js';

// ── Load resources ──
const fingerprints = loadFingerprints();
const proxies = loadProxyPool();
const apps = loadAppRotation();

if (fingerprints.length === 0) { console.error('ERROR: No fingerprints in data/fingerprints_tv.csv'); process.exit(1); }
if (proxies.length === 0) { console.error('ERROR: No proxies in data/proxies.txt'); process.exit(1); }

const DEFAULT_APP = { bundle: 'tv.pluto.android', name: 'Pluto TV', storeurl: 'https://play.google.com/store/apps/details?id=tv.pluto.android', ver: '5.40.1' };
const totalSessions = Math.min(fingerprints.length, getProxyPoolSize());

// ── Output setup ──
const BASE_DIR = RUN_DIR;
mkdirSync(BASE_DIR, { recursive: true });

// Per-session analytics CSV
const analyticsCsv = createWriteStream(resolve(BASE_DIR, 'analytics.csv'));
analyticsCsv.write('session_id,timestamp,app_bundle,app_name,store_url,app_ver,os,vendor,model,proxy_ip,carrier,user_agent,result,bid_price,events_fired,duration_ms,error\n');

// Summary log
const summaryStream = createWriteStream(resolve(BASE_DIR, 'summary.log'));
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  summaryStream.write(line + '\n');
}

function csvEsc(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// ── Analytics state ──
interface SessionTracker {
  config: SessionConfig;
  bidPrice: number;
  events: Set<string>;
  error?: string;
  state: string;
}

const trackers = new Map<string, SessionTracker>();

// Per-app aggregated stats
interface AppStats {
  bundle: string;
  name: string;
  storeurl: string;
  sessions: number;
  bids: number;
  noBids: number;
  errors: number;
  totalRevenue: number;
  impressions: number;
  starts: number;
  firstQuartiles: number;
  midpoints: number;
  thirdQuartiles: number;
  completes: number;
  clicks: number;
  totalDurationMs: number;
}

const appStatsMap = new Map<string, AppStats>();

function getAppStats(bundle: string, name: string, storeurl: string): AppStats {
  let stats = appStatsMap.get(bundle);
  if (!stats) {
    stats = {
      bundle, name, storeurl,
      sessions: 0, bids: 0, noBids: 0, errors: 0,
      totalRevenue: 0, impressions: 0, starts: 0,
      firstQuartiles: 0, midpoints: 0, thirdQuartiles: 0,
      completes: 0, clicks: 0, totalDurationMs: 0,
    };
    appStatsMap.set(bundle, stats);
  }
  return stats;
}

let completedCount = 0;
let queueCursor = 0;

// ── Build session queue ──
const queue: SessionConfig[] = [];
for (let i = 0; i < totalSessions; i++) {
  const device = { ...fingerprints[i] };
  if (device.geo) device.geo = { ...device.geo };
  if (device.fingerprint) device.fingerprint = {
    ...device.fingerprint,
    connection: { ...device.fingerprint.connection },
    screen: { ...device.fingerprint.screen },
    webgl: { ...device.fingerprint.webgl },
    fonts: [...device.fingerprint.fonts],
  };

  const app = getNextApp() || DEFAULT_APP;

  queue.push({
    device,
    rtbEndpoint: RTB_ENDPOINT,
    contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    appBundle: app.bundle,
    appName: app.name,
    appStoreUrl: app.storeurl,
    appVersion: app.ver,
    bidfloor: BIDFLOOR,
    proxy: proxies[i],
  });
}

// ── Feed queue ──
let scheduler: SessionScheduler;

function feedQueue(): void {
  let fed = 0;
  while (queueCursor < queue.length) {
    try {
      const config = queue[queueCursor];
      const session = scheduler.createSession(config);
      trackers.set(session.id, {
        config,
        bidPrice: 0,
        events: new Set(),
        state: 'CREATED',
      });
      queueCursor++;
      fed++;
    } catch (err) {
      // Workers full — will retry on next session completion
      log(`  [feedQueue] blocked at cursor ${queueCursor}: ${(err as Error).message}`);
      break;
    }
  }
  if (fed > 0) {
    log(`  [feedQueue] fed ${fed} sessions, cursor now ${queueCursor}/${queue.length}`);
  }
}

function writeSessionCsv(sessionId: string, durationMs: number): void {
  const t = trackers.get(sessionId);
  if (!t) return;

  const result = t.bidPrice > 0 ? 'BID' : (t.error ? 'ERROR' : 'NOBID');
  const eventsStr = [...t.events].join(';');

  analyticsCsv.write([
    sessionId,
    new Date().toISOString(),
    t.config.appBundle,
    csvEsc(t.config.appName),
    t.config.appStoreUrl,
    t.config.appVersion || '',
    t.config.device.os,
    t.config.device.vendor,
    t.config.device.model,
    t.config.device.ip,
    csvEsc(t.config.device.carrier || ''),
    csvEsc(t.config.device.userAgent),
    result,
    t.bidPrice > 0 ? t.bidPrice.toFixed(4) : '',
    eventsStr,
    String(durationMs),
    csvEsc(t.error || ''),
  ].join(',') + '\n');
}

function checkDone(): void {
  if (completedCount >= totalSessions) {
    finishAndExit();
  }
}

// ── Main ──
async function main(): Promise<void> {
  const startTime = Date.now();

  log('═══════════════════════════════════════════════════════════════');
  log('  CTV TEST LAUNCHER — Full Playwright Cycle');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Fingerprints:   ${fingerprints.length}`);
  log(`  Proxies:        ${getProxyPoolSize()}`);
  log(`  Apps:           ${apps.length || 1}`);
  log(`  Total sessions: ${totalSessions}`);
  log(`  Workers:        ${WORKERS} × ${PER_WORKER} = ${CONCURRENCY} concurrent`);
  log(`  Endpoint:       ${RTB_ENDPOINT}`);
  log(`  Bidfloor:       $${BIDFLOOR}`);
  log(`  Output:         ${BASE_DIR}`);
  log('───────────────────────────────────────────────────────────────');

  await initGeoDb();

  const metrics = new MetricsRegistry();
  const store = new SessionStore(resolve(BASE_DIR, 'sessions.db'));

  const workerManager = new WorkerManager((msg) => {
    scheduler.handleWorkerMessage(msg);
  });

  scheduler = new SessionScheduler(workerManager, metrics, store, {
    onBid(sessionId, price, config) {
      const t = trackers.get(sessionId);
      if (t) t.bidPrice = price;

      const stats = getAppStats(config.appBundle, config.appName, config.appStoreUrl);
      stats.bids++;
      stats.totalRevenue += price;

      log(`  BID  $${price.toFixed(2)} | ${config.appBundle} | ${config.device.os} ${config.device.model} | ${config.device.ip}`);
    },

    onTrackingEvent(sessionId, event, config) {
      const t = trackers.get(sessionId);
      if (t) t.events.add(event);

      const stats = getAppStats(config.appBundle, config.appName, config.appStoreUrl);
      if (event === 'impression') stats.impressions++;
      else if (event === 'start') stats.starts++;
      else if (event === 'firstQuartile') stats.firstQuartiles++;
      else if (event === 'midpoint') stats.midpoints++;
      else if (event === 'thirdQuartile') stats.thirdQuartiles++;
      else if (event === 'complete') stats.completes++;
      else if (event === 'click') stats.clicks++;
    },

    onSessionComplete(sessionId, config, durationMs) {
      const t = trackers.get(sessionId);
      if (t) t.state = 'STOPPED';

      const stats = getAppStats(config.appBundle, config.appName, config.appStoreUrl);
      stats.totalDurationMs += durationMs;
      if (t && t.bidPrice === 0 && !t.error) stats.noBids++;

      writeSessionCsv(sessionId, durationMs);
      completedCount++;

      if (completedCount % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const totalBids = [...appStatsMap.values()].reduce((s, a) => s + a.bids, 0);
        log(`  ── Progress: ${completedCount}/${totalSessions} | Bids: ${totalBids} | ${elapsed}s ──`);
      }

      trackers.delete(sessionId);
      feedQueue();
      checkDone();
    },

    onSessionError(sessionId, error, state, config) {
      const t = trackers.get(sessionId);
      if (t) {
        t.error = error;
        t.state = state;
      }

      const stats = getAppStats(config.appBundle, config.appName, config.appStoreUrl);
      stats.errors++;

      writeSessionCsv(sessionId, Date.now() - (scheduler.getSession(sessionId)?.createdAt || Date.now()));
      completedCount++;

      trackers.delete(sessionId);
      feedQueue();
      checkDone();
    },
  });

  log('\nStarting workers...');
  await workerManager.start();
  log(`Workers ready (${WORKERS})\n`);

  // Count sessions per app
  for (const config of queue) {
    const stats = getAppStats(config.appBundle, config.appName, config.appStoreUrl);
    stats.sessions++;
  }

  // Start feeding
  feedQueue();
  log(`Fed initial batch, cursor at ${queueCursor}/${totalSessions}\n`);

  // Keep alive — process exits when finishAndExit() is called
  const keepAlive = setInterval(() => {
    if (completedCount >= totalSessions) {
      clearInterval(keepAlive);
    }
  }, 5000);

  // Graceful shutdown
  function finishAndExit(): void {
    clearInterval(keepAlive);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Write app-summary.csv ──
    const appSumPath = resolve(BASE_DIR, 'app-summary.csv');
    const appSumStream = createWriteStream(appSumPath);
    appSumStream.write('bundle,name,store_url,sessions,bids,no_bids,errors,fill_rate,avg_bid_price,impressions,starts,q1,midpoint,q3,completes,clicks,completion_rate,total_revenue,avg_duration_s\n');

    const allStats = [...appStatsMap.values()].sort((a, b) => b.bids - a.bids);

    for (const s of allStats) {
      const fillRate = s.sessions > 0 ? (s.bids / s.sessions * 100).toFixed(1) : '0';
      const avgPrice = s.bids > 0 ? (s.totalRevenue / s.bids).toFixed(4) : '0';
      const completionRate = s.impressions > 0 ? (s.completes / s.impressions * 100).toFixed(1) : '0';
      const avgDuration = s.sessions > 0 ? (s.totalDurationMs / s.sessions / 1000).toFixed(1) : '0';

      appSumStream.write([
        s.bundle,
        csvEsc(s.name),
        s.storeurl,
        s.sessions, s.bids, s.noBids, s.errors,
        fillRate + '%',
        avgPrice,
        s.impressions, s.starts, s.firstQuartiles, s.midpoints, s.thirdQuartiles, s.completes, s.clicks,
        completionRate + '%',
        s.totalRevenue.toFixed(4),
        avgDuration,
      ].join(',') + '\n');
    }
    appSumStream.end();

    // ── Summary ──
    const totalBids = allStats.reduce((s, a) => s + a.bids, 0);
    const totalNoBids = allStats.reduce((s, a) => s + a.noBids, 0);
    const totalErrors = allStats.reduce((s, a) => s + a.errors, 0);
    const totalRevenue = allStats.reduce((s, a) => s + a.totalRevenue, 0);
    const totalImpressions = allStats.reduce((s, a) => s + a.impressions, 0);
    const totalCompletes = allStats.reduce((s, a) => s + a.completes, 0);
    const fillRate = totalSessions > 0 ? (totalBids / totalSessions * 100).toFixed(1) : '0';
    const completionRate = totalImpressions > 0 ? (totalCompletes / totalImpressions * 100).toFixed(1) : '0';

    log('\n═══════════════════════════════════════════════════════════════');
    log('  RESULTS');
    log('═══════════════════════════════════════════════════════════════');
    log(`  Total sessions:   ${totalSessions}`);
    log(`  Bids:             ${totalBids}`);
    log(`  No-Bids:          ${totalNoBids}`);
    log(`  Errors:           ${totalErrors}`);
    log(`  Fill rate:        ${fillRate}%`);
    log(`  Avg bid price:    $${totalBids > 0 ? (totalRevenue / totalBids).toFixed(4) : '0'}`);
    log(`  Total revenue:    $${totalRevenue.toFixed(4)}`);
    log(`  Impressions:      ${totalImpressions}`);
    log(`  Completions:      ${totalCompletes}`);
    log(`  Completion rate:  ${completionRate}%`);
    log(`  Duration:         ${elapsed}s`);
    log('───────────────────────────────────────────────────────────────');
    log('  TOP APPS BY BIDS:');

    for (const s of allStats.slice(0, 15)) {
      if (s.bids === 0) continue;
      const fr = (s.bids / s.sessions * 100).toFixed(0);
      const cr = s.impressions > 0 ? (s.completes / s.impressions * 100).toFixed(0) : '0';
      log(`    ${s.bundle.padEnd(45)} ${String(s.bids).padStart(3)} bids | ${fr}% fill | $${(s.totalRevenue / s.bids).toFixed(2)} avg | ${cr}% complete`);
    }

    log('───────────────────────────────────────────────────────────────');
    log(`  Analytics:    ${resolve(BASE_DIR, 'analytics.csv')}`);
    log(`  App summary:  ${appSumPath}`);
    log(`  Sessions DB:  ${resolve(BASE_DIR, 'sessions.db')}`);
    log('═══════════════════════════════════════════════════════════════');

    analyticsCsv.end();
    summaryStream.end();

    scheduler.shutdown();
    workerManager.shutdown().then(() => process.exit(0));
  }

  process.on('SIGINT', finishAndExit);
  process.on('SIGTERM', finishAndExit);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
