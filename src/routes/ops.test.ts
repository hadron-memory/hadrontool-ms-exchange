import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { db } from '../db.js';
import { fakeProvider } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

/** Seed one ACTIVE connection and return its id. */
async function seedConnection(refreshToken = 'rt-original'): Promise<string> {
  const row = await db.connection.create({
    data: { mailboxEmail: 'prof@example.edu', refreshTokenEnc: encryptToken(refreshToken) },
  });
  return row.id;
}

beforeEach(async () => {
  await db.processedNotification.deleteMany();
  await db.idempotencyRecord.deleteMany();
  await db.subscription.deleteMany();
  await db.connection.deleteMany();
});

describe('POST /ops/:operation', () => {
  it('rejects calls without the bearer token', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/list-messages').send({ connectionId: 'c' });
    expect(res.status).toBe(401);
  });

  it('404s an unknown operation, listing the known ones', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/read-minds').set(AUTH).send({});
    expect(res.status).toBe(404);
    expect(res.body.operations).toContain('list-messages');
  });

  it('returns connection_not_found for an unknown connectionId', async () => {
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_not_found');
  });

  it('lists messages in the neutral shape, decrypting the stored token', async () => {
    const connectionId = await seedConnection('rt-original');
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId, unreadOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({
      id: 'msg-1',
      conversationId: 'conv-1',
      from: { address: 'student@example.edu' },
      snippet: 'When are your office hours?',
    });
    // The DECRYPTED token reached the provider, with the unread filter.
    const [method, args] = provider.calls[0];
    expect(method).toBe('listMessages');
    expect(args[0]).toBe('rt-original');
    expect(args[1]).toBe('inbox');
    expect(args[2]).toMatchObject({ filter: 'isRead eq false' });
  });

  it('persists a rotated refresh token', async () => {
    const connectionId = await seedConnection('rt-original');
    const app = createApp(db, fakeProvider({ rotateTo: 'rt-rotated' }), async () => {});

    await request(app).post('/ops/get-message').set(AUTH).send({ connectionId, messageId: 'm-1' }).expect(200);

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-rotated');
  });

  it('creates a reply draft via save-draft { replyToMessageId }', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const res = await request(app)
      .post('/ops/save-draft')
      .set(AUTH)
      .send({ connectionId, replyToMessageId: 'msg-1', bodyHtml: '<p>Tuesdays 2–4pm.</p>' });
    expect(res.status).toBe(200);
    expect(res.body.draftId).toBe('draft-reply');
    expect(provider.calls[0][0]).toBe('createDraftReply');
  });

  it('requires recipients + subject on a fresh draft', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});

    const noTo = await request(app).post('/ops/save-draft').set(AUTH).send({ connectionId, bodyHtml: '<p>x</p>' });
    expect(noTo.status).toBe(400);
    expect(noTo.body.error).toBe('recipients_required');

    const empty = await request(app)
      .post('/ops/save-draft')
      .set(AUTH)
      .send({ connectionId, to: ['a@b.c'], subject: 's', bodyHtml: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('body_required');
  });

  it('replays a mutating operation with the same idempotencyKey without touching the provider', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider, async () => {});

    const body = { connectionId, messageId: 'msg-1', bodyHtml: '<p>ok</p>', idempotencyKey: 'key-1' };
    const first = await request(app).post('/ops/reply-to-message').set(AUTH).send(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ sent: true, replayed: false });

    const second = await request(app).post('/ops/reply-to-message').set(AUTH).send(body);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ sent: true, replayed: true });

    expect(provider.calls.filter(([m]) => m === 'replyToMessage')).toHaveLength(1);
  });

  it('rejects reusing an idempotencyKey across operations', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});

    await request(app)
      .post('/ops/reply-to-message')
      .set(AUTH)
      .send({ connectionId, messageId: 'm', bodyHtml: 'x', idempotencyKey: 'shared' })
      .expect(200);
    const res = await request(app)
      .post('/ops/send-draft')
      .set(AUTH)
      .send({ connectionId, draftId: 'd', idempotencyKey: 'shared' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('maps provider auth failure to connection_unauthorized and marks the connection ERROR', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider({ failWith: { methods: ['getMessage'], error: { statusCode: 401 } } }), async () => {});

    const res = await request(app).post('/ops/get-message').set(AUTH).send({ connectionId, messageId: 'm-1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('connection_unauthorized');

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.status).toBe('ERROR');

    // Subsequent calls short-circuit on the stored ERROR status.
    const again = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId });
    expect(again.status).toBe(403);
  });

  it('surfaces provider rate limiting as provider_rate_limited', async () => {
    const connectionId = await seedConnection();
    const app = createApp(
      db,
      fakeProvider({ failWith: { methods: ['listMessages'], error: { statusCode: 429, headers: { get: () => '9' } } } }),
      async () => {},
    );
    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'provider_rate_limited', retryAfterSeconds: 9 });
  });

  it('validates input via zod → validation_error', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider(), async () => {});
    const res = await request(app).post('/ops/list-messages').set(AUTH).send({ connectionId, top: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('top');
  });
});
