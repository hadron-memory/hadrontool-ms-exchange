/**
 * Microsoft OAuth 2.0 Authorization Code flow (delegated permissions).
 *
 * Ported from hadron-server src/integrations/exchange/auth.ts (plus the
 * PR #51 personal-account salvage: decodeIdToken + the /me fallback).
 * Hadron owns ONE multi-tenant Azure AD app; this tool holds its client
 * secret — hadron-server only builds the user-facing authorize URL.
 */
import { ProviderNotConfiguredError } from '../../errors.js';
import { config } from '../../config.js';
import type { MicrosoftProfile, TokenResponse } from './types.js';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access', // refresh token
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.Read',
];

/** The Azure AD app credentials; typed 503 when the deploy lacks them. */
function credentials(): { clientId: string; clientSecret: string } {
  if (!config.microsoftClientId || !config.microsoftClientSecret) {
    throw new ProviderNotConfiguredError();
  }
  return { clientId: config.microsoftClientId, clientSecret: config.microsoftClientSecret };
}

/** Exchange the authorization code for tokens. The redirectUri must equal the one used on the authorize URL (hadron-server's callback). */
export async function exchangeMicrosoftCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: SCOPES.join(' '),
  });
  return postToken(body, 'token exchange');
}

/** Use a refresh token to get a fresh access token (and possibly a rotated refresh token). */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES.join(' '),
  });
  return postToken(body, 'token refresh');
}

/** POST to the token endpoint with shared error shaping. */
async function postToken(body: URLSearchParams, what: string): Promise<TokenResponse> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    const failure = new Error(`Microsoft ${what} failed: ${err}`) as Error & { statusCode: number };
    failure.statusCode = res.status;
    throw failure;
  }
  return res.json() as Promise<TokenResponse>;
}

/**
 * Decode the email and name from the ID token (JWT) claims.
 * Personal Microsoft accounts don't always support the /me Graph endpoint,
 * so profile info comes from the token claims instead (PR #51 salvage).
 */
export function decodeIdToken(idToken: string): { email: string | null; name: string | null } {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    return {
      email: payload.email ?? payload.preferred_username ?? null,
      name: payload.name ?? null,
    };
  } catch {
    return { email: null, name: null };
  }
}

/** Fetch the signed-in user's profile from Graph, with the personal-account fallback: a failing /me returns null fields and the caller uses ID-token claims. */
export async function fetchMicrosoftProfile(accessToken: string): Promise<MicrosoftProfile> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    return { mail: null, userPrincipalName: '', displayName: null };
  }
  return res.json() as Promise<MicrosoftProfile>;
}
