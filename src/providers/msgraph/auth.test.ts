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
