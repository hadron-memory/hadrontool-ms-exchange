import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './crypto.js';

describe('token encryption', () => {
  it('round-trips a refresh token', () => {
    const token = 'M.C123_BAY.-secret-refresh-token-value';
    const enc = encryptToken(token);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc)).toBe(token);
  });

  it('produces distinct ciphertexts per call (fresh IV)', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });

  it('rejects tampered ciphertext', () => {
    const enc = Buffer.from(encryptToken('secret'), 'base64');
    enc[enc.length - 1] ^= 0xff;
    expect(() => decryptToken(enc.toString('base64'))).toThrow();
  });

  it('uses the core-compatible wire format (iv 12 ‖ tag 16 ‖ data)', () => {
    const enc = Buffer.from(encryptToken('x'), 'base64');
    expect(enc.length).toBe(12 + 16 + 1);
  });
});
