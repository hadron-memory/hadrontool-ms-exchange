# hadrontool-ms-exchange

Microsoft Exchange email tool for the Hadron platform — a standalone
capability tool that **owns the Microsoft Graph provider relationship**:
OAuth refresh tokens, mail operations, and webhook subscriptions. It exposes
a **provider-neutral** operations surface over HTTP; `hadron-server` stays
the front door (identity, authorization, the email contract) and calls this
service with already-authorized requests.

One tool per provider: this tool is Exchange/Graph only. Gmail lands later as
a sibling tool. Provider-neutrality lives at the core boundary —
hadron-server's email surface dispatches by `connection.provider`.

See [docs/architecture.md](docs/architecture.md) for the boundary, the two
planes, and the decisions behind them. Extraction tracking:
[hadron-server#396](https://github.com/hadron-memory/hadron-server/issues/396).

## Surface

| Method | Path | Plane | Purpose |
|---|---|---|---|
| `POST` | `/ops/<operation>` | internal | Provider-neutral mail operations (spec 002 names) |
| `POST` | `/connections` | internal | Create a connection (OAuth code exchange, or raw-token import for migration) |
| `GET` | `/connections/:id` | internal | Connection identity + subscription state |
| `DELETE` | `/connections/:id` | internal | Teardown subscriptions + soft-delete |
| `POST` | `/connections/:id/subscriptions` | internal | Subscribe a folder (`inbox`, `sentitems`) to Graph notifications |
| `POST` | `/webhooks/msgraph` | **public** | Graph change notifications + `validationToken` handshake |
| `GET` | `/info` | internal | Capabilities (operation list) |
| `GET` | `/healthz` / `/readyz` | — | Liveness / readiness (readiness checks the DB) |

All internal routes require `Authorization: Bearer $MS_EXCHANGE_TOOL_TOKEN`;
in production the service refuses to start without it. Only
`/webhooks/msgraph` may be exposed publicly (Traefik routes that path only).

### Operations (v1)

`list-messages`, `get-message`, `list-folders`, `reply-to-message`,
`move-message`, `save-draft` (fresh or reply draft), `update-draft`,
`send-draft`, `delete-message`, `mark-read`, `flag-message`,
`categorize-message`.

Request body: the operation input (always includes `connectionId`) plus an
optional `idempotencyKey` on mutating operations — a replayed key returns the
stored response without touching Microsoft. Errors use the spec 002 typed
catalog (`connection_not_found`, `connection_unauthorized`,
`provider_rate_limited`, `not_found`, `validation_error`, …) as
`{ "error": "<code>", "message": "…", ...fields }`.

```bash
curl -sS -X POST http://hadrontool-ms-exchange:8080/ops/list-messages \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MS_EXCHANGE_TOOL_TOKEN" \
  -d '{"connectionId":"…","folder":"inbox","top":10,"unreadOnly":true}'
```

### Events (tool → core)

Folder subscriptions turn Graph notifications into normalized events —
`email.received` (inbox) / `email.sent` (sentitems) with the neutral message
shape — POSTed to `CORE_EVENTS_URL` (hadron-server's internal ingress) with
`CORE_EVENTS_TOKEN`. Unset ⇒ logged and dropped; a missing consumer never
breaks webhook handling. The transport is HTTP now, designed to wrap behind a
NATS subject later.

## Security

- **Bearer token** gate on every internal route; required in production.
- **Refresh tokens** are AES-256-GCM-encrypted at rest under this tool's own
  `TOKEN_ENCRYPTION_KEY` (never core's key) and never leave the service.
- **Webhook authenticity**: the Graph `clientState` is an HMAC of
  `(connectionId, folder)` under `WEBHOOK_CLIENT_STATE_SECRET`, verified on
  every notification; redeliveries are deduped.
- **No authorization logic here**: hadron-server authorizes every request
  *before* calling this tool — the tool never re-implements grants.

## Development

```bash
npm install
cp .env.example .env           # fill in what you need; see comments
createdb hadrontool_ms_exchange && npm run db:push
npm run dev                    # tsx watch on src/index.ts

npm test                       # vitest — requires the test DB once:
createdb hadrontool_ms_exchange_test && npm run db:test-setup
```

Tests run the real HTTP surface + real Postgres over a fake Graph provider —
no Microsoft credentials needed.

## Configuration

See [.env.example](.env.example). Key vars: `MS_EXCHANGE_TOOL_TOKEN`,
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_CLIENT_STATE_SECRET`,
`MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`, `WEBHOOK_BASE_URL`,
`CORE_EVENTS_URL` / `CORE_EVENTS_TOKEN`.
