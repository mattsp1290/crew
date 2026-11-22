# Frontend tools

A frontend tool is a tool whose handler runs in the owner's client, the AgentUI
desktop or iOS app, while a member's native agent waits for its result. Crew stores
the definitions, offers each call to one executor, records exactly one result per call
and hands the complete batch back to the native turn. Crew never runs the handler.

This document is the contract for that feature. It specifies the public API additions,
the durable states of a call and a batch, and how Crew uses Switchboard's frontend
restore contract. It adds only optional fields and new routes. Existing text submit and
observation semantics stay strict and unchanged. Bean `crew-lfk7` owns it. `crew-1rcl`
implements storage and the routes. `crew-avzm` integrates the native side and qualifies
it. Nothing here is implemented or advertised yet.

## Status and gating

The `frontendTools` capability is **proposed, not advertised**. Crew must not return it
from `GET /v1/capabilities` until all of these hold.

- `crew-1rcl` has landed the storage, the routes and the state machines below.
- `crew-avzm` has landed batch admission, the continuation intent and native delivery.
- Both have met the [implementation obligations](#implementation-obligations-crew-1rcl-crew-avzm).
- Switchboard delivery of frontend calls (`switchboard-5py2`) is qualified for at least
  one engine, and Crew's vendored Switchboard pin includes it.

No Switchboard adapter executes frontend tools today. The Codex adapter runs
`codex-sdk` exec with tools disabled, the Claude adapter passes `tools: []` and the Pi
adapter runs with no tools. Switchboard has no tool catalog type and no result
submission API. What exists is the restore contract in
`src/core/frontend-restore.ts` and the tool fact types in `src/core/interaction.ts`.
Crew's vendored Switchboard (`58c7922`) predates even the restore contract, so
`crew-avzm` must refresh the pin first.

Crew's rule is that no route accepts a tool registry from an AG-UI client
([architecture](architecture.md), "No route accepts a provider endpoint, credential,
coworker instructions, or tool registry"), and trusted context is not a public tool
injection endpoint ([integration API](integration-api-v1.md#discovery-and-routes)).
`frontendTools` is a deliberate, versioned exception to that rule, and the only one.

- A definition names a function the client runs. It carries no endpoint, credential,
  instructions for Crew or engine configuration. It never adds a tool Crew or the
  member runs.
- A member can call it only in a request whose submit selected it.
- Crew relays arguments and results. It executes nothing on the definition's behalf.
- A definition's `description` and `parameters` reach the model. Text pasted into
  them from an untrusted source is a prompt-injection path, as with
  [instruction packs](instruction-packs.md).

The trusted-context lane and its internal Codex `dynamicTools` are unchanged and
remain operator-configured.

## Capability block

`capabilities().frontendTools` advertises version 1:

```json
{
  "version": 1,
  "engines": [],
  "definitionRoute": "/v1/frontend-tools/definitions",
  "definitionReadRoute": "/v1/frontend-tools/definitions/{definitionDigest}",
  "submitField": "frontendTools",
  "batchRoute": "/v1/conversations/{conversationId}/requests/{requestId}/frontend-batches/{batchId}",
  "callRoute": "/v1/conversations/{conversationId}/requests/{requestId}/frontend-batches/{batchId}/calls/{toolCallId}",
  "callActions": ["reserve", "begin", "result"],
  "namePattern": "^[a-z][a-z0-9-]{0,31}__[A-Za-z][A-Za-z0-9_-]*$",
  "digest": "sha256-utf8-json-stringify",
  "limits": {
    "nameBytes": 64, "definitionBytes": 128000, "selectionBytes": 128000,
    "toolsPerRequest": 128, "callsPerBatch": 128, "batchesPerRequest": 32,
    "argumentsBytes": 60000, "contentBytes": 60000, "errorBytes": 1024,
    "batchArgumentsBytes": 1000000,
    "reservationSeconds": 60, "batchSeconds": 86400, "pollSeconds": 1
  },
  "content": ["string"],
  "effects": ["known-none", "known-occurred", "unknown"],
  "restoreMechanisms": ["defer", "settle-interrupted"],
  "replay": "same-id-and-body",
  "conflictCode": "result_conflict",
  "unverifiableCode": "result_unverifiable"
}
```

`engines` lists the engines whose adapter is qualified to deliver frontend calls. Today
it would be empty, and Crew returns the block only once it is not. Every other field of
version 1 is an exact literal. Any change to one is a new version, because a client
that cannot parse version 1 rejects the whole capabilities response. The client schema
follows `decisionReceiptsCapabilitySchema`. It is a union of the version 1 schema and
`{ version: int, version !== 1 }` as opaque metadata.

The capability changes no observation behavior. It names no query parameter and no
observation field. The observation route and its stream stay as they are for every
observer (see [AG-UI observation](#ag-ui-observation)).

A Crew without the capability rejects the `frontendTools` submit field with
`400 invalid_input`, as it rejects any unknown field. Every new route returns
`404 not_found`. A client sends the field only when version 1 is advertised and the
member's engine is in `engines`.

## Identities

| Identity | Chosen by | Where it appears | Maps to |
| --- | --- | --- | --- |
| `conversationId` | owner | every route; AG-UI `threadId` | existing |
| `requestId` | owner | submit, receipts, routes | existing owner request |
| `runId` | Crew, UUID, one per native turn segment of a request | batch receipt | Switchboard `PendingFrontendBatch.sourceRunId`; the restore payload's `sourceRunId` |
| `batchId` | Crew, UUID | batch receipt, request receipt, routes | one stored `PendingFrontendBatch` |
| `toolCallId` | Crew, UUID | batch receipt, routes, the tool message `toolCallId` Crew hands the adapter | `PendingFrontendCall.publicToolCallId` |
| native call ID | native engine | never exposed | `ToolTarget.nativeToolCallId` |
| `definitionDigest` | Crew | definition routes, submit, receipts | `PendingFrontendCall.definitionDigest` |
| `argumentsDigest` | Crew | receipts | `PendingFrontendCall.argumentsDigest` |
| `executorId` | client, UUID | submit, call actions, receipts | new |
| `reservationId`, `beginId`, `resultId` | client, UUID | call actions, receipts | new |

A request's first native turn is its first segment. Each continuation after a committed
batch starts a new segment with a new `runId`, so one request can hold a chain of at
most `batchesPerRequest` (32) batches (see [segment bound](#segment-bound)). Crew mints
public tool call IDs because native IDs can repeat across sessions and reveal adapter
internals. A native ID never appears in a response, an event, an audit row or a restore
payload. UUIDs are compared and echoed in lowercase.

`executorId` is scoped to the request. `reservationId`, `beginId` and `resultId` are
scoped to their call. Crew looks each one up only within the call the route names, so
the same UUID on another call is an unrelated operation. A client still mints a fresh
UUID for every operation.

A batch `runId` is Crew's. It is never an observer's run and never the run key of a
client's own local run.

## Text values

Every string Crew accepts or stores for this feature follows Crew's text convention in
`boundedText` (`packages/client/src/contract.ts:11-12`): it is well-formed UTF-16, with
no unpaired surrogate, and contains no NUL. That covers `content` and `error` in a
result, every string and every object key inside a definition, and every string and
every object key inside native arguments after parsing. Unlike `boundedText`, `content`
may be empty.

- A client value that breaks the rule fails `400 invalid_input`. Nothing is stored.
- Native arguments that break it are not stored. Crew records the call's result itself
  as `invalid_arguments` (see [results Crew records itself](#calls-offer-reservation-begin)).

Crew stores a definition and a call's arguments as `text` holding the exact
`JSON.stringify` output it hashed, not as `jsonb`. `jsonb` would reorder keys and drop
duplicates, and PostgreSQL `text` cannot hold NUL, which is one reason for the rule.
Every size in this document is the UTF-8 byte length of that stored text, and Crew
embeds that text unchanged as a JSON value in its replies.

## Definitions and consent

`POST /v1/frontend-tools/definitions` stores one immutable definition for the owner:

```json
{ "definition": { "name": "agentui-files__open", "description": "Open a file in the editor",
  "parameters": { "type": "object", "properties": { "path": { "type": "string" } } } } }
```

`definition` holds `name` and `description`, and optionally `parameters` (an object)
and `metadata` (an object). Unknown fields fail `400 invalid_input`. The name must match
`namePattern` and be at most 64 bytes, the same rule as AgentUI's `parseFrontendDefinition`.
The `__` separator keeps every frontend name apart from Crew's own tools.
`metadata["ag-ui"]` is reserved and fails `400 invalid_input`. One serialized
definition is at most 128,000 bytes, which fits the 128 KiB body cap. Every string and
key in it follows [text values](#text-values).

The response is `201` for a new definition and for an exact replay:

```json
{ "apiVersion": "1", "definitionDigest": "sha256:<64 lowercase hex>", "name": "agentui-files__open" }
```

`definitionDigest` follows Switchboard's rule exactly. It is `sha256:` and the lowercase
hex SHA-256 of the UTF-8 bytes of `JSON.stringify` of the parsed definition object. Crew
parses the body once, stores those bytes and passes the same object to the adapter.
Parsing keeps the received key order, except that integer-like keys move first in
ascending order and a duplicate key keeps only its last value. Crew is the only writer
to its ledger, so every digest in it hashes the same bytes. A client that builds the
object in JavaScript and sends `JSON.stringify` of it gets the same digest locally. Any
other client uses the returned value. Definitions are keyed by owner and digest, so one
owner learns nothing about another's. This version never updates or deletes a
definition. New text is a new digest.

`GET /v1/frontend-tools/definitions/{definitionDigest}` returns
`{ apiVersion, definitionDigest, definition }`, or `404 not_found`.

A request selects definitions at submit with the new optional `frontendTools` field:

```json
{ "requestId": "…", "text": "Open the release notes",
  "frontendTools": { "executorId": "…", "definitions": ["sha256:…", "sha256:…"] } }
```

`definitions` holds 1 to 128 distinct digests. The field is part of the request's
identity, as `approvalDeadlineSeconds` is. A replay must repeat it exactly, in the same
order, or fail `409 conflict`. A submit without the field is the existing text submit,
byte for byte, and still rejects any unknown field.

Submit checks run in this order. The first failure wins, and nothing is admitted.

1. `400 invalid_input` for the body, including the field's shape and counts.
2. The existing submit checks, including request identity replay and `409 conflict`.
3. `409 definition_unknown` when a digest is not one of the owner's definitions.
4. `409 definition_name_conflict` when two selected definitions share a name.
5. `409 selection_too_large` when the stored bytes of the selected definitions total
   more than 128,000.
6. `409 frontend_tools_unsupported` when the member's engine is not in `engines`.

Consent binds to the definition set and the request. By submitting the selection the
owner lets the member call any selected tool with any arguments, in every segment of
that request and in no other. Crew shows no per-call approval card and has no universal
per-call approval. A client may still refuse a call locally. It reports that as a
result with an `error` and a known-none effect. Standing grants, cards and
`approvalDeadlineSeconds` keep their meaning for Crew's own tools and never cover a
frontend call.

## Eligible executor

The AgentUI Node host holds the owner's static bearer token and acts as the executor.
Crew has one owner per token, no viewer roles and no OIDC. It cannot tell one of the
owner's clients from another, so the executor is not an authentication boundary.

`frontendTools.executorId` names the executor for the request's life. The client
chooses it, saves it durably before the first submit that uses it, and sends it on every
`reserve`, `begin` and `result`. A call action with another `executorId` fails
`409 executor_mismatch`. The fence keeps two of the owner's own clients from both
executing one call. It does not stop a holder of the token that reads the ID from a
receipt. An executor that loses its `executorId` cannot act on the request's calls, and
they expire as described below. Registration happens at submit, in the same
transaction as admission, so no batch exists without an executor.

## Calls: offer, reservation, begin

When a native turn stops with frontend calls, Crew commits the batch with every call in
one transaction. Each call is then `offered`, unless Crew records its result itself.
Every call action is a `POST` to `{callRoute}/{action}` with a strict body.

A frontend call is a native call the turn stopped on that is not one of Crew's own
tools. Crew keeps the calls in the order the native turn emitted them. That order is
the order of `PendingFrontendBatch.calls` and of the receipt's `calls`.

**Arguments and their digest.** `argumentsDigest` follows Switchboard's rule exactly. It
is `sha256:` and the lowercase hex SHA-256 of the UTF-8 bytes of `JSON.stringify` of the
arguments the provider sent, in the provider's key order. Crew parses the native
argument text once and stringifies the parsed object, so integer-like keys move first
and duplicate keys collapse, as for definitions. Crew is the only writer, so the digest
is consistent across its ledger. Clients treat it as opaque. The argument size is the
UTF-8 byte length of that same string, which is also the size of `arguments` inside
any Crew reply.

**Where arguments are returned.** A call's arguments never change. Crew returns them in
the reserve reply and in `GET {batchRoute}` and `GET {callRoute}` while the call is
`offered`, `reserved` or `begun`. Once the call has a result, is fenced or is
`settled_interrupted`, no reply carries them, and `arguments` is `null`. A call Crew
records itself never carries arguments. A reserve reply carries them only when the
reservation is current, so a reserve never returns the arguments of a call that has a
result, is fenced or is `settled_interrupted`. The owner bearer protects every one of
these reads.

**Results Crew records itself.** Crew never offers a call it cannot hand over intact. It
records that call's result when the batch opens, with `content: ""`, a known-none effect
and one of these `error` values. Crew checks each call in this order, and the first
that applies is recorded.

| `error` | Cause |
| --- | --- |
| `too_many_calls` | The native turn stopped with more than 128 frontend calls. Crew records this for every call in the batch and offers none. |
| `unknown_tool` | The call's name is not the name of a definition the request selected. |
| `invalid_arguments` | The native arguments are not valid JSON, are not a JSON object, or contain a string or key that breaks [text values](#text-values). |
| `arguments_too_large` | The arguments exceed 60,000 bytes. |
| `batch_too_large` | This call, or an earlier call in batch order, would take the batch's offered arguments over 1,000,000 bytes. |

`batch_too_large` stops at the first overflow. Crew walks the calls in batch order and
adds each offered call's argument bytes. The first call that would take the total over
1,000,000 bytes gets `batch_too_large`, and so does every later call that no earlier row
of the table already refused, even one whose arguments would still fit. The offered
calls are therefore always a prefix of the batch's otherwise valid calls, never a
scattered subset. Only the arguments of calls Crew offers count toward the 1,000,000
bytes.

Digests for a call Crew records itself:

- `definitionDigest` is the selected definition's digest when the call's name matches
  one. For `unknown_tool`, and for a `too_many_calls` call whose name matches no
  selected definition, it is the reserved digest `sha256:` and the lowercase hex SHA-256
  of the UTF-8 bytes of `JSON.stringify({ "name": nativeName })`, where `nativeName` is
  the name exactly as the provider sent it. `JSON.stringify` escapes an unpaired
  surrogate, so these bytes are defined for any name. A stored definition always has a
  `description`, so the reserved digest never names a stored definition, and
  `GET {definitionReadRoute}` answers `404 not_found` for it. The same value goes into
  `PendingFrontendCall.definitionDigest` in the Switchboard envelope, which requires
  `^sha256:[0-9a-f]{64}$`, and into the receipt.
- For `unknown_tool`, and for a `too_many_calls` call whose native name matches no
  selected definition, the receipt's `name` is `nativeName` when it follows
  [text values](#text-values) and is at most 1,024 bytes, else `null`. Crew never
  stores a native name that breaks that rule.
- For `invalid_arguments`, `argumentsDigest` hashes the UTF-8 bytes of the raw provider
  argument text, with any unpaired surrogate encoded as U+FFFD. For every other row it
  hashes the stringified arguments as above.

Each of these results is a known-none result, so none of them blocks continuation. If
Crew records every call's result, the batch commits when it opens, and the model sees
every refusal in its continuation. The [segment bound](#segment-bound) stops a chain of
such batches from looping forever.

**Envelope rejection.** Before it commits a batch, Crew builds the
`PendingFrontendBatch` and checks it with Switchboard's `parsePendingFrontendBatch`.
That check rejects, among others:

- more than 1,000 calls (`frontendRestoreLimits.maxCalls`);
- two calls with the same native call ID;
- a native call ID that is blank, longer than 1,024 UTF-16 units or contains a control
  character;
- a blank `nativeTurnId` or `epoch`, or one that breaks the same identifier rule.

Any rejection has one outcome. Crew stores no batch, records no call and offers nothing.
It ends the native turn through its existing native uncertainty path, which requests
the native stop and marks the turn uncertain (`markUncertain`,
`src/service/store.ts:734`). The request's status becomes `uncertain`, which already
means that "native execution reconciliation cannot establish a safe final result; do
not replay as new work". `frontendBatch` keeps its previous value. Request status
`failed` is never used for this, because it means only predecessor failure or
unconfirmed admission.

**Reserve.** `POST …/calls/{toolCallId}/reserve` with
`{ "executorId": "…", "reservationId": "…" }` returns `200`:

```json
{ "apiVersion": "1", "toolCallId": "…", "state": "reserved", "reservationId": "…",
  "expiresAt": "…", "name": "agentui-files__open", "definitionDigest": "sha256:…",
  "argumentsDigest": "sha256:…", "arguments": { "path": "notes/release.md" } }
```

A batch is **closed to new work** when any of these holds:

- it is `blocked`, `committed` or `settled_interrupted`;
- the owner has cancelled the request;
- the current time is at or past its `expiresAt`.

Every receipt shows it as `closedToNewWork`. Reserve and begin check it. Results do
not, except a refusal that names a `reservationId`, so a begun call can still report.

A reservation is **current** while all of these hold:

- it has not lapsed, `reservationSeconds` (60) after it was issued;
- no begin has committed on the call;
- the call has no result, is not fenced and is not `settled_interrupted`;
- the batch is not closed to new work.

When a reservation lapses with no committed begin, the call returns to `offered` and may
be reserved again under a new `reservationId`, if the batch is still open to new work.
The arguments are the same every time. Crew evaluates a lapse when the call is read or
acted on and writes it with the next action. A read never writes.

Reserve, begin and result each lock the batch row, then make every check below inside
that transaction. A check never relies on a state read before the lock.

Reserve checks run in this order.

1. `400 invalid_input`.
2. `409 executor_mismatch`.
3. The same `reservationId` while it is current returns `200` with the same body.
4. `409 call_closed` when the call has a committed begin, has a result, is fenced or
   is `settled_interrupted`, or its batch is closed to new work.
5. `409 reservation_expired` when this `reservationId` was issued for this call and is
   no longer current.
6. `409 call_reserved` when another reservation is current.
7. The reservation commits.

Check 3 never answers for a closed call, because a reservation on such a call is not
current. That replay then falls through to check 4.

**Begin.** `POST …/calls/{toolCallId}/begin` with
`{ "executorId": "…", "reservationId": "…", "beginId": "…" }` returns `200`:

```json
{ "apiVersion": "1", "toolCallId": "…", "state": "begun", "beginId": "…" }
```

Begin commits only while its reservation is current, by compare-and-set in the
transaction that holds the batch row lock.

Begin checks run in this order.

1. `400 invalid_input`.
2. `409 executor_mismatch`.
3. The same `beginId` already committed with the same body digest returns `200` with
   the same reply, even after the reservation's time has passed or the batch closed.
   The same `beginId` with another body digest fails `409 conflict`.
4. `409 call_closed` when the call has a result, is fenced or is `settled_interrupted`,
   or its batch is closed to new work, and this `beginId` did not commit.
5. `409 begin_conflict` when another `beginId` committed.
6. `409 reservation_expired` when the named reservation is not current, including a
   `reservationId` Crew never issued for this call. This begin never committed and
   never will.
7. The begin commits.

After a committed begin the call is never offered, reserved or begun again, by any
executor, after any expiry, restore or process loss. The executor invokes its handler
only after it holds a confirmed begin, which is a `200` or a read that shows its own
`beginId`.

**Body digests.** Crew compares a replayed begin or result with the committed one by a
body digest. The digest is `sha256:` and the lowercase hex SHA-256 of the UTF-8 bytes
of `JSON.stringify` of an array of the body's fields in a fixed order, with UUIDs
lowercased and `null` for an absent optional field.

- Begin: `[executorId, reservationId, beginId]`.
- Result: `[executorId, resultId, beginId, reservationId, content, error, effect.kind, effect.effect]`.

Key order and whitespace in the received body never change the digest.

## Call states

Three terms describe a call whose effect Crew does not know. This document uses them
with these meanings only.

- **Begun, no result.** A begin committed and no result is recorded yet. The handler
  may be running, may have finished, or may never run. This is not final. A begun call
  keeps its batch `open` unless another call blocks it, until the batch expires or
  settles.
- **Result with unknown effect.** A recorded result whose effect is `unknown`. It is
  final. It is the executor's explicit statement that it gives up on knowing the
  outcome.
- **Fenced.** No result is recorded, and Crew refused one because it names a begin Crew
  does not hold (`result_unverifiable`) while the batch was not settled. It is final.
  The call never gets a result.

| State | Meaning |
| --- | --- |
| `offered` | Waiting for a reservation. Not a claim that a reserve will succeed. |
| `reserved` | Held under a current reservation. No begin committed. |
| `begun` | Begun, no result. |
| `resulted` | A result with a known effect, `none` or `occurred`. |
| `unknown_effect` | A result with unknown effect. |
| `fenced` | Fenced. |
| `settled_interrupted` | The batch settled while this call had no result. |

| From | To | Cause | Actor |
| --- | --- | --- | --- |
| (none) | `offered` | batch opens | Crew worker |
| (none) | `resulted` | Crew records `too_many_calls`, `unknown_tool`, `invalid_arguments`, `arguments_too_large` or `batch_too_large` | Crew worker |
| `offered` | `reserved` | reserve | executor |
| `reserved` | `offered` | reservation lapses with no begin (evaluated at read or action time) | Crew |
| `reserved` | `begun` | begin | executor |
| `reserved` | `resulted` | result with `reservationId` and a known-none effect (local refusal) | executor |
| `begun` | `resulted` | result with a known effect | executor |
| `begun` | `unknown_effect` | result with an unknown effect | executor |
| `offered`, `reserved` | `fenced` | a result naming a `beginId` when no begin is recorded and the batch is not settled | executor, answered `result_unverifiable` |
| `offered`, `reserved` | `settled_interrupted` | batch settles; effect `none` | owner cancel, expiry timer or restore policy |
| `begun` | `settled_interrupted` | batch settles; effect stays unknown until a result says otherwise | owner cancel, expiry timer or restore policy |

A recorded result is final. A call with a result, and a fenced call, keep their state
when the batch settles. No transition returns a call to `offered` from `begun` or later.
A `settled_interrupted` call that had begun still accepts its one result, naming its
begin, from its executor. That result is recorded for reconciliation and is never
delivered. The call's state stays `settled_interrupted`. A `settled_interrupted` call
that receives a result naming a begin Crew does not hold is answered
`result_unverifiable`. Crew records nothing, does not fence the call, and the call
keeps its state.

## Results

`POST …/calls/{toolCallId}/result` records the call's one result:

```json
{ "executorId": "…", "resultId": "…", "beginId": "…",
  "content": "Opened notes/release.md", "effect": { "kind": "known", "effect": "occurred" } }
```

A refusal with an error:

```json
{ "executorId": "…", "resultId": "…", "reservationId": "…",
  "content": "", "error": "denied", "effect": { "kind": "known", "effect": "none" } }
```

- `resultId` is a UUID the executor chooses and saves before sending.
- `beginId` names the committed begin. A local refusal before any begin sends
  `reservationId` instead, and its effect must be known `none`.
- `content` is the canonical AG-UI tool message `content`, a string. Optional `error` is
  a string. `content` may be `""` when `error` is set. Together they are the tool message
  `{ role: "tool", toolCallId, content, error? }` Crew hands to the adapter. Both follow
  [text values](#text-values) and the [result bounds](#result-bounds).
- `effect` mirrors Switchboard `ToolEffect` without evidence:
  `{ "kind": "known", "effect": "none" }`, `{ "kind": "known", "effect": "occurred" }` or
  `{ "kind": "unknown" }`. It is a separate fact from `content` and `error`. An error with
  a known-none effect is a refusal that changed nothing.

In a request body `error` is optional. In every reply and receipt `error` is always
present, and `null` when the result has none.

What the native model sees for an error result is the adapter's rendering of that tool
message, defined with native delivery in `switchboard-5py2`. Crew passes `content` and
`error` unchanged and adds nothing. Both fields are model-visible, so `error` holds only
text the client is willing to show the model. Crew stores both exactly as received.

The reply is `200`:

```json
{ "apiVersion": "1", "toolCallId": "…", "resultId": "…", "state": "resulted" }
```

`state` is `resulted`, `unknown_effect` or `settled_interrupted`.

| Already recorded | Request | Result |
| --- | --- | --- |
| no result, begin `B` | `resultId` R, `beginId` B | `200`; the result commits. |
| result R with body digest X | `resultId` R, body digest X | `200`, same reply. Nothing new is recorded. |
| result R with body digest X | `resultId` R, another body digest | `409 result_conflict` |
| result R | another `resultId` | `409 result_conflict` |
| fenced | any new result | `409 result_unverifiable`; nothing recorded |
| no result, begin `B` | another `beginId` | `409 begin_conflict` |
| no result, begin `B` | `reservationId` | `409 begin_conflict` |
| no begin; the call is `settled_interrupted` or its batch is closed to new work | `reservationId` | `409 call_closed` |
| no begin, batch open to new work, `reservationId` lapsed or not current | known-none effect | `409 reservation_expired` |
| no begin, `reservationId` current | known-none effect | `200`; the result commits. |
| no result, no begin, batch not settled | any `beginId` | `409 result_unverifiable`; the call becomes fenced |
| `settled_interrupted` before any begin | any `beginId` | `409 result_unverifiable`; nothing recorded; the call is not fenced and stays `settled_interrupted` |
| `settled_interrupted` after begin `B`, no result | `resultId` R, `beginId` B | `200`; recorded for reconciliation, never delivered. |
| any | `reservationId` with an `occurred` or `unknown` effect, or both `beginId` and `reservationId`, or neither | `400 invalid_input` |

Result checks run in this order, under the batch row lock. The first that applies wins.

1. `400 invalid_input`, including a field over its limit or a string that breaks
   [text values](#text-values).
2. `409 executor_mismatch`.
3. The call has a result. The same `resultId` with the same body digest returns `200`
   with the same reply. Anything else fails `409 result_conflict`.
4. `409 result_unverifiable` when the call is fenced.
5. `409 begin_conflict` when a begin committed and the request names another `beginId`
   or names a `reservationId`.
6. `409 call_closed` when the request names a `reservationId` and the call is
   `settled_interrupted` or its batch is closed to new work.
7. `409 reservation_expired` when the request names a `reservationId` that is not
   current.
8. `409 result_unverifiable` when the request names a `beginId` and no begin is
   recorded. The call becomes fenced unless it is `settled_interrupted`, which keeps
   its state.
9. The result commits.

A body over the 128 KiB cap fails `413 request_too_large` before any of these checks.

`400 invalid_input` and `413 request_too_large` on a result are definitive. The result
never applied and never will. `result_conflict` is definitive. The call already has a
different result, so this result never applied and never will.

`result_unverifiable` is not definitive. Crew holds no begin for the call, yet the
result names one. That happens when a database restore lost a begin committed after the
recovery point, or when the ID is wrong. Crew cannot tell which. It records nothing for
the result. On an unsettled batch it fences the call. A fenced call is never offered
again, and its batch cannot continue automatically. On a `settled_interrupted` call it
changes nothing. Either way the executor treats its operation as unknown.

Native delivery is a separate fact. A result says what the client observed. It never
says the native turn received it. Crew records delivery later, from the adapter, as
`continuation.delivery` on the batch receipt (mirroring Switchboard `NativeDelivery`),
and never infers it from the client.

### Result bounds

- `content` is at most 60,000 bytes and `error` at most 1,024 bytes, each measured as
  the UTF-8 length of the decoded string. A field over its limit fails
  `400 invalid_input`.
- JSON escaping can make the encoded body larger than the decoded fields. A control
  character becomes a six-byte `\u00XX` escape. So a result within both field limits can
  still exceed the 128 KiB body cap once encoded, and then fails `413 request_too_large`.
- Neither failure ever applies the result.

The executor checks both field limits, the [text values](#text-values) rule and the
encoded size of the whole body before it saves a result. When the handler's output does
not fit or breaks the text rule, it saves a bounded result instead, under a new
`resultId`, and never sends the original. The bounded result is one of these:

- `content` truncated to fit, at a code point boundary so it stays well-formed, with
  `error` unchanged if it fits;
- `content: ""` and `error: "output_too_large"`; or
- for text that breaks the rule, `content: ""` and `error: "output_invalid_text"`.

Either way it keeps the **same effect** as the handler's outcome. An `occurred` effect
stays `occurred`. If an executor finds a saved result answered `400 invalid_input` or
`413 request_too_large`, that result never applied, so it saves a bounded result the
same way under a new `resultId` and sends that. Neither size nor ill-formed text ever
leaves a call begun.

## Batches

A batch is the ordered set of frontend calls one native turn segment stopped on, in the
order the native turn emitted them. A batch holds 1 to 1,000 calls, of which Crew offers
at most 128. Crew stores it with its `PendingFrontendBatch` envelope.

| State | Meaning |
| --- | --- |
| `open` | Some call has no result, and no call has a result with unknown effect or is fenced. A begun call with no result keeps the batch here unless another call blocks it. |
| `blocked` | At least one call has a result with unknown effect or is fenced. The batch is closed to new work. Begun calls can still record results. The batch never continues on its own. |
| `committed` | Every call has a result with a known effect, and the ordered result set committed. It has one continuation intent, except as in [late commits](#late-commits). |
| `settled_interrupted` | Settled without continuation, with `reason` `endpoint-lost`, `app-cancelled` or `expired`. |

| From | To | Cause | Actor | Request outcome |
| --- | --- | --- | --- | --- |
| (none) | `open` | native turn stops on frontend calls | Crew worker | unchanged |
| (none) | `committed` | Crew records every call's result itself | Crew worker | the continuation runs |
| `open` | `committed` | the last result commits and every effect is known | executor's result, Crew in the same transaction | the continuation runs, unless [late](#late-commits) |
| `open` | `blocked` | a call gets a result with unknown effect or is fenced | executor | unchanged; never continues on its own |
| `open`, `blocked` | `settled_interrupted` (`app-cancelled`) | owner cancels the request, except as below | owner, or restore policy after process loss | the existing cancellation path |
| `open`, `blocked` | `settled_interrupted` (`expired`) | the batch's expiry timer fires at `expiresAt`, except as below | Crew workflow timer, or restore policy after process loss | the existing cancellation path, as an expired approval |
| `open`, `blocked` | `settled_interrupted` (`endpoint-lost`) | restore policy after the native waiter is lost | Crew restore policy | see [open questions](#open-questions-and-non-goals) |
| `committed` | `committed`, gaining a `settlement` (`app-cancelled`, `expired` or `endpoint-lost`) | restore policy settles a committed batch whose native waiter is lost and whose delivery is not confirmed | Crew restore policy | the continuation is never delivered; the request ends as for the same reason in the rows above |

The exception: after process loss, a batch whose restore situation is `already-settled`
or `indeterminate` is offered only `defer`. It never settles, not on cancel and not
after `expiresAt`, while its situation stays that way. See
[restore](#restore-after-process-loss) for what such a batch shows.

`expiresAt` is `openedAt` plus `batchSeconds` (86,400). Expiry has a durable actor. The
request's workflow starts a timer when the batch opens, and the timer acts at
`expiresAt`. Without process loss it settles the batch. After process loss it triggers
a restore assessment. Expiry is never evaluated lazily on read, though the batch is
closed to new work at or past `expiresAt`.

Reserve, begin, result commits and settlements serialize on the batch row lock. The
call routes, the owner's cancel and the expiry timer each lock the batch row before they
read or change the batch or a call. The first to take the lock wins.

- If the last result commits first, the batch is `committed`. A later cancel follows
  the existing rule that a completed result beats a later cancel. The cancel applies to
  the continuation turn, not to the batch. A later expiry timer finds the batch
  committed and changes nothing.
- If a settlement commits first, a later result follows the result table for a settled
  call.

Without process loss, an owner cancel or expiry settles the batch directly, and Crew
cancels the native turn through the existing cancellation path. After process loss a
batch settles only through a restore decision, and cancel and expiry trigger a fresh
assessment. Whether process loss has happened is a durable fact (see
[implementation obligations](#implementation-obligations-crew-1rcl-crew-avzm)).

`settled_interrupted` is final. `committed` is final for results, but restore can still
settle a committed batch whose native waiter is gone. Its state stays `committed`, it
gains a `settlement`, and its continuation is never delivered.

### Late commits

The last result of a batch can arrive after the owner cancelled the request or at or
past `expiresAt`. No continuation intent is ever admitted for such a batch.

- Without process loss, the result route, holding the batch row lock, first settles the
  batch as the cancel or the timer would (`app-cancelled` or `expired`), then records
  the result as for a settled call. The result is kept for reconciliation and never
  delivered.
- After process loss, for example on a batch deferred as `already-settled` or
  `indeterminate`, Crew records the result. When every effect is known the batch
  becomes `committed`, with its ordered result set, no continuation intent and
  `continuation: null`. That commit triggers a restore assessment.

### Commit rule

- The complete ordered batch commits atomically, in the transaction that records its
  last result, before any continuation is admitted and before any public success.
- Each batch has at most one continuation intent, unique on `batchId`, and exactly one
  unless it committed late. A retry of the last result replays. It never writes a second
  intent.
- Results with errors and a known-none effect complete a batch like any other result,
  including every result Crew records itself.
- A result with unknown effect, or a fenced call, blocks automatic continuation, even
  when a payload is stored. Version 1 has no route that overrides the block. The owner
  cancels the request.
- Expiry, cancellation and abandonment never authorize a replacement execution. No
  settled call is offered again, and no new batch repeats its calls.

### Segment bound

A request holds at most `batchesPerRequest` (32) batches. When a native turn of a
request that already holds 32 batches stops on frontend calls again, Crew stores no
batch and takes the same path as an [envelope rejection](#calls-offer-reservation-begin):
it ends the native turn through its native uncertainty path, and the request becomes
`uncertain`.

Why 32: it bounds a request's stored batches at 32 times the per-batch bounds, and its
lifetime with open batches at 32 times `batchSeconds`. A batch in which Crew records
every call's result commits at once and continues at once, so without a bound a model
that keeps calling an unknown tool would loop with no human in it. 32 rounds of client
tool calls is generous for an interactive request.

### Request receipt

The request status keeps its existing meaning. An open or blocked batch does not make a
request `waiting`, because `waiting` still means only that a published human decision
is unresolved. The request receipt gains an additive field `frontendBatch` for the
request's latest batch, or `null`:

```json
{
  "apiVersion": "1", "conversationId": "…", "requestId": "…",
  "acceptance": { "boundary": "sql_admission_and_temporal_queue" },
  "status": "running",
  "frontendBatch": { "batchId": "…", "state": "open", "closedToNewWork": false }
}
```

A consumer reads `frontendBatch` to learn about frontend work, never `waiting`. Expiry
and cancellation end the request through the existing cancellation path, as an expired
approval does, except for a deferred batch after process loss.

## Reading back and reconciling

`GET {batchRoute}` returns the batch receipt. Both reads take the identity in the path
only, return `404 not_found` for any mismatch or another owner's IDs, use
`Cache-Control: no-store`, take no lock and change nothing.

```json
{
  "apiVersion": "1", "conversationId": "…", "requestId": "…", "batchId": "…",
  "runId": "…", "previousBatchId": null, "state": "open", "closedToNewWork": false,
  "openedAt": "2026-11-17T23:10:00Z", "expiresAt": "2026-11-18T23:10:00Z",
  "calls": [
    { "toolCallId": "…", "name": "agentui-files__open", "definitionDigest": "sha256:…",
      "argumentsDigest": "sha256:…", "state": "reserved",
      "arguments": { "path": "notes/release.md" },
      "reservation": { "reservationId": "…", "expiresAt": "2026-11-17T23:11:05Z" },
      "beginId": null, "result": null },
    { "toolCallId": "…", "name": "agentui-files__read", "definitionDigest": "sha256:…",
      "argumentsDigest": "sha256:…", "state": "begun",
      "arguments": { "path": "notes/changelog.md" },
      "reservation": null, "beginId": "…", "result": null },
    { "toolCallId": "…", "name": "agentui-files__list", "definitionDigest": "sha256:…",
      "argumentsDigest": "sha256:…", "state": "resulted", "arguments": null,
      "reservation": null, "beginId": "…",
      "result": { "resultId": "…", "content": "notes/\nsrc/", "error": null,
        "effect": { "kind": "known", "effect": "none" }, "recordedAt": "…" } },
    { "toolCallId": "…", "name": "shell__run", "definitionDigest": "sha256:…",
      "argumentsDigest": "sha256:…", "state": "resulted", "arguments": null,
      "reservation": null, "beginId": null,
      "result": { "resultId": null, "content": "", "error": "unknown_tool",
        "effect": { "kind": "known", "effect": "none" }, "recordedAt": "…" } }
  ],
  "continuation": null,
  "settlement": null,
  "restore": null
}
```

`calls` is in batch order. Each call carries `toolCallId`, `name`, `definitionDigest`,
`argumentsDigest`, `state`, `arguments`, `reservation`, `beginId` and `result`.

- `arguments` is as [above](#calls-offer-reservation-begin): the object while the call
  is `offered`, `reserved` or `begun`, else `null`.
- `reservation` is `{ reservationId, expiresAt }` only in state `reserved`, else `null`.
- `beginId` is the committed begin, or `null`.
- `result` is `null` or `{ resultId, content, error, effect, recordedAt }`. `error` is
  always present and `null` when absent. A result Crew recorded itself has `resultId`
  `null` and `beginId` `null`.
- `name` is `null` only for an `unknown_tool` or `too_many_calls` call whose native name
  matches no selected definition and cannot be shown
  (see [results Crew records itself](#calls-offer-reservation-begin)).

`continuation` is `null` until the batch commits with a continuation intent, then
`{ committedAt, delivery }`, where `delivery` is `{ "kind": "unknown" }` or
`{ "kind": "confirmed", "confirmedAt": "…" }`. A committed batch, once delivered:

```json
"continuation": { "committedAt": "2026-11-17T23:12:40Z",
  "delivery": { "kind": "confirmed", "confirmedAt": "2026-11-17T23:12:41Z" } }
```

`settlement` is `null` or `{ reason, settledAt }`. `restore` is `null` or the latest
public restore payload (see [restore](#restore-after-process-loss)). Like `undecided`,
`offered` and `reserved` say only what is recorded now, not that a later action will
succeed.

`GET {callRoute}` returns one call's fields, flattened, with the batch identity and the
batch's `state` and `closedToNewWork`:

```json
{
  "apiVersion": "1", "conversationId": "…", "requestId": "…", "batchId": "…",
  "batchState": "open", "closedToNewWork": false,
  "toolCallId": "…", "name": "agentui-files__read", "definitionDigest": "sha256:…",
  "argumentsDigest": "sha256:…", "state": "begun",
  "arguments": { "path": "notes/changelog.md" },
  "reservation": null, "beginId": "…", "result": null
}
```

Every error has the existing body, for example a reserve on a settled batch:

```json
{ "error": "call_closed" }
```

## Discovering work

The batch receipt is the only source of frontend work. The observation stream carries
no frontend call and no signal of one, so reconnecting an observer is not a discovery
mechanism.

- Poll `GET` on the request receipt and read `frontendBatch`. A new `batchId`, or a
  `state` of `open` or `blocked`, means there may be work.
- Then poll `GET {batchRoute}`. Calls in `offered` on a batch with
  `closedToNewWork: false` may be reserved, and their arguments are in the receipt.
  An `offered` call on a batch closed to new work is never reservable again.
- The poll budget is shared per request. An executor makes at most one read per
  `pollSeconds` (1) per request, counting the request `GET`, `GET {batchRoute}` and
  `GET {callRoute}` together. Call actions are not polls and are not budgeted. Any read
  may carry a `Retry-After` header in seconds, and the executor waits at least that long
  before its next read of that request.
- Version 1 has no rate-limit status or code. Crew answers a read that comes too early
  normally, with the current state, and it shows nothing new. `Retry-After` is guidance
  only.
- Owner cancel and expiry are observable only as state. A settled batch shows
  `settled_interrupted` with a `settlement`, its calls without a result show
  `settled_interrupted`, `closedToNewWork` is `true`, and reserve and begin return
  `409 call_closed`.
- A handler already running gets no push signal from Crew. The executor sees the
  settlement on its next read or action. Its result is still recorded for
  reconciliation and never delivered.

Stop rules:

- Stop polling a batch once any of these holds: it is `committed`; it is
  `settled_interrupted`; or `closedToNewWork` is `true` and the executor holds no call
  in it that it began and whose result Crew has not yet answered. Then go back to the
  request receipt for the next segment's batch.
- Stop polling the request once its status is terminal: `completed`, `cancelled`,
  `failed` or `uncertain`, and no batch of it is still being polled.
- Stopping a poll never stops resending a saved result until it is answered.

## Executor algorithm

The executor keeps a durable journal per call. Each step below saves before it sends,
so the executor can resume after a crash at any point. It follows the integration API's
rules for ambiguity. After `503 retry_same_request`, a timeout, a lost reply or a
restart, it resends the exact body under the same IDs. It never mints a new
`reservationId`, `beginId` or `resultId` for an operation that may have been sent,
except where a step below says so.

**Rule 0.** An executor that holds a confirmed begin for a call, or a saved result that
names a `beginId`, never reserves or begins that call again, whatever a read shows. That
includes a read after a Crew database restore that shows the call `offered`. It resends
its saved result, naming its own `beginId`. Crew then records the result, or answers
`result_unverifiable`. Rule 0 does not cover a refusal before any begin: a saved result
naming a `reservationId` that is answered `409 reservation_expired` never applied, and
the executor may reserve again (see below).

The steps:

1. Save `executorId` before the submit.
2. Save a new `reservationId`, then send reserve. If the reply is lost, repeat the same
   reserve to get the arguments. `409 reservation_expired` means it lapsed with no
   begin, so return to this step with a new `reservationId`. `409 call_reserved` means
   wait and retry later. `409 call_closed` means stop. The call is not this executor's
   to run.
3. Save the arguments the reserve returned. Only then save a new `beginId` and send
   begin.
4. Resend the same begin until it is answered. `200` is a confirmed begin. Save that
   fact. `409 reservation_expired` means this begin never committed and never will, so
   return to step 2 with a new `reservationId`. `409 begin_conflict` or
   `409 call_closed` means never run the handler, and stop.
5. Save an "about to invoke" marker, then invoke the handler. The marker means the
   handler may have run. A crash after the marker means the effect is unknown, and the
   handler is never run again.
6. Build the result body from the handler's outcome, apply the
   [result bounds](#result-bounds), save it with a new `resultId`, then send it. Resend
   the same body until it is answered.

On restart, the journal decides the next step for each call.

| Journal holds | Action |
| --- | --- |
| no `reservationId` | step 2 |
| a `reservationId`, no arguments | repeat the same reserve (step 2) |
| arguments, no `beginId` | save a new `beginId`, then send begin (step 3) |
| arguments and a `beginId`, begin not confirmed | resend the same begin (step 4) |
| a confirmed begin, no marker | the handler never ran. Read the call. If it is `begun` with this `beginId`, go to step 5. Otherwise never run the handler, and send a result naming this `beginId` with `content: ""`, `error: "not_invoked"` and a known-none effect. |
| a marker, no saved outcome | never run the handler again. Save and send a result naming this `beginId` with `content: ""`, `error: "interrupted"` and an unknown effect. AgentUI overrides this row (see [binding obligations](#binding-obligations-agentui-itki)). |
| a saved result | resend it exactly (step 6) |

Reading the outcome of a sent result:

- `200`, or a read showing its own `resultId`, means the result applied.
- `409 result_conflict`, or a read showing another `resultId`, means its result never
  applied.
- `400 invalid_input` or `413 request_too_large` means it never applied and never will.
  When the cause is `content` or `error` (size or the text rule), apply the
  [result bounds](#result-bounds) under a new `resultId` with the same effect.
- `409 result_unverifiable` means Crew holds no begin for the call. The executor treats
  its operation as unknown.
- `409 reservation_expired` on a `reservationId` result means it never applied. The
  executor reserves again, saves a new `resultId` and sends the refusal under the new
  `reservationId`. `409 call_closed` on it means stop.
- `404` or a transport failure means still unknown. Retry the exact request.

**Persistent 404.** A `404` can follow a Crew database restore to a point before the
batch or the request existed. After 10 consecutive `404` answers to the same operation,
spread over at least 10 minutes, the executor stops retrying it, records the operation
as unknown in its journal and stops acting on that request. It never runs a handler for
a call it has not confirmed begun, and never reruns one it has.

An executor that has lost its journal never runs a call that a read shows as `begun`.
It may send a result with unknown effect naming the `beginId` the read shows, which
ends the call as a result with unknown effect.

## AgentUI mapping

AgentUI's coordinator (`packages/host/src/frontend-tools/index.ts`) gates each call on
host consent and an execution permit. Its binding to Crew is `agentui-itki`. This
section fixes only the Crew-facing facts the binding sends. The AgentUI names are
AgentUI's, and Crew gains no field for them. How the binding drives the coordinator is
in [binding obligations](#binding-obligations-agentui-itki).

| AgentUI | Crew |
| --- | --- |
| `deny` | A result with `reservationId`, `error: "denied"`, `content: ""` and a known-none effect. |
| reserve returned arguments whose AgentUI digest differs from the consented digest | A result with `reservationId`, `error: "arguments_mismatch"`, `content: ""` and a known-none effect. Never a begin. |
| refusal after begin: `released`, `unknown-tool`, `activation-mismatch`, `decode-failed`, `invalid-arguments` | A result with `beginId`, `error` set to the code, `content: ""` and a known-none effect. |
| a receipt `completed` with `output` | A result with `beginId`, `content` set to `output` within the [result bounds](#result-bounds), and a known `occurred` effect. |

- `activationId` has no Crew field. The host keeps its own map from definition digest to
  name and activation.
- AgentUI's `argumentsDigest` is AgentUI's own, the hex SHA-256 of its canonical JSON of
  the arguments. The binding treats Crew's `argumentsDigest` as opaque and never
  compares it with AgentUI's. The only digest comparison is AgentUI's digest against
  AgentUI's digest.
- The local run key is the binding's own. A batch `runId` never equals it.

## Binding obligations (agentui-itki)

The binding builds its own local AG-UI run for the coordinator from the batch receipt,
under its own run key. It never feeds Crew's observation stream to the coordinator.
Crew's bounds rest on Crew's own grounds and promise nothing about AgentUI's limits. The
binding must handle each item below. Each names the Crew-side signal it uses.

1. **Per-call order.** Decide consent with
   `decide(key, callId, allow | deny, activationId, argumentsDigest)` using AgentUI's
   own digest of the receipt's `arguments`. On allow, reserve in Crew, recompute
   AgentUI's digest of the arguments the reserve returned and compare. On a match, save
   the arguments, begin in Crew, then claim the AgentUI permit and invoke. The claim
   gate in item 6 is mandatory from `decide(allow)` onward. On deny,
   send the refusal under a current `reservationId`, reserving again if it holds none or
   its reservation lapsed. Signals: receipt `arguments`, the reserve reply, the begin
   reply.
2. **Coordinator per-run limits.** The coordinator allows 128 calls per run, 64,000
   bytes per event, argument and output, 1,000,000 bytes of run metadata and 4,096
   cursors. For each call the binding chunks its `TOOL_CALL_ARGS` deltas, shards the
   batch across several local runs, or refuses a call it cannot fit, known-none, with a
   `reservationId` result. Signals: receipt `arguments` (at most 60,000 bytes each, at
   most 1,000,000 per batch) and the batch's call count (at most 128 offered).
3. **What enters a local run.** Only calls the receipt shows `offered`, `reserved` or
   `begun` enter a local run. A call with a result, a fenced call, a
   `settled_interrupted` call and every Crew-recorded call (`resultId` `null`) never
   does. Signals: call `state`, `result.resultId`.
4. **Stable local run key.** The key for a batch, or for each shard of it, is derived
   from `batchId` and is the same on every poll, so a repeated poll never registers a
   second local run. After local state loss the binding rebuilds from the batch
   receipt and follows the journal-loss rule: it never runs a call the receipt shows
   `begun`. Signals: `batchId`, call `state`, `beginId`.
5. **Claim after a confirmed Crew begin.** If `claim` returns `unavailable`, the
   handler was never invoked: send a result naming the `beginId` with `content: ""`,
   `error: "not_invoked"` and a known-none effect. If it returns `uncertain`, a permit
   already exists, and the binding treats it as the "about to invoke" marker: it never
   invokes again and waits for that permit's receipt. Signal: the confirmed begin.
6. **Mandatory claim gate.** `decide(allow)` makes the call claimable at once in the
   coordinator. So from `decide(allow)` until the binding holds a confirmed Crew begin
   for that call, the actor `authorized` callback refuses every `claim`, and after the
   begin only the binding's own actor may claim. On `409 call_closed` or
   `409 begin_conflict` the gate stays shut and no one ever claims the call. Signals:
   the begin reply and the begin error.
7. **Uncertain receipts.** In `coordinator.ts`, `receipt` with `{ kind: "uncertain" }`
   returns `uncertain` and writes nothing, so the call stays permitted and a later
   `completed` receipt from the original actor is still recorded. The AgentUI permit is
   the durable "about to invoke" marker. A permit with no receipt leaves the Crew call
   begun, no result, and the binding sends nothing, until a receipt arrives or the
   batch settles. It sends `interrupted` or any unknown effect only under an explicit
   give-up policy of its own. This overrides the restart row "a marker, no saved
   outcome". Signals: call `state` `begun`, `settlement`.
8. **A completed receipt Crew refuses.** `409 result_conflict` means Crew holds another
   result and this one never applied. The binding reads the call, keeps Crew's result
   as the outcome and never runs the handler again. `409 result_unverifiable` means the
   outcome is unknown. The binding never runs the handler again and surfaces the call to
   the owner. Signals: the result error, `GET {callRoute}`.
9. **Crew cancel, expiry or settlement.** When the batch shows a `settlement`, or
   `closedToNewWork` turns `true` because the request was cancelled or `expiresAt`
   passed, the binding calls `producer.cancel(key)` for each local run of the batch. A
   receipt that still arrives for a begun call is sent as a result and is recorded for
   reconciliation. Signals: `settlement`, `closedToNewWork`, request `status`.
10. **Durable actor.** The coordinator accepts a receipt only from the original actor.
    The binding's actor id equals `executorId`, or is stably mapped from it and saved,
    so a late receipt after a restart still comes from the original actor. Signal:
    `executorId`.
11. **Oversize output.** AgentUI accepts output up to 64,000 bytes. Crew accepts
    `content` up to 60,000 bytes and a body up to 128 KiB. The binding applies the
    [result bounds](#result-bounds): it truncates or sends `output_too_large`, with the
    same `occurred` effect, under a new `resultId`. AgentUI does not check output for
    NUL or unpaired surrogates, so the binding also applies the text rule and sends
    `output_invalid_text` with the same effect when it fails. Signal:
    `limits.contentBytes`.
12. **The client run pin.** AgentUI's run pin over its handlers is released only after
    each pending call is held by a handle that survives the run, as AgentUI's retained
    pins already do. Signal: call `state` `begun`.

## Restore after process loss

Crew is the importing application under Switchboard's
[frontend restore contract](https://github.com/operatorworks/switchboard/blob/main/docs/architecture/frontend-restore.md).
Switchboard owns no persistence. Crew persists, in its own tables:

- the `PendingFrontendBatch` envelope (`formatVersion: 1`, `adapter`, `session`,
  `nativeTurnId`, `epoch`, `sourceRunId`, `calls`), written with the batch;
- every result, as above;
- restore decisions, keyed by `(batchId, situationKey)`.

Switchboard derives the situation key deterministically. In
`src/core/frontend-restore.ts` it is `sha256:` and the hex SHA-256 of
`JSON.stringify([1, batch, admission, classified, options])`. The same situation gives
the same key, and a changed situation gives a new key. A decision is write-once for its
key. A decision stored under another key is stale and never applies to a different
situation.

**Which batches are assessed.** Crew assesses a batch only while it has no applied
final decision and no confirmed delivery. A final decision is any decision other than
`defer`. A `settled_interrupted` batch, a batch whose `deliver-original` decision was
applied, and a batch whose continuation delivery is confirmed are never assessed again.

**How.** Crew first looks up the decisions stored for the batch by `batchId`. If one of
them is final, Crew follows it and stops. Otherwise it parses the envelope with
`parsePendingFrontendBatch` and calls `assessFrontendRestore` with admission
`production`, then looks up a decision stored under `(batchId, situation.key)`. If one
is stored, Crew follows it. Otherwise it runs its policy through
`decideFrontendRestore`. It writes the decision by compare-and-set against the exact
stored value it read, using `compareRestoreDecisions`. `write` and `replace-defer`
write. `replay` and `defer-ignored` write nothing. On `decision-conflict` or a lost
compare-and-set Crew writes nothing, reads the stored decision again and follows it.

A stored `defer` is not an end state. For a batch that is still assessed, Crew assesses
again and reruns its policy on each of these events.

- The owner cancels the request.
- The batch's expiry timer fires.
- A deferred batch commits (see [late commits](#late-commits)).
- Any new observation of the batch's native state, such as a worker taking over the
  request.

Crew's policy reads the cancel and the clock as well as the situation. So an
assessment can yield the same situation, and the same key, while the policy now
chooses a final mechanism. `compareRestoreDecisions` then answers `replace-defer`, and
Crew writes the final decision over the `defer`.

Crew sets its own `FrontendRestorePolicy` with revision `crew.frontend-restore.v1`:

| Situation | Choice |
| --- | --- |
| `warm`, batch `committed` with a continuation intent, `deliver-original` offered at `production` admission | `deliver-original` |
| `warm`, `rejoinable` or `original-lost`, request cancelled by the owner | `settle-interrupted` with `app-cancelled` |
| `warm`, `rejoinable` or `original-lost`, now at or past `expiresAt` | `settle-interrupted` with `expired` |
| `original-lost`, any other case | `settle-interrupted` with `endpoint-lost` |
| anything else, including `already-settled` and `indeterminate` | `defer` |

The policy runs only for a batch that is still assessed: `open`, `blocked`, or
`committed` without confirmed delivery, and with no final decision. For a committed
batch whose waiter is lost and whose delivery is not offered, the cancel and expiry rows
give it an end state through `settle-interrupted`, which it would otherwise lack.

No adapter offers `deliver-original` at production admission today. The Codex option
is fixture-only and production admission hides it. Until that changes, a warm committed
batch defers until it is cancelled or expires. Crew never chooses `redispatch` or
`continue-new-turn` for a batch with a begun call. Version 1 chooses neither at all, nor
`paired-repair`.

Settling a warm batch does not release the native waiter. A warm `settle-interrupted`
decision therefore also writes the native cancellation intent for the turn, in the same
transaction as the decision, and Crew cancels the native turn through the existing
path.

**Batches that can only defer.** Switchboard offers only `defer` for `already-settled`
and `indeterminate`, because settling them could misreport native output that already
exists. `already-settled` means the native session settled every call itself.
`indeterminate` means an epoch conflict, partial native output, or a native state Crew
could not observe. Such a batch never settles, on cancel or after `expiresAt`, until a
new observation yields a situation that offers a final mechanism. While it stays
deferred:

- The batch receipt keeps the batch's last `state` (`open`, `blocked` or `committed`),
  `settlement` stays `null`, and `restore` shows the deferred decision with the
  situation's kind and, for `indeterminate`, its reason.
- The request receipt's `frontendBatch.state` matches the batch. The request keeps its
  current status: `cancellation_requested` after an owner cancel, otherwise the status
  it had.
- Once the request is cancelled or the batch is at or past `expiresAt`, the batch is
  closed to new work, and reserve and begin fail `409 call_closed`. A result naming a
  committed begin is still recorded. If it is the last one, the batch commits late,
  with no continuation intent.
- The batch needs operator action. The operator inspects the native session, and a
  worker taking over gives Crew a new observation. Version 1 has no owner or operator
  route that settles a deferred batch.

**Restore facts.** Version 1 emits no restore fact on the public observation stream.
The only public view of restore is the batch receipt's `restore` field. It is `null` or
the latest Switchboard public restore payload,
`{ sourceRunId, toolCallIds, situation: { kind, key, reason? } }` with phase `required`
and `options`, or phase `decided` with `policyRevision` and the chosen option's
`mechanism`, `deliveryClass` and `qualification`. It carries no native IDs, session
envelope, epoch, arguments or results. A deferred `indeterminate` batch shows:

```json
"restore": {
  "sourceRunId": "…", "toolCallIds": ["…", "…"],
  "situation": { "kind": "indeterminate", "key": "sha256:…", "reason": "lookup-failed" },
  "phase": "decided", "policyRevision": "crew.frontend-restore.v1",
  "mechanism": "defer", "deliveryClass": "not-delivered", "qualification": "native-free"
}
```

Projecting the payload as Switchboard's CUSTOM fact (namespace
`switchboard.frontend-restore`, name `frontend-restore`) on the public stream is a
possible later addition.

## Run pins and process replacement

The native turn's live handle, the worker activity holding the waiter, is a run pin.
The worker keeps the native waiter live until the batch's continuation is delivered or
the batch settles. Releasing the pin means durable ownership moves to the batch and call
rows once they commit. It does not mean the worker drops the waiter. Moving ownership
before the rows commit could leave calls with no durable owner.

The durable identity of a frontend artifact is
`(owner, conversationId, requestId, batchId, toolCallId)`, with its digests. It survives
worker replacement, gateway replacement and Continue-As-New. The live native waiter
does not, and restore handles that. A replaced gateway serves reads and call actions
from PostgreSQL alone.

## AG-UI observation

Version 1 does not change observation. `POST /v1/conversations/{conversationId}/events`
keeps its body rules, its query rules and its stream exactly as today, for every
observer. An observer can neither define, reserve, begin nor answer a frontend call.
Results reach Crew only through the result route.

Native frontend calls do not appear on the public stream. Crew's projection
(`src/service/observation.ts`) builds events from a closed set of ledger change kinds.
Its `TOOL_CALL_*` events come only from Crew's own tools: approval-gated calls such as
`record_work_item` (`call`), their argument previews (`toolPreview`, `toolValue`) and
delegation. Version 1 adds no change kind for a frontend call, so the projection emits
nothing for one. No frontend `TOOL_CALL_*` event, no `pendingToolCallIds` and no
restore fact reach any observer. While a batch is open, the stream shows the request in
its existing status, and frontend work is read only from the batch receipt.

## Errors and bounds

All errors use `{"error":"<snake_code>"}`. Existing codes keep their meaning.
`400 invalid_input`, `401`, `404 not_found`, `409 conflict`, `413 request_too_large`
over 128 KiB, and `503 retry_same_request` when the outcome may be ambiguous. On a
result, `400 invalid_input` and `413 request_too_large` are definitive: the result never
applied.

| Code | Status | Routes | Definitive | Meaning |
| --- | --- | --- | --- | --- |
| `definition_unknown` | 409 | submit | yes | A selected digest is not the owner's definition. Nothing admitted. |
| `definition_name_conflict` | 409 | submit | yes | Two selected definitions share a name. Nothing admitted. |
| `selection_too_large` | 409 | submit | yes | The selected definitions total more than 128,000 bytes. Nothing admitted. |
| `frontend_tools_unsupported` | 409 | submit | yes | The member's engine cannot deliver frontend calls. Nothing admitted. |
| `executor_mismatch` | 409 | reserve, begin, result | yes | Another `executorId` owns the request's calls. |
| `call_reserved` | 409 | reserve | no | Another reservation is current. Read and retry later. |
| `reservation_expired` | 409 | reserve, begin, result | yes | This reservation is not current and never began. It never will begin. |
| `begin_conflict` | 409 | begin, result | yes | Another begin committed, or a `reservationId` result arrived after a begin. This one never applied. Never run the handler. |
| `call_closed` | 409 | reserve, begin, result | yes | On reserve, the call has begun, has a result, is fenced or is `settled_interrupted`, or its batch is closed to new work. On begin, the call has a result, is fenced or is `settled_interrupted`, or its batch is closed to new work, and this `beginId` did not commit. On result, a `reservationId` result when the call is `settled_interrupted` or its batch is closed to new work, with no begin. |
| `result_conflict` | 409 | result | yes | The call has a different result. This one never applied. |
| `result_unverifiable` | 409 | result | no | No record of that begin, or the call is fenced. Nothing recorded. An unsettled call becomes fenced. A `settled_interrupted` call keeps its state. |

`409 conflict` keeps its existing meaning and also answers a begin that reuses a
committed `beginId` with another body digest.

Crew-recorded `error` values are result contents, not HTTP codes. Crew checks them per
call in this order:

| `error` | Recorded when |
| --- | --- |
| `too_many_calls` | the native turn stopped with more than 128 frontend calls; every call gets it |
| `unknown_tool` | the call names no selected definition |
| `invalid_arguments` | the arguments are not valid JSON, are not a JSON object, or contain a string or key that breaks [text values](#text-values) |
| `arguments_too_large` | the arguments exceed 60,000 bytes |
| `batch_too_large` | this call, or an earlier call in batch order, would take the batch's offered arguments over 1,000,000 bytes |

Executor-written `error` values this document names are `denied`,
`arguments_mismatch`, `not_invoked`, `interrupted`, `output_too_large` and
`output_invalid_text`. Crew treats
every `error` as opaque text.

Bounds:

| Bound | Limit | Why |
| --- | --- | --- |
| name | 64 bytes | `namePattern`; the same rule as AgentUI's, so one definition serves both |
| one definition | 128,000 bytes | fits the 128 KiB (131,072-byte) body cap of the definition route |
| selected definitions per request | 128, totalling 128,000 bytes | bounds what Crew stores per request and hands the engine on every segment |
| offered calls per batch | 128 | bounds the work one segment hands a client; a larger stop gets `too_many_calls` |
| calls stored per batch | 1,000 | Switchboard's `frontendRestoreLimits.maxCalls`; a larger stop is an envelope rejection |
| batches per request | 32 | see [segment bound](#segment-bound) |
| arguments | 60,000 bytes | arguments share the `content` limit, so every stored value per call is bounded alike |
| `content` | 60,000 bytes decoded | leaves room in the 128 KiB body for `error`, IDs and moderate escaping; heavier escaping fails `413`, which the [result bounds](#result-bounds) avoid |
| `error` | 1,024 bytes decoded | short refusal text |
| offered arguments per batch | 1,000,000 bytes | bounds the batch's stored arguments and the arguments part of every `GET {batchRoute}` reply, which an executor polls |
| public IDs per batch | 1,000 UUIDs, 39,042 bytes | Switchboard measures the UTF-8 length of `JSON.stringify([sourceRunId, publicIds])`; for a UUID `runId` and 1,000 UUIDs that is 39,042 bytes, under `maxPublicIdBytes` (57,344) |

Arguments are measured as the UTF-8 length of their stored JSON text, which is also
their size inside any Crew reply. `content` and `error` are measured as decoded UTF-8
strings, as in [result bounds](#result-bounds). The per-batch budget counts arguments
only and is enforced once, when the batch opens, by the Crew-recorded `batch_too_large`
result. Results are stored exactly as received and are never rewritten. A
`GET {batchRoute}` reply therefore holds at most 1,000,000 bytes of arguments plus at
most 128 results of at most 61,024 decoded bytes each. Their JSON encoding in the reply
can be larger, up to six times for content made of control characters.

Content is a string in version 1. AG-UI content parts (images, files, structured
parts) are deferred to a later version, which will add a new value to `content`.

## Implementation obligations (crew-1rcl, crew-avzm)

These are constraints the implementation must meet. Each says what the implementation
must decide. None of them is a design.

1. **Native turn segments against Crew's one-turn-per-request schema.** A request with
   frontend batches runs several native turn segments. Crew's schema today assumes one
   turn per request:
   - `birbcrew_ts.turns` has `PRIMARY KEY (conversation_id, request_id)`
     (`src/service/sql/001-members.sql:20,33`), one `reply` of at most 65,536 bytes
     (`:31`), one `checkpoint` (`:32`), and a check that a committed turn has both and
     an uncommitted one has neither (`:35-38`).
   - `birbcrew_ts.codex_item_receipts.ordinal` is limited to 0 to 127 per request
     (`src/service/sql/013-codex-item-receipts.sql:4`, primary key `:7`).
   - The observation projection's `nativeItem` change throws `input_limit` at index
     128 or above (`src/service/observation.ts:152-154`).
   - `commitTurn` (`src/service/store.ts:701`) commits the reply and checkpoint
     (`:707-709`), publishes the `reply` change (`:719`) and appends
     `request.finished` (`:720-721`). The projection's `reply` case finishes the step
     and moves the conversation to `idle`, `complete` or `cancelled`
     (`src/service/observation.ts:322-345`). So a reply finishes the run.

   `crew-1rcl` and `crew-avzm` must decide how segments map onto turns, item receipts,
   the reply and the checkpoint, and onto the unchanged observation stream, including
   what an observer sees between segments. Existing tables will change. The migrations
   must state their locking and rewrite cost.
2. **A durable process-loss fact.** The cancel route, the expiry timer and the result
   route switch on whether the batch's native process was lost: without it they settle
   directly, after it they go through restore. The implementation must record process
   loss as a durable fact, for example a lost run-pin lease, name the one writer of that
   fact, write it before any restore assessment, and read it under the batch row lock.
   The mechanism is the implementation's choice.
3. **Envelope check before commit.** Crew must run the Switchboard envelope check, or
   checks proven equivalent, before the batch transaction commits, and must take the
   [envelope rejection](#calls-offer-reservation-begin) path on any failure.
4. **Crew database restore.** After PostgreSQL is restored from a backup, begins,
   results and whole batches committed after the recovery point are gone. Before any
   continuation is admitted, every restored batch that is `open`, `blocked`, or
   `committed` without confirmed delivery, and has no final decision, must be assessed
   under [restore](#restore-after-process-loss). Executors meet the restored state
   through Rule 0, `result_unverifiable` and the
   [persistent 404](#executor-algorithm) rule. The implementation must define how the
   restore procedure triggers those assessments.
5. **Text storage.** Definitions and arguments are stored as `text`, never `jsonb`, so
   that every size claim in this document holds (see [text values](#text-values)).

## Storage and rollout

For `crew-1rcl`. Names are proposals. The implementation PR settles them.

- `frontend_tool_definitions`: owner, digest, name and the stored definition text.
  Primary key `(owner_id, definition_digest)`, so no index spans owners.
- `request_frontend_selections`: the request, its `executorId` and the ordered digests.
- `frontend_batches`: `batchId`, request, `runId`, previous batch, state, the
  `PendingFrontendBatch` envelope with native IDs, `openedAt`, `expiresAt`, settlement,
  the continuation intent (unique per batch), delivery, the running total of offered
  argument bytes and the native cancellation intent.
- `frontend_restore_decisions`: primary key `(batch_id, situation_key)`, the situation,
  the write-once decision and its policy revision, with an index on `batch_id` for the
  lookup by batch.
- `frontend_calls`: batch, ordinal, public `toolCallId`, native call ID, name,
  definition and argument digests, arguments as `text` (for offered calls), the fenced
  flag, the begin, and the one result.
  - The begin: `beginId`, the `reservationId` it committed under, its body digest and
    when it committed. Unique per call, since a call has at most one begin.
  - The result: `resultId` (`null` when Crew recorded it), its body digest, `content`,
    `error`, effect and when it was recorded.
- `frontend_call_reservations`: every reservation ever issued for a call, with
  `reservationId`, `executorId`, `issuedAt` and `expiresAt`. Primary key
  `(call_id, reservation_id)`.

What the checks read, all under the batch row lock:

- Reserve replay and `reservation_expired` need the reservation history. A
  `reservationId` in the history that is not current is `reservation_expired`. One
  absent from the history is a new reservation.
- Begin needs the named reservation's `expiresAt` and whether a begin has committed.
  Begin replay needs the committed `beginId` and its body digest.
  `reservation_expired` on begin needs only the current reservation, since any other
  `reservationId` is not current.
- Result replay needs the committed `resultId` and its body digest. A `reservationId`
  result needs the current reservation.
- Closed to new work needs the batch's state and `expiresAt` and the request's cancel
  intent.

Migrations take numbers after 039 (040 onward), and every process refuses a migration
numbered below the newest applied one. The feature adds new tables and also changes
existing ones (see [implementation obligations](#implementation-obligations-crew-1rcl-crew-avzm)).
Deploy the worker before the gateway, or both together. The worker must handle a
frontend stop and run the expiry timer before any gateway admits a selection. Advertise
the capability only after both run everywhere.

Each new audit event type is added to the `auditEvents` registry and to a migration
that replaces `audit_events_type_check` with every type the newest widening lists plus
the new ones, `NOT VALID`, without a rewrite, as migrations 24 to 36 did. Payloads hold
identifiers, digests, states and effect kinds only, never definitions, arguments,
content or errors. Candidates are `frontend_tool.defined`, `frontend_batch.opened`,
`frontend_call.begun`, `frontend_call.resulted`, `frontend_call.fenced`,
`frontend_batch.committed`, `frontend_batch.settled` and `frontend_restore.decided`.

Permission-changing implementation PRs, which let a client cause native tool calls,
need owner review before merge.

## Open questions and non-goals

- Native delivery of a committed batch matches the upstream contract after delivery
  (`switchboard-5py2`). This document defines no native envelope, no adapter call, no
  delivery evidence and no native rendering of an error result.
- `deliver-original` at production admission, and any adapter beyond Codex, match the
  upstream contract after delivery.
- `paired-repair`, `continue-new-turn` and `redispatch` are out of scope until
  Switchboard qualifies them. Adding one to `restoreMechanisms` is a new version.
- An owner route to accept an unknown effect and continue a blocked batch is not in
  version 1. Neither is an owner or operator route that settles a batch deferred as
  `already-settled` or `indeterminate`.
- The request status for an `endpoint-lost` settlement follows Crew's existing
  uncertainty rules. `crew-1rcl` settles which status that is, because the receipt
  contract depends on it.
- Projecting frontend calls or the restore CUSTOM fact on the public observation
  stream is a possible later version, not version 1.
- Non-goals: viewer roles, OIDC, per-call approval cards, server-side handlers,
  rich content, definition deletion, and any change to the observation route or stream.
