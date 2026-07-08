/**
 * Production MsGraphProvider — the Microsoft Graph SDK implementation.
 *
 * Ported from hadron-server src/integrations/exchange/client.ts plus the
 * PR #51 salvage operations (drafts, flag, categorize, read-status, the
 * parameterized subscription resource and folder-scoped listing). All mail
 * calls use /me endpoints (delegated permissions — the tool acts as the
 * signed-in user), acquire an access token from the connection's refresh
 * token per call, and surface refresh-token rotation via GraphCallResult.
 */
import 'isomorphic-fetch';
import { Client } from '@microsoft/microsoft-graph-client';
import { exchangeMicrosoftCode, fetchMicrosoftProfile, refreshAccessToken } from './auth.js';
import type {
  DraftInput,
  GraphCallResult,
  GraphFolder,
  GraphMessage,
  ListMessagesOptions,
  MessageFlag,
  MsGraphProvider,
  WebhookSubscription,
} from './types.js';

/** Graph subscriptions live ≤3 days; request just under the max. */
function subscriptionExpiry(): string {
  return new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60000).toISOString();
}

/** Build a Graph SDK client around a bearer access token. */
function createGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

/**
 * Execute a Graph call using a refresh token: acquire an access token, run
 * the call, retry once on 429 honoring Retry-After, and report refresh-token
 * rotation. Everything else propagates for mapGraphError at the ops layer.
 */
async function withToken<T>(
  refreshToken: string,
  fn: (client: Client) => Promise<T>,
): Promise<GraphCallResult<T>> {
  const tokenRes = await refreshAccessToken(refreshToken);
  const client = createGraphClient(tokenRes.access_token);
  const newRefreshToken = tokenRes.refresh_token !== refreshToken ? tokenRes.refresh_token : undefined;
  try {
    try {
      const data = await fn(client);
      return { data, newRefreshToken };
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 429) {
        const rawRetry = (err as { headers?: { get?: (h: string) => string | null } })?.headers?.get?.('Retry-After');
        const retryAfter = parseInt(rawRetry ?? '5', 10);
        await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000));
        const data = await fn(client);
        return { data, newRefreshToken };
      }
      throw err;
    }
  } catch (err) {
    // The refresh SUCCEEDED before fn() failed — a rotated token must still
    // reach the caller or (on rotating tenants) one harmless Graph error
    // permanently strands the connection. withConnection persists it from
    // the error object.
    if (newRefreshToken && err != null && typeof err === 'object') {
      (err as { newRefreshToken?: string }).newRefreshToken = newRefreshToken;
    }
    throw err;
  }
}

/** Only well-known folder names / Graph folder ids reach the URL path. */
function folderPath(folder: string): string {
  return `/me/mailFolders/${encodeURIComponent(folder)}/messages`;
}

export const msGraphProvider: MsGraphProvider = {
  exchangeCode: exchangeMicrosoftCode,
  fetchProfile: fetchMicrosoftProfile,

  async listMessages(refreshToken, folder, options: ListMessagesOptions = {}) {
    return withToken(refreshToken, async (client) => {
      let request = client
        .api(folderPath(folder))
        .top(options.top ?? 25)
        .orderby(options.orderby ?? 'receivedDateTime DESC');
      if (options.skip) request = request.skip(options.skip);
      if (options.filter) request = request.filter(options.filter);
      if (options.select) request = request.select(options.select);
      const response = await request.get();
      return response.value as GraphMessage[];
    });
  },

  async getMessage(refreshToken, messageId) {
    return withToken(refreshToken, async (client) => {
      return client.api(`/me/messages/${messageId}`).get();
    });
  },

  async replyToMessage(refreshToken, messageId, bodyHtml, replyAll) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${messageId}/${replyAll ? 'replyAll' : 'reply'}`).post({
        comment: bodyHtml,
      });
    });
  },

  async moveMessage(refreshToken, messageId, destinationFolderId) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${messageId}/move`).post({
        destinationId: destinationFolderId,
      });
    });
  },

  async listFolders(refreshToken) {
    return withToken(refreshToken, async (client) => {
      const response = await client.api('/me/mailFolders').get();
      return response.value as GraphFolder[];
    });
  },

  async createDraft(refreshToken, draft: DraftInput) {
    return withToken(refreshToken, async (client) => {
      return client.api('/me/messages').post({
        subject: draft.subject,
        body: { contentType: 'html', content: draft.bodyHtml },
        toRecipients: draft.to.map((address) => ({ emailAddress: { address } })),
      }) as Promise<GraphMessage>;
    });
  },

  async createDraftReply(refreshToken, messageId, bodyHtml) {
    return withToken(refreshToken, async (client) => {
      // createReply creates a draft reply in the Drafts folder (does NOT send)
      return client.api(`/me/messages/${messageId}/createReply`).post({
        message: {
          body: { contentType: 'html', content: bodyHtml },
        },
      }) as Promise<GraphMessage>;
    });
  },

  async updateDraft(refreshToken, draftMessageId, bodyHtml) {
    return withToken(refreshToken, async (client) => {
      return client.api(`/me/messages/${draftMessageId}`).patch({
        body: { contentType: 'html', content: bodyHtml },
      }) as Promise<GraphMessage>;
    });
  },

  async sendDraft(refreshToken, draftMessageId) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${draftMessageId}/send`).post({});
    });
  },

  async deleteMessage(refreshToken, messageId) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${messageId}`).delete();
    });
  },

  async setMessageReadStatus(refreshToken, messageId, isRead) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${messageId}`).patch({ isRead });
    });
  },

  async flagMessage(refreshToken, messageId, flagStatus: MessageFlag) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${messageId}`).patch({
        flag: { flagStatus },
      });
    });
  },

  async categorizeMessage(refreshToken, messageId, categories) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/me/messages/${messageId}`).patch({ categories });
    });
  },

  async createSubscription(refreshToken, notificationUrl, clientState, resource) {
    return withToken(refreshToken, async (client) => {
      return client.api('/subscriptions').post({
        changeType: 'created',
        notificationUrl,
        resource,
        expirationDateTime: subscriptionExpiry(),
        clientState,
      }) as Promise<WebhookSubscription>;
    });
  },

  async renewSubscription(refreshToken, subscriptionId) {
    return withToken(refreshToken, async (client) => {
      return client.api(`/subscriptions/${subscriptionId}`).patch({
        expirationDateTime: subscriptionExpiry(),
      }) as Promise<WebhookSubscription>;
    });
  },

  async deleteSubscription(refreshToken, subscriptionId) {
    return withToken(refreshToken, async (client) => {
      await client.api(`/subscriptions/${subscriptionId}`).delete();
    });
  },
};
