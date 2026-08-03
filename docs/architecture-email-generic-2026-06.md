> **Archived design doc — preserved, not current.**
>
> This is the original **provider-agnostic email tool** architecture, written 2026-06-18 in
> the `hadrontool-email` repo before it was renamed to `hadrontool-ms-exchange` and its scope
> narrowed to a single provider. It is kept here because the successor docs are per-provider
> rewrites, not supersets: the cross-provider reasoning below — provider separation, the NATS
> subject/envelope design, delivery semantics, the dependency list, and the open decisions —
> has no counterpart in [`architecture.md`](architecture.md) or in `hadrontool-gmail`, yet it
> is the reasoning behind the one-tool-per-provider split those repos actually implement.
>
> **For current design, read [`architecture.md`](architecture.md).** Treat everything below as
> of its date: links, issue numbers, and open questions were accurate on 2026-06-18 and have
> not been updated.

---

# hadrontool-email — Architecture

**Status:** Draft for review · **Date:** 2026-06-18 · Resolves [hadrontool-email#1](https://github.com/hadron-memory/hadrontool-email/issues/1)

A high-level plan for a **generic email integration tool** on the Hadron platform: an
independently-deployed service that owns the email-provider relationship (Microsoft Exchange
first) and exposes a provider-agnostic, agent-agnostic email surface to the platform over NATS.

This document is meant to validate the *approach*, not to be an implementation spec. It says
where the tool sits, what messages cross the boundary, and what has to exist first.

## What this builds on (and what it changes)

| Prior art | What we keep | What we change |
|---|---|---|
| [spec 002 — Generic Email Tool](https://github.com/hadron-memory/spec-kits/tree/main/specs/002-generic-email-tool) | The whole **contract**: the ~15 operations, the typed error codes, the `filter` shape, the `AgentEmailGrant` Zero-Trust model, the agent-agnostic naming invariant. | spec 002 put the implementation *inside* `hadron-server` (`src/integrations/email/`) and was **pull-only** (webhook/event path explicitly deferred). We move the implementation **out** into this tool and **add the event path**. |
| [Platform Tools Architecture (2026-06-17)](https://github.com/hadron-memory/hadron-concept/blob/main/design-discussions/hadron-platform/2026-06-17-platform-tools-architecture/summary.md) | "A tool is the async processing step a feature delegates"; core owns identity/contracts/canonical-write, the tool owns transformation; first-party tools speak NATS directly; contracts are versioned and transport-agnostic. | We apply it concretely for the first event-driven, request/reply tool. |
| [Message Bus (2026-06-11)](https://github.com/hadron-memory/hadron-concept/blob/main/design-discussions/hadron-platform/2026-06-11-message-bus/summary.md) | NATS JetStream, the narrow `BusClient`, at-least-once + idempotency, the outbox. | This tool is an early exerciser of the bus's pub/sub and request/reply ("V2") patterns. |
| [Agent Pong](https://github.com/hadron-memory/hadron-concept/tree/main/agents/pong) | The reference consumer — what the surface has to support. | Pong is **not** built here. No agent code or agent name appears in this tool or in the platform. |
| [hadron-server PR #51](https://github.com/hadron-memory/hadron-server/pull/51) | The user-scoped OAuth refinements were correct. | Rejected: it put **provider + agent** code into the platform. This tool removes *both* from the platform. |

The one-line stance: **spec 002 took Pong out of the platform; this takes the email *provider* out of the platform too.** What's left in core is contracts, identity, and authorization.

## Where this sits in the spec corpus

The authoritative platform specs now live as nodes in the **`hadronmemory.com::specs`** memory
(loc-citation scheme `cor:<service>:<feature>:<rule>`), not in the spec-kit markdown. The
generic-email-tool spec (002) has **not been migrated there yet**, so this plan is reconciled
against what the corpus holds *today* and flags every node it would change or add:

| Live loc-citation | What it says today | What this plan does to it |
|---|---|---|
| [`cor:dmo:080:04`](hrn:node:hadronmemory.com::specs::cor:dmo:080:04) — `ExchangeConnection` | **Org-scoped** mailbox; `refreshTokenEncrypted` + `webhookSubscriptionId`/`webhookExpiresAt` **in core**; "email-ingestion pipeline" (v0.0.1). | **Change** — re-scope to a provider-agnostic, **user-owned** `Connection` (per spec 002 / PR #134) and move the Graph token + webhook columns **into this tool**. See Open Decision 1. |
| [`cor:int`](hrn:node:hadronmemory.com::specs::cor:int) — Integrations | Only `cor:int:010` **Git sync** exists. | **Add** — an email-integration feature spec describing this tool and the NATS contract. |
| [`cor:dmo:050:08`](hrn:node:hadronmemory.com::specs::cor:dmo:050:08) `AgentSubscription` · [`cor:dmo:050:09`](hrn:node:hadronmemory.com::specs::cor:dmo:050:09) `AgentMemoryItem` | Subscription is **license-only** (grants no access); `AgentMemoryItem` is a per-**memory** `(agent, memory, role)` cap. | **Add** — a per-**connection** grant (spec 002's `AgentEmailGrant`), modeled exactly parallel to `AgentMemoryItem` but keyed on the email connection. It does **not** exist in the corpus yet. |
| [`cor:acl:010:02`](hrn:node:hadronmemory.com::specs::cor:acl:010:02) — strict ownership | Single-owner read/write; ADMIN/OWNER don't bypass. | **Honor** — the per-call grant check below is the email-connection analogue of this Zero-Trust posture. |
| Message bus · platform-tools architecture | **Not specced** in `cor:*` — only hadron-concept design discussions (2026-06-11, 2026-06-17). | **Depends on** — both must be specced and built before this tool ships (see *What must exist first*). |

## Where the tool sits

```
┌──────────────────────────────────────────────────────────────────────┐
│  hadron-server (open core)                                             │
│                                                                        │
│  • Connection identity record  (connectionId, userId, mailbox,        │
│      provider, status)         — agent-agnostic, provider-agnostic     │
│  • AgentEmailGrant             — Zero-Trust: who may use which mailbox  │
│  • The email contract          — owns subjects, schemas, versions      │
│  • Agent-facing surface        — the ~15 email tools over MCP+GraphQL   │
│      (unchanged from spec 002; now backed by a bus call, not Graph)    │
│  • Bus + outbox + event dispatcher → headless agent runner             │
└───────────────┬───────────────────────────────────────┬──────────────┘
       requestReply  (operations)            subscribe   │ (events)
   email.exchange.op.<verb>.v1        email.received.v1 / email.sent.v1
                │   NATS (internal-only backbone)         ▲
                ▼                                          │
┌──────────────────────────────────────────────────────────────────────┐
│  hadrontool-email  (THIS REPO — separate process/container)           │
│                                                                        │
│  • Microsoft Graph adapter     — implements each generic verb          │
│  • OAuth token store + refresh — provider secrets live here, not core  │
│  • Graph webhook lifecycle     — create/renew/delete subscriptions     │
│  • Public webhook endpoint     — receives Graph change notifications,  │
│      normalizes, and publishes email.received / email.sent onto NATS   │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ Microsoft Graph API + OAuth
                                 ▼
                        User's Exchange mailbox
```

**The split.** Core keeps the things that are the *same* for every provider and every agent:
the connection's identity, the authorization grant, the contract, and the bus. The tool keeps
everything that is *Microsoft-specific*: the Graph SDK, the OAuth refresh token, the webhook
subscription IDs, the 3-day renewal timer, the `validationToken` handshake — none of which has
any meaning to core or to another provider. This is stricter than the live spec: `cor:dmo:080:04`
keeps `refreshTokenEncrypted` and the `webhookSubscriptionId`/`webhookExpiresAt` columns on
`ExchangeConnection` in core, because the integration code is in core. With the tool separated,
**core's schema keeps zero Graph-specific columns** — a change to that node (Open Decision 1).

## Provider separation — one tool per provider

**Decision: one tool per provider, all serving the same generic contract.** Exchange ships in
this repo (`hadrontool-email`, v1). IMAP and Gmail, when they land, are *sibling tools in their
own repos*, subscribing to the same operation contract under a different provider segment.

Why not one tool with internal adapters (the spec-002 `providers/<name>/` shape)?

- **Dependency isolation** — the Graph SDK, IMAP libraries, and Gmail SDK never co-mingle in one
  image; each tool carries only its own provider's deps.
- **Independent deploy / scale / certify** — per the platform-tools model, "multiple tools may
  serve one contract and may compete," and certification is per-tool-per-contract-version. A
  Gmail outage or a Graph SDK bump touches one tool.
- **Third-party providers** — an outside team can ship a Fastmail or Proton tool against the
  published contract without a PR to this repo.

**Routing.** Core resolves `connectionId → provider` from the Connection record and dispatches the
operation to that provider's subject subtree (`email.exchange.op.*`, later `email.imap.op.*`).
The agent never sees the provider — it calls the generic tool with a `connectionId`; core does
the routing. Events are already normalized, so they need **no** provider segment.

## NATS subjects & messages

Two interaction patterns over one tool:

- **Operations** — synchronous, core → tool, **request/reply**. An agent's LLM calls an email
  tool and needs the result inline to keep reasoning. Maps to `BusClient.requestReply`.
- **Events** — asynchronous, tool → core/agents, **pub/sub fan-out**. A new email arrives and
  zero or more agents react. Maps to `BusClient.publish` / `subscribePubSub`.

Subjects follow the `asset.uploaded.v1` precedent: dotted, lowercase, `.vN` suffix; version in
both the subject and the envelope. Org/tenant scoping rides the message-bus naming convention
(carried in the envelope; subject-prefixed when NATS-account tenancy lands in V2).

### Common envelope

```jsonc
{
  "v": 1,                       // schema version (mirrors the subject)
  "idempotencyKey": "uuid",     // REQUIRED — at-least-once means handlers must dedupe
  "connectionId": "conn_…",     // the mailbox this concerns
  "correlationId": "uuid",      // request/reply pairing (operations only)
  "occurredAt": "ISO-8601",
  "payload": { /* per subject */ }
}
```

### Operations plane (request/reply) — `email.<provider>.op.<verb>.v1`

One subject per operation from spec 002. Core publishes the request **after** `assertGrant`
passes, so the tool can trust that anything on the bus is already authorized (the bus is
internal-only). The reply payload is the generic result **or** a typed error from the catalog.

| spec-002 operation | Subject (Exchange) | Graph call behind it |
|---|---|---|
| `list-messages` | `email.exchange.op.list-messages.v1` | `GET /me/mailFolders/{f}/messages` |
| `get-message` | `email.exchange.op.get-message.v1` | `GET /me/messages/{id}` |
| `search-messages` | `email.exchange.op.search-messages.v1` | `GET /me/messages?$search` |
| `get-thread` | `email.exchange.op.get-thread.v1` | `GET …?$filter=conversationId` |
| `list-folders` | `email.exchange.op.list-folders.v1` | `GET /me/mailFolders` |
| `get-attachment` | `email.exchange.op.get-attachment.v1` | `GET …/attachments/{id}` |
| `send-message` | `email.exchange.op.send-message.v1` | `POST /me/sendMail` |
| `reply-to-message` | `email.exchange.op.reply-to-message.v1` | `POST /me/messages/{id}/reply` |
| `forward-message` | `email.exchange.op.forward-message.v1` | `POST /me/messages/{id}/forward` |
| `save-draft` | `email.exchange.op.save-draft.v1` | `POST /me/messages` (isDraft) |
| `update-draft` | `email.exchange.op.update-draft.v1` | `PATCH /me/messages/{id}` |
| `send-draft` | `email.exchange.op.send-draft.v1` | `POST /me/messages/{id}/send` |
| `mark-read` | `email.exchange.op.mark-read.v1` | `PATCH /me/messages/{id}` |
| `move-message` | `email.exchange.op.move-message.v1` | `POST /me/messages/{id}/move` |
| `delete-message` | `email.exchange.op.delete-message.v1` | `POST …/move` → Deleted Items |

### Events plane (pub/sub) — generic, normalized, provider-agnostic

| Subject | Published when | Consumed by |
|---|---|---|
| `email.received.v1` | A new message lands in a connected mailbox | Core dispatcher → granted+subscribed agents |
| `email.sent.v1` | The user sends a message (the learning-loop signal) | Core dispatcher → granted+subscribed agents |
| `email.connection.unauthorized.v1` | The tool's OAuth refresh fails permanently | Core → marks Connection `ERROR`, prompts reconnect |

`email.received.v1` payload (already translated out of Graph shapes):

```jsonc
{
  "v": 1, "idempotencyKey": "…", "connectionId": "conn_…", "occurredAt": "…",
  "payload": {
    "messageId": "msg_…",           // opaque platform id, not a Graph id
    "conversationId": "thr_…",
    "from": { "name": "Ada L.", "email": "ada@acme.com" },
    "subject": "Re: office hours",
    "snippet": "Could we move to Thursday…",
    "folder": "Inbox",
    "unread": true,
    "hasAttachment": false
  }
}
```

`email.sent.v1` carries the same message envelope for the sent item; an agent matches it to a
draft it created (by `conversationId`) to run its learning loop.

### Delivery semantics (the correctness detail that decides "right path?")

At-least-once delivery means **a `send` could be redelivered and double-send an email.** Two rules:

1. **Mutating operations** (`send-*`, `reply-*`, `forward-*`, draft writes) carry an
   `idempotencyKey`. The tool records processed keys and **returns the prior result on replay**
   instead of re-sending. Reads need no dedupe.
2. **Reads** can use plain (at-most-once) request/reply — if a reply is lost, the agent retries.
   **Mutations** should ride a durable path (JetStream-backed request/reply, or
   publish-then-await-reply) so an in-flight crash doesn't lose the fact that the send happened.

Inbound events use the outbox on the tool side too: the tool commits "I saw this Graph
notification" and publishes `email.received.v1` from the outbox, so a crash between fetch and
publish doesn't drop the email.

## Microsoft Exchange integration

The Exchange adapter is the prior Pong work, lifted into this tool and stripped of anything
Pong-specific. Three pieces already exist in `hadron-server/src/integrations/exchange/`
(`auth.ts`, `client.ts`, and the webhook lifecycle from PR #51) — they **move here**:

- **OAuth** (delegated, Authorization-Code flow, one multi-tenant Azure app, `/me` endpoints,
  AES-256-GCM refresh token, Microsoft-managed rotation). The token store moves into the tool;
  see Open Decision 1 for the callback/UX consequence.
- **Graph client** — each generic verb → the Graph call in the table above; `401 → refresh &
  retry`, `429 → respect Retry-After` (→ `provider_rate_limited`), Graph errors → typed codes.
- **Webhook lifecycle** — two Graph subscriptions per connection (`inbox` and `sentItems`),
  `clientState` to tag which connection, the `validationToken` handshake, and the 6-hour renewal
  timer against the 3-day TTL. The tool hosts the public endpoint Graph calls; on a notification
  it fetches the changed message, normalizes it, and publishes `email.received.v1` /
  `email.sent.v1`.

Everything Microsoft — token shapes, Graph IDs, subscription IDs, draft IDs — stays inside this
boundary. The bus only ever sees normalized, opaque platform IDs.

## How the platform integrates the tool

1. **Contract ownership.** hadron-server owns the subjects, payload schemas, versions, and the
   typed error catalog (per the platform-tools model). This tool *complies* with a contract
   version; the contract docs live with core / hadron-docs, mirrored here.
2. **Connection lifecycle.** The portal Account page runs the OAuth flow → core gets a
   provider-agnostic `Connection` record; the tool gets the encrypted refresh token. Disconnect
   cascades grant revocation (spec 002's flow, unchanged).
3. **Authorization stays in core.** Every operation passes `assertGrant(principal, connectionId,
   agentId)` in hadron-server *before* core issues the NATS request — the grant is the new
   per-connection entity (parallel to `AgentMemoryItem`, [`cor:dmo:050:09`](hrn:node:hadronmemory.com::specs::cor:dmo:050:09)).
   Zero-Trust never moves into the tool, and the tool never receives an unauthorized call.
4. **The agent-facing surface does not change.** Agents still see the ~15 email tools over MCP
   (and GraphQL for apps/portal), exactly as spec 002 defines. Core's tool handler is now
   `assertGrant → bus.requestReply(email.<provider>.op.<verb>.v1) → map reply`. Swapping
   in-process Graph calls for a bus hop is invisible above the contract — which is the point.
5. **Event dispatch.** Core runs durable consumers on `email.received.v1` / `email.sent.v1`,
   looks up which agents are *granted* the connection *and* subscribed to that event, and
   triggers each via the **headless agent runner**.
6. **Deployment.** A separate container alongside hadron-server (Komodo/Docker, per message-bus
   D4). First-party, so it speaks NATS directly (a leaf node if it runs off-host). A future
   third-party email tool would bind the *same contract* over the HTTP edge instead — the
   contract is transport-agnostic.

## How Pong uses the tool

Pong is a **no-code agent**: its behavior lives entirely in its Hadron memory (conversations,
stages, actions, learned templates) — there is no Pong code in this tool or in the platform.

```
Subscribe to Pong (marketplace) → memory + chatbot station provisioned → onboarding chat
        │
        ├─ Pong asks user to connect email   → OAuth → Connection in core, token in the tool
        └─ Pong asks user to grant it access → AgentEmailGrant(user, app, Pong, connection)
        ▼
── steady state ────────────────────────────────────────────────────────────────────────
New email arrives
   → Exchange tool publishes  email.received.v1
   → core dispatcher: is Pong granted + subscribed?  → headless runner wakes Pong
   → Pong (LLM) calls get-message → queries its memory + templates → confidence check
        ├─ above its threshold → save-draft  (or reply-to-message on auto-send)
        └─ below               → skip, record a one-line reason   (both: Pong's logic, in memory)
   → user reviews the draft in Outlook, edits, sends
   → Exchange tool publishes  email.sent.v1
   → core dispatches to Pong → Pong diffs draft vs sent → writes a template node to its memory
```

Everything that is "Pong" — the confidence threshold, tone, exclusion rules, pause state,
learned templates, the draft-vs-sent diffing — lives in **Pong's memory and is evaluated by
Pong's LLM**. The tool is dumb plumbing: read a message, write a draft, send a reply, apply a
label. That clean line is exactly what PR #51 violated and what this architecture restores.

## What must exist first (honest dependencies)

This tool is near the top of a stack that is mostly still designed-not-built:

| Dependency | State | Needed for |
|---|---|---|
| `BusClient` + NATS JetStream deployed | Designed (message-bus 2026-06-11), not built | Both planes |
| Outbox relay | Designed, partial (embedding markers only) | Reliable publish of events/mutations |
| Request/reply + pub/sub on the bus | Bus's "V2" target; chosen to serve them | Operations and events |
| Headless agent runner | Stubbed, not built | Running Pong unattended on `email.received.v1` |
| Core email contract surface (`Connection`, per-connection grant, the ~15 tools) | Drafted in spec-kit 002; **not yet in the `cor:*` corpus** or built | The whole agent-facing contract + Zero-Trust |
| **This tool** (Exchange adapter, OAuth store, webhook lifecycle, bus bridge) | This document | — |

A reasonable build order: bus + outbox → spec-002 contract surface in core → this tool's
operations plane (pull path, reuses the existing Graph code) → headless runner → this tool's
event plane → Pong as the first real consumer.

## Open decisions (flagging, not picking)

1. **Who owns the OAuth refresh token — the tool (recommended) or core?** Putting it in the tool
   gives the strict provider-isolation above (zero Graph columns in core) but means the OAuth
   callback and connection-create UX must round-trip to the tool, and the tool needs
   encryption-at-rest. Keeping it in core reuses spec-002 plumbing but leaves Microsoft secrets
   in the platform DB. *This is the main change to [`cor:dmo:080:04`](hrn:node:hadronmemory.com::specs::cor:dmo:080:04)
   and the decision most worth making early.*
2. **Core proxies operations (recommended) vs. agents reach the tool more directly.** Proxying
   keeps Zero-Trust and the existing MCP surface in core and keeps the tool ignorant of identity.
   The cost is one extra bus hop per call (the `p95 ≤ 1.5s` budget from spec 002 SC-007 must
   absorb it).
3. **Repo scope.** Is `hadrontool-email` the Exchange tool specifically (with IMAP/Gmail as
   sibling repos), or an umbrella that also hosts the shared contract docs? The name suggests
   umbrella; one-tool-per-provider suggests Exchange-specific. Recommend: this repo = Exchange
   tool + a mirror of the contract; the canonical contract lives with core/hadron-docs.
4. **Durable request/reply for mutations.** Plain NATS request/reply is at-most-once; mutations
   want durability. Decide whether mutations use a JetStream-backed reply path or
   publish-then-await, and confirm the idempotency-key dedupe store lives in the tool.
5. **Event subscription model.** How an agent declares "I subscribe to `email.received` for this
   connection" — is it implied by the `AgentEmailGrant`, or a separate subscription record? Spec
   002 left the dispatch mechanism as a plan-level decision (FR-038); this is where it gets
   decided.
