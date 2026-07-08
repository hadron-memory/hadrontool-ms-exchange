/**
 * Boot: env validation (config.ts import throws on production misconfig),
 * HTTP server, and the subscription renewal worker.
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { forwardEventToCore } from './events/forwarder.js';
import { startRenewalWorker } from './jobs/renewal.js';
import { logInfo } from './logger.js';
import { msGraphProvider } from './providers/msgraph/client.js';

const app = createApp(db, msGraphProvider, forwardEventToCore);

app.listen(config.port, () => {
  logInfo(`hadrontool-ms-exchange listening on :${config.port}`);
  if (!config.microsoftClientId || !config.microsoftClientSecret) {
    logInfo('MICROSOFT_CLIENT_ID/SECRET not set — provider calls will return provider_not_configured');
  }
});

startRenewalWorker(db, msGraphProvider);
