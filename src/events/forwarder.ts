/**
 * Event plane, tool → core (decided 2026-07-08, hadron-server#396): normalized
 * email events are POSTed to hadron-server's internal ingress over HTTP now,
 * designed so the transport can wrap behind a NATS subject later without
 * touching callers. Unset CORE_EVENTS_URL ⇒ events are logged and dropped —
 * a missing consumer never breaks webhook handling.
 */
import { config } from '../config.js';
import { logError, logInfo } from '../logger.js';
import type { EmailMessage } from '../ops/index.js';

/** Normalized event delivered to core's /internal/email-events ingress. */
export interface EmailEvent {
  /** `email.received` (inbox-class folders) or `email.sent` (sentitems). */
  event: 'email.received' | 'email.sent';
  connectionId: string;
  folder: string;
  message: EmailMessage;
}

/** Signature of the forwarder — injectable for tests. */
export type EventForwarder = (event: EmailEvent) => Promise<void>;

/** Production forwarder: POST to core with the events bearer token. */
export const forwardEventToCore: EventForwarder = async (event) => {
  if (!config.coreEventsUrl) {
    logInfo(`event ${event.event} for connection ${event.connectionId} dropped (CORE_EVENTS_URL unset)`);
    return;
  }
  try {
    const res = await fetch(config.coreEventsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.coreEventsToken ? { authorization: `Bearer ${config.coreEventsToken}` } : {}),
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      logError(`core event ingress returned ${res.status} for ${event.event} (connection ${event.connectionId})`);
    }
  } catch (err) {
    logError(`failed to deliver ${event.event} for connection ${event.connectionId} to core`, err);
  }
};
