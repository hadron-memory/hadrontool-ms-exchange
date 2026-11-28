import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCOPES, decodeIdToken, exchangeMicrosoftCode, refreshAccessToken } from './auth.js';
import { ConnectionUnauthorizedError } from '../../errors.js';

/** Stub global fetch with a canned token-endpoint response. */
function stubTokenEndpoint(status: number, body: string): void {
  vi.stubGlobal('fetch', async () => ({
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('token endpoint error mapping', () => {
  it('maps a 400 invalid_grant (dead refresh token) to connection_unauthorized', async () => {
    stubTokenEndpoint(400, '{"error":"invalid_grant","error_description":"AADSTS700082: refresh token expired"}');
    await expect(refreshAccessToken('dead-token')).rejects.toBeInstanceOf(ConnectionUnauthorizedError);
  });

  it('keeps other token failures as status-coded errors (→ provider mapping)', async () => {
    stubTokenEndpoint(503, 'upstream unavailable');
    await expect(refreshAccessToken('rt')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('decodeIdToken', () => {
  it('extracts email + name from the payload claims', () => {
    const payload = Buffer.from(
      JSON.stringify({ preferred_username: 'personal@outlook.com', name: 'Personal User' }),
    ).toString('base64url');
    expect(decodeIdToken(`h.${payload}.s`)).toEqual({ email: 'personal@outlook.com', name: 'Personal User' });
  });

  it('returns nulls on malformed tokens instead of throwing', () => {
    expect(decodeIdToken('')).toEqual({ email: null, name: null });
    expect(decodeIdToken('not-a-jwt')).toEqual({ email: null, name: null });
  });
});

describe('token calls carry no scope parameter', () => {
  it.each([
    ['refresh', () => refreshAccessToken('rt')],
    ['code exchange', () => exchangeMicrosoftCode('code', 'https://core.example/cb')],
  ])('%s omits scope so Microsoft answers with the consented set', async (_n, call) => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ access_token: 'a', refresh_token: 'r' }) };
    });
    await call();
    expect(bodies).toHaveLength(1);
    expect(new URLSearchParams(bodies[0]).has('scope')).toBe(false);
  });

  it('documents Calendars.Read, and no calendar write scope, in the connect set', () => {
    expect(SCOPES).toContain('Calendars.Read');
    expect(SCOPES.join(' ')).not.toMatch(/Calendars\.ReadWrite/);
  });
});
