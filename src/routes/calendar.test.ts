import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { fakeProvider, graphEvent, resetDb } from '../test/fakes.js';
import { MAX_WINDOW_DAYS } from '../ops/calendar.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };
const WINDOW = { start: '2026-12-01T00:00:00Z', end: '2026-12-08T00:00:00Z' };

async function seedConnection(): Promise<string> {
  const row = await db.connection.create({
    data: { mailboxEmail: 'prof@example.edu', refreshTokenEnc: encryptToken('rt-original') },
  });
  return row.id;
}

beforeEach(() => resetDb(db));

describe('POST /ops/get-schedule', () => {
  it('returns busy intervals only, never event contents, resolving primary to the mailbox', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const res = await request(createApp(db, provider, async () => {}))
      .post('/ops/get-schedule').set(AUTH).send({ connectionId, ...WINDOW });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toEqual( [{ id: 'primary', busy: [{ start: '2026-12-01T15:00:00.000Z', end: '2026-12-01T16:00:00.000Z' }], error: null }]
    );
    // The fake returned a subject and a location; neither may appear anywhere.
    expect(JSON.stringify(res.body)).not.toMatch(/Secret|Room 9|subject|location/);
    const [method, args] = provider.calls[0];
    expect(method).toBe('getSchedule');
    expect(args[1]).toEqual(['prof@example.edu']);
    expect(args[2]).toBe('2026-12-01T00:00:00.000Z');
  });

  it('keeps an unresolved schedule in its slot with an error marker', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const res = await request(createApp(db, provider, async () => {}))
      .post('/ops/get-schedule').set(AUTH).send({ connectionId, ...WINDOW, schedules: ['primary', 'x@example.edu'] });
    expect(res.status).toBe(200);
    expect(res.body.schedules.map((s: { id: string }) => s.id)).toEqual(['primary', 'x@example.edu']);
  });

  it.each([
    ['end before start', { start: WINDOW.end, end: WINDOW.start }],
    ['end equal to start', { start: WINDOW.start, end: WINDOW.start }],
    ['a window past the cap', { start: WINDOW.start, end: `2027-01-${String(2 + 1).padStart(2, '0')}T00:00:00Z` }],
    ['a time with no offset', { start: '2026-12-01T00:00:00', end: WINDOW.end }],
    ['a non-date', { start: 'soon', end: WINDOW.end }],
  ])('refuses %s before any Graph call', async (_n, w) => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const res = await request(createApp(db, provider, async () => {}))
      .post('/ops/get-schedule').set(AUTH).send({ connectionId, ...w });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(provider.calls).toHaveLength(0);
  });

  it('accepts exactly the cap and refuses one second past it', async () => {
    const connectionId = await seedConnection();
    const start = new Date('2026-12-01T00:00:00Z');
    const edge = new Date(start.getTime() + MAX_WINDOW_DAYS * 86400000);
    const ok = await request(createApp(db, fakeProvider(), async () => {}))
      .post('/ops/get-schedule').set(AUTH).send({ connectionId, start: start.toISOString(), end: edge.toISOString() });
    expect(ok.status).toBe(200);
    const over = await request(createApp(db, fakeProvider(), async () => {}))
      .post('/ops/get-schedule').set(AUTH)
      .send({ connectionId, start: start.toISOString(), end: new Date(edge.getTime() + 1000).toISOString() });
    expect(over.status).toBe(400);
  });

  it('refuses more than 20 schedules', async () => {
    const connectionId = await seedConnection();
    const res = await request(createApp(db, fakeProvider(), async () => {}))
      .post('/ops/get-schedule').set(AUTH)
      .send({ connectionId, ...WINDOW, schedules: Array.from({ length: 21 }, (_, i) => `u${i}@example.edu`) });
    expect(res.status).toBe(400);
  });

  it('answers the indistinguishable not-found for an unknown connection', async () => {
    const res = await request(createApp(db, fakeProvider(), async () => {}))
      .post('/ops/get-schedule').set(AUTH).send({ connectionId: 'nope', ...WINDOW });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_not_found');
  });

  it('maps a 403 (no Calendars.Read) to provider_scope_missing and leaves the connection ACTIVE', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider({ failWith: { methods: ['getSchedule'], error: { statusCode: 403, code: 'ErrorAccessDenied' } } });
    const res = await request(createApp(db, provider, async () => {})).post('/ops/get-schedule').set(AUTH).send({ connectionId, ...WINDOW });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'provider_scope_missing', scope: 'Calendars.Read' });
    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.status).toBe('ACTIVE');
  });

  it('still maps a 401 to connection_unauthorized and marks ERROR', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider({ failWith: { methods: ['getSchedule'], error: { statusCode: 401 } } });
    const res = await request(createApp(db, provider, async () => {})).post('/ops/get-schedule').set(AUTH).send({ connectionId, ...WINDOW });
    expect(res.body.error).toBe('connection_unauthorized');
    expect((await db.connection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe('ERROR');
  });
});

describe('POST /ops/list-events', () => {
  it('returns the neutral ToolCalendarEvent shape with a default limit of 25', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const res = await request(createApp(db, provider, async () => {})).post('/ops/list-events').set(AUTH).send({ connectionId, ...WINDOW });
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toEqual({
      id: 'evt-1', calendarId: 'primary', title: 'Planning', description: 'Agenda inside', location: 'Room 4',
      start: { dateTime: '2026-12-01T15:00:00.000Z', date: null, timeZone: 'UTC' },
      end: { dateTime: '2026-12-01T16:00:00.000Z', date: null, timeZone: 'UTC' },
      isAllDay: false, status: 'confirmed',
      organizer: { name: 'Org Anizer', address: 'org@example.edu' }, isOrganizer: false,
      attendees: [{ name: 'Al', address: 'al@example.edu', optional: true, response: 'tentative' }],
      myResponse: 'accepted', webLink: 'https://outlook.example/evt-1', seriesId: null,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
    });
    expect(provider.calls[0][1][3]).toBe(25);
  });

  it('renders all-day events as dates and cancelled/tentative status', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const orig = provider.listCalendarView;
    provider.listCalendarView = async (...a) => ({
      ...(await orig(...a)),
      data: [
        graphEvent({ id: 'a', isAllDay: true, start: { dateTime: '2026-12-02T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-12-03T00:00:00.0000000', timeZone: 'UTC' } }),
        graphEvent({ id: 'b', isCancelled: true }),
        graphEvent({ id: 'c', showAs: 'tentative' }),
      ],
    });
    const res = await request(createApp(db, provider, async () => {})).post('/ops/list-events').set(AUTH).send({ connectionId, ...WINDOW, top: 100 });
    const [a, b, c] = res.body.events;
    expect(a.start).toEqual({ dateTime: null, date: '2026-12-02', timeZone: null });
    expect(a.end.date).toBe('2026-12-03');
    expect([b.status, c.status]).toEqual(['cancelled', 'tentative']);
  });

  it.each([[0], [101], [1.5]])('refuses top=%s before any Graph call', async (top) => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const res = await request(createApp(db, provider, async () => {})).post('/ops/list-events').set(AUTH).send({ connectionId, ...WINDOW, top });
    expect(res.status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it('requires a bounded window (start and end)', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const res = await request(createApp(db, provider, async () => {})).post('/ops/list-events').set(AUTH).send({ connectionId, start: WINDOW.start });
    expect(res.status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it('maps a 403 to provider_scope_missing', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider({ failWith: { methods: ['listCalendarView'], error: { statusCode: 403 } } });
    const res = await request(createApp(db, provider, async () => {})).post('/ops/list-events').set(AUTH).send({ connectionId, ...WINDOW });
    expect(res.body.error).toBe('provider_scope_missing');
  });

  it('adds no calendar mutation operation', async () => {
    const res = await request(createApp(db, fakeProvider(), async () => {})).post('/ops/read-minds').set(AUTH).send({});
    const calendarOps = (res.body.operations as string[]).filter((o) => /event|calendar|schedule/.test(o));
    expect(calendarOps.sort()).toEqual(['get-schedule', 'list-events']);
  });
});
