/**
 * Test doubles: an in-memory MsGraphProvider fake with call recording, and a
 * fixture GraphMessage builder. Route tests run the real Express app + real
 * test DB over these fakes — only Microsoft is simulated.
 */
import type {
  GraphCallResult,
  GraphMessage,
  MsGraphProvider,
} from '../providers/msgraph/types.js';

/** Build a plausible Graph message fixture. */
export function graphMessage(overrides: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    subject: 'Office hours',
    from: { emailAddress: { name: 'A Student', address: 'student@example.edu' } },
    toRecipients: [{ emailAddress: { name: 'The Professor', address: 'prof@example.edu' } }],
    receivedDateTime: '2026-07-08T12:00:00Z',
    isRead: false,
    bodyPreview: 'When are your office hours?',
    body: { contentType: 'html', content: '<p>When are your office hours?</p>' },
    hasAttachments: false,
    ...overrides,
  };
}

/** Wrap data in a GraphCallResult. */
function ok<T>(data: T, newRefreshToken?: string): GraphCallResult<T> {
  return { data, newRefreshToken };
}

export interface FakeProviderOptions {
  /** When set, every mailbox call reports this rotated refresh token once. */
  rotateTo?: string;
  /** When set, the named methods throw this error. */
  failWith?: { methods: string[]; error: unknown };
}

/**
 * A recording fake provider. `calls` collects [method, args] tuples so tests
 * assert both HTTP behavior and what reached "Microsoft".
 */
export function fakeProvider(options: FakeProviderOptions = {}): MsGraphProvider & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  let rotation = options.rotateTo;

  /** Record a call; throw if configured to fail; consume one rotation. */
  function record<T>(method: string, args: unknown[], data: T): GraphCallResult<T> {
    calls.push([method, args]);
    if (options.failWith?.methods.includes(method)) throw options.failWith.error;
    const result = ok(data, rotation);
    rotation = undefined;
    return result;
  }

  return {
    calls,
    async exchangeCode(code, redirectUri) {
      calls.push(['exchangeCode', [code, redirectUri]]);
      if (options.failWith?.methods.includes('exchangeCode')) throw options.failWith.error;
      return {
        access_token: 'at-1',
        refresh_token: 'rt-fresh',
        // header.payload.signature — payload carries personal-account claims
        id_token: `x.${Buffer.from(JSON.stringify({ preferred_username: 'personal@outlook.com', name: 'Personal User' })).toString('base64url')}.y`,
        expires_in: 3600,
        scope: 'Mail.Read',
        token_type: 'Bearer',
      };
    },
    async fetchProfile() {
      calls.push(['fetchProfile', []]);
      // Personal-account behavior: /me fails soft → null fields.
      return { mail: null, userPrincipalName: '', displayName: null };
    },
    async listMessages(token, folder, opts) {
      return record('listMessages', [token, folder, opts], [graphMessage()]);
    },
    async getMessage(token, messageId) {
      return record('getMessage', [token, messageId], graphMessage({ id: messageId }));
    },
    async replyToMessage(token, messageId, bodyHtml, replyAll) {
      return record('replyToMessage', [token, messageId, bodyHtml, replyAll], undefined);
    },
    async moveMessage(token, messageId, dest) {
      return record('moveMessage', [token, messageId, dest], undefined);
    },
    async listFolders(token) {
      return record('listFolders', [token], [
        { id: 'f-inbox', displayName: 'Inbox', totalItemCount: 10, unreadItemCount: 2 },
      ]);
    },
    async createDraft(token, draft) {
      return record('createDraft', [token, draft], graphMessage({ id: 'draft-new' }));
    },
    async createDraftReply(token, messageId, bodyHtml) {
      return record('createDraftReply', [token, messageId, bodyHtml], graphMessage({ id: 'draft-reply' }));
    },
    async updateDraft(token, draftId, bodyHtml) {
      return record('updateDraft', [token, draftId, bodyHtml], graphMessage({ id: draftId }));
    },
    async sendDraft(token, draftId) {
      return record('sendDraft', [token, draftId], undefined);
    },
    async deleteMessage(token, messageId) {
      return record('deleteMessage', [token, messageId], undefined);
    },
    async setMessageReadStatus(token, messageId, isRead) {
      return record('setMessageReadStatus', [token, messageId, isRead], undefined);
    },
    async flagMessage(token, messageId, flag) {
      return record('flagMessage', [token, messageId, flag], undefined);
    },
    async categorizeMessage(token, messageId, categories) {
      return record('categorizeMessage', [token, messageId, categories], undefined);
    },
    async createSubscription(token, notificationUrl, clientState, resource) {
      return record('createSubscription', [token, notificationUrl, clientState, resource], {
        id: `graph-sub-${calls.length}`,
        expirationDateTime: new Date(Date.now() + 71 * 60 * 60 * 1000).toISOString(),
      });
    },
    async renewSubscription(token, subscriptionId) {
      return record('renewSubscription', [token, subscriptionId], {
        id: subscriptionId,
        expirationDateTime: new Date(Date.now() + 71 * 60 * 60 * 1000).toISOString(),
      });
    },
    async deleteSubscription(token, subscriptionId) {
      return record('deleteSubscription', [token, subscriptionId], undefined);
    },
  };
}
