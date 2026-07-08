/**
 * Public webhook ingress — the ONLY publicly exposed route (Traefik routes
 * just <WEBHOOK_BASE_URL>/webhooks/msgraph here; the operations plane stays
 * internal on the Docker network).
 *
 * Microsoft Graph change-notification contract:
 *  - Handshake: Graph POSTs with `?validationToken=...` and expects the raw
 *    token echoed as text/plain 200 within 10s.
 *  - Notifications: `{ value: [{ subscriptionId, clientState, resource, ... }] }`,
 *    delivered at-least-once. Must 202 fast; processing is async.
 *
 * Hardening vs the PR #51 draft this salvages:
 *  - clientState is an HMAC of (connectionId, folder) under
 *    WEBHOOK_CLIENT_STATE_SECRET — not the raw connection id — and is
 *    verified against the Subscription row before any DB-driven work.
 *  - Redeliveries are deduped via ProcessedNotification.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { decryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import type { EmailEvent, EventForwarder } from '../events/forwarder.js';
import { logError, logInfo } from '../logger.js';
import { normalizeMessage } from '../ops/index.js';
import type { MsGraphProvider } from '../providers/msgraph/types.js';

/** Derive the clientState HMAC for a (connection, folder) subscription. */
export function hmacClientState(connectionId: string, folder: string): string {
  if (!config.webhookClientStateSecret) {
    throw new Error('WEBHOOK_CLIENT_STATE_SECRET is not configured');
  }
  return createHmac('sha256', config.webhookClientStateSecret).update(`${connectionId}:${folder}`).digest('hex');
}

/** Constant-time hex comparison. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resource?: string;
}

/** Extract the Graph message id from a notification resource path (`Users/{id}/Messages/{messageId}`). */
function messageIdFromResource(resource: string | undefined): string | null {
  const parts = resource?.split('/') ?? [];
  const id = parts[parts.length - 1];
  return id && id.length > 0 ? id : null;
}

/**
 * Process one notification: verify, dedupe, fetch, normalize, forward.
 * Failures are logged, never thrown — Graph retries drop into the dedupe.
 */
async function processNotification(
  db: Db,
  provider: MsGraphProvider,
  forward: EventForwarder,
  notification: GraphNotification,
): Promise<void> {
  const { subscriptionId, clientState } = notification;
  if (!subscriptionId || !clientState) return;

  const subscription = await db.subscription.findUnique({
    where: { graphSubscriptionId: subscriptionId },
    include: { connection: true },
  });
  if (!subscription || subscription.connection.deletedAt) return;

  // Authenticity: Graph echoes the clientState we set at subscribe time.
  const expected = hmacClientState(subscription.connectionId, subscription.folder);
  if (!safeEqualHex(clientState, expected)) {
    logError(`webhook clientState mismatch for subscription ${subscriptionId} — dropping`);
    return;
  }

  const messageId = messageIdFromResource(notification.resource);
  if (!messageId) return;

  // At-least-once delivery → process each (subscription, message) once.
  const dedupeId = `${subscriptionId}:${messageId}`;
  try {
    await db.processedNotification.create({ data: { id: dedupeId } });
  } catch {
    return; // already processed (unique-violation) — a Graph redelivery
  }

  try {
    const refreshToken = decryptToken(subscription.connection.refreshTokenEnc);
    const { data: message } = await provider.getMessage(refreshToken, messageId);
    const event: EmailEvent = {
      event: subscription.folder === 'sentitems' ? 'email.sent' : 'email.received',
      connectionId: subscription.connectionId,
      folder: subscription.folder,
      message: normalizeMessage(message),
    };
    logInfo(`${event.event} in ${subscription.connection.mailboxEmail}: "${event.message.subject ?? ''}"`);
    await forward(event);
  } catch (err) {
    logError(`failed to process notification ${dedupeId}`, err);
  }
}

/** Build the /webhooks router over injected db + provider + forwarder. */
export function webhooksRouter(db: Db, provider: MsGraphProvider, forward: EventForwarder): Router {
  const router = Router();

  router.post('/msgraph', (req, res) => {
    // Subscription-creation handshake: echo the raw token as text/plain.
    const validationToken = req.query.validationToken;
    if (typeof validationToken === 'string') {
      res.status(200).type('text/plain').send(validationToken);
      return;
    }

    // 202 immediately (Graph requires a fast ack); process async.
    const notifications: GraphNotification[] = Array.isArray(req.body?.value) ? req.body.value : [];
    res.status(202).json({ accepted: notifications.length });

    for (const notification of notifications) {
      processNotification(db, provider, forward, notification).catch((err) =>
        logError('notification processing crashed', err),
      );
    }
  });

  return router;
}
