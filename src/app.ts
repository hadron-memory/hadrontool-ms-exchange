/**
 * Express app factory. Dependencies (db, Graph provider, event forwarder)
 * are injected so tests run the real HTTP surface over fakes.
 *
 * Route map:
 *   GET  /healthz                          liveness (public-safe, no secrets)
 *   GET  /readyz                           readiness (DB reachable)
 *   GET  /info                             capabilities (bearer-gated)
 *   POST /ops/<operation>                  operations plane   (bearer-gated, internal)
 *   *    /connections…                     connection plane   (bearer-gated, internal)
 *   POST /webhooks/msgraph                 Graph notifications (PUBLIC — Traefik routes only this)
 */
import express, { type Express } from 'express';
import { config } from './config.js';
import type { Db } from './db.js';
import type { EventForwarder } from './events/forwarder.js';
import { requireToolToken } from './middleware/auth.js';
import { OPERATIONS } from './ops/index.js';
import type { MsGraphProvider } from './providers/msgraph/types.js';
import { connectionsRouter } from './routes/connections.js';
import { opsRouter } from './routes/ops.js';
import { webhooksRouter } from './routes/webhooks.js';

/** Package version, surfaced on /info. */
const VERSION = process.env.npm_package_version ?? '0.1.0';

/** Build the app over injected dependencies. */
export function createApp(db: Db, provider: MsGraphProvider, forward: EventForwarder): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.maxBodySize }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.get('/info', requireToolToken, (_req, res) => {
    res.json({
      name: 'hadrontool-ms-exchange',
      version: VERSION,
      provider: 'ms-exchange',
      operations: Object.keys(OPERATIONS),
      events: ['email.received', 'email.sent'],
    });
  });

  app.use('/ops', requireToolToken, opsRouter(db, provider));
  app.use('/connections', requireToolToken, connectionsRouter(db, provider));
  app.use('/webhooks', webhooksRouter(db, provider, forward));

  return app;
}
