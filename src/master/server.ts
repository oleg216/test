import { readFileSync } from 'fs';
import { resolve } from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createLogger } from '../shared/logger.js';
import { PORT, DEFAULT_PROXY } from '../shared/constants.js';
import { initGeoDb } from '../shared/geo-lookup.js';
import { SessionConfigSchema, BatchSessionSchema } from '../shared/schemas.js';
import { MetricsRegistry } from './metrics.js';
import { WorkerManager } from './worker-manager.js';
import { SessionScheduler } from './scheduler.js';
import { generateDeviceProfile } from '../emulation/device-profiles.js';
import { loadUserPool, getRandomPoolUser, buildDeviceFromPoolUser, getPoolSize } from '../emulation/user-pool.js';
import { loadProxyPool, getNextProxy, getProxyPoolSize } from '../emulation/proxy-pool.js';
import { SessionStore } from './session-store.js';
import type { SessionConfig } from '../shared/types.js';

const logger = createLogger('server');

// Load dashboard HTML once at startup
let dashboardHtml = '';
try {
  dashboardHtml = readFileSync(resolve(process.cwd(), 'public', 'dashboard.html'), 'utf-8');
} catch {
  logger.warn('dashboard.html not found in public/');
}

// Load user pool and proxy pool at startup
loadUserPool();
loadProxyPool();

export async function startMaster(): Promise<void> {
  await initGeoDb();
  const metrics = new MetricsRegistry();
  const store = new SessionStore();
  const workerManager = new WorkerManager((msg) => {
    scheduler.handleWorkerMessage(msg);
  });
  const scheduler = new SessionScheduler(workerManager, metrics, store);

  const app = Fastify({ logger: false });
  await app.register(cors);

  // --- Health & Metrics ---
  app.get('/health', async (request, reply) => {
    const workers = workerManager.getWorkersInfo();
    const runningWorkers = workers.filter(w => w.status === 'running').length;
    if (runningWorkers === 0) {
      return reply.status(503).send({
        status: 'degraded',
        uptime: process.uptime(),
        workers: { total: workers.length, running: 0 },
      });
    }
    return {
      status: 'ok',
      uptime: process.uptime(),
      workers: { total: workers.length, running: runningWorkers },
    };
  });

  app.get('/metrics', async (request, reply) => {
    const metricsText = await metrics.getMetrics();
    const contentType = await metrics.getContentType();
    reply.type(contentType).send(metricsText);
  });

  // --- Dashboard ---
  app.get('/dashboard', async (request, reply) => {
    reply.type('text/html').send(dashboardHtml);
  });

  // --- Stats API (JSON for dashboard) ---
  app.get('/api/stats', async () => {
    return metrics.getStats();
  });

  app.get('/api/stats/sessions', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    return { sessions: metrics.getRecentSessions(limit) };
  });

  // --- Session Management ---
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

  app.get('/api/sessions', async () => {
    const sessions = scheduler.getAllSessions();
    return { sessions, total: sessions.length };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = scheduler.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return session;
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const stopped = scheduler.stopSession(request.params.id);
    if (!stopped) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { status: 'stopping', sessionId: request.params.id };
  });

  app.get('/api/workers', async () => {
    return { workers: workerManager.getWorkersInfo() };
  });

  // --- Traffic Launch API ---
  // Quick launch: auto-generate device profiles and start sessions
  app.post('/api/launch', async (request, reply) => {
    const body = request.body as {
      count?: number;
      rtbEndpoint: string;
      contentUrl?: string;
      appBundle?: string;
      appName?: string;
      appStoreUrl?: string;
      appVersion?: string;
      appId?: string;
      publisherId?: string;
      publisherName?: string;
      bidfloor?: number;
      bcat?: string[];
      os?: 'AndroidTV' | 'Tizen' | 'WebOS';
      usePool?: boolean;
      proxy?: string;
    };

    if (!body.rtbEndpoint) {
      return reply.status(400).send({ error: 'rtbEndpoint is required' });
    }

    if (body.usePool && getPoolSize() === 0) {
      return reply.status(400).send({ error: 'User pool is empty. Place users.csv in data/' });
    }

    const count = Math.min(body.count || 1, 50);
    const osList: Array<'AndroidTV' | 'Tizen' | 'WebOS'> = body.os
      ? [body.os]
      : ['AndroidTV', 'Tizen', 'WebOS'];

    const configs: SessionConfig[] = [];
    for (let i = 0; i < count; i++) {
      const os = osList[i % osList.length];
      let device;
      if (body.usePool) {
        const poolUser = getRandomPoolUser()!;
        device = buildDeviceFromPoolUser(poolUser, os);
      } else {
        device = generateDeviceProfile(os);
      }

      let proxy: string | undefined;
      if (body.proxy === 'none') {
        proxy = undefined;
      } else {
        proxy = body.proxy || DEFAULT_PROXY || (getProxyPoolSize() > 0 ? getNextProxy()! : undefined);
      }

      configs.push({
        device,
        rtbEndpoint: body.rtbEndpoint,
        contentUrl: body.contentUrl || 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
        appBundle: body.appBundle || 'tv.pluto.android',
        appName: body.appName || 'Pluto TV - Live TV & Movies',
        appStoreUrl: body.appStoreUrl || 'https://play.google.com/store/apps/details?id=tv.pluto.android',
        appVersion: body.appVersion,
        appId: body.appId,
        publisherId: body.publisherId,
        publisherName: body.publisherName,
        bidfloor: body.bidfloor ?? 2.0,
        bcat: body.bcat,
        proxy,
      });
    }

    try {
      const sessions = scheduler.createBatch(configs);
      return reply.status(201).send({
        launched: sessions.length,
        sessions: sessions.map(s => ({ id: s.id, device: s.config.device.os, model: s.config.device.model })),
      });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // --- User Pool API ---
  app.get('/api/pool', async () => {
    return { size: getPoolSize() };
  });

  app.post('/api/pool/reload', async () => {
    const users = loadUserPool();
    return { loaded: users.length };
  });

  // --- History API (from SQLite) ---
  app.get('/api/history/sessions', async (request) => {
    const query = request.query as { limit?: string; offset?: string; date?: string };
    if (query.date) {
      return { sessions: store.getSessionsByDate(query.date) };
    }
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = parseInt(query.offset || '0', 10);
    return { sessions: store.getRecentSessions(limit, offset), total: store.getTotalCount() };
  });

  app.get('/api/history/daily', async (request) => {
    const query = request.query as { days?: string };
    const days = Math.min(parseInt(query.days || '7', 10), 90);
    return { stats: store.getDailyStats(days) };
  });

  app.get('/api/history/stats', async () => {
    return store.getAggregateStats();
  });

  app.get('/api/history/errors', async () => {
    return { errors: store.getErrorBreakdown() };
  });

  // --- Proxy Pool API ---
  app.get('/api/proxies', async () => {
    return { size: getProxyPoolSize() };
  });

  app.post('/api/proxies/reload', async () => {
    const proxies = loadProxyPool();
    return { loaded: proxies.length };
  });

  await workerManager.start();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT }, 'CTV Emulator API started');

  let shutdownInProgress = false;
  const shutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info('Shutting down...');
    scheduler.shutdown();
    await workerManager.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
