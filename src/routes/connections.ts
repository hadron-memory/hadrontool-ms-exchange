/**
 * Connection lifecycle — internal plane (bearer-gated).
 *
 * OAuth handoff (#396 Phase 2): hadron-server owns the user-facing flow and
 * the callback URL; this tool owns the client secret and the tokens. Core's
 * callback forwards the authorization code here; the tool exchanges it,
 * derives the mailbox identity (ID-token claims first — personal Microsoft
 * accounts may fail /me — then the Graph profile), stores the encrypted
 * refresh token, and returns the identity. Core stores only that identity.
 *
 * POST /connections also accepts a raw `refreshToken` instead of a `code` —
 * the one-time Phase-2 migration path for tokens currently encrypted in
 * core's DB (core decrypts with its key; this tool re-encrypts with its own).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withConnection } from '../connectionCall.js';
import { encryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import { ConnectionNotFoundError, ValidationError } from '../errors.js';
import { logError, logInfo } from '../logger.js';
import { decodeIdToken } from '../providers/msgraph/auth.js';
import type { MsGraphProvider } from '../providers/msgraph/types.js';
import { isSubscribableFolder, registerFolderSubscription } from '../subscriptions.js';
import { respondWithError } from './respond.js';

const createSchema = z
  .object({
    code: z.string().min(1).optional(),
    redirectUri: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    mailboxEmail: z.string().min(1).optional(),
    displayName: z.string().optional(),
  })
  .refine((v) => (v.code ? !!v.redirectUri : !!v.refreshToken && !!v.mailboxEmail), {
    message: 'provide either {code, redirectUri} or {refreshToken, mailboxEmail}',
  });

const subscribeSchema = z.object({
  folder: z
    .string()
    .min(1)
    .transform((f) => f.toLowerCase()),
});

/** Build the /connections router over injected db + provider. */
export function connectionsRouter(db: Db, provider: MsGraphProvider): Router {
  const router = Router();

  // Create a connection: OAuth-code exchange (normal path) or direct
  // refresh-token import (migration path).
  router.post('/', async (req, res) => {
    try {
      const input = createSchema.parse(req.body ?? {});

      let refreshToken: string;
      let mailboxEmail: string | undefined = input.mailboxEmail;
      let displayName: string | undefined = input.displayName;

      if (input.code) {
        const tokens = await provider.exchangeCode(input.code, input.redirectUri!);
        // TokenResponse types refresh_token as present, but Microsoft omits
        // it when offline_access wasn't actually granted (tenant policy,
        // partial consent) — surface the real cause, not a crypto crash.
        if (!tokens.refresh_token) {
          throw new ValidationError(
            'code',
            'Microsoft did not return a refresh token — the offline_access scope was not granted',
          );
        }
        refreshToken = tokens.refresh_token;
        // ID-token claims first (works for personal accounts), /me fallback.
        const idClaims = decodeIdToken(tokens.id_token ?? '');
        const profile = await provider.fetchProfile(tokens.access_token);
        mailboxEmail = idClaims.email ?? profile.mail ?? profile.userPrincipalName ?? undefined;
        displayName = profile.displayName ?? idClaims.name ?? undefined;
        if (!mailboxEmail) {
          throw new ValidationError('code', 'could not determine the mailbox email from the Microsoft account');
        }
      } else {
        refreshToken = input.refreshToken!;
      }

      const connection = await db.connection.create({
        data: {
          mailboxEmail: mailboxEmail!,
          displayName: displayName ?? null,
          refreshTokenEnc: encryptToken(refreshToken),
        },
      });
      logInfo(`connection created for ${connection.mailboxEmail} (${connection.id})`);
      res.status(201).json({
        id: connection.id,
        provider: connection.provider,
        mailboxEmail: connection.mailboxEmail,
        displayName: connection.displayName,
        status: connection.status,
      });
    } catch (err) {
      respondWithError(res, err, 'create connection');
    }
  });

  // Connection identity + subscription state.
  router.get('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({
        where: { id: req.params.id },
        include: { subscriptions: true },
      });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      res.json({
        id: connection.id,
        provider: connection.provider,
        mailboxEmail: connection.mailboxEmail,
        displayName: connection.displayName,
        status: connection.status,
        lastError: connection.lastError,
        subscriptions: connection.subscriptions.map((s) => ({
          folder: s.folder,
          expiresAt: s.expiresAt.toISOString(),
        })),
      });
    } catch (err) {
      respondWithError(res, err, 'get connection');
    }
  });

  // Disconnect: best-effort Graph subscription teardown, then soft-delete.
  router.delete('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({
        where: { id: req.params.id },
        include: { subscriptions: true },
      });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();

      for (const sub of connection.subscriptions) {
        try {
          await withConnection(db, connection.id, undefined, (token) =>
            provider.deleteSubscription(token, sub.graphSubscriptionId),
          );
        } catch (err) {
          logError(`failed to delete Graph subscription ${sub.graphSubscriptionId} (continuing)`, err);
        }
      }
      await db.subscription.deleteMany({ where: { connectionId: connection.id } });
      await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
      res.json({ deleted: true });
    } catch (err) {
      respondWithError(res, err, 'delete connection');
    }
  });

  // Subscribe a folder to Graph change notifications.
  router.post('/:id/subscriptions', async (req, res) => {
    try {
      const { folder } = subscribeSchema.parse(req.body ?? {});
      if (!isSubscribableFolder(folder)) {
        throw new ValidationError('folder', `folder must be a subscribable folder (inbox, sentitems)`);
      }
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();

      const row = await registerFolderSubscription(db, provider, connection.id, folder);
      res.status(201).json({ folder: row.folder, expiresAt: row.expiresAt.toISOString() });
    } catch (err) {
      respondWithError(res, err, 'subscribe folder');
    }
  });

  return router;
}
