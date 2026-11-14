# Integration API v1: durable handoff, not a distributed transaction

This is the stable consumer-facing HTTP contract. Consumers do not import the
store, native SDKs, or Temporal workflows. Start the normal gateway described in
[member-gateway.md](member-gateway.md); its operator-configured token hash maps to
one owner. All routes below require that bearer token. Never send proxy credentials,
trusted scopes, tool registries, or engine configuration in a turn request.

The portable [TypeScript client](../packages/client/README.md) provides one-attempt
commands and explicit receipt reconciliation. Its [generated OpenAPI 3.1 document](../packages/client/openapi.json)
covers the core integration routes and lists excluded extensions in `x-excluded-routes`.
It is not a complete specification of every `/v1` route. Run `npm run openapi` to
regenerate it and `npm run check:openapi` to reject a stale document.

## Discovery and routes

`GET /v1/capabilities` returns `apiVersion: "1"`, request and cancellation contract
identifiers, proxy protocol versions, conversation/generation limits, trusted-context
transport availability, observation limits, receipt retention semantics, the
request initiator kinds (`initiatorKinds`, today `["owner", "routine", "handoff"]`), the audit
contract (event types, page limits, formats, filter names and actor kinds) and the
scheduled-routine limits and policies (`routines`), `standingGrants` (the standing
choices, the card and state fields, the grantable tool, policy version and
initiator kinds, the grants route and the inactive-list limit), `memories` (the
member memory route, limits, injection and deletion semantics per engine), `handoffs`
(the conversation handoff routes, delivery and transcript and prompt limits),
`approvalExpiry` (the deadline field, its bounds and the fields that report an
expiry), `memberInstructions` (the spawn field, the read route, limits, order and
restore), `usage` (the ledger states, what each engine reports, the cost rules and the
operator's price table setting, the lanes, the budget period and refusal codes),
`webhooks` (the webhook route, kinds, formats and the default one, signature and the
formats it covers, retry and restore semantics, and `insecureTargets`, which says an
operator setting for testing exists, not whether it is on), `instructionPacks` (the pack
route, the spawn field, limits, order, deletion and restore), health dependencies and
listing limits. Additive
response fields are compatible; consumers must reject an unsupported major version.
Trusted context is currently an operator-configured local runtime, **not** a public
HTTP context/tool injection endpoint. Capabilities are implementation contracts, not
proof of the operator's provider access or configured profile availability.

| Route | Purpose |
| --- | --- |
| `POST /v1/members` | Existing member creation contract (`requestId`, `engine`, `profile`), plus optional `instructions` and `instructionPacks` |
| `POST /v1/conversations` | Open an owned conversation (`conversationId`, `memberId`) |
| `POST /v1/conversations/{conversationId}/requests` | Submit `{ "requestId": "UUID", "text": "exact input" }`, optionally with `approvalDeadlineSeconds` |
| `GET /v1/conversations/{conversationId}/requests/{requestId}` | Reconcile status and original committed result; never invokes inference |
| `POST /v1/conversations/{conversationId}/requests/{requestId}/cancel` | Persist cancellation intent, body `{}` |
| `GET /v1/conversations/{conversationId}` | Current public snapshot |
| `POST /v1/conversations/{conversationId}/events` | Independent, read-only AG-UI observation |
| `POST /v1/conversations/{conversationId}/human` | Existing explicit human-decision contract |
| `GET /v1/health` | Readiness of PostgreSQL and Temporal; `200` ready, `503` not ready |
| `GET /v1/members` | The owner's members, keyset-paginated |
| `GET /v1/conversations` | The owner's conversations with coarse phase, optional `memberId` filter, keyset-paginated |
| `GET /v1/audit` | Owner-scoped, append-only audit events; keyset pages as JSON or CSV export, with optional filters |
| `POST /v1/routines`, `GET /v1/routines` | Create (`requestId`, `memberId`, `schedule`, `prompt`, `approvalPolicy`) and list scheduled routines |
| `GET`/`DELETE /v1/routines/{routineId}`, `POST .../enable`, `POST .../disable` | Read, tombstone, enable or disable one routine |
| `GET /v1/routines/{routineId}/firings` | Firing history, newest first, with each firing's conversation and request |
| `GET /v1/members/{memberId}/grants` | The member's active standing grants and up to 20 ended ones |
| `POST /v1/members/{memberId}/grants/{grantId}/revoke` | Revoke a standing grant for later calls, body `{}`; repeating returns the same grant |
| `POST /v1/memories`, `GET /v1/memories` | Create (`requestId`, `memberId`, `text`) and list member memory entries |
| `GET`/`DELETE /v1/memories/{memoryId}` | Read one entry, or erase its text and keep a tombstone |
| `POST /v1/conversations/{conversationId}/handoffs` | Hand the conversation to another member (`requestId`, `memberId`): seal it and open a target whose first request carries its transcript |
| `GET /v1/conversations/{conversationId}/handoff` | The handoff that created or sealed this conversation; never its transcript |
| `GET /v1/members/{memberId}/instructions` | The member's instructions, or `null`, and its instruction packs |
| `POST /v1/instruction-packs`, `GET /v1/instruction-packs` | Create (`requestId`, `name`, optional `description`, `text`) and list the owner's instruction packs |
| `GET`/`DELETE /v1/instruction-packs/{packId}` | Read one pack, or delete one no member has: erase its text and keep a tombstone |
| `GET /v1/usage`, `GET /v1/usage/members`, `GET /v1/usage/conversations` | Token totals for the owner, per member (with its budget) and per conversation, over an optional time range |
| `GET /v1/usage/records` | Usage ledger rows, one per native segment, newest first |
| `GET`/`PUT`/`DELETE /v1/usage/budgets/{memberId}` | Read, set (`tokenLimit`) or clear a member's daily token budget |
| `POST /v1/webhooks`, `GET /v1/webhooks` | Create (`requestId`, `url`, `kinds`, optional `format`; the response alone carries the signing secret) and list webhook endpoints |
| `GET`/`DELETE /v1/webhooks/{webhookId}`, `POST .../enable`, `POST .../disable` | Read, tombstone, enable or disable one endpoint |
| `GET /v1/webhooks/{webhookId}/deliveries` | Delivery rows, newest event first |

Authentication is required even for capabilities and health. There is no
unauthenticated route. A request without a valid token gets `401` before the gateway
parses the URL, reads the body or touches PostgreSQL or Temporal. That `401` is the
supported liveness signal: it shows that the gateway is listening and answering, and
nothing about its dependencies (see
[Health](persistent-deployment.md#health)). Other owners get `404`, not a
confirmation of a request's existence. Versioned request bodies are strict: unknown
fields (including an attempted `ownerId` override or an `initiator`) fail `400`. Query parameters on the
health and listing routes are strict too: unknown or repeated parameters fail `400`.

## Health and listing

These routes exist only under `/v1`; `/health` and `GET /members` or
`GET /conversations` without the prefix are not served.

`GET /v1/health` takes no parameters. It probes both dependencies concurrently, each
bounded to 2 seconds: a PostgreSQL round trip that reads the highest applied schema
version, and a Temporal frontend `GetSystemInfo` call on the gateway's connection. The
probe never starts, signals or describes a workflow. A ready Temporal result proves only
that the frontend answers: `GetSystemInfo` names no namespace, so it does not show that
the namespace the gateway uses exists, or that workers are polling. It returns `200`
when every dependency is ready and `503` with the same body shape otherwise, for
example:

```json
{
  "apiVersion": "1",
  "status": "not_ready",
  "dependencies": {
    "database": { "status": "unavailable", "schemaVersion": null },
    "temporal": { "status": "ready" }
  }
}
```

The top-level `status` is `ready` or `not_ready`. Each dependency reports `ready` or
`unavailable` (failed or exceeded its bound). Driver errors, addresses and connection
strings are never returned.

The database probe opens its own short-lived PostgreSQL connection with the gateway's
connection settings instead of borrowing one from the gateway's pool. It never queues
behind other requests or takes a pool slot, and a saturated pool does not affect it:
the database is `ready` whenever a fresh connection can read the schema version, even
while every pooled connection is busy. Each step of that connection has the same
2-second bound: connecting (including TLS and authentication), the read (the server
cancels it if it is blocked on a lock, and the gateway abandons it if the server goes
silent) and closing. Concurrent health requests share one probe, so health polling
holds at most one database connection beyond the pool at a time. A response never
waits past its bound. A probe still running then reports `unavailable` and ends within
three times the bound (6 seconds), whether the server refuses connections, drops
packets, accepts a connection and never answers, or answers slowly. The next health
request after that starts a fresh probe, so health stops reporting `unavailable`
within about 6 seconds of PostgreSQL becoming reachable again.

Leave PostgreSQL one connection slot of headroom beyond the gateway's pool for this
probe. The probe sends `statement_timeout` as a connection startup parameter. A pooler
that rejects startup parameters it does not track, as PgBouncer does by default, refuses
that connection, and health then reports the database `unavailable` while requests
through the pool still work. Allow the parameter in the pooler (PgBouncer's
`ignore_startup_parameters`) or point the gateway at PostgreSQL directly.

When the database is ready, `schemaVersion` is the highest migration number applied to
it. It is `null` when the database is unavailable. Migration numbers are not
contiguous. Up to migration 26, a later release could add a migration numbered below one
that an earlier release had already applied (22 came after 26), so a database can gain a
migration without `schemaVersion` changing. (From the release that adds migration 31
on, every gateway, worker and CLI process refuses to start rather than apply a migration
numbered 27 or above below the newest applied one.) `schemaVersion` therefore names the newest migration present, not the full
applied set, and cannot by itself identify a release. The gateway applies its
migrations at startup, so a value below the largest number in the deployed release's
migration list (in `src/service/store.ts`) means the database is behind that release;
an equal value does not prove that every migration is present.

`GET /v1/members` and `GET /v1/conversations` return only the authenticated owner's
rows:

```json
{ "apiVersion": "1", "members": [{ "memberId": "UUID", "engine": "pi", "profile": "name" }], "next": "opaque" }
```

A member spawned with instructions also carries `"instructions": { "bytes": 73, "digest": "sha256 hex" }`,
never the text, and one spawned with instruction packs carries `"instructionPacks": ["UUID", ...]`, their
IDs in order.

```json
{
  "apiVersion": "1",
  "conversations": [
    { "conversationId": "UUID", "memberId": "UUID", "engine": "claude", "profile": "name", "phase": "idle" }
  ],
  "next": null
}
```

| Parameter | Routes | Meaning |
| --- | --- | --- |
| `limit` | both | Decimal page size from 1 to 100, without sign or leading zeros; default 50 |
| `after` | both | The previous page's `next`, unchanged |
| `memberId` | conversations | Only that member's conversations |

Pages follow a stable ascending identifier order. Neither table records creation time,
so the order is not chronological. `next` is `null` on the last page. Treat it as
opaque and send it back with the same parameters that produced it. A cursor records
only its resource (members or conversations) and a position. A malformed or altered
value, or one from the other resource, fails `400`. Because it does not record the
`memberId` filter, reusing it with a different `memberId`, or without one, is accepted
and returns that other listing from after the cursor's identifier, skipping that
listing's earlier rows. A row that exists throughout pagination appears exactly
once; a row created meanwhile appears only if it sorts after the current position.

`phase` uses the snapshot vocabulary (`idle`, `running`, `waiting`, `complete`,
`cancelled`, `failed`). It is `null` for a conversation that predates the public event
ledger, whose snapshot returns `409 history_unavailable`. Listings never include
messages, prompts or results; read the snapshot or request receipts for those.
Conversations used through operator-configured trusted context are ordinary owned
conversations and are listed like any other, including after their trusted session is
deleted. A
`memberId` that is not the owner's, whether another owner's or nonexistent, returns an
empty `200` page, exactly like an owned member without conversations.

A rejected query parameter on the health or listing routes (unknown, repeated or
invalid, including a malformed `after`, `limit` or `memberId`) returns
`400 {"error":"invalid_input"}`. If PostgreSQL fails while a listing is read, the
route returns `503 {"error":"retry_same_request"}`; listings are read-only, so
repeating the request is safe. Health does not use that body: a failed dependency is
reported in the health body itself.

### Identity and equivalence

The identity is **(authenticated owner, conversation UUID, request UUID)**.
UUIDs are normalized to lowercase. Payload equivalence is exact UTF-8 text equality:
whitespace and Unicode normalization are not changed. The 16 KiB text limit and valid
Unicode rules of the existing input contract apply. Only a conversation handoff's
reserved first request, which the server submits, may be longer (see below). Reusing an identity with changed
text returns `409 conflict`; it never creates a second turn. The optional
`approvalDeadlineSeconds` is part of the payload too: a reuse must repeat it exactly, or
omit it if the first submission did.

A consumer with owner-scoped event identities must durably record their mapping to
**both** conversation and request UUID before sending. Use a deterministic UUID
scheme scoped to that application/owner, or generate UUIDs once inside the consumer's
inbound-event/outbox transaction. Retrying the same event in a different conversation
is a different request and can execute twice. Crew does not deduplicate across
conversations or databases.

## Acceptance, lookup, and failures

A successful submit returns `202` with a receipt:

```json
{
  "apiVersion": "1",
  "conversationId": "UUID",
  "requestId": "UUID",
  "acceptance": { "boundary": "sql_admission_and_temporal_queue" },
  "status": "accepted",
  "initiator": { "kind": "owner" }
}
```

`initiator` is read-only: what started the request, recorded once when Crew
admitted it. Requests submitted through this API are started by the authenticated
owner, so the owner kind carries no ID. A request a scheduled routine submitted
reports `{"kind": "routine", "id": "<routineId>"}`; only the routine's firing record
can make an admission say so (see [scheduled routines](scheduled-routines.md)), and
a request sent here under a claimed firing's conversation and request UUIDs with
exactly the routine's prompt is that firing's request. A conversation handoff's
reserved first request reports `{"kind": "handoff", "id": "<handoffId>"}`; only the
handoff's own record can make an admission say so, for that one request and exactly its
transcript. No request body can set it. A later release that adds a kind lists it in
`initiatorKinds`. The field is absent for a request admitted before admissions were
durable (a workflow history older than bounded conversations) until a cancellation
intent records its admission.

The successful boundary means the admission identity/payload digest is committed in
Crew PostgreSQL and the Temporal workflow owns the queued work. It does **not**
mean native execution started or completed, a tool effect happened, or the consumer
recorded the reply. A request can complete before the submit response arrives; its
receipt then already contains `status: "completed"` and `result: { "text": "..." }`.
Repeated successful submissions preserve identity and eventual result, not a frozen
snapshot of the old status. A previously accepted request rejected because an earlier
turn failed/cancelled is discoverable through GET even though resubmission returns
`409 request_rejected`.

| Status | Meaning |
| --- | --- |
| `accepted` | Durable admission, waiting for execution |
| `running` | A turn has started; not a claim that a native process is currently live |
| `waiting` | A published human decision is unresolved |
| `completed` | Original reply committed; available as `result.text` |
| `cancellation_requested` | Intent recorded, no terminal execution conclusion yet |
| `cancelled` | Accepted queued request rejected due to predecessor cancellation; no turn executed |
| `failed` | Accepted queued request rejected due to predecessor failure or unconfirmed admission in a closed workflow; see `reason` |
| `uncertain` | Existing native execution reconciliation cannot establish a safe final result; do not replay as new work |

`completed` and `uncertain` are never overwritten by a cancellation intent. A native
cancellation can leave an uncertain outcome or a committed cancellation reply; use
the cancellation fields, not an assumption that `completed` means a tool succeeded.

- `400`: invalid input; fix it before submitting.
- `401`: authentication required; no acceptance claim.
- `404`: no owned request currently discoverable. After an ambiguous send this is
  **not** proof it can never appear; retry the same identity/payload.
- `409`: explicit conflict, capacity limit, or rejected request. Inspect the error and
  reconcile that identity. Never silently generate a replacement UUID.
  `409 usage_limit` means the member has used its daily token budget: nothing was
  admitted, and the same request can be sent again once the window or the budget
  allows it (see [usage metering](usage-metering.md)). `409 usage_limit_closed` is the
  same refusal from Crew's second budget check, which only refuses when usage was
  recorded, or the budget set or lowered, between the two checks. As after any refused
  admission, that conversation is then closed to new turns; send the request again in a
  new conversation.
- `503 retry_same_request`, connection loss, timeout: the outcome may be ambiguous.
  GET the same identity, then retry the exact submission if needed. Do not infer a
  rejection from a lost acknowledgement. A validation/explicit rejected submission
  is not reported with an accepted response.

If the SQL admission committed but its activity acknowledgement was lost and retries
were exhausted, a no-turn receipt is reconciled against the logical workflow. The
workflow's guarded cleanup or a subsequent status read records `failed` with
`reason: "admission_unconfirmed"` when that workflow is terminal. It never starts a
replacement workflow or replays effects. Running/continued workflows and any request
with a begun or committed turn are not rejected by this recovery. Status reads may
persist this terminal reconciliation, but never invoke inference. Temporal observation
has a ten-second RPC deadline; failure returns retryable error instead of falsely
asserting the request is still accepted.

Receipts and results are retained with the database, across gateway/client restarts
and supported Continue-As-New rollover. There is no automatic receipt TTL in v1;
operator deletion/restoration of storage has its own recovery contract. Native
checkpoints, credentials, and storage paths are never returned.

## Cancellation is durable intent, not rollback

The cancellation POST commits a deduplicated PostgreSQL intent before returning
`202`. The receipt includes a stable `cancellation.receiptId`, `delivery` (`pending`
or `delivered`), `nativeTermination` (`unconfirmed` or `confirmed`), and
`effects: "not_assessed"`. Gateway background delivery retries intents after process
restart; GET never triggers delivery. Each Temporal delivery RPC has a 10-second
deadline; an ambiguous timeout leaves the intent pending and eligible for retry.
Attempts are ordered by least-recent attempt so permanently unavailable requests
do not starve later intents. The existing cancellation handler is idempotent. Multiple gateway replicas can
attempt delivery, but one SQL intent is retained.

`delivered` means the cancellation handler acknowledged, or the request was already
terminal and needed no delivery. It does not mean the native SDK stopped. Native
termination is confirmed only when a cancellation marker exists and all recorded
native launches for that request are stopped. A completed result remains the winner
even if a cancellation arrives later. Effects may already have committed: v1 does not
claim to undo them or infer their outcome from process exit.

Cancellation is best effort, not preemption of an already committed reply. Queued
cancellation can race the start or completion of work. If the workflow is unavailable,
intent remains pending; operations must restore the service or investigate, not treat
that as confirmed termination. Disconnecting an AG-UI observer only closes observation
and never writes a cancellation intent.

## Consumer transaction and reconciliation algorithm

1. In the consumer's database transaction, insert the inbound event and its unique
   handoff row `(event identity, conversation UUID, request UUID, exact payload)`.
2. A dispatcher reads unacknowledged handoffs and submits them. There is no cross-system
   transaction. If it dies before send, the row is still pending locally.
3. On restart or ambiguous transport failure, GET the recorded identity. If missing,
   resend the identical payload/identity. A lost acceptance reply cannot create a new
   logical turn. Record an observed receipt in a separate local transaction.
4. Poll GET for terminal status. Record the original result durably in the consumer
   database. If this acknowledgement is lost, retrieve the same result again.
5. Treat explicit rejection/uncertainty as an application reconciliation case, not
   permission to repeat effects under a fresh identity.

The maintained fixture commits both rows in its own disposable database, actually SIGKILLs the
consumer before send, after acceptance, and after completion, then recreates the
gateway/consumer and reconciles. Those focused tests use a real PostgreSQL store and
an instrumented transport. The portable service proof additionally exercises the
real Temporal worker/native fixtures and AG-UI observation; neither needs paid inference.

## AG-UI observation

An official `@ag-ui/client` HttpAgent observes `/v1/conversations/{id}/events` with
empty messages, tools, context, state and forwardedProps. Observation is independent
of the consumer's request identities and does not submit work. A new connection
starts from a current messages/state snapshot plus a bounded live tail (256 events).
The optional `?after=` must equal the current snapshot cursor; otherwise the gateway
returns `410 CURSOR_EXPIRED`. A gap during streaming emits `CURSOR_EXPIRED`; reconnect
without the old cursor for a fresh snapshot. Do not promise arbitrary historic token
replay, including across rollover. Committed per-request results use the separate
request lookup above, not the event cursor.

The stream opens with `RUN_STARTED` carrying `protocolVersion: "1.0"`, the AG-UI
version the gateway speaks, which the official client checks against its own.
The stream ends when the conversation does, with an event that matches the final
`state.phase`. `complete` (the conversation used its last turn) sends `RUN_FINISHED`
with no `outcome`, which AG-UI reads as success. `cancelled` sends `RUN_FINISHED`
with `outcome: {"type":"cancelled"}`, which the official client reports to
`onRunFinishedEvent` as `outcome: "cancelled"`. `failed` sends `RUN_ERROR` with code
`MEMBER_FAILED`.

## Standing grants

A work-item card may carry `standingChoices: ["allow_conversation", "allow_always"]`
beside its unchanged `choices`. Answering with one approves the call and creates a
grant, and the human route reports that choice. Later top-level work-item calls of
owner-started requests that the grant covers proceed without a card: their request
reads `running`, not `waiting`, and the conversation state's `grantedCalls` names
the grant. No route creates a grant. Revocation affects later calls only. Crew has
one token per owner, so it cannot tell a person from an automated client holding
it, and a grant covers both. See [standing grants](standing-grants.md).

## Approval expiry

A request may carry `approvalDeadlineSeconds`, an integer from 60 to 604800; a
routine may too, for each firing. It is part of the request's identity: a retry with
another value, or without one, fails `409 conflict`, and the receipt reports it. A
Claude or Pi card of such a request shows `expiresAt`. From then on a decision fails
`409 conflict`, and Crew cancels the request as a cancel would. The receipt then
carries `expiredApproval: { approvalId, expiresAt, expiredAt }`, the conversation
state's `expiredCalls` lists the card, and the audit trail has `approval.expired`; the
receipt `status` values are unchanged. A Codex card keeps the earlier of its live
deadline and the request's. A conversation handoff's reserved first request never
carries one; its ID sent with a deadline fails `409 conflict`. See
[approval expiry](approval-expiry.md).

## Audit trail

`GET /v1/audit` returns the authenticated owner's durable record of who acted and
when. It covers member spawn, conversation open, request admission, approval and
question decisions, committed work-item and trusted effects, cancellation requests
and terminal request status. Unlike the AG-UI tail, it is not truncated. Each fact
is written in the same transaction as the change it records, appears once despite
retries, and cannot be updated or deleted. Only releases that include the audit
migration write facts: while a process of an earlier release still runs, during an
upgrade or after a rollback, its changes leave silent gaps. See
[the audit trail](audit-trail.md#retention-upgrade-and-recovery) for how to
upgrade without them.

| Parameter | Meaning |
| --- | --- |
| `after` | Decimal event ID; return later events only. Default `0`. |
| `limit` | Default 100 in both formats. At most 1000 for JSON and 10000 for CSV (the hard row cap). |
| `conversationId` | Restrict to one conversation. Another owner's ID yields an empty page. |
| `memberId` | Restrict to one member. Another owner's ID yields an empty page. `webhook.*` and `instruction_pack.*` rows name no member and never match. |
| `eventType` | Comma-separated registered event types. |
| `actorKind`, `initiatorKind` | `owner` or `system`; one of `initiatorKinds`. |
| `initiatorId` | Requests a routine or a handoff started, by routine or handoff ID. Another owner's ID yields an empty page. |
| `from`, `to` | RFC 3339 timestamps with an offset, at most six fractional digits, no leap second, offsets within ±15:59; `occurredAt` at or after `from` and before `to`. Encode `+` as `%2B`. |
| `format` | `json` (default) or `csv`. |

Filters combine with AND, work in both formats and leave paging unchanged; see
[audit filters](audit-filters.md).

Unknown, repeated or malformed parameters fail `400`, as strict bodies do. JSON
responses are `{ apiVersion, events, nextAfter, hasMore }`. CSV responses carry the
same rows, with `Audit-Next-After` and `Audit-Has-More` headers. Pass `nextAfter`
as the next `after`. Event IDs are global across owners and not contiguous. Pages
never skip an event that commits late. A read waits for in-flight writes without
delaying them. If it cannot settle within 5 s, because writes overlap continuously
or a writer process stalled mid-transaction, it returns `503 audit_unsettled` with
`Retry-After: 1`; retry the same read. Event IDs are decimal strings of up to 19
digits; compare them as 64-bit integers, not as strings or JavaScript numbers. A
restore removes the events after its recovery point, and new event IDs jump to a
range above every earlier ID, so a saved cursor never skips a new event; the audit
trail guide states the conditions. Any CSV cell that starts with `=`, `+`, `-`,
`@`, tab, CR or `'` gets one extra leading `'`, so a spreadsheet shows it as text;
to recover the exact value, remove one leading `'` from any cell that starts with
it.
Payloads hold identifiers, digests, choices and statuses only, never prompt or
reply text, tool arguments or credentials. See [the audit trail](audit-trail.md)
for the event registry, field semantics and limits.

## Scheduled routines

An owner can define a routine: a five-field UTC cron schedule, one of their members
and a fixed prompt. The gateway submits the prompt at each window in a new
conversation, through the same admission as a request sent here, with nobody
present. Windows are at least 15 minutes apart and an owner has at most 20 enabled
routines. Missed windows are skipped, never replayed. A routine's request that
reaches a human decision either waits for it (`wait`) or is cancelled through the
durable intent above (`fail_closed`). The routes, firing statuses, limits and costs
are in [scheduled routines](scheduled-routines.md). Like the other routes, bodies
are strict and the owner comes only from the bearer token.

## Member memory

An owner can save up to 32 active entries of at most 1024 bytes for each member. A
conversation records the member's active entries when it opens, and its native
launches get them, framed as reference data, after any project notes. Entries created
later never reach it. Only the owner writes memory; the model cannot. A create is
idempotent by `requestId`; a replay of a deleted entry fails `409 memory_deleted`,
and a 33rd active entry `409 memory_limit`. `POST /v1/conversations` also fails
`409 memory_limit` when the conversation's project notes fit what the member's engine
can be given but notes and entries together do not, counting any member instructions
with the notes; nothing is opened. Deleting an
entry erases its text and keeps a tombstone. A deletion reaches every later launch on
Pi with Crew's Pi models. Codex replays the context its rollout recorded on a
conversation's first turn, and Claude's SDK may resend the prompt it recorded then, so
on those engines a deletion may reach only conversations that have not run a turn.
`capabilities.memories.startedConversations` says which. See
[member memory](memories.md) for the trust boundary and what deletion does not erase.

## Conversation handoff

An owner can hand a conversation to another of their members, often of another engine.
One transaction checks that both are the owner's, refuses a busy, trusted-lane, empty or
already handed off source, seals the source, opens a fresh target exactly as an open
would, and records a transcript of the source's newest whole committed turns, at most
64 KiB, with a server-reserved request for the target's first turn. The gateway then
submits that request through the normal path; the target model gets the transcript as a
user message, quoted as data. The source keeps its snapshot and receipts but admits no
new request (`409 handed_off`), and the target admits no other request before the
reserved one (`409 handoff_pending`). Every other request keeps the 16 KiB limit. Retry a
POST with the same `requestId`: it returns the same handoff and submits the reserved request again
if a failure interrupted it. A target whose workflow has closed stays unadmitted. See [conversation handoff](handoffs.md) for what is carried, the
errors, costs and the trust boundary.

## Member instructions

`POST /v1/members` takes optional `instructions`: 1 to 16,384 bytes under memory's
character rules. The route now decodes its body strictly, so bytes that are not UTF-8
fail `400 invalid_json` with or without the field. Instructions are fixed for the life
of the member; a spawn replay must repeat them exactly, or fails `409 conflict`. Every native launch of the member's conversations
gets them first, before project notes and memory; Pi children and the trusted-context
lane do not. They never change the member's tools, approvals or limits.
`GET /v1/members/{memberId}/instructions` returns the text to its owner only; spawn
responses, `GET /v1/members` and the `member.instructions_set` audit row carry its
SHA-256 and byte count. `POST /v1/conversations`, and a handoff to the member, which
opens its target the same way, fail `409 instructions_limit` when the conversation's
project notes fit what the member's engine can be given but notes and instructions
together do not, and `409 memory_limit` when notes and instructions fit but memory on top
does not. A handoff adds no instructions to its transcript; a source reply that quotes
them is carried like any other reply. A restore keeps instructions as they were. See
[member instructions](member-instructions.md).

## Instruction packs

An owner can write up to 32 active instruction packs: a name and an optional description for
the owner, and 1 to 16,384 bytes of text for the model. A pack never changes. `POST /v1/members`
takes optional `instructionPacks`, 1 to 8 distinct pack IDs of the owner's, in order; a member's
packs are fixed for its life, and a spawn replay must repeat them exactly or fails
`409 conflict`. A pack that is not the owner's fails `404 not_found` and a deleted one
`409 pack_deleted`. The member's own instructions and its packs' texts share 16,384 bytes; a
spawn over that fails `409 pack_limit`, as does a 33rd active pack. Every native launch of the
member's conversations gets the packs' texts first, before its instructions, project notes and
memory; Pi children and the trusted-context lane do not, and a handoff carries none: its target
gets its own member's packs. Names and descriptions never reach the model. A pack any member has
cannot be deleted (`409 pack_in_use`); deleting another erases its text. Packs never change a
member's tools, approvals or limits, and the model follows their text as the owner's
instructions, so text pasted into a pack from an untrusted source is a prompt-injection path to
every member that has it. `instruction_pack.*` audit rows belong to no member, like
`webhook.*`. Packs count with instructions toward `409 instructions_limit` when a
conversation opens. A restore keeps packs as they were at the recovery point, so a pack
deleted after it comes back, unattached. See [instruction packs](instruction-packs.md).

## Usage metering

Crew records one ledger row for each native segment with the token counts the engine's
SDK reported, or `unknown` when it reported none, in the member lane and in the
trusted-context lane alike. A row carries a billed cost when the provider billed one, or
else an estimated cost when the operator's price table (`BIRBCREW_USAGE_PRICES_PATH`)
prices its model; Crew ships no prices. The `/v1/usage` routes total an owner's rows,
per member and per conversation, and mark the parts that routines started and that the
trusted lane used. Totals report `costUsd` (billed) and `estimatedCostUsd` apart, each
with its segment count, and never add them; records gain `lane`, `estimatedCostUsd` and
`estimatePrice`. These are additive fields, and `costUsd` keeps its meaning. An
owner can set one daily token budget per member (`PUT /v1/usage/budgets/{memberId}`).
While the member's input and output tokens for the UTC day are at or over it, a new
request fails `409 usage_limit` (or `409 usage_limit_closed` when the refusal also closed
the conversation), and a routine's firing fails with reason `usage_limit`; a request already
admitted is never refused or interrupted, so the cap can be passed by what running
requests use. The budget counts the member's trusted-context tokens too, but refuses only
member-lane requests, routine firings and handoffs. See [usage metering](usage-metering.md).

## Outbound webhooks

An owner can register up to 10 enabled HTTPS endpoints. Crew posts to an endpoint
when an event it selected happens: a card or question became pending
(`approval.pending`), a request finished (`request.finished`), a routine firing
settled (`routine.firing_settled`), or Crew disabled a routine after ten failures
(`routine.disabled`). Each is derived from a committed audit event. The body carries
IDs, the kind, the time and a status only; fetch details with your token. Each
request in the default `crew` format is signed with HMAC-SHA256 over a timestamp and
the body, using a secret that only the create response returns. An endpoint can
choose another `format` at creation, fixed for its life and returned by every read.
`slack` posts `{"text": ...}`, which Slack, Mattermost and Discord's
Slack-compatible incoming webhooks show. `ntfy` posts plain text with a `Title`
header to an ntfy topic. Both send a fixed template of the same IDs, status, tool
name and time to a third-party service, unsigned, because those services check no
signature. A `slack` or `ntfy` URL is itself a credential: the routes return it to
the owner's token only, and the audit trail keeps only its host. An unknown format
fails `400 invalid_input`, and a replay with another format `409 conflict`. Delivery
is at least once and unordered, with ten attempts over about three hours, and an
endpoint that gives up ten deliveries in a row is disabled. Crew sends only to
public addresses over HTTPS, unless the operator allows insecure targets for local
testing, follows no redirect and sends no credential. `webhook.*` audit rows belong
to no member, so their `memberId` is `null` and a `memberId` filter never matches
them. An expired card, a handoff and a budget refusal add no kind: a handoff's
reserved request and an expired card's request are sent as `request.finished`, and a
refused request sends nothing (see
[what they send](webhooks.md#handoffs-approval-expiry-and-usage-budgets)). See
[outbound webhooks](webhooks.md) for the receiver's checks, the formats and their
templates, the secret's storage and the restore behaviour.

## Validation

Use Node 24.22.3 and a disposable PostgreSQL 17 database. The test role needs
CREATEDB so the fixture can create and remove its separate consumer database:

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:api
```

The full portable proof additionally needs Linux Landlock ABI 4+, Docker, a C
compiler, and Temporal CLI 1.10.0:

```sh
npm run test:api:service
```

The fixtures use synthetic credentials and local protocol servers. Record the exact
commit and each command result. Live application/proxy-provider acceptance is separate
and requires existing authorized access and any required spend approval. Do not print
real credentials, publish test tokens, or claim production identity-provider coverage.
