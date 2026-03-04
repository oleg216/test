import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createLogger } from '../shared/logger.js';
import { PORT } from '../shared/constants.js';
import { SessionConfigSchema, BatchSessionSchema } from '../shared/schemas.js';
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

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/metrics', async (request, reply) => {
    const metricsText = await metrics.getMetrics();
    const contentType = await metrics.getContentType();
    reply.type(contentType).send(metricsText);
  });

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

  await workerManager.start();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT }, 'CTV Emulator API started');

  const shutdown = async () => {
    logger.info('Shutting down...');
    await workerManager.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
