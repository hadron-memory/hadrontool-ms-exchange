/**
 * Environment configuration, validated once at import time.
 *
 * Posture (mirrors hadrontool-pdf + hadron-server's BASE_URL IIFE): fail LOUD
 * at boot in production for anything the service cannot safely run without;
 * degrade gracefully in development. Microsoft OAuth credentials are the one
 * deliberate exception — without them the HTTP surface still boots and every
 * provider-touching call returns a typed error, so a half-configured deploy
 * is observable instead of dead.
 */
import 'dotenv/config';

/** True when NODE_ENV is production. */
export const isProduction = process.env.NODE_ENV === 'production';

/** True under vitest (NODE_ENV=test pinned by vitest.config.ts). */
export const isTest = process.env.NODE_ENV === 'test';

/** Read an env var, trimmed; empty string counts as unset. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v === '' ? undefined : v;
}

/** Read a required-in-production env var; throws at boot when missing there. */
function required(name: string): string | undefined {
  const v = env(name);
  if (!v && isProduction) {
    throw new Error(`${name} is required in production — refusing to start`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT') ?? 8080),

  /** Bearer token gating /ops/* and /connections*. Required in production. */
  toolToken: required('MS_EXCHANGE_TOOL_TOKEN'),

  /** 32-byte hex key for AES-256-GCM refresh-token encryption at rest. */
  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),

  /** HMAC key for the Graph subscription clientState. */
  webhookClientStateSecret: required('WEBHOOK_CLIENT_STATE_SECRET'),

  /** Azure AD app credentials. Optional at boot — see module JSDoc. */
  microsoftClientId: env('MICROSOFT_CLIENT_ID'),
  microsoftClientSecret: env('MICROSOFT_CLIENT_SECRET'),

  /** Public base URL for Graph change notifications (Traefik-exposed). */
  webhookBaseUrl: env('WEBHOOK_BASE_URL'),

  /** hadron-server's internal event ingress; unset ⇒ events logged + dropped. */
  coreEventsUrl: env('CORE_EVENTS_URL'),
  coreEventsToken: env('CORE_EVENTS_TOKEN'),

  maxBodySize: env('MAX_BODY_SIZE') ?? '2mb',
} as const;

// Key-shape check runs at boot, not first use — a bad key must not surface
// as a decrypt failure mid-request.
if (config.tokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes) — refusing to start');
}
