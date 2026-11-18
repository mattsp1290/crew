# Trusted application context and registered tools

Implemented by Forg, an AI agent, for request `birbcrew-r-sab0`.

This is a **backend-only integration seam**, not a new observer endpoint or a
plugin system. A trusted application authenticates its user, chooses the exact
scope/context version, registers executable handlers at deployment time, and
provides a fresh authorization callback. Never derive any of those permissions
from a prompt, AG-UI `context`, forwarded properties, or client-selected labels.
The existing observer gateway continues to reject those inputs.

## What is supported

- A bounded snapshot (64 KiB UTF-8), one opaque scope and version, and at most
  eight registered tools per application. Tool schemas are explicit JSON object
  schemas with `additionalProperties: false`; argument/result limits and a
  deadline are mandatory. Unregistered tools and missing authorization deny.
- Claude and Pi SDK adapters and the pinned official Codex app-server expose only
  the registered catalog. Codex uses app-server dynamic tools instead of exec/MCP:
  the pinned MCP path adds resource helper tools that cannot be disabled.
  Native built-ins remain disabled. All three engines run through the isolated
  launcher. Pi's SDK runs in a confined worker with no network; the backend
  process still runs each registered tool handler and the model request (see
  [native confinement](verification.md#native-confinement)).
- Native checkpoints bind engine, owner/conversation scope, version, generation,
  context and tool manifest. Rotation creates a fresh engine-native session;
  old transcripts are **not** summarized into the new context. Cold restoration
  requires the matching checkpoint and, for Claude/Codex, the private volume.
  Missing/mismatched restoration fails; it does not silently create a replacement.
- One PostgreSQL-backed queue keeps the logical conversation and request IDs
  stable across generations. This is an alternative execution lane for a
  conversation with **no legacy member turns**, not a second lane alongside the
  old Temporal `submitTurn` workflow. Legacy turn admission rejects conversations
  attached to this seam. Do not start that workflow for a trusted conversation.
- This initial lane is bounded to 1,024 accepted requests per conversation,
  16 tool calls per request, a 170-second native turn deadline, 4 MiB checkpoints
  and 64 KiB final replies.
  It does not implement the separate unlimited-conversation/rollover request.

## Backend integration

Import `TrustedContextStore` and `RegisteredTool` from
`src/service/trusted-context.ts`, and `runTrustedRequest` from
`src/service/trusted-runner.ts`. First run `MemberStore.migrate()`. Create a
member and open a conversation through the existing store. The backend must
supply its own authenticated owner ID; these internal APIs are not authenticators.

Construct one `TrustedApplication`:

```ts
const application = {
  id: "my-app-tools-v1", // change when handlers or policy contract change
  tools: [readContext, recordEffect], // RegisteredTool objects, fixed trusted code
  async authorize(input) {
    // Check the CURRENT application policy, not a captured startup permission.
    // input: ownerId, conversationId, scope, version, phase, requestId,
    // toolName, and bounded validated arguments for dispatch/release.
    return policy.permits(input); // only literal true permits
  },
};
const trusted = new TrustedContextStore(pool, application);
await trusted.open(key, {scope: "opaque-scope-A", version: "revision-1", text: snapshot});
await trusted.submit(key, requestId, prompt);
await runTrustedRequest(trusted, key, nativeProfile, abortSignal);
const result = await trusted.result(key, requestId);
```

`nativeProfile` is `{engine: "pi" | "claude" | "codex", profile: ...}` using the
existing native profile options, including the proxy profiles from PR #29.
Claude/Codex owner and member identities must match the database conversation.
The runner does not forward speculative text to observers: it buffers output,
rechecks authorization and generation at commit, then returns only a request ID.
`result()` checks current output authorization again before returning a reply.

The runner meters each request in the [usage ledger](usage-metering.md#the-trusted-context-lane):
one row of token counts and the model, written after the native turn returns and before
the reply commits, priced from the table named by `BIRBCREW_USAGE_PRICES_PATH` in the
backend's process unless a table is passed as `runTrustedRequest`'s fifth argument. The
row holds no context, prompt, reply or tool data. The owner reads it through `/v1/usage`
as `lane: "trusted"`, and its tokens count toward the member's daily budget, which does
not refuse trusted requests. A malformed table makes `runTrustedRequest` throw before it
claims a request; to fail at startup instead, read the table once and pass it:

```ts
import { operatorPrices } from "./src/service/usage-prices.ts";
const prices = operatorPrices(); // throws, naming the setting, on a malformed table
await runTrustedRequest(trusted, key, nativeProfile, abortSignal, prices);
```

Each registered tool supplies:

- `name`, `description`, `inputSchema`, `kind: "read" | "effect"`;
- `maxArgumentBytes` (1..16,384), `maxResultBytes` (1..65,536),
  `deadlineMs` (1..30,000);
- `execute({args, operationId, signal, authority})`, returning bounded JSON.

Use the service-generated `operationId` for application idempotency, not an ID
chosen by a model. Effects must honor `signal` and use an application-side receipt
or idempotency transaction. The fixture tests register `read_context` and
`record_effect` (native fixtures use compatible fixture tool names). This is not
a general exactly-once guarantee for arbitrary external services.

Tool schemas/handlers are snapshotted at registration. Changing the deployment ID
or manifest against an existing session fails closed; migrate/reconcile such a
session deliberately rather than hot-mutating its capabilities.

## Invalidation and one serialization order

1. `invalidate(key, expectedGeneration, nextSnapshot, cancelCallback)` commits the
   next generation and a **draining** barrier before calling `cancelCallback`.
   Cancellation callback failure does not undo that fence. Native lease polling
   also observes the fence, so notification is not the security boundary.
2. Dispatch, result release, acknowledgement, checkpoint commit and output reads
   check durable current generation. Queued old-generation requests become held.
   Concurrent accepted submissions during draining are also held, retaining their
   original durable positions and request IDs.
3. `finishRotation(key)` returns `busy` while an old SDK/effect lease survives.
   After leases drain it explicitly classifies the old running request cancelled
   and unresolved effect admissions uncertain. It then activates the new native
   generation. It never starts an independent replacement conversation.
4. Inspect held work and call `releaseHeld(key, requestId, "run" | "cancel")`.
   Running rechecks application authorization. A held earlier request blocks all
   later work even if a later request has been released. No accepted item is
   silently dropped, reordered or run concurrently with an earlier turn.

Native/effect leases use dedicated PostgreSQL connections, not slots in the
control/query pool needed to invalidate them. Bound worker concurrency and budget
PostgreSQL connections accordingly (up to two lease connections per active tool
turn, in addition to the ordinary query pool).

A noncooperative application callback cannot be forcibly killed by JavaScript.
The caller's deadline still fails promptly, while its dedicated lease remains
held until that callback settles. Rotation stays busy. If the worker/database
connection dies, the barrier can proceed only by **classifying uncertainty**;
that is not proof a remote effect was rolled back. Reconcile receipts with the
application before deciding what subsequent work is safe.

## Crashes, receipts and acknowledgements

Effect admission, observed outcome, result release and native acknowledgement are
separate durable fields. A duplicate native call with different arguments
conflicts. A completed duplicate can return its stored receipt after fresh
authorization, without invoking the handler again. An orphaned admission returns
explicit uncertainty, never an automatic retry of the effect.

After a worker disappears, call `recover(key)`. A live lease makes it busy. With
no live lease it classifies the interrupted request as uncertain, returns receipt
operation IDs/outcomes/result-release/acknowledgement status, and holds later queued work behind
a generation barrier. Finish that barrier and explicitly release or cancel held
requests. Recovery never calls an effect handler. If its acknowledgement is lost,
`recover(key, requestId)` reconstructs the persisted uncertain outcome and receipt
status without advancing the generation again. The same explicit request lookup
works after context rotation has marked that interrupted request `cancelled`:
request cancellation does not imply its effect was rolled back. Receipt outcomes
remain `completed` when known, or `uncertain` when admitted without a recorded
outcome. Readback never re-executes a tool or revives a cancelled request.

Recovery requires current `output` permission and a fresh `receipt` authorization
for **each original operation**. The policy input contains the historical `scope`
and `version`, `requestId`, `toolName` and `operationId`. Implement this phase
explicitly; permission to the replacement scope alone is not permission to an old
operation. A denial fails the entire readback. Only operation ID, tool name,
outcome, `released` and `acknowledged` are returned: no historical context,
arguments, result body or reply. These authority identifiers are erased by
`erase()`. Migration 15 can backfill still-current operations, but pre-upgrade
rotated records have no provable historical scope and fail closed with `denied`.
Applications must reconcile those legacy records through their existing domain
receipts rather than guess authority from the current context.

`acknowledged` means the native SDK/adapter confirmed the correctly paired tool
result. It is **not** proof of remote provider durability, user delivery or an
external effect's exactly-once execution. Claude parallel pending application
calls are deliberately unsupported and fail explicitly.

## Retention and deletion contract

Credentials belong in the proxy resolver/profile, never snapshot text, prompts,
arguments or tool results. The application is responsible for excluding them;
this service cannot reliably identify every possible secret in arbitrary text.
No credential callback/value is serialized by the trusted-context integration.

The trusted lane stores snapshots, pending prompts, current checkpoints and
receipted tool results in PostgreSQL. Completed/cancelled prompts are cleared;
completed replies and effect receipts remain until explicit erasure. Native
Claude/Codex transcripts remain in private volumes; Pi history is in its bounded
checkpoint. Old generation locations are retained as opaque identifiers for
operator cleanup. Context versions and scope IDs should be opaque, not content.

To erase: invalidate first, stop the worker/native processes, and use
`nativeStateForDeletion(key)` while draining to obtain the exact member and native
thread IDs. `erase(key)` requires the drain lease and clears database snapshot,
checkpoint, prompt, reply, tool-result and legacy note contents. It leaves a
non-reusable deleted session and minimal request/receipt digests as replay
fences. It leaves the requests' usage ledger rows, which hold counts and a model
name. A late callback cannot resurrect erased results. Separately remove the
listed native directories from the configured private volume after confirming
process termination. Erasure of backups, WAL, logs and provider-held data follows
the deployment's retention policy; a SQL update is not physical media erasure.

If wrapping `runTrustedRequest` in Temporal, pass **only the authenticated key**
into the activity and return only the request ID. Load context/profile and invoke
tools inside the activity. Do not put snapshots, checkpoints, credentials or
results into workflow arguments, activity outputs, exceptions or logs. Existing
Temporal history cannot be selectively erased by this API; configure namespace
retention and an approved history-deletion process separately. This PR does not
rewrite the legacy workflow or prove a full Temporal-server replacement.

## Validate without personal credentials or paid inference

Requires Linux with Landlock ABI 4+, Node **24.22.3**, a C compiler and a disposable
PostgreSQL 17 database. CI uses Ubuntu 24.04 and exercises the actual locked SDKs
against scripted local providers, not paid models.

```sh
npm ci
npm run build
# Point this ONLY at a disposable database. Tests migrate and write fixture data.
export BIRBCREW_TEST_DATABASE_URL=postgresql://birbcrew:fixture-only@127.0.0.1:55432/trusted_context_test
npm run test:trusted
node --test tests/service/store.test.ts
npm run test:proxy
```

Example disposable database (in a separate terminal):

```sh
docker run --rm --name birbcrew-trusted-pg \
  -e POSTGRES_USER=birbcrew -e POSTGRES_PASSWORD=fixture-only \
  -e POSTGRES_DB=trusted_context_test \
  -p 127.0.0.1:55432:5432 postgres:17
```

`trusted-context.test.ts` covers real PostgreSQL races, actual SIGKILL around a
committed fixture effect, lease disconnects, late settlement after erasure,
rotation/order preservation and registry immutability. Native tests cover all
three SDK tool catalogs, result correlation, cold restore and fresh-scope
rotation. Runner tests compose the native SDK with the durable store. A kernel
without Landlock fails closed for all three engines; do not bypass that isolation or
report those tests as passing locally.

This is offline fixture qualification. Live application policy/provider
acceptance, deployment authentication, backup erasure and a complete Temporal
worker/container replacement remain separate acceptance work.
