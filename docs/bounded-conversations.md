# Bounded durable conversations

This change implements `birbcrew-r-qjvc`. It is the existing member-service lane,
not a new Temporal wrapper for the trusted-context API.

## Contract

New conversations retain their logical member/conversation IDs for at most 128
application turns. Each Temporal execution admits at most 4 distinct request IDs,
then drains accepted work, Update handlers, approvals and child workflows before
Continue-As-New. The same drain begins at 2,000 history events or Temporal's
Continue-As-New recommendation, even with fewer distinct turns. This event
threshold is a soft drain trigger, not a hard bound while a human decision or
in-flight handler still needs to finish; pending work is never abandoned merely
to force a rollover. New requests at a full generation receive a typed rejection;
the client retries that rejection against the logical workflow ID for up to 30s.
A busy response is not acceptance. Arbitrary network errors are not retried as
new work. Native checkpoint identity is retained across generations.

Admission is separately durably recorded before `accept()` acknowledges. Exact
request IDs bind a SHA-256 prompt digest; changed duplicates conflict. Earlier
committed requests return their stored result without provider/tool execution.
If an earlier request cancels or fails, already-accepted queued successors are
recorded as `rejected` with `predecessor_cancelled` or `predecessor_failed`, before
the execution closes. They cannot later start. If storage is unavailable, an
accepted-but-unsettled receipt remains visible; it is not evidence that retrying
the effect is safe.

`GET /conversations/:conversationId/requests/:requestId` reads tenant-scoped
status directly from PostgreSQL: accepted, started, committed, uncertain or
rejected. Committed status includes the stored reply; rejected status includes
the reason. It does not route to a historical Temporal run. Decisions and
cancellation also address the logical workflow ID; first-turn `workflow_run_id`
is audit evidence only. Pending work never transfers across a rollover boundary:
rollover waits for it, including human decisions.

## Migration and retention

Migration 16 preserves existing proof conversations' four-turn limit; it does
not resurrect previously completed/failed workflows. Only newly created
conversations receive the 128-turn budget. Patched workflow code preserves old
captured history behavior. Migration 17 backfills request admissions for existing
turns without inventing prompt text or native state.

Keep request admission identities, prompt digests, terminal turn results and
side-effect receipts for the lifetime of the logical conversation, including
closed conversations. There is no automatic TTL or reuse of expired request IDs.
The count is bounded per conversation, not globally across all user-created
conversations. PostgreSQL receipts are authoritative even after Temporal's
history retention expires. An operator must not purge them independently and
then reuse the conversation ID. A future coordinated retention/erasure API must
retain a denial tombstone or permanently retire that identity.

Public AG-UI snapshots preserve final messages across generations; the event
tail remains 256 events and an expired cursor requires a new snapshot. Native
context and model budgets are separate: see [native bounds](native-conversation-bounds.md).
No native summarization, cross-engine conversion or unlimited retention is added.

## Reproduce

Requires Linux with Landlock ABI 4+, Node 24.22.3, a C compiler, Docker and Temporal
CLI 1.10.0 on PATH (or `TEMPORAL_CLI` pointing at it). No paid inference or personal
credentials are required. Tests use disposable local fixture credentials.

```sh
npm ci
npm run build
node --test tests/service/native-limits.test.ts tests/service/rollover-client.test.ts
npm run test:proxy
npm run test:rollover
```

The rollover proof creates disposable PostgreSQL/Temporal services, runs twelve
turns through each real pinned SDK, kills/restarts the worker on both sides of a
rollover, verifies duplicate replay and AG-UI history, and replays captured
Temporal histories in a network-isolated child with no activity implementations.
It also tests fourth-turn decisions/cancellation and accepted queue rejection.
Use `BIRBCREW_TEST_DATABASE_URL` with a disposable PostgreSQL 17 database to run
`node --test tests/service/store.test.ts` separately.

Live model token windows, paid spend, forced native compaction, arbitrary
in-flight side-effect recovery and worker-container replacement are not implied
by this fixture. Codex live approval callbacks are not resumable after native
process loss; that remains an explicit uncertain outcome, not an automatic retry.

### History-pressure drain boundary

New workflow generations also stop admitting updates when the history reaches
2,000 events or Temporal recommends Continue-As-New, even if fewer than four
unique turns arrived. This prevents repeated duplicate submissions from keeping
an otherwise idle generation alive indefinitely. Known completed requests remain
readable from the database without addressing Temporal. Other submissions receive
`RolloverInProgress`; the client retries for at most 30 seconds, then returns busy
without claiming acceptance.

The event threshold is a **drain trigger, not a hard history-size guarantee**.
Pending human decisions, active SDK work, child workflows and already-accepted
updates must finish or be cancelled before rollover. Decision and cancellation
handlers remain serviceable past the threshold so they can release that work.
An operator must still rate-limit untrusted traffic and monitor Temporal history
limits: sustained invalid decision/signal traffic while a decision is pending can
grow history. The implementation does not discard or falsely complete accepted
work merely to force a history boundary.

## Recovering the initial progress-payload defect

PR #31's original `ea386e1` caller sent the whole conversation to the strictly
validated `conversationProgress` activity. Four committed turns could then stall
at the boundary; those committed turns were not rolled back. This revision uses
an exact `{ownerId, conversationId}` payload for newly scheduled progress calls.

Temporal does not rewrite an activity's recorded arguments on deployment. The
worker therefore retains a narrow compatibility adapter for the *exact* old
five-field conversation DTO. It validates that DTO strictly and verifies its
member/engine/profile binding against the database before projecting the key.
Unknown extra fields and mismatched bindings still fail. The store API remains
strict. A workflow patch marker preserves the original command arguments when
replaying an affected history; newly continued executions use the narrow key.

For an affected execution whose progress activity is still retrying, deploy the
fixed worker. The next retry accepts that recorded legacy DTO, reads progress,
and continues the workflow without re-running committed turn activities. The
compatibility proof records such an old history, observes the original strict
validation failure, replaces the worker, and checks recovery/replay.

If the activity has already exhausted its 60-second schedule-to-close budget,
the workflow may be failed. Deployment alone does not revive a closed execution.
Committed request results remain readable from PostgreSQL. Do not start a new
conversation under the old ID, delete receipts, or resubmit committed inference.
An operator must inspect/export the original history and perform a controlled
Temporal reset to the workflow-task boundary preceding the failed progress
activity, retaining earlier completed turn events. This is a separate recovery
action, not an automatic retry or permission to repeat effects. Verify request
receipts and provider/effect counters afterward. The compatibility proof also exercises this controlled reset on a genuinely
failed fixture execution and verifies no committed turn is invoked again. That
is not a claim that every closed or manually altered history is repaired.

### Progress-payload upgrade regression

`node tests/proof/progress-compatibility.mts` exercises the progress activity with
real Temporal and PostgreSQL. It captures the pre-fix workflow at commit
`ea386e1196703aae21f2423d9b1e9d503a048774`, reproduces the strict-store rejection
of its full `Conversation` payload, replaces the workflow worker, and verifies
that the already-scheduled activity succeeds on retry through the compatibility
adapter. Four committed turns are not executed again. A fresh conversation then
verifies the caller schedules only the strict two-field key. The fixture also waits for an old run to fail at its original progress deadline,
then resets at the recorded progress-scheduling workflow task and verifies that
committed turns are not repeated. All four captured histories replay with network
access disabled.

This focused regression uses deterministic turn activities backed by the real
store, not model inference. It requires Docker and Temporal CLI 1.10.0, but does
not require native SDK isolation or credentials. Alternatively provide both
`BIRBCREW_TEST_DATABASE_URL` (a disposable database) and
`BIRBCREW_TEMPORAL_ADDRESS` to use existing local services without Docker. The separate rollover fixture
covers the engine drivers. Already-failed workflow runs are not automatically
revived by the adapter: they require an operator-reviewed Temporal reset or a new
conversation, and must not be blindly resubmitted as new provider work.

Run `node tests/proof/progress-compatibility.mts` with Docker and the pinned
Temporal CLI for the focused real-store/workflow regression. Alternatively, set
both `BIRBCREW_TEST_DATABASE_URL` and `BIRBCREW_TEMPORAL_ADDRESS` to disposable
local services; the harness then leaves service ownership to the caller. It
checks the old strict failure, pending activity retry, new narrow dispatch, an
explicit closed-run reset, and isolated replay of all four captured histories.
The deterministic turn activity writes real database receipts but invokes no SDK
or model; the separate unchanged `npm run test:rollover` journey qualifies SDKs.

### Lost admission acknowledgement regression

`node tests/proof/admission-compatibility.mts` tests the real database/Temporal
boundary where SQL commits an admission but every activity acknowledgement fails.
The first case exhausts actual Temporal retry/deadline budgets and checks that the
workflow persists a terminal rejection without invoking any turn activity. The
second also fails final reconciliation through its retry budget, then checks that
a fresh client observing the confirmed terminal workflow repairs the retained
receipt durably. Repeated status, acceptance and submission must never restart the
workflow or invoke a provider. Both captured failure histories replay with network
access disabled. The fixture uses the same disposable-service setup and optional
external-service variables as the progress compatibility regression above.

An exhausted admission acknowledgement is reported as the durable terminal reason
`admission_unconfirmed`, not as successful execution or an indefinitely accepted
request. If the workflow cannot write that outcome before closing, status and
repeat submission reconcile only after observing a terminal *logical* workflow
and atomically confirming no turn row exists. Running/continued executions are
never finalized this way; committed or begun work is never overwritten. A
Temporal lookup failure is surfaced as unavailable after a ten-second deadline,
not permission to replay. Ownership is checked before the Temporal lookup.
Migration 20 permits the new reason; migrations 18/19 belong to downstream API
and backup work and are not prerequisites for this isolated change.
