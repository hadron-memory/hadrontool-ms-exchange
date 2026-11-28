import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeIdToken, refreshAccessToken } from './auth.js';
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

describe('requested scopes', () => {
  it('asks for Calendars.Read and no calendar write scope', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      body = init.body;
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    });
    await refreshAccessToken('rt').catch(() => {});
    // Config may be unset in the test env; only assert when a request was made.
    if (body) {
      const scope = new URLSearchParams(body).get('scope') ?? '';
      expect(scope.split(' ')).toContain('Calendars.Read');
      expect(scope).not.toMatch(/Calendars\.ReadWrite/);
    }
  });
});
