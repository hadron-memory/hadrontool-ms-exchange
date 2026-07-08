/**
 * Subscription renewal worker (salvaged from PR #51's webhook lifecycle,
 * pointed at this tool's own tables and genericized to folder-keyed rows).
 *
 * Graph subscriptions live ≤3 days. Every RENEWAL_INTERVAL the worker renews
 * rows expiring inside the lookahead window; when a renewal fails because
 * Graph dropped the subscription it re-registers from scratch, but a DEAD
 * GRANT (connection_unauthorized) does NOT re-register — withConnection has
 * already marked the connection ERROR, and churning the token endpoint with
 * a dead grant helps nobody. Each subscription is isolated: one bad row
 * (undecryptable token, provider failure) never aborts the pass.
 *
 * The worker tick also prunes the dedupe + idempotency ledgers — both grow
 * per processed notification / mutating call and are useless after the
 * retention window (notifications don't arrive weeks late; callers don't
 * retry days later).
 */
import { withConnection } from '../connectionCall.js';
import type { Db } from '../db.js';
import { ConnectionUnauthorizedError } from '../errors.js';
import { logError, logInfo } from '../logger.js';
import type { MsGraphProvider } from '../providers/msgraph/types.js';
import { isSubscribableFolder, registerFolderSubscription } from '../subscriptions.js';

const RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const LOOKAHEAD_MS = 12 * 60 * 60 * 1000; // renew what expires within 12h
const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // prune dedupe/idempotency rows after 7 days

/** Renew (or re-register) every subscription expiring inside the lookahead window. */
export async function renewExpiringSubscriptions(db: Db, provider: MsGraphProvider): Promise<void> {
  const cutoff = new Date(Date.now() + LOOKAHEAD_MS);
  const expiring = await db.subscription.findMany({
    where: { expiresAt: { lt: cutoff }, connection: { deletedAt: null, status: 'ACTIVE' } },
    include: { connection: true },
  });
  if (expiring.length === 0) return;
  logInfo(`renewing ${expiring.length} expiring subscription(s)`);

  for (const sub of expiring) {
    try {
      const renewed = await withConnection(db, sub.connectionId, undefined, (token) =>
        provider.renewSubscription(token, sub.graphSubscriptionId),
      );
      await db.subscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(renewed.expirationDateTime) },
      });
      logInfo(`renewed ${sub.folder} subscription for ${sub.connection.mailboxEmail}`);
    } catch (err) {
      if (err instanceof ConnectionUnauthorizedError) {
        // withConnection already marked the connection ERROR; re-registering
        // with the same dead grant would just churn until the user reconnects.
        logError(`grant dead for ${sub.connection.mailboxEmail} — skipping re-register until reconnect`);
        continue;
      }
      logError(`renewal failed for ${sub.connection.mailboxEmail} ${sub.folder}; re-registering`, err);
      if (!isSubscribableFolder(sub.folder)) continue;
      try {
        await registerFolderSubscription(db, provider, sub.connectionId, sub.folder);
      } catch (reErr) {
        logError(`re-registration also failed for ${sub.connection.mailboxEmail} ${sub.folder}`, reErr);
      }
    }
  }
}

/** Prune dedupe + idempotency rows older than the retention window. */
export async function pruneLedgers(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - LEDGER_RETENTION_MS);
  const [notifications, idempotency] = await Promise.all([
    db.processedNotification.deleteMany({ where: { processedAt: { lt: cutoff } } }),
    db.idempotencyRecord.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  if (notifications.count > 0 || idempotency.count > 0) {
    logInfo(`pruned ${notifications.count} notification + ${idempotency.count} idempotency ledger rows`);
  }
}

/** One worker tick: renewals then ledger pruning, each failure-isolated. */
async function tick(db: Db, provider: MsGraphProvider): Promise<void> {
  await renewExpiringSubscriptions(db, provider).catch((err) => logError('renewal pass failed', err));
  await pruneLedgers(db).catch((err) => logError('ledger pruning failed', err));
}

/** Start the renewal timer: one pass at boot, then every RENEWAL_INTERVAL. Returns the timer so tests/shutdown can clear it. */
export function startRenewalWorker(db: Db, provider: MsGraphProvider): NodeJS.Timeout {
  void tick(db, provider);
  const timer = setInterval(() => {
    void tick(db, provider);
  }, RENEWAL_INTERVAL_MS);
  timer.unref();
  return timer;
}
