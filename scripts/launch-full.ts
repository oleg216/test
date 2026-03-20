/**
 * Full CTV launcher — every proxy × every app (cartesian product).
 *
 * Full Playwright pipeline per session:
 *   bid request → VAST resolve → video playback → tracking pixels
 *   (impression, start, Q1, midpoint, Q3, complete, click)
 *
 * Output (single folder):
 *   logs/full-<ts>/analytics.csv     — all sessions
 *   logs/full-<ts>/bids.csv          — successful bids only
 *   logs/full-<ts>/app-summary.csv   — per-app aggregated stats
 *   logs/full-<ts>/summary.log       — progress log
 *   logs/full-<ts>/sessions.db       — SQLite full data
 *   logs/full-<ts>/worker-logs/      — per-worker pino logs
 *
 * Usage:
 *   npx tsx scripts/launch-full.ts [rtb_endpoint]
 *   WORKERS=5 BIDFLOOR=0.7 npx tsx scripts/launch-full.ts
 */

// ENV MUST be set before ANY import
process.env.MAX_SESSIONS = '999999';
process.env.MAX_WORKERS = process.env.WORKERS || '5';
process.env.SESSIONS_PER_WORKER = process.env.PER_WORKER || '10';

import { mkdirSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';

// ── Config ──
const WORKERS = parseInt(process.env.MAX_WORKERS!, 10);
const PER_WORKER = parseInt(process.env.SESSIONS_PER_WORKER!, 10);
const CONCURRENCY = WORKERS * PER_WORKER;
const BIDFLOOR = parseFloat(process.env.BIDFLOOR || '0.7');
const RTB_ENDPOINT = process.argv[2] || 'http://rtb.pixelimpact.live/?pid=f6ea8478bf1a826ebf9a53f3dc58fb31';

const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = resolve(process.cwd(), 'logs', `full-${RUN_TS}`);

process.env.LOG_DIR = resolve(RUN_DIR, 'worker-logs');

// ── Now import project modules ──
import { initGeoDb } from '../src/shared/geo-lookup.js';
import { loadProxyPool, getProxyPoolSize } from '../src/emulation/proxy-pool.js';
import { loadFingerprints } from '../src/emulation/fingerprint-loader.js';
import { loadAppRotation } from '../src/emulation/app-rotation.js';
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
if (apps.length === 0) { console.error('ERROR: No apps in data/app_rotation.csv'); process.exit(1); }

const totalSessions = proxies.length * apps.length;

// ── Output setup ──
mkdirSync(RUN_DIR, { recursive: true });

// All sessions log
const analyticsCsv = createWriteStream(resolve(RUN_DIR, 'analytics.csv'));
analyticsCsv.write('session_id,timestamp,app_bundle,app_name,store_url,app_ver,os,vendor,model,proxy,proxy_index,carrier,user_agent,result,bid_price,events_fired,duration_ms,error\n');

// Successful bids only
const bidsCsv = createWriteStream(resolve(RUN_DIR, 'bids.csv'));
bidsCsv.write('session_id,timestamp,app_bundle,app_name,store_url,os,vendor,model,ip,carrier,bid_price,events_fired,duration_ms,geo_city,geo_region,geo_country,proxy_index\n');

// Progress log
const summaryStream = createWriteStream(resolve(RUN_DIR, 'summary.log'));

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

// ── Per-session tracker ──
interface SessionTracker {
  config: SessionConfig;
  proxyIdx: number;
  appIdx: number;
  bidPrice: number;
  events: Set<string>;
  error?: string;
  state: string;
}

const trackers = new Map<string, SessionTracker>();

// ── Per-app stats ──
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

// ── Build session queue: proxy × app ──
const queue: { config: SessionConfig; proxyIdx: number; appIdx: number }[] = [];

for (let p = 0; p < proxies.length; p++) {
  for (let a = 0; a < apps.length; a++) {
    const fpIdx = p % fingerprints.length;
    const device = { ...fingerprints[fpIdx] };
    if (device.geo) device.geo = { ...device.geo };
    if (device.fingerprint) device.fingerprint = {
      ...device.fingerprint,
      connection: { ...device.fingerprint.connection },
      screen: { ...device.fingerprint.screen },
      webgl: { ...device.fingerprint.webgl },
      fonts: [...device.fingerprint.fonts],
    };

    const app = apps[a];

    queue.push({
      proxyIdx: p,
      appIdx: a,
      config: {
        device,
        rtbEndpoint: RTB_ENDPOINT,
        contentUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
        appBundle: app.bundle,
        appName: app.name,
        appStoreUrl: app.storeurl,
        appVersion: app.ver,
        bidfloor: BIDFLOOR,
        proxy: proxies[p],
      },
    });
  }
}

// ── Feed queue ──
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
        appIdx: entry.appIdx,
        bidPrice: 0,
        events: new Set(),
        state: 'CREATED',
      });
      queueCursor++;
      fed++;
    } catch {
      break;
    }
  }
  if (fed > 0) {
    log(`  [feedQueue] fed ${fed} sessions, cursor ${queueCursor}/${queue.length}`);
  }
}

function writeAnalyticsCsv(sessionId: string, durationMs: number): void {
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
    (t.config.proxy || '').replace(/:[^:@]+@/, ':***@'),
    String(t.proxyIdx),
    csvEsc(t.config.device.carrier || ''),
    csvEsc(t.config.device.userAgent),
    result,
    t.bidPrice > 0 ? t.bidPrice.toFixed(4) : '',
    eventsStr,
    String(durationMs),
    csvEsc(t.error || ''),
  ].join(',') + '\n');
}

function writeBidCsv(sessionId: string, durationMs: number): void {
  const t = trackers.get(sessionId);
  if (!t || t.bidPrice <= 0) return;

  const eventsStr = [...t.events].join(';');

  bidsCsv.write([
    sessionId,
    new Date().toISOString(),
    t.config.appBundle,
    csvEsc(t.config.appName),
    t.config.appStoreUrl,
    t.config.device.os,
    t.config.device.vendor,
    t.config.device.model,
    t.config.device.ip,
    csvEsc(t.config.device.carrier || ''),
    t.bidPrice.toFixed(4),
    eventsStr,
    String(durationMs),
    t.config.device.geo?.city || '',
    t.config.device.geo?.region || '',
    t.config.device.geo?.country || '',
    String(t.proxyIdx),
  ].join(',') + '\n');
}

function checkDone(): void {
  if (completedCount >= totalSessions) {
    finishAndExit();
  }
}

// ── Main ──
let startTime: number;

async function main(): Promise<void> {
  startTime = Date.now();

  log('═══════════════════════════════════════════════════════════════');
  log('  CTV FULL LAUNCHER — Proxy × App (Full Playwright Cycle)');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Fingerprints:   ${fingerprints.length}`);
  log(`  Proxies:        ${proxies.length}`);
  log(`  Apps:           ${apps.length}`);
  log(`  Total sessions: ${totalSessions} (${proxies.length} × ${apps.length})`);
  log(`  Workers:        ${WORKERS} × ${PER_WORKER} = ${CONCURRENCY} concurrent`);
  log(`  Endpoint:       ${RTB_ENDPOINT}`);
  log(`  Bidfloor:       $${BIDFLOOR}`);
  log(`  Output:         ${RUN_DIR}`);
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

      const stats = getAppStats(config.appBundle, config.appName, config.appStoreUrl);
      stats.bids++;
      stats.totalRevenue += price;

      log(`  BID  $${price.toFixed(2)} | ${config.appBundle.padEnd(45)} | ${config.device.os} ${config.device.model} | ${config.device.ip}`);
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

      writeAnalyticsCsv(sessionId, durationMs);
      writeBidCsv(sessionId, durationMs);
      completedCount++;

      if (completedCount % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const totalBids = [...appStatsMap.values()].reduce((s, a) => s + a.bids, 0);
        const totalImpressions = [...appStatsMap.values()].reduce((s, a) => s + a.impressions, 0);
        const totalCompletes = [...appStatsMap.values()].reduce((s, a) => s + a.completes, 0);
        const pct = (completedCount / totalSessions * 100).toFixed(1);
        log(`  ── Progress: ${completedCount}/${totalSessions} (${pct}%) | Bids: ${totalBids} | Imp: ${totalImpressions} | Complete: ${totalCompletes} | ${elapsed}s ──`);
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

      writeAnalyticsCsv(sessionId, Date.now() - (scheduler.getSession(sessionId)?.createdAt || Date.now()));
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
  for (const entry of queue) {
    const stats = getAppStats(entry.config.appBundle, entry.config.appName, entry.config.appStoreUrl);
    stats.sessions++;
  }

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

  // ── App summary CSV ──
  const appSumPath = resolve(RUN_DIR, 'app-summary.csv');
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
  const totalClicks = allStats.reduce((s, a) => s + a.clicks, 0);
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
  log(`  Avg bid price:    $${totalBids > 0 ? (totalRevenue / totalBids).toFixed(4) : '0'}`);
  log(`  Total revenue:    $${totalRevenue.toFixed(4)}`);
  log(`  Impressions:      ${totalImpressions}`);
  log(`  Completions:      ${totalCompletes}`);
  log(`  Clicks:           ${totalClicks}`);
  log(`  Completion rate:  ${completionRate}%`);
  log(`  Duration:         ${elapsed}s`);
  log('───────────────────────────────────────────────────────────────');
  log('  TOP APPS BY BIDS:');

  for (const s of allStats.slice(0, 20)) {
    if (s.bids === 0) continue;
    const fr = (s.bids / s.sessions * 100).toFixed(0);
    const cr = s.impressions > 0 ? (s.completes / s.impressions * 100).toFixed(0) : '0';
    log(`    ${s.bundle.padEnd(50)} ${String(s.bids).padStart(4)} bids | ${fr}% fill | $${(s.totalRevenue / s.bids).toFixed(2)} avg | ${cr}% complete`);
  }

  log('───────────────────────────────────────────────────────────────');
  log(`  All sessions:   ${resolve(RUN_DIR, 'analytics.csv')}`);
  log(`  Bids only:      ${resolve(RUN_DIR, 'bids.csv')}`);
  log(`  App summary:    ${appSumPath}`);
  log(`  Sessions DB:    ${resolve(RUN_DIR, 'sessions.db')}`);
  log('═══════════════════════════════════════════════════════════════');

  analyticsCsv.end();
  bidsCsv.end();
  summaryStream.end();

  scheduler.shutdown();
  workerManager.shutdown().then(() => process.exit(0));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
