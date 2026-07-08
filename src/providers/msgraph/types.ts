/**
 * Provider-layer types + the injectable MsGraphProvider interface.
 *
 * The ops layer (src/ops) and routes depend only on this interface; tests
 * inject a fake, and src/providers/msgraph/client.ts is the production
 * implementation over the Microsoft Graph SDK.
 */

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export interface MicrosoftProfile {
  mail: string | null;
  userPrincipalName: string;
  displayName: string | null;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject: string | null;
  from: { emailAddress: { name: string; address: string } } | null;
  toRecipients?: { emailAddress: { name: string; address: string } }[];
  receivedDateTime: string;
  isRead: boolean;
  bodyPreview: string;
  body: { contentType: string; content: string } | null;
  hasAttachments: boolean;
}

export interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface WebhookSubscription {
  id: string;
  expirationDateTime: string;
}

export interface ListMessagesOptions {
  top?: number;
  skip?: number;
  filter?: string;
  select?: string[];
  orderby?: string;
}

export type MessageFlag = 'notFlagged' | 'flagged' | 'complete';

/**
 * Result of a token-refreshing Graph call. When Microsoft rotated the refresh
 * token, `newRefreshToken` is set and the caller MUST persist it — the old
 * token may already be dead.
 */
export interface GraphCallResult<T> {
  data: T;
  newRefreshToken?: string;
}

/** Fields for composing a fresh (non-reply) draft. */
export interface DraftInput {
  to: string[];
  subject: string;
  bodyHtml: string;
}

/**
 * Everything the tool needs from Microsoft. One method per Graph interaction;
 * every mailbox method takes the connection's refresh token and reports
 * rotation via GraphCallResult.
 */
export interface MsGraphProvider {
  // ── OAuth ────────────────────────────────────────────────────────────
  exchangeCode(code: string, redirectUri: string): Promise<TokenResponse>;
  fetchProfile(accessToken: string): Promise<MicrosoftProfile>;

  // ── Mail operations (delegated /me — acts as the signed-in user) ─────
  listMessages(refreshToken: string, folder: string, options?: ListMessagesOptions): Promise<GraphCallResult<GraphMessage[]>>;
  getMessage(refreshToken: string, messageId: string): Promise<GraphCallResult<GraphMessage>>;
  replyToMessage(refreshToken: string, messageId: string, bodyHtml: string, replyAll: boolean): Promise<GraphCallResult<void>>;
  moveMessage(refreshToken: string, messageId: string, destinationFolderId: string): Promise<GraphCallResult<void>>;
  listFolders(refreshToken: string): Promise<GraphCallResult<GraphFolder[]>>;
  createDraft(refreshToken: string, draft: DraftInput): Promise<GraphCallResult<GraphMessage>>;
  createDraftReply(refreshToken: string, messageId: string, bodyHtml: string): Promise<GraphCallResult<GraphMessage>>;
  updateDraft(refreshToken: string, draftMessageId: string, bodyHtml: string): Promise<GraphCallResult<GraphMessage>>;
  sendDraft(refreshToken: string, draftMessageId: string): Promise<GraphCallResult<void>>;
  deleteMessage(refreshToken: string, messageId: string): Promise<GraphCallResult<void>>;
  setMessageReadStatus(refreshToken: string, messageId: string, isRead: boolean): Promise<GraphCallResult<void>>;
  flagMessage(refreshToken: string, messageId: string, flagStatus: MessageFlag): Promise<GraphCallResult<void>>;
  categorizeMessage(refreshToken: string, messageId: string, categories: string[]): Promise<GraphCallResult<void>>;

  // ── Webhook subscriptions ─────────────────────────────────────────────
  createSubscription(refreshToken: string, notificationUrl: string, clientState: string, resource: string): Promise<GraphCallResult<WebhookSubscription>>;
  renewSubscription(refreshToken: string, subscriptionId: string): Promise<GraphCallResult<WebhookSubscription>>;
  deleteSubscription(refreshToken: string, subscriptionId: string): Promise<GraphCallResult<void>>;
}
