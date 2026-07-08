/**
 * Folder-subscription domain logic — the single home for folder semantics
 * and the Graph subscription recipe, shared by the subscribe route, the
 * renewal worker, and the webhook verifier so none of them can drift.
 */
import { createHmac } from 'crypto';
import { config } from './config.js';
import { withConnection } from './connectionCall.js';
import { safeEqual } from './crypto.js';
import type { Db } from './db.js';
import { ValidationError } from './errors.js';
import { logError, logInfo } from './logger.js';
import type { MsGraphProvider } from './providers/msgraph/types.js';

/**
 * The one registry of folder semantics: which folders can be subscribed AND
 * which normalized event each produces. Adding a folder here is the complete
 * change — the subscribe route validates against the keys and the webhook
 * handler maps through the values.
 */
export const FOLDER_EVENTS = {
  inbox: 'email.received',
  sentitems: 'email.sent',
} as const;

export type SubscribableFolder = keyof typeof FOLDER_EVENTS;

/** Type guard for the subscribable-folder allow-list. */
export function isSubscribableFolder(folder: string): folder is SubscribableFolder {
  return folder in FOLDER_EVENTS;
}

/**
 * Derive the clientState HMAC for a (connection, folder) subscription —
 * never a raw id; Graph echoes it on every notification and the webhook
 * handler verifies before any DB-driven work.
 */
export function hmacClientState(connectionId: string, folder: string): string {
  if (!config.webhookClientStateSecret) {
    throw new Error('WEBHOOK_CLIENT_STATE_SECRET is not configured');
  }
  return createHmac('sha256', config.webhookClientStateSecret).update(`${connectionId}:${folder}`).digest('hex');
}

/** Constant-time clientState verification. */
export function verifyClientState(clientState: string, connectionId: string, folder: string): boolean {
  return safeEqual(clientState, hmacClientState(connectionId, folder));
}

/**
 * Create (or re-create) the Graph subscription for a (connection, folder)
 * and persist the row. When a row already exists — a re-subscribe or a
 * failed-renewal re-register — the OLD Graph subscription is deleted
 * best-effort first: overwriting the id without teardown would orphan a live
 * subscription that keeps notifying (and counts against Microsoft's
 * per-mailbox subscription quota).
 */
export async function registerFolderSubscription(
  db: Db,
  provider: MsGraphProvider,
  connectionId: string,
  folder: SubscribableFolder,
): Promise<{ folder: string; expiresAt: Date }> {
  if (!config.webhookBaseUrl) {
    throw new ValidationError('server', 'WEBHOOK_BASE_URL is not configured on this service');
  }

  const existing = await db.subscription.findUnique({
    where: { connectionId_folder: { connectionId, folder } },
  });
  if (existing) {
    try {
      await withConnection(db, connectionId, undefined, (token) =>
        provider.deleteSubscription(token, existing.graphSubscriptionId),
      );
    } catch (err) {
      // Best-effort: the old subscription may already be gone on Graph's side.
      logError(`failed to delete superseded Graph subscription ${existing.graphSubscriptionId} (continuing)`, err);
    }
  }

  const sub = await withConnection(db, connectionId, undefined, (token) =>
    provider.createSubscription(
      token,
      `${config.webhookBaseUrl}/webhooks/msgraph`,
      hmacClientState(connectionId, folder),
      `/me/mailFolders/${folder}/messages`,
    ),
  );

  const row = await db.subscription.upsert({
    where: { connectionId_folder: { connectionId, folder } },
    create: { connectionId, folder, graphSubscriptionId: sub.id, expiresAt: new Date(sub.expirationDateTime) },
    update: { graphSubscriptionId: sub.id, expiresAt: new Date(sub.expirationDateTime) },
  });
  logInfo(`subscription registered: connection ${connectionId} ${folder} (expires ${sub.expirationDateTime})`);
  return { folder: row.folder, expiresAt: row.expiresAt };
}
