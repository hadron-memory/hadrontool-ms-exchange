# Agent dev guide — hadrontool-email

**hadrontool-email** is a planned, independently-deployed **email integration tool** for the
Hadron platform: it owns the email-provider relationship (Microsoft Exchange first) and exposes
a **provider-agnostic, agent-agnostic** email surface to the platform over **NATS** (pub/sub +
request/reply). Core keeps contracts, identity, and authorization; this tool owns the provider
transformation.

**Status: early / design.** The approach is in [docs/architecture.md](docs/architecture.md)
(Draft); there is no implementation yet. Add the commands + structure here once code lands.

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

**Contract & design sources** (the email contract is not in `::specs` yet):
- Spec 002 — *Generic Email Tool* (spec-kits): the ~15 operations, typed error codes, the
  `filter` shape, and the Zero-Trust `AgentEmailGrant` model — the contract this tool keeps.
- hadron-concept design discussions: *Platform Tools Architecture* (2026-06-17) and
  *Message Bus* (2026-06-11).

## Key invariants (before writing any code)

- **Agent-agnostic.** No agent name or agent-specific code appears in this tool or in the
  platform — the email surface is generic. (Pong is only a reference *consumer*, not built here.)
- **Provider-agnostic surface.** Exchange is the first provider behind a provider-neutral API;
  don't leak provider specifics into the contract.
- **The tool owns the provider; core owns the contract.** Identity, authorization
  (`AgentEmailGrant`), and canonical writes stay in core; this tool does the transformation and
  adds the event path spec 002 deferred.
- **NATS transport:** at-least-once delivery + idempotency + the outbox pattern (per the
  message-bus design); this tool is an early exerciser of the bus's request/reply path.
