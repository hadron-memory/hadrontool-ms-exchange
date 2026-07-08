import { describe, expect, it } from 'vitest';
import {
  ConnectionUnauthorizedError,
  EmailToolError,
  NotFoundError,
  ProviderRateLimitedError,
  ProviderUnavailableError,
  ValidationError,
  mapGraphError,
} from './errors.js';

describe('mapGraphError', () => {
  it('maps 401/403 to connection_unauthorized', () => {
    expect(mapGraphError({ statusCode: 401 })).toBeInstanceOf(ConnectionUnauthorizedError);
    expect(mapGraphError({ statusCode: 403 })).toBeInstanceOf(ConnectionUnauthorizedError);
    expect(mapGraphError({ code: 'InvalidAuthenticationToken' })).toBeInstanceOf(ConnectionUnauthorizedError);
  });

  it('maps 404 to not_found with the resource hint', () => {
    const err = mapGraphError({ statusCode: 404 }, { resource: 'draft', id: 'd-1' });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.toBody()).toMatchObject({ error: 'not_found', resource: 'draft', id: 'd-1' });
  });

  it('maps 429 to provider_rate_limited honoring Retry-After', () => {
    const err = mapGraphError({ statusCode: 429, headers: { get: () => '17' } });
    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect(err.toBody()).toMatchObject({ retryAfterSeconds: 17 });
  });

  it('defaults Retry-After to 60 when missing or malformed', () => {
    expect(mapGraphError({ statusCode: 429 }).toBody()).toMatchObject({ retryAfterSeconds: 60 });
    expect(mapGraphError({ statusCode: 429, headers: { get: () => 'soon' } }).toBody()).toMatchObject({
      retryAfterSeconds: 60,
    });
  });

  it('maps 400 to validation_error and everything else to provider_unavailable', () => {
    expect(mapGraphError({ statusCode: 400, message: 'bad filter' })).toBeInstanceOf(ValidationError);
    expect(mapGraphError({ statusCode: 503 })).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGraphError(new Error('socket hang up'))).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGraphError(undefined)).toBeInstanceOf(ProviderUnavailableError);
  });

  it('passes already-typed errors through unchanged', () => {
    const original = new NotFoundError('message', 'm-9');
    expect(mapGraphError(original)).toBe(original);
  });

  it('every error carries a stable code and an HTTP status', () => {
    const samples: EmailToolError[] = [
      new ConnectionUnauthorizedError(),
      new NotFoundError('message', 'x'),
      new ProviderRateLimitedError(5),
      new ProviderUnavailableError(),
      new ValidationError('f', 'r'),
    ];
    for (const err of samples) {
      expect(err.code).toBeTruthy();
      expect(err.httpStatus).toBeGreaterThanOrEqual(400);
      expect(err.toBody().error).toBe(err.code);
    }
  });
});
