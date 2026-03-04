/* eslint-disable @typescript-eslint/no-explicit-any */
declare var window: any;

import { resolve } from 'path';
import { createLogger } from '../shared/logger.js';
import { BrowserPool } from './browser-pool.js';
import { SessionStateMachine } from './session.js';
import { setupNetworkInterceptor } from './network-interceptor.js';
import { sendBidRequest, extractVastFromBidResponse } from '../engines/rtb-adapter.js';
import { resolveVast } from '../engines/vast-resolver.js';
import { buildTimeline, AdTimelineScheduler } from '../engines/ad-timeline.js';
import { TrackingEngine } from '../engines/tracking-engine.js';
import { SessionState } from '../shared/types.js';
import type { MasterToWorkerMessage, WorkerToMasterMessage, NetworkLogEntry } from '../shared/types.js';

const logger = createLogger('worker');

const browserPool = new BrowserPool();
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

    setupNetworkInterceptor(page, sessionId, (entry: NetworkLogEntry) => {
      logger.info(entry, 'network');
    });

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

    await page.waitForFunction(
      () => (window as any).__adCompleted === true,
      { timeout: (creative.duration + 10) * 1000 },
    );

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
  switch (msg.type) {
    case 'create-session':
      await createSession(msg.payload.sessionId, msg);
      break;
    case 'stop-session':
      await stopSession(msg.sessionId);
      break;
  }
});

(async () => {
  await browserPool.init();
  logger.info({ pid: process.pid }, 'Worker started');
  reportStats();
})();

process.on('SIGTERM', async () => {
  logger.info('Worker shutting down');
  await browserPool.destroy();
  process.exit(0);
});
