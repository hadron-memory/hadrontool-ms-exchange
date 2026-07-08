import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { decryptToken, encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { fakeProvider } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

beforeEach(async () => {
  await db.processedNotification.deleteMany();
  await db.idempotencyRecord.deleteMany();
  await db.subscription.deleteMany();
  await db.connection.deleteMany();
});

describe('/connections', () => {
  it('creates a connection from an OAuth code, using ID-token claims for a personal account', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/auth/microsoft/callback' });

    expect(res.status).toBe(201);
    // /me returned null fields (personal account) → ID-token claims win.
    expect(res.body).toMatchObject({
      provider: 'ms-exchange',
      mailboxEmail: 'personal@outlook.com',
      displayName: 'Personal User',
      status: 'ACTIVE',
    });
    // The exchange used core's redirect URI (must match the authorize URL).
    expect(provider.calls[0]).toEqual(['exchangeCode', ['auth-code-1', 'https://core.example/auth/microsoft/callback']]);

    // The refresh token is stored ENCRYPTED, decryptable with the tool key.
    const row = await db.connection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.refreshTokenEnc).not.toContain('rt-fresh');
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-fresh');
  });

  it('imports a raw refresh token (the Phase-2 core→tool migration path)', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ refreshToken: 'rt-migrated', mailboxEmail: 'prof@example.edu', displayName: 'The Professor' });

    expect(res.status).toBe(201);
    const row = await db.connection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-migrated');
  });

  it('rejects a create with neither code nor refreshToken', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/connections').set(AUTH).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('returns identity + subscriptions on GET, and 404s a deleted connection', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app = createApp(db, fakeProvider(), async () => {});

    const res = await request(app).get(`/connections/${connection.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mailboxEmail: 'a@b.c', subscriptions: [] });
    // The encrypted token never leaves the tool.
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');

    await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
    await request(app).get(`/connections/${connection.id}`).set(AUTH).expect(404);
  });

  it('creates a Graph subscription for a folder and stores the row', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post(`/connections/${connection.id}/subscriptions`)
      .set(AUTH)
      .send({ folder: 'Inbox' }); // case-insensitive
    expect(res.status).toBe(201);
    expect(res.body.folder).toBe('inbox');

    const [method, args] = provider.calls.find(([m]) => m === 'createSubscription')!;
    expect(method).toBe('createSubscription');
    expect(args[1]).toBe('https://tool.example/webhooks/msgraph'); // WEBHOOK_BASE_URL + path
    expect(args[3]).toBe('/me/mailFolders/inbox/messages');
    // clientState is an HMAC, never the raw connection id.
    expect(args[2]).not.toContain(connection.id);

    const row = await db.subscription.findUniqueOrThrow({
      where: { connectionId_folder: { connectionId: connection.id, folder: 'inbox' } },
    });
    expect(row.graphSubscriptionId).toBeTruthy();
  });

  it('rejects unsupported folders', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app)
      .post(`/connections/${connection.id}/subscriptions`)
      .set(AUTH)
      .send({ folder: 'junkemail' });
    expect(res.status).toBe(400);
  });

  it('deletes Graph subscriptions then soft-deletes the connection', async () => {
    const connection = await db.connection.create({
      data: { mailboxEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    await db.subscription.create({
      data: {
        connectionId: connection.id,
        folder: 'inbox',
        graphSubscriptionId: 'graph-sub-del',
        expiresAt: new Date(Date.now() + 1000 * 60),
      },
    });
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    await request(app).delete(`/connections/${connection.id}`).set(AUTH).expect(200);

    expect(provider.calls.some(([m, args]) => m === 'deleteSubscription' && args[1] === 'graph-sub-del')).toBe(true);
    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await db.subscription.count({ where: { connectionId: connection.id } })).toBe(0);
  });
});
