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
 *  - clientState is an HMAC of (connectionId, folder) — never a raw id —
 *    verified against the Subscription row before any DB-driven work.
 *  - Redeliveries are deduped via ProcessedNotification, and the dedupe row
 *    is RELEASED when processing fails after the insert — otherwise a
 *    transient failure would swallow Graph's redelivery and lose the event
 *    permanently (the 202 was already sent; redelivery is the only retry).
 */
import { Router } from 'express';
import { withConnection } from '../connectionCall.js';
import type { Db } from '../db.js';
import type { EmailEvent, EventForwarder } from '../events/forwarder.js';
import { logError, logInfo } from '../logger.js';
import { normalizeMessage } from '../ops/index.js';
import type { MsGraphProvider } from '../providers/msgraph/types.js';
import { FOLDER_EVENTS, isSubscribableFolder, verifyClientState } from '../subscriptions.js';

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

/** Prisma unique-violation check (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * Process one notification: verify, dedupe, fetch, normalize, forward.
 * Failures are logged, never thrown to Express — but a failure AFTER the
 * dedupe insert releases the row so Graph's redelivery gets processed.
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
  if (!verifyClientState(clientState, subscription.connectionId, subscription.folder)) {
    logError(`webhook clientState mismatch for subscription ${subscriptionId} — dropping`);
    return;
  }

  const messageId = messageIdFromResource(notification.resource);
  if (!messageId) return;

  // At-least-once delivery → process each (subscription, message) once.
  // Only a unique violation means "already processed"; any other DB error
  // propagates (no row was written, so redelivery will retry).
  const dedupeId = `${subscriptionId}:${messageId}`;
  try {
    await db.processedNotification.create({ data: { id: dedupeId } });
  } catch (err) {
    if (isUniqueViolation(err)) return; // a Graph redelivery
    throw err;
  }

  try {
    const message = await withConnection(db, subscription.connectionId, { resource: 'message', id: messageId }, (token) =>
      provider.getMessage(token, messageId),
    );
    const event: EmailEvent = {
      event: isSubscribableFolder(subscription.folder) ? FOLDER_EVENTS[subscription.folder] : 'email.received',
      connectionId: subscription.connectionId,
      folder: subscription.folder,
      message: normalizeMessage(message),
    };
    logInfo(`${event.event} in ${subscription.connection.mailboxEmail}: "${event.message.subject ?? ''}"`);
    await forward(event);
  } catch (err) {
    logError(`failed to process notification ${dedupeId} — releasing dedupe for redelivery`, err);
    await db.processedNotification.delete({ where: { id: dedupeId } }).catch(() => {});
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
