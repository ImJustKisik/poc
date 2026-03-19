// ============================================================
// PCM Server — Entry Point
// ============================================================

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import jwt from '@fastify/jwt';
import { registerAuthRoutes, stopAuthChallengeCleanup } from './auth/index.js';
import { registerApiRoutes } from './routes/api.js';
import { registerFileRoutes } from './routes/files.js';
import { wsHub } from './ws/hub.js';
import { sfuService } from './ws/sfu.js';
import { initDb } from './db/index.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireProductionEnv, serverConfig } from './config.js';


// Extend Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: string; publicKey: string; type?: string };
    user: { userId: string; publicKey: string; type?: string };
  }
}

export async function buildApp() {
  requireProductionEnv();
  const app = Fastify({
    logger: {
      level: serverConfig.logLevel,
      ...(serverConfig.env === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          }
        : {}),
    },
  });

  // ---- Plugins ----
  await app.register(cors, { origin: serverConfig.corsOrigin });
  await app.register(multipart, { limits: { fileSize: serverConfig.maxFileSize } });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(jwt, { secret: serverConfig.jwtSecret });
  await app.register(websocket);

  // ---- Auth decorator ----
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
    }
  });

  // ---- HTTP Routes ----
  registerAuthRoutes(app);
  registerApiRoutes(app);
  registerFileRoutes(app);

  // ---- Health check ----
  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // ---- WebSocket ----
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, request) => {
      // Expect token in query string: /ws?token=xxx
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        socket.close(4001, 'No token provided');
        return;
      }

      try {
        const payload = app.jwt.verify(token) as { userId: string; publicKey: string };
        wsHub.addClient(payload.userId, payload.publicKey, socket);

        app.log.info(`WebSocket connected: ${payload.userId}`);
      } catch {
        socket.close(4001, 'Invalid token');
      }
    });
  });

  return app;
}

async function main() {
  let app;
  try {
    app = await buildApp();
    await initDb();
    await sfuService.init();
    wsHub.start();

    app.addHook('onClose', () => {
      wsHub.stop();
      stopAuthChallengeCleanup();
    });

    await app.listen({ port: serverConfig.port, host: serverConfig.host });
    app.log.info(`PCM Server running on ${serverConfig.host}:${serverConfig.port}`);
  } catch (err) {
    app?.log.error(err);
    stopAuthChallengeCleanup();
    process.exit(1);
  }
}

const isEntrypoint = process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url;

if (isEntrypoint) {
  main();
}
