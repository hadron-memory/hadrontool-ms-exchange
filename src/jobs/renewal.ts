/**
 * Subscription renewal worker (salvaged from PR #51's webhook lifecycle,
 * pointed at this tool's own tables and genericized to folder-keyed rows).
 *
 * Graph subscriptions live ≤3 days. Every RENEWAL_INTERVAL the worker renews
 * rows expiring inside the lookahead window; when a renewal fails (Graph
 * deleted/expired the subscription) it re-registers from scratch. Connections
 * in status ERROR are skipped — they need the user to reconnect first.
 */
import { config } from '../config.js';
import { decryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import { logError, logInfo } from '../logger.js';
import type { MsGraphProvider } from '../providers/msgraph/types.js';
import { hmacClientState } from '../routes/webhooks.js';

const RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const LOOKAHEAD_MS = 12 * 60 * 60 * 1000; // renew what expires within 12h

/** Renew (or re-register) every subscription expiring inside the lookahead window. */
export async function renewExpiringSubscriptions(db: Db, provider: MsGraphProvider): Promise<void> {
  const cutoff = new Date(Date.now() + LOOKAHEAD_MS);
  const expiring = await db.subscription.findMany({
    where: { expiresAt: { lt: cutoff } },
    include: { connection: true },
  });
  if (expiring.length === 0) return;
  logInfo(`renewing ${expiring.length} expiring subscription(s)`);

  for (const sub of expiring) {
    if (sub.connection.deletedAt || sub.connection.status === 'ERROR') continue;
    const refreshToken = decryptToken(sub.connection.refreshTokenEnc);
    try {
      const { data: renewed } = await provider.renewSubscription(refreshToken, sub.graphSubscriptionId);
      await db.subscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(renewed.expirationDateTime) },
      });
      logInfo(`renewed ${sub.folder} subscription for ${sub.connection.mailboxEmail}`);
    } catch (err) {
      logError(`renewal failed for ${sub.connection.mailboxEmail} ${sub.folder}; re-registering`, err);
      try {
        if (!config.webhookBaseUrl) throw new Error('WEBHOOK_BASE_URL is not configured');
        const { data: fresh } = await provider.createSubscription(
          refreshToken,
          `${config.webhookBaseUrl}/webhooks/msgraph`,
          hmacClientState(sub.connectionId, sub.folder),
          `/me/mailFolders/${sub.folder}/messages`,
        );
        await db.subscription.update({
          where: { id: sub.id },
          data: { graphSubscriptionId: fresh.id, expiresAt: new Date(fresh.expirationDateTime) },
        });
        logInfo(`re-registered ${sub.folder} subscription for ${sub.connection.mailboxEmail}`);
      } catch (reErr) {
        logError(`re-registration also failed for ${sub.connection.mailboxEmail} ${sub.folder}`, reErr);
      }
    }
  }
}

/** Start the renewal timer: one pass at boot, then every RENEWAL_INTERVAL. Returns the timer so tests/shutdown can clear it. */
export function startRenewalWorker(db: Db, provider: MsGraphProvider): NodeJS.Timeout {
  renewExpiringSubscriptions(db, provider).catch((err) => logError('initial renewal pass failed', err));
  const timer = setInterval(() => {
    renewExpiringSubscriptions(db, provider).catch((err) => logError('renewal cycle failed', err));
  }, RENEWAL_INTERVAL_MS);
  timer.unref();
  return timer;
}
