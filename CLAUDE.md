# Agent dev guide — hadrontool-ms-exchange

**hadrontool-ms-exchange** (renamed from `hadrontool-email`, 2026-07-08) is an
independently-deployed **Microsoft Exchange email tool** for the Hadron platform: it owns the
Graph provider relationship — OAuth refresh tokens, mail operations, webhook subscriptions —
behind a **provider-neutral, agent-agnostic** HTTP surface. Core (hadron-server) keeps the
contract, identity, and authorization; this tool does the provider transformation. **One tool
per provider**: Gmail lands later as a sibling tool; provider-neutrality lives at the core
boundary (dispatch by `connection.provider`), not inside a multi-provider tool.

**Status: implemented (v1), pre-deploy.** Design: [docs/architecture.md](docs/architecture.md).
Extraction tracking + decisions: hadron-server#396.

## Commands

```bash
npm run dev          # tsx watch (port 8080)
npm test             # vitest — real HTTP + Postgres over a FAKE Graph provider
npm run typecheck
npm run db:push      # sync the tool's own DB (dev)
npm run db:test-setup # one-time: schema into hadrontool_ms_exchange_test
```

Local DBs: `hadrontool_ms_exchange` (dev, via `.env`), `hadrontool_ms_exchange_test`
(pinned by vitest.config.ts — tests never touch dev data).

**Prisma 7** (engine-less; differs from hadron-server's Prisma 6): the CLI
connection URL lives in `prisma.config.ts` (NOT in the schema datasource
block); the runtime client connects through `@prisma/adapter-pg` (src/db.ts);
the generated client is TypeScript under `src/generated/prisma/` (gitignored —
`prisma generate` runs in typecheck/pretest/build); `db push` no longer
auto-generates.

## Structure

- `src/ops/` — the provider-neutral operation registry (spec 002 names + typed errors);
  `POST /ops/<operation>`, idempotency for mutating ops.
- `src/providers/msgraph/` — the ONLY Microsoft-specific layer (`MsGraphProvider` interface in
  `types.ts`; production SDK impl in `client.ts`; OAuth in `auth.ts`). Tests inject fakes from
  `src/test/fakes.ts`.
- `src/routes/` — `ops` (internal), `connections` (internal; OAuth-code exchange + raw-token
  migration import + folder subscriptions), `webhooks` (the ONE public route: Graph handshake,
  HMAC clientState verify, dedupe, normalize, forward).
- `src/events/forwarder.ts` — the tool→core event seam (HTTP now, NATS-wrappable later).
- `src/jobs/renewal.ts` — subscription renewal worker (6h cycle, 12h lookahead, re-register on
  failure).

## Use of Hadron

This tool has no memory of its own yet — work against the shared ones:

- `hrn:memory:hadronmemory.com::dev` — shared findings, conventions, ops, the `preflight` routing index
- `hrn:memory:hadronmemory.com::specs` — product specs (loc-as-citation)
- `hrn:memory:hadronmemory.com::hadron-server` — the platform core this tool integrates with

(1) **Query Hadron before reading code/design.** Run `hadron_find_nodes` first, then
`hadron_get_node` on promising hits; cite node `loc` values.

(2) Read `hadron_get_node hrn:node:hadronmemory.com::dev::instructions` once per session, and
`hadron_get_node hrn:node:hadronmemory.com::dev::preflight` before a change.

(3) Capture a non-obvious finding the moment it emerges (`hadron_create_node` / `hadron_update_node`).

(4) The **Hadron CLI is a superset of the MCP tools.**

**Contract & design sources**:
- Spec 002 — *Generic Email Tool* (spec-kits): operation names, typed error codes, the `filter`
  shape. (`AgentEmailGrant` is a CORE concern, deferred — owner-only auth in v1.)
- `hadronmemory.com::hadrontool-pdf::reference:hadrontool-email` — the extraction decisions
  (2026-07-08: HTTP-callback events, tool-owned tokens, owner-only v1, one-tool-per-provider).

## Key invariants

- **Agent-agnostic.** No agent name or agent-specific code appears in this tool or the
  platform — the email surface is generic. (Pong is only a reference *consumer*, built as
  memory automation flows — see agent-pong#1.)
- **Provider-neutral surface, provider-specific internals.** Graph types never cross
  `src/ops/` — everything is normalized (`EmailMessage`); error codes come from the spec 002
  typed catalog and are stable public surface.
- **The tool owns the provider; core owns the contract.** Authorization happens in core BEFORE
  any call reaches this tool; never re-implement it here. Refresh tokens are encrypted under
  the tool's OWN key and never leave the service.
- **Event transport is HTTP now, bus-ready.** All tool→core delivery goes through the single
  forwarder seam; at-least-once semantics with dedupe (inbound) + idempotency keys (mutating ops).
- **Only `/webhooks/msgraph` is public.** The operations plane stays internal
  (`komodo_default`, container-name URL).
