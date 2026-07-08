/**
 * Provider-neutral operations — the spec 002 contract surface.
 *
 * Operation names, input shapes, and error codes follow
 * spec-kits/specs/002-generic-email-tool/contracts/. hadron-server's
 * emailClient calls POST /ops/<name>; nothing Microsoft-specific leaks out of
 * this layer (Graph types are normalized to EmailMessage / EmailFolder).
 *
 * v1 implements the operations that existed in hadron-server + PR #51:
 * list-messages, get-message, list-folders, reply-to-message, move-message,
 * save-draft, update-draft, send-draft, delete-message, mark-read,
 * flag-message, categorize-message. search-messages / forward-message /
 * attachments are additive later.
 *
 * Every operation:
 *  1. loads the connection (typed connection_not_found / connection_unauthorized),
 *  2. decrypts the refresh token with the tool's key,
 *  3. runs the provider call, persisting refresh-token rotation,
 *  4. maps provider failures to the typed catalog.
 */
import { z } from 'zod';
import type { Db } from '../db.js';
import { decryptToken, encryptToken } from '../crypto.js';
import {
  BodyRequiredError,
  ConnectionNotFoundError,
  ConnectionUnauthorizedError,
  EmailToolError,
  RecipientsRequiredError,
  ValidationError,
  mapGraphError,
} from '../errors.js';
import { logError } from '../logger.js';
import type { GraphCallResult, GraphMessage, MsGraphProvider } from '../providers/msgraph/types.js';

/** Provider-neutral message shape returned by every read surface. */
export interface EmailMessage {
  id: string;
  conversationId: string | null;
  subject: string | null;
  from: { name: string | null; address: string } | null;
  to: { name: string | null; address: string }[];
  receivedAt: string;
  isRead: boolean;
  snippet: string;
  body: { contentType: string; content: string } | null;
  hasAttachments: boolean;
}

/** Normalize a Graph message to the neutral shape. */
export function normalizeMessage(m: GraphMessage): EmailMessage {
  return {
    id: m.id,
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? null,
    from: m.from ? { name: m.from.emailAddress.name ?? null, address: m.from.emailAddress.address } : null,
    to: (m.toRecipients ?? []).map((r) => ({ name: r.emailAddress.name ?? null, address: r.emailAddress.address })),
    receivedAt: m.receivedDateTime,
    isRead: m.isRead,
    snippet: m.bodyPreview,
    body: m.body ? { contentType: m.body.contentType, content: m.body.content } : null,
    hasAttachments: m.hasAttachments,
  };
}

/**
 * Load an ACTIVE connection and its decrypted refresh token.
 * Missing/deleted → connection_not_found; status ERROR → connection_unauthorized.
 */
async function loadConnection(db: Db, connectionId: string) {
  const connection = await db.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
  if (connection.status === 'ERROR') throw new ConnectionUnauthorizedError();
  return { connection, refreshToken: decryptToken(connection.refreshTokenEnc) };
}

/**
 * Persist a rotated refresh token. Non-fatal on failure (the op itself
 * succeeded) but logged loudly — a lost rotation strands the connection.
 */
async function persistRotation(db: Db, connectionId: string, result: GraphCallResult<unknown>): Promise<void> {
  if (!result.newRefreshToken) return;
  try {
    await db.connection.update({
      where: { id: connectionId },
      data: { refreshTokenEnc: encryptToken(result.newRefreshToken) },
    });
  } catch (err) {
    logError(`failed to persist rotated refresh token for connection ${connectionId}`, err);
  }
}

/**
 * Run a provider call for a connection with the full lifecycle: load,
 * decrypt, call, persist rotation, map errors. On connection_unauthorized
 * the connection row is marked ERROR so later calls short-circuit.
 */
async function withConnection<T>(
  db: Db,
  connectionId: string,
  resourceHint: { resource: 'message' | 'draft' | 'folder'; id: string } | undefined,
  fn: (refreshToken: string) => Promise<GraphCallResult<T>>,
): Promise<T> {
  const { refreshToken } = await loadConnection(db, connectionId);
  try {
    const result = await fn(refreshToken);
    await persistRotation(db, connectionId, result);
    return result.data;
  } catch (err) {
    const mapped = mapGraphError(err, resourceHint);
    if (mapped instanceof ConnectionUnauthorizedError) {
      await db.connection
        .update({
          where: { id: connectionId },
          data: { status: 'ERROR', lastError: 'provider auth failure — user must reconnect' },
        })
        .catch(() => {});
    }
    throw mapped;
  }
}

const connectionIdSchema = z.object({ connectionId: z.string().min(1) });

/** One operation: input schema + handler. `mutating` ops accept an idempotency key at the route layer. */
export interface OperationDef {
  name: string;
  mutating: boolean;
  schema: z.ZodType<Record<string, unknown>>;
  run(db: Db, provider: MsGraphProvider, input: Record<string, unknown>): Promise<unknown>;
}

const listMessagesSchema = connectionIdSchema.extend({
  folder: z.string().min(1).default('inbox'),
  top: z.number().int().min(1).max(100).optional(),
  skip: z.number().int().min(0).optional(),
  unreadOnly: z.boolean().optional(),
});

const messageRefSchema = connectionIdSchema.extend({ messageId: z.string().min(1) });

/** The v1 operation registry, keyed by spec 002 operation name. */
export const OPERATIONS: Record<string, OperationDef> = {
  'list-messages': {
    name: 'list-messages',
    mutating: false,
    schema: listMessagesSchema,
    async run(db, provider, raw) {
      const input = listMessagesSchema.parse(raw);
      const messages = await withConnection(db, input.connectionId, { resource: 'folder', id: input.folder }, (token) =>
        provider.listMessages(token, input.folder, {
          top: input.top,
          skip: input.skip,
          ...(input.unreadOnly ? { filter: 'isRead eq false' } : {}),
        }),
      );
      return { messages: messages.map(normalizeMessage) };
    },
  },

  'get-message': {
    name: 'get-message',
    mutating: false,
    schema: messageRefSchema,
    async run(db, provider, raw) {
      const input = messageRefSchema.parse(raw);
      const message = await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.getMessage(token, input.messageId),
      );
      return { message: normalizeMessage(message) };
    },
  },

  'list-folders': {
    name: 'list-folders',
    mutating: false,
    schema: connectionIdSchema,
    async run(db, provider, raw) {
      const input = connectionIdSchema.parse(raw);
      const folders = await withConnection(db, input.connectionId, undefined, (token) => provider.listFolders(token));
      return {
        folders: folders.map((f) => ({
          id: f.id,
          name: f.displayName,
          totalCount: f.totalItemCount,
          unreadCount: f.unreadItemCount,
        })),
      };
    },
  },

  'reply-to-message': {
    name: 'reply-to-message',
    mutating: true,
    schema: messageRefSchema.extend({ bodyHtml: z.string(), replyAll: z.boolean().default(false) }),
    async run(db, provider, raw) {
      const schema = messageRefSchema.extend({ bodyHtml: z.string(), replyAll: z.boolean().default(false) });
      const input = schema.parse(raw);
      if (input.bodyHtml.trim() === '') throw new BodyRequiredError();
      await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.replyToMessage(token, input.messageId, input.bodyHtml, input.replyAll),
      );
      return { sent: true };
    },
  },

  'move-message': {
    name: 'move-message',
    mutating: true,
    schema: messageRefSchema.extend({ destinationFolderId: z.string().min(1) }),
    async run(db, provider, raw) {
      const schema = messageRefSchema.extend({ destinationFolderId: z.string().min(1) });
      const input = schema.parse(raw);
      await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.moveMessage(token, input.messageId, input.destinationFolderId),
      );
      return { moved: true };
    },
  },

  'save-draft': {
    name: 'save-draft',
    mutating: true,
    schema: connectionIdSchema.extend({
      // Either a reply-draft to an existing message, or a fresh draft.
      replyToMessageId: z.string().min(1).optional(),
      to: z.array(z.string().min(1)).optional(),
      subject: z.string().optional(),
      bodyHtml: z.string(),
    }),
    async run(db, provider, raw) {
      const schema = connectionIdSchema.extend({
        replyToMessageId: z.string().min(1).optional(),
        to: z.array(z.string().min(1)).optional(),
        subject: z.string().optional(),
        bodyHtml: z.string(),
      });
      const input = schema.parse(raw);
      if (input.bodyHtml.trim() === '') throw new BodyRequiredError();
      let draft: GraphMessage;
      if (input.replyToMessageId) {
        draft = await withConnection(db, input.connectionId, { resource: 'message', id: input.replyToMessageId }, (token) =>
          provider.createDraftReply(token, input.replyToMessageId!, input.bodyHtml),
        );
      } else {
        if (!input.to || input.to.length === 0) throw new RecipientsRequiredError();
        if (input.subject == null) throw new ValidationError('subject', 'subject is required for a fresh draft');
        draft = await withConnection(db, input.connectionId, undefined, (token) =>
          provider.createDraft(token, { to: input.to!, subject: input.subject!, bodyHtml: input.bodyHtml }),
        );
      }
      return { draftId: draft.id, conversationId: draft.conversationId ?? null };
    },
  },

  'update-draft': {
    name: 'update-draft',
    mutating: true,
    schema: connectionIdSchema.extend({ draftId: z.string().min(1), bodyHtml: z.string() }),
    async run(db, provider, raw) {
      const schema = connectionIdSchema.extend({ draftId: z.string().min(1), bodyHtml: z.string() });
      const input = schema.parse(raw);
      if (input.bodyHtml.trim() === '') throw new BodyRequiredError();
      const draft = await withConnection(db, input.connectionId, { resource: 'draft', id: input.draftId }, (token) =>
        provider.updateDraft(token, input.draftId, input.bodyHtml),
      );
      return { draftId: draft.id };
    },
  },

  'send-draft': {
    name: 'send-draft',
    mutating: true,
    schema: connectionIdSchema.extend({ draftId: z.string().min(1) }),
    async run(db, provider, raw) {
      const schema = connectionIdSchema.extend({ draftId: z.string().min(1) });
      const input = schema.parse(raw);
      await withConnection(db, input.connectionId, { resource: 'draft', id: input.draftId }, (token) =>
        provider.sendDraft(token, input.draftId),
      );
      return { sent: true };
    },
  },

  'delete-message': {
    name: 'delete-message',
    mutating: true,
    schema: messageRefSchema,
    async run(db, provider, raw) {
      const input = messageRefSchema.parse(raw);
      await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.deleteMessage(token, input.messageId),
      );
      return { deleted: true };
    },
  },

  'mark-read': {
    name: 'mark-read',
    mutating: true,
    schema: messageRefSchema.extend({ isRead: z.boolean().default(true) }),
    async run(db, provider, raw) {
      const schema = messageRefSchema.extend({ isRead: z.boolean().default(true) });
      const input = schema.parse(raw);
      await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.setMessageReadStatus(token, input.messageId, input.isRead),
      );
      return { isRead: input.isRead };
    },
  },

  'flag-message': {
    name: 'flag-message',
    mutating: true,
    schema: messageRefSchema.extend({ flag: z.enum(['notFlagged', 'flagged', 'complete']).default('flagged') }),
    async run(db, provider, raw) {
      const schema = messageRefSchema.extend({ flag: z.enum(['notFlagged', 'flagged', 'complete']).default('flagged') });
      const input = schema.parse(raw);
      await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.flagMessage(token, input.messageId, input.flag),
      );
      return { flag: input.flag };
    },
  },

  'categorize-message': {
    name: 'categorize-message',
    mutating: true,
    schema: messageRefSchema.extend({ categories: z.array(z.string()) }),
    async run(db, provider, raw) {
      const schema = messageRefSchema.extend({ categories: z.array(z.string()) });
      const input = schema.parse(raw);
      await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
        provider.categorizeMessage(token, input.messageId, input.categories),
      );
      return { categories: input.categories };
    },
  },
};

/**
 * Execute an operation by name with idempotency: a mutating call carrying an
 * `idempotencyKey` that was already completed returns the stored response
 * without touching the provider (at-least-once callers, spec 002 / #396).
 */
export async function runOperation(
  db: Db,
  provider: MsGraphProvider,
  name: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ result: unknown; replayed: boolean }> {
  const op = OPERATIONS[name];
  if (!op) throw new ValidationError('operation', `unknown operation "${name}"`);

  if (idempotencyKey && op.mutating) {
    const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey } });
    if (existing) {
      if (existing.operation !== name) {
        throw new ValidationError('idempotencyKey', 'key was used for a different operation');
      }
      return { result: JSON.parse(existing.responseJson), replayed: true };
    }
  }

  let result: unknown;
  try {
    result = await op.run(db, provider, input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      throw new ValidationError(issue?.path.join('.') || 'input', issue?.message ?? 'invalid input');
    }
    if (err instanceof EmailToolError) throw err;
    throw mapGraphError(err);
  }

  if (idempotencyKey && op.mutating) {
    await db.idempotencyRecord
      .create({ data: { key: idempotencyKey, operation: name, responseJson: JSON.stringify(result) } })
      .catch(() => {
        // Lost race with a concurrent identical call — the other writer's
        // stored response is equivalent; this call already did the work.
      });
  }
  return { result, replayed: false };
}
