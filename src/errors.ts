/**
 * Typed error catalog — the spec 002 contract (contracts/error-codes.md).
 *
 * Codes are the PUBLIC surface: hadron-server's emailClient passes them
 * through to GraphQL `extensions.code` / MCP errors verbatim, so their
 * meanings must stay stable. New codes may be added; existing ones never
 * change meaning.
 */

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class EmailToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** connectionId unknown OR not owned by the caller — indistinguishable by design (anti-enumeration). */
export class ConnectionNotFoundError extends EmailToolError {
  readonly code = 'connection_not_found';
  readonly httpStatus = 404;
  constructor() {
    super('This email connection no longer exists.');
  }
}

/** Connection exists but its provider grant is dead (revoked / expired refresh token). */
export class ConnectionUnauthorizedError extends EmailToolError {
  readonly code = 'connection_unauthorized';
  readonly httpStatus = 403;
  constructor() {
    super('The mailbox connection is no longer authorized; the user must reconnect.');
  }
}

/** Provider 429 — caller should retry after the indicated delay. */
export class ProviderRateLimitedError extends EmailToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor(public retryAfterSeconds: number) {
    super('The email provider is rate-limiting; retry shortly.');
  }
  protected extraFields() {
    return { retryAfterSeconds: this.retryAfterSeconds };
  }
}

/** Provider 5xx / network failure — transient, caller may retry with backoff. */
export class ProviderUnavailableError extends EmailToolError {
  readonly code = 'provider_unavailable';
  readonly httpStatus = 502;
  constructor() {
    super('The email provider is temporarily unavailable.');
  }
}

/** A message/draft/folder id does not exist within this connection. */
export class NotFoundError extends EmailToolError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
  constructor(
    public resource: 'message' | 'attachment' | 'draft' | 'conversation' | 'folder',
    public id: string,
  ) {
    super(`The ${resource} is no longer available.`);
  }
  protected extraFields() {
    return { resource: this.resource, id: this.id };
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends EmailToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/** Message body missing on a compose operation. */
export class BodyRequiredError extends EmailToolError {
  readonly code = 'body_required';
  readonly httpStatus = 400;
  constructor() {
    super('The message has no body.');
  }
}

/** Recipient list empty on a compose operation. */
export class RecipientsRequiredError extends EmailToolError {
  readonly code = 'recipients_required';
  readonly httpStatus = 400;
  constructor() {
    super('This message has no recipients.');
  }
}

/** The service is missing its Microsoft OAuth credentials (deploy-time gap). */
export class ProviderNotConfiguredError extends EmailToolError {
  readonly code = 'provider_not_configured';
  readonly httpStatus = 503;
  constructor() {
    super('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET are not configured on this service.');
  }
}

/** Shape of the error object the Microsoft Graph SDK throws. */
interface GraphErrorLike {
  statusCode?: number;
  code?: string;
  message?: string;
  headers?: { get?: (name: string) => string | null };
  body?: unknown;
}

/**
 * Map a raw Microsoft Graph / fetch failure to a typed EmailToolError.
 * Anything already typed passes through; unknown shapes become
 * provider_unavailable (transient by default — never pretend success).
 */
export function mapGraphError(err: unknown, resourceHint?: { resource: 'message' | 'draft' | 'folder'; id: string }): EmailToolError {
  if (err instanceof EmailToolError) return err;

  const graphErr = (err ?? {}) as GraphErrorLike;
  const status = typeof graphErr.statusCode === 'number' ? graphErr.statusCode : undefined;

  if (status === 401 || status === 403 || graphErr.code === 'InvalidAuthenticationToken') {
    return new ConnectionUnauthorizedError();
  }
  if (status === 404 || graphErr.code === 'ErrorItemNotFound') {
    return new NotFoundError(resourceHint?.resource ?? 'message', resourceHint?.id ?? 'unknown');
  }
  if (status === 429) {
    const raw = graphErr.headers?.get?.('Retry-After');
    const parsed = raw != null ? parseInt(raw, 10) : NaN;
    return new ProviderRateLimitedError(Number.isFinite(parsed) && parsed > 0 ? parsed : 60);
  }
  if (status === 400) {
    return new ValidationError('request', graphErr.message ?? 'the provider rejected the request');
  }
  return new ProviderUnavailableError();
}
