import { beforeEach, describe, expect, it } from 'vitest';
import { renewExpiringSubscriptions } from './renewal.js';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

/** Seed a connection with one subscription expiring in `hours` hours. */
async function seed(hours: number, status: 'ACTIVE' | 'ERROR' = 'ACTIVE') {
  const connection = await db.connection.create({
    data: { mailboxEmail: `m${hours}@x.y`, refreshTokenEnc: encryptToken('rt'), status },
  });
  const subscription = await db.subscription.create({
    data: {
      connectionId: connection.id,
      folder: 'inbox',
      graphSubscriptionId: `sub-${connection.id}`,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    },
  });
  return { connection, subscription };
}

beforeEach(() => resetDb(db));

describe('renewExpiringSubscriptions', () => {
  it('renews only subscriptions inside the 12h lookahead window', async () => {
    const { subscription: soon } = await seed(2);
    await seed(48); // far in the future — untouched
    const provider = fakeProvider();

    await renewExpiringSubscriptions(db, provider);

    const renewCalls = provider.calls.filter(([m]) => m === 'renewSubscription');
    expect(renewCalls).toHaveLength(1);
    expect(renewCalls[0][1][1]).toBe(soon.graphSubscriptionId);

    const row = await db.subscription.findUniqueOrThrow({ where: { id: soon.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 48 * 60 * 60 * 1000);
  });

  it('re-registers from scratch when renewal fails', async () => {
    const { subscription } = await seed(1);
    const provider = fakeProvider({ failWith: { methods: ['renewSubscription'], error: { statusCode: 404 } } });

    await renewExpiringSubscriptions(db, provider);

    expect(provider.calls.some(([m]) => m === 'createSubscription')).toBe(true);
    const row = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.graphSubscriptionId).not.toBe(subscription.graphSubscriptionId);
  });

  it('skips connections in ERROR status', async () => {
    await seed(1, 'ERROR');
    const provider = fakeProvider();
    await renewExpiringSubscriptions(db, provider);
    expect(provider.calls).toHaveLength(0);
  });

  it('marks the connection ERROR and does NOT re-register when the grant is dead', async () => {
    const { connection } = await seed(1);
    const provider = fakeProvider({ failWith: { methods: ['renewSubscription'], error: { statusCode: 401 } } });

    await renewExpiringSubscriptions(db, provider);

    expect(provider.calls.filter(([m]) => m === 'createSubscription')).toHaveLength(0);
    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe('ERROR');
  });

  it('does not let one undecryptable token abort the pass for other subscriptions', async () => {
    const bad = await seed(1);
    await db.connection.update({
      where: { id: bad.connection.id },
      data: { refreshTokenEnc: 'not-valid-ciphertext' },
    });
    const good = await seed(2);
    const provider = fakeProvider();

    await renewExpiringSubscriptions(db, provider);

    const renewed = provider.calls.filter(([m]) => m === 'renewSubscription');
    expect(renewed.some(([, args]) => args[1] === good.subscription.graphSubscriptionId)).toBe(true);
  });
});
