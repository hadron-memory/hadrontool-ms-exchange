import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import type { EmailEvent } from '../events/forwarder.js';
import { hmacClientState } from '../subscriptions.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

/** Seed a connection + inbox/sentitems subscription; returns ids. */
async function seedSubscribedConnection(folder = 'inbox') {
  const connection = await db.connection.create({
    data: { mailboxEmail: 'prof@example.edu', refreshTokenEnc: encryptToken('rt-1') },
  });
  const subscription = await db.subscription.create({
    data: {
      connectionId: connection.id,
      folder,
      graphSubscriptionId: `graph-sub-${folder}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { connection, subscription };
}

/** A Graph notification body for the given subscription. */
function notification(graphSubscriptionId: string, clientState: string, messageId = 'msg-77') {
  return {
    value: [
      {
        subscriptionId: graphSubscriptionId,
        clientState,
        resource: `Users/u-1/Messages/${messageId}`,
        changeType: 'created',
      },
    ],
  };
}

/** Await the fire-and-forget notification processing. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => resetDb(db));

describe('POST /webhooks/msgraph', () => {
  it('echoes the validationToken as text/plain (subscription handshake)', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/webhooks/msgraph?validationToken=tok-abc%20xyz').send();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('tok-abc xyz');
  });

  it('is NOT bearer-gated (Graph cannot send our token) but acks 202', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/webhooks/msgraph').send({ value: [] });
    expect(res.status).toBe(202);
  });

  it('normalizes and forwards an inbox notification as email.received', async () => {
    const { connection, subscription } = await seedSubscribedConnection('inbox');
    const events: EmailEvent[] = [];
    const provider = fakeProvider();
    const app = createApp(db, provider, async (e) => {
      events.push(e);
    });

    const clientState = hmacClientState(connection.id, 'inbox');
    await request(app)
      .post('/webhooks/msgraph')
      .send(notification(subscription.graphSubscriptionId, clientState))
      .expect(202);
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'email.received',
      connectionId: connection.id,
      folder: 'inbox',
      message: { id: 'msg-77', from: { address: 'student@example.edu' } },
    });
    expect(provider.calls.some(([m]) => m === 'getMessage')).toBe(true);
  });

  it('labels sentitems notifications email.sent', async () => {
    const { connection, subscription } = await seedSubscribedConnection('sentitems');
    const events: EmailEvent[] = [];
    const app = createApp(db, fakeProvider(), async (e) => {
      events.push(e);
    });

    await request(app)
      .post('/webhooks/msgraph')
      .send(notification(subscription.graphSubscriptionId, hmacClientState(connection.id, 'sentitems')))
      .expect(202);
    await settle();

    expect(events[0]?.event).toBe('email.sent');
  });

  it('drops notifications with a wrong clientState (no fetch, no event)', async () => {
    const { subscription } = await seedSubscribedConnection('inbox');
    const events: EmailEvent[] = [];
    const provider = fakeProvider();
    const app = createApp(db, provider, async (e) => {
      events.push(e);
    });

    await request(app)
      .post('/webhooks/msgraph')
      .send(notification(subscription.graphSubscriptionId, 'not-the-hmac'))
      .expect(202);
    await settle();

    expect(events).toHaveLength(0);
    expect(provider.calls.filter(([m]) => m === 'getMessage')).toHaveLength(0);
  });

  it('dedupes redelivered notifications (at-least-once → processed once)', async () => {
    const { connection, subscription } = await seedSubscribedConnection('inbox');
    const events: EmailEvent[] = [];
    const app = createApp(db, fakeProvider(), async (e) => {
      events.push(e);
    });

    const body = notification(subscription.graphSubscriptionId, hmacClientState(connection.id, 'inbox'));
    await request(app).post('/webhooks/msgraph').send(body).expect(202);
    await request(app).post('/webhooks/msgraph').send(body).expect(202);
    await settle();

    expect(events).toHaveLength(1);
  });

  it('releases the dedupe row on processing failure so the redelivery is processed', async () => {
    const { connection, subscription } = await seedSubscribedConnection('inbox');
    const events: EmailEvent[] = [];
    const body = notification(subscription.graphSubscriptionId, hmacClientState(connection.id, 'inbox'));

    // First delivery: transient Graph failure after the dedupe insert.
    const failing = createApp(
      db,
      fakeProvider({ failWith: { methods: ['getMessage'], error: { statusCode: 503 } } }),
      async (e) => {
        events.push(e);
      },
    );
    await request(failing).post('/webhooks/msgraph').send(body).expect(202);
    await settle();
    expect(events).toHaveLength(0);
    expect(await db.processedNotification.count()).toBe(0); // released

    // Graph redelivers; a healthy pass processes it.
    const working = createApp(db, fakeProvider(), async (e) => {
      events.push(e);
    });
    await request(working).post('/webhooks/msgraph').send(body).expect(202);
    await settle();
    expect(events).toHaveLength(1);
  });

  it('ignores notifications for unknown subscriptions', async () => {
    const events: EmailEvent[] = [];
    const app = createApp(db, fakeProvider(), async (e) => {
      events.push(e);
    });
    await request(app).post('/webhooks/msgraph').send(notification('never-registered', 'x')).expect(202);
    await settle();
    expect(events).toHaveLength(0);
  });
});
