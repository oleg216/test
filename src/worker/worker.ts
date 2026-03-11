/* eslint-disable @typescript-eslint/no-explicit-any */
declare var window: any;

import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import { BrowserPool } from './browser-pool.js';
import { SessionStateMachine } from './session.js';
import { setupNetworkInterceptor } from './network-interceptor.js';
import { sendBidRequest, extractBidResult, fireWinNotice, fireBillingNotice } from '../engines/rtb-adapter.js';
import { initGeoDb } from '../shared/geo-lookup.js';
import { resolveVast } from '../engines/vast-resolver.js';
import { createProxyFetch } from '../shared/proxy-fetch.js';
import { buildTimeline, AdTimelineScheduler } from '../engines/ad-timeline.js';
import { TrackingEngine } from '../engines/tracking-engine.js';
import { SessionState } from '../shared/types.js';
import type { MasterToWorkerMessage, WorkerToMasterMessage, NetworkLogEntry, BidResult } from '../shared/types.js';
import { PixalateChecker } from '../engines/pixalate-checker.js';

const logger = createLogger('worker');

const browserPool = new BrowserPool();
const pixalate = new PixalateChecker();
const sessions = new Map<string, SessionStateMachine>();
const timelines = new Map<string, AdTimelineScheduler>();
const trackingEngines = new Map<string, TrackingEngine>();
let totalProcessed = 0;

const ERROR_STATES_SET = new Set([
  SessionState.ERROR_VAST, SessionState.ERROR_MEDIA,
  SessionState.ERROR_NETWORK, SessionState.ERROR_TIMEOUT,
  SessionState.STOPPING, SessionState.STOPPED,
]);

function sendToMaster(msg: WorkerToMasterMessage): void {
  try {
    process.send?.(msg);
  } catch {
    logger.error({ type: msg.type }, 'IPC send failed — channel closed');
  }
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

    setupNetworkInterceptor(page, sessionId, (entry: NetworkLogEntry) => {
      logger.info(entry, 'network');
    });

    const playerPath = resolve(process.cwd(), 'public', 'player.html');
    await page.goto(`file://${playerPath}`);
    await page.waitForFunction(() => (window as any).__playerReady === true, { timeout: 10000 });

    // Pre-RTB fraud check (non-blocking — log only)
    if (pixalate.enabled) {
      const fraudCheck = await pixalate.checkSession({
        ip: config.payload.device.ip,
        ua: config.payload.device.userAgent,
        deviceId: config.payload.device.ifa,
      });
      logger.info({ sessionId, probability: fraudCheck.probability, pass: fraudCheck.pass }, 'Pixalate pre-bid check');
      if (!fraudCheck.pass) {
        logger.warn({ sessionId, probability: fraudCheck.probability }, 'Pixalate fraud probability above threshold — proceeding anyway');
      }
    }

    // RTB REQUESTING
    sm.transition(SessionState.RTB_REQUESTING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    let bidResult: BidResult;
    try {
      const rtbStart = Date.now();
      const bidResponse = await sendBidRequest(config.payload);
      const rtbLatency = Date.now() - rtbStart;
      const result = extractBidResult(bidResponse);
      if (!result) {
        // Report no-bid + latency to master
        sendToMaster({ type: 'session-update', sessionId, state: sm.state, metrics: { no_bid: 1, rtb_latency_ms: rtbLatency } });
        throw new Error('No VAST in bid response');
      }
      bidResult = result;
      // Report bid price + latency to master
      sendToMaster({ type: 'session-update', sessionId, state: sm.state, metrics: {
        bid_price: bidResult.auctionData.price,
        rtb_latency_ms: rtbLatency,
      } });
    } catch (err) {
      if (sm.canRetry()) {
        sm.incrementRetry();
        logger.warn({ sessionId, retry: sm.retryCount }, 'RTB failed, retrying');
        const rtbStart = Date.now();
        const bidResponse = await sendBidRequest(config.payload);
        const rtbLatency = Date.now() - rtbStart;
        const result = extractBidResult(bidResponse);
        if (!result) {
          sendToMaster({ type: 'session-update', sessionId, state: sm.state, metrics: { no_bid: 1, rtb_latency_ms: rtbLatency } });
          throw new Error('No VAST in bid response after retry');
        }
        bidResult = result;
        sendToMaster({ type: 'session-update', sessionId, state: sm.state, metrics: {
          bid_price: bidResult.auctionData.price,
          rtb_latency_ms: rtbLatency,
        } });
      } else {
        sm.setError(SessionState.ERROR_NETWORK, (err as Error).message);
        sendToMaster({ type: 'session-error', sessionId, error: sm.error!, state: sm.state });
        return;
      }
    }

    // Build proxy-aware fetch for IP-critical requests (VAST, tracking, win/billing)
    // Video media loads directly in Chromium without proxy to save proxy traffic
    const proxyFetchFn = createProxyFetch(config.payload.proxy);

    // Fire win notification (nurl) — fire-and-forget, don't block session
    if (bidResult.nurl) {
      fireWinNotice(bidResult.nurl, bidResult.auctionData, proxyFetchFn).catch(() => {});
    }

    // VAST RESOLVING
    sm.transition(SessionState.VAST_RESOLVING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    const vastFetchFn = proxyFetchFn
      ? async (url: string, signal?: AbortSignal) => {
          const res = await proxyFetchFn(url, { signal });
          if (!res.ok) throw new Error(`VAST fetch failed: ${res.status}`);
          return res.text();
        }
      : undefined;
    let creative;
    try {
      creative = await resolveVast(bidResult.vastXml, vastFetchFn);
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
        } catch (retryErr) {
          sm.setError(SessionState.ERROR_MEDIA, (retryErr as Error).message);
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

    const trackingFetchFn = proxyFetchFn
      ? (url: string, init?: RequestInit) => proxyFetchFn(url, init).then(r => ({ ok: r.ok }))
      : undefined;
    const trackingEngine = new TrackingEngine(sessionId, trackingFetchFn);
    trackingEngines.set(sessionId, trackingEngine);

    const timeline = buildTimeline(creative.duration);
    const hasComplete = timeline.some(e => e.event === 'complete');
    const lastEntryMs = timeline[timeline.length - 1].timeMs;
    const scheduler = new AdTimelineScheduler();
    timelines.set(sessionId, scheduler);

    scheduler.schedule(timeline, async (event) => {
      if (event === 'click') {
        // Simulate DOM click event on the ad video
        await page.evaluate(() => (window as any).__simulateClick());
        // Fire click tracking pixels
        if (creative.clickTrackingUrls.length > 0) {
          await trackingEngine.fireEvent('click', creative.clickTrackingUrls);
        }
        // Simulate landing page open (GET on ClickThrough URL)
        if (creative.clickThroughUrl) {
          try {
            const doFetch = proxyFetchFn || fetch;
            await doFetch(creative.clickThroughUrl, { method: 'GET', redirect: 'follow' });
          } catch {
            logger.warn({ sessionId, url: creative.clickThroughUrl }, 'ClickThrough fetch failed');
          }
        }
      } else {
        const urls = event === 'impression'
          ? creative.impressionUrls
          : creative.trackingEvents.get(event) || [];
        await trackingEngine.fireEvent(event, urls);

        // Fire billing notice (burl) after impression — confirms ad was rendered
        if (event === 'impression' && bidResult.burl) {
          fireBillingNotice(bidResult.burl, bidResult.auctionData, proxyFetchFn).catch(() => {});
        }
      }
      sendToMaster({ type: 'session-update', sessionId, state: sm.state, metrics: { [`tracking_${event}`]: 1 } });
    });

    if (hasComplete) {
      // Full view — wait for video to end
      await page.waitForFunction(
        () => (window as any).__adCompleted === true,
        { timeout: (creative.duration + 10) * 1000 },
      );
    } else {
      // Simulated abandon — wait until last tracked event fires + small delay, then skip
      await new Promise(r => setTimeout(r, lastEntryMs + 2000));
    }

    // CONTENT PLAYING
    sm.transition(SessionState.CONTENT_PLAYING);
    sendToMaster({ type: 'session-update', sessionId, state: sm.state });

    await page.evaluate((url: string) => (window as any).__loadContent(url), config.payload.contentUrl);
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

process.on('message', async (msg: MasterToWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'create-session':
        await createSession(msg.payload.sessionId, msg);
        break;
      case 'stop-session':
        await stopSession(msg.sessionId);
        break;
    }
  } catch (err) {
    logger.error({ err }, 'Unhandled error in message handler');
  }
});

(async () => {
  await Promise.all([browserPool.init(), initGeoDb()]);
  logger.info({ pid: process.pid }, 'Worker started');
  sendToMaster({ type: 'worker-ready' });
  reportStats();
})();

process.on('SIGTERM', async () => {
  logger.info('Worker shutting down');
  await browserPool.destroy();
  process.exit(0);
});
