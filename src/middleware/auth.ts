/**
 * Bearer-token gate for the internal operations plane (mirrors
 * hadrontool-pdf): every /ops/* and /connections* request must carry
 * `Authorization: Bearer <MS_EXCHANGE_TOOL_TOKEN>`. In production the
 * service refuses to boot without the token (src/config.ts), so an
 * unauthenticated deploy cannot exist; in development an unset token
 * disables the gate.
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { timingSafeEqual } from 'crypto';

/** Constant-time string comparison (defends the shared token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Express middleware enforcing the shared bearer token when configured. */
export function requireToolToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.toolToken) {
    next(); // development only — production boot requires the token
    return;
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, config.toolToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
