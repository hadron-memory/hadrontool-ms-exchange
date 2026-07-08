# hadrontool-ms-exchange — architecture

Status: **implemented (v1)**, replacing the earlier draft that predated the
capability-tool extraction decisions. Decisions recorded 2026-07-08 (Holger)
on [hadron-server#396](https://github.com/hadron-memory/hadron-server/issues/396)
and in the Hadron node `hadronmemory.com::hadrontool-pdf::reference:hadrontool-email`.

## Where this sits

The second application of the **capability-tool pattern** hadrontool-pdf
established: hadron-server stays lean; provider integrations are standalone,
independently-deployed tools. Email is the harder case — the tool is
**stateful and secrets-bearing**, has **two planes**, needs **public
ingress** for one route, and its mutating operations need **idempotency**.

### Decisions (2026-07-08)

1. **One tool per provider, provider-named.** This tool owns Microsoft
   Exchange/Graph only; Gmail lands later as a sibling (e.g.
   `hadrontool-gmail`). Provider-neutrality lives at the **core boundary**:
   hadron-server's email contract, `emailClient`, GraphQL operations, and
   error codes stay provider-agnostic and dispatch by `connection.provider`
   (spec 002 US4 is preserved in core, not inside a multi-provider tool).
2. **Event transport: HTTP callback now.** The tool POSTs normalized events
   to hadron-server's internal ingress; the forwarder is a single seam
   (`src/events/forwarder.ts`) that can wrap behind a NATS subject later.
3. **Token ownership: the tool.** Encrypted Microsoft refresh tokens +
   subscription state live in the tool's own database; core keeps only the
   connection identity record — zero Graph columns in core.
4. **Authorization: owner-only v1, in core.** hadron-server checks that the
   caller owns the connection *before* calling this tool. The tool never
   receives an unauthorized request and never re-implements authorization
   (`AgentEmailGrant` is a core concern, deferred until the first
   third-party-agent consumer).

## The two planes

### Operations (request/reply, core → tool, internal)

`POST /ops/<operation>` with spec 002 operation names and the typed error
catalog (`spec-kits/specs/002-generic-email-tool/contracts/`). Bearer-gated
(`MS_EXCHANGE_TOOL_TOKEN`), internal-only (Docker network, no public route).
hadron-server's thin `emailClient` mirrors `pdfClient.ts`: bearer + timeout +
typed errors + graceful degradation when the tool is down.

Every operation loads the connection, decrypts the refresh token with the
tool's key, executes the Graph call (acquiring an access token per call,
persisting refresh-token rotation), and maps failures to typed codes. A
provider auth failure marks the connection `ERROR` so later calls
short-circuit as `connection_unauthorized` until the user reconnects.

**Idempotency**: mutating operations accept an `idempotencyKey`; a completed
key replays the stored response without touching Microsoft (at-least-once
callers). Keys are single-operation — reuse across operations is rejected.

### Events (async, tool → core, one public route)

Graph change-notification subscriptions per (connection, folder) — `inbox`
and `sentitems` in v1. `POST /webhooks/msgraph` is the ONLY public route
(Traefik routes exactly that path; Cloudflare DNS on the webhook host):

1. **Handshake**: Graph's `validationToken` is echoed as `text/plain`.
2. **Authenticity**: `clientState` is an HMAC of `(connectionId, folder)`
   under `WEBHOOK_CLIENT_STATE_SECRET` — never a raw id — verified against
   the subscription row before any work.
3. **Dedupe**: Graph delivers at-least-once; each (subscription, message)
   pair is processed once (`ProcessedNotification`).
4. **Normalize + forward**: the message is fetched, normalized to the
   provider-neutral shape, and POSTed to `CORE_EVENTS_URL` as
   `email.received` / `email.sent`. Delivery failure is logged, never fatal.

Subscriptions expire ≤3 days; the renewal worker (6h cycle, 12h lookahead)
renews or re-registers. Connections in `ERROR` are skipped.

## OAuth handoff (who holds what)

hadron-server owns the user-facing flow: it builds the authorize URL (client
id is public), receives the callback (it owns sessions + the Account page),
and forwards `{code, redirectUri}` to `POST /connections`. This tool holds
the **client secret**, performs the token exchange (the `redirectUri`
parameter must equal core's callback URL), derives the mailbox identity —
ID-token claims first (personal Microsoft accounts may fail Graph `/me`),
profile fallback — stores the encrypted refresh token, and returns the
identity. Core stores only that identity.

**Migration path**: `POST /connections` also accepts a raw `refreshToken` +
`mailboxEmail` — the one-time transfer of tokens currently encrypted in
core's `ExchangeConnection` rows (core decrypts with its key; the tool
re-encrypts with its own). Core's encrypted column is dropped only after the
tool-side copies are verified.

## Data model

`Connection` (encrypted refresh token, status, identity) →
`Subscription` (folder, Graph subscription id, expiry) +
`ProcessedNotification` (dedupe ledger) + `IdempotencyRecord`.
See [prisma/schema.prisma](../prisma/schema.prisma).

## Deployment

Komodo build → GHCR → `komodo_default`, Doppler-injected secrets (image bakes
the Doppler CLI; Komodo sets only `DOPPLER_TOKEN`) — the hadrontool-pdf
deployment model, plus the one public Traefik route for `/webhooks/msgraph`.
hadron-server's Doppler config gains `MS_EXCHANGE_TOOL_URL` +
`MS_EXCHANGE_TOOL_TOKEN`; this tool's config holds the Microsoft app
credentials, `DATABASE_URL` (own database), `TOKEN_ENCRYPTION_KEY`,
`WEBHOOK_CLIENT_STATE_SECRET`, `WEBHOOK_BASE_URL`, and `CORE_EVENTS_*`.
