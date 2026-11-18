# Approval expiry

A Claude or Pi card used to wait for a decision for as long as nobody answered it:
the conversation workflow waited with no timeout. A scheduled routine with
`approvalPolicy: "wait"` could leave a card pending with nobody watching, and its
open firing then skipped every later window for `overlap`. Codex live cards already
expired, after their native callback deadline. Migration 28 lets an owner bound how
long a card may wait. When a card is still undecided at its deadline, Crew settles it
without a person: it cancels the request the way an owner's cancel does, and records
that the deadline did it.

## Contract

`approvalDeadlineSeconds` is an optional integer from 60 (one minute) to 604800
(seven days). An owner gives it:

- with a request, in the body of `POST /v1/conversations/{conversationId}/requests`
  (`{ "requestId", "text", "approvalDeadlineSeconds" }`). The legacy
  `POST /conversations/{id}/inputs` route and the members CLI share that schema and
  accept it too;
- with a routine, in the body of `POST /v1/routines`. Every firing's request carries
  the routine's deadline.

Without it, a card waits until someone answers it, as before. A value outside the
bounds, a fraction, a string or `null` fails `400 invalid_input`.

The deadline is part of the request's identity, like its text (see
[Identity and equivalence](integration-api-v1.md#identity-and-equivalence)). A retry
must send the same value, or none if the first submission had none; any other value
fails `409 conflict` and changes nothing. The admission stores it, a trigger keeps it
from changing, and the receipt reports it as `approvalDeadlineSeconds`. A routine's
deadline is part of its immutable definition: a create replayed with another deadline
fails `409 conflict`, the routine reports `approvalDeadlineSeconds` when it has one,
and `routine.created` records it. Under a firing's identity only the routine's
deadline is admitted, just as only its prompt is.

## The card

When a top-level card or question is proposed for a request with a deadline, Crew
records when it expires: the database clock at the proposal, to the millisecond, plus
the deadline. The card in `pendingApprovals` or `pendingQuestions` carries that time as
`expiresAt`, in the same field and format as a Codex live card:

```json
{ "approvalId": "UUID", "requestId": "UUID", "toolName": "record_work_item", "choices": ["approve", "deny"],
  "expiresAt": "2026-11-12T10:01:00.000Z", "...": "..." }
```

Before `expiresAt` the card is decided as usual. From `expiresAt` on, a decision
through `POST /v1/conversations/{id}/human` (or the CLI) fails `409 conflict`, the
answer a settled card gives, even before Crew has recorded the expiry, and
`members pending` no longer lists the card. Repeating an answer that was given in time
still returns it.

## At the deadline

The conversation workflow waits for an answer on a Temporal timer set to `expiresAt`.
When it fires, the `expireApproval` activity runs `ApprovalStore.expireTurn`, one
transaction under the conversation row lock. The activity touches only the database,
runs on the member task queue, and is retried until the database answers: past its
deadline a card refuses every decision, so failing the conversation instead would leave
the card stuck. A lasting database error, such as a held installation (`55000`), is
therefore retried about once a minute until it clears, and the card stays listed until
then; the workflow's pending `expireApproval` activity in Temporal shows the last
failure. Each attempt is:

- If the card has a decision, or its request was cancelled, the other outcome won and
  nothing changes. The workflow continues with that outcome.
- If the database clock has not reached `expiresAt` (the Temporal server's clock runs
  ahead), nothing changes, and the workflow waits out the rest and asks again.
- Otherwise it sets the card's `expired_at`, writes the request's cancellation marker
  (`tool_cancellations`) exactly as an owner's cancel does, removes the card from the
  snapshot, and appends `approval.expired`.

The workflow then settles the card as it does after a cancel. The native call gets the
result `{"kind":"cancelled"}`, the turn continues to its reply, and nothing is
recorded. The conversation closes to new turns and requests queued behind this one are
rejected with `predecessor_cancelled`, as after a cancel. It is a cancellation, not an
automatic deny, because `choose_next_step` has no deny choice; a `fail_closed` routine
cancels for the same reason.

**Exactly one outcome.** A decision and an expiry both lock the conversation row
first. The decision's `UPDATE` requires `expires_at > clock_timestamp()`; the expiry's
requires `expires_at <= clock_timestamp()` and no decision. Each statement reads the
clock itself, so a decision either commits before the deadline or not at all, and an
expiry only after it. A decision also checks `expired_at`, so a database clock that
steps backwards cannot reopen an expired card, and `deferred_calls_expiry_check` makes
an expired card refuse a decision even from a direct write. When the timer fires does
not decide anything.

## Telling an expiry from a deny and a cancel

| Where | Expiry | Owner's deny | Owner's cancel |
| --- | --- | --- | --- |
| Snapshot `state` | card removed; `expiredCalls` gains `{ requestId, approvalId, expiresAt, expiredAt }`; the turn ends in phase `cancelled` | card removed; the tool result is `{"kind":"denied"}` | card removed; the turn ends in phase `cancelled`; no `expiredCalls` entry |
| Request receipt | `expiredApproval: { approvalId, expiresAt, expiredAt }`; status `running`, then `completed` or `uncertain` | no `expiredApproval` | `cancellation` when the v1 cancel route recorded the intent; no `expiredApproval` |
| Routine firing | `failed` with reason `approval_expired` | settles by the request's end | settles by the request's end |
| Audit trail | `approval.expired`, actor `system` | `approval.decided`, actor owner, `choice: "deny"` | `request.cancellation_requested`, actor owner |

`expiredCalls` keeps the last 16 expiries, like `grantedCalls`. The receipt status
values are unchanged: a client that predates this feature sees an expired request as a
cancelled one that went on to complete.

## Routines

Under `wait`, a firing whose card expires fails with `approval_expired` however its
request then ends, as a `fail_closed` firing fails with `approval_required`. **An
expiry counts as a failure** toward the ten consecutive failures that disable a
routine. A routine whose cards nobody answers is not doing its job; counting the
expiry stops it from opening a conversation every window, unattended, for good. The
dispatcher records the reason from the receipt's `expiredApproval` when it observes
the request's end.

Under `fail_closed` the dispatcher cancels at its first observation of `waiting`,
normally within 5 seconds, well before a deadline of at least a minute. A firing that
recorded `approval_required` keeps it even if the expiry then wins the race. If no
dispatcher observed the request until after the deadline, for example because every
gateway was down, the firing fails `approval_expired` instead.

## Codex

A Codex live card has its own deadline: the native callback's, at most 170 seconds by
contract and 45 seconds as Crew's Codex adapter sets it. With a request deadline, the
card's deadline is the earlier of the two. `proposeLive` stores it in
`codex_live_calls` and shows it as the card's `expiresAt`, and the existing live-call
path enforces it: past it a decision is refused and the call is interrupted, the
snapshot lists it under `interruptedCalls`, the turn becomes `uncertain` and a firing
fails `turn_uncertain`. No `approval.expired` row is written for Codex. With the 45
second adapter deadline and the 60 second minimum, the live deadline is always the
earlier one today.

## Conversation handoff

A [conversation handoff](handoffs.md)'s reserved first request never has a deadline.
The server submits it without one, and that request ID sent with
`approvalDeadlineSeconds` fails `409 conflict`, so a card of the handoff turn waits for
an answer. Later requests to the target take a deadline like any request.

A card waiting on its deadline makes its conversation `busy` to a handoff, as any
pending card does. After it expires, its turn goes on to its reply. The source can be
handed off once that turn has ended and the requests queued behind it were rejected,
as after an owner's cancel.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `approval.expired` | system | `expireTurn` settles an undecided card at its deadline | `approvalId` | `approvalId`, `invocationId`, `toolName`, `expiresAt` |

The row copies the request's initiator from its admission, so a routine's expiry names
the routine. `routine.firing_settled` gains the reason `approval_expired`, and
`routine.created` the optional `approvalDeadlineSeconds`.
`GET /v1/capabilities` describes the feature under `approvalExpiry`.

## Not covered

- Cards of a Pi delegation's child tasks get no deadline and wait as before. A request
  that delegates has no top-level card, so its deadline bounds nothing.
- One deadline per request: no per-tool deadline, no default per owner or member, and
  no way to extend, snooze or change a deadline. A routine's deadline changes only
  with a new routine.
- An automatic approve or deny at the deadline.
- A notification before or at expiry. A client reads `expiresAt` and
  `expiredCalls`, or the receipt. An [outbound webhook](webhooks.md#handoffs-approval-expiry-and-usage-budgets)
  sends `approval.pending` when the card becomes pending and the request's
  `request.finished` afterwards, whose body does not say that the card expired.
- Requests admitted before migration 28: they have no deadline and never expire.
- While no worker runs, the snapshot keeps listing an overdue card until the
  workflow records the expiry. Its `expiresAt` is in the past and a decision on it is
  refused.

## Upgrade, in-flight workflows and recovery

Migration 28 adds `request_admissions.approval_deadline_seconds`,
`deferred_calls.expires_at` and `expired_at`, and `routines.approval_deadline_seconds`,
with `NOT VALID` CHECKs, so no table is rewritten or scanned. It names and widens the
firing reason CHECK that 025 left unnamed, widens `audit_events_type_check` (repeating
every type migration 27 lists), keeps a routine's deadline in its immutable definition,
and builds one empty partial unique index on `audit_events`. Until `migrate()` commits it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17) | Why |
| --- | --- | --- |
| `deferred_calls` | `ACCESS EXCLUSIVE` | two columns and a CHECK |
| `request_admissions` | `ACCESS EXCLUSIVE`, `SHARE ROW EXCLUSIVE` | a column, a CHECK and the immutability trigger |
| `routines` | `ACCESS EXCLUSIVE` | a column and a CHECK |
| `routine_firings` | `ACCESS EXCLUSIVE` | the reason CHECK |
| `audit_events` | `ACCESS EXCLUSIVE`, `SHARE` | the type CHECK and the index build |

Crew takes these tables in several orders, so, as in migration 25, the migration takes
all five together with `LOCK ... NOWAIT` and retries every 20 to 100 ms. It never waits
in a lock queue, never joins a deadlock and never holds up other sessions while it
waits. Applied alone it holds nothing while it retries. Applied with earlier migrations
in one `migrate()` transaction, it retries while holding their locks, and admissions
and audited writes wait. A running native turn's admission transaction touches none of
these tables, so a live upgrade never waits for a turn. After 60 s without the locks it
fails with `55P03`, applies nothing, and the process exits; start it again.

The workflow change is behind the Temporal patch `approval-expiry-v1`, and the
workflow tests the card's `expiresAt` before calling `patched`, so only a history
whose card has a deadline records the marker. Histories recorded before this release,
and new ones without a deadline, replay unchanged. A workflow waiting on a card at the
upgrade keeps waiting without a timer: that card was proposed without a deadline. A
conversation workflow started before the upgrade gets the timer for a later request
that carries a deadline.

As for every migration, stop every process of the previous release first (see
[persistent deployment](persistent-deployment.md#upgrades)). A workflow worker of the
previous release waiting on a card that has a deadline would never expire it, while
the database refuses a decision past it, so the card would be stuck. Rolling back
once a request with a deadline was accepted is not supported: the previous release's
workflow repeats its update validator when it replays an accepted update, and that
validator refuses `approvalDeadlineSeconds`, so its worker cannot replay the
conversation.

The migration adds no table, so recovery capture and the write barrier need no
change. A restore keeps each card's `expiresAt`, an absolute time. A card whose
deadline passed while the installation was held or restored refuses a decision once
the restored installation resumes, and expires when the restored workers run its
overdue timer. See [coordinated recovery](coordinated-recovery.md).

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may create
databases:

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:expiry
npm run test:handoffs
npm run test:recovery
```

`approval-expiry.test.ts` runs against real PostgreSQL through the real gateway and
MemberClient, with a Temporal client double that runs each workflow update through the
store calls its handler makes. It checks:

- the bounds and strictness of `approvalDeadlineSeconds`, a retry with the same value,
  `409` for another value or none, the receipt field, `404` for another owner, the
  immutability trigger and the SQL bound;
- `expiresAt` on the card in the snapshot, `early` before the deadline, a deny before it
  winning and staying idempotent after it, and no deadline without the field;
- an undecided card refused past its deadline before and after the expiry, two
  concurrent expiries recording one, the snapshot's `expiredCalls`, the receipt's
  `expiredApproval`, the cancelled tool result, no work item, a closed request, and the
  audit rows, against a deny and a cancel that leave none of these marks;
- a question expiring the same way;
- 24 decisions racing an expiry at the deadline each leaving exactly one outcome, and the
  CHECK refusing a second by direct write;
- Codex: a 60 second request deadline shortening a 160 second live deadline, and a
  600 second one or none leaving it;
- a routine's deadline: bounds, idempotent create, immutability, the audit payload, a
  firing's request carrying it, another deadline refused under the firing's identity,
  and an expired card failing the firing `approval_expired` and counting once;
- migration 28 on a version-27 database: no table rewritten, the locks above, the
  constraints `NOT VALID`, no lock queue while an admission holds `request_admissions`,
  completion while a native turn holds its admission, and an earlier receipt unchanged.

`handoffs.test.ts` checks that a handoff's reserved first request refuses a deadline
while a later request in the target takes one and expires, and that a source whose card
expires stays `busy` until its turn has ended and can then be handed off.

`recovery.test.ts` restores a real `pg_dump` taken while a card with a deadline was
pending, checks its `expiresAt` survives, a decision past it is refused, the restored
installation records one expiry and the held source writes nothing.

`approval-expiry-workflow.test.ts` needs a Temporal CLI 1.10.0 development server
(`BIRBCREW_TEMPORAL_ADDRESS`) and runs the real conversation workflow, Crew's worker
activities and the Pi fixture provider:

```sh
temporal server start-dev --headless --port 7233 &
BIRBCREW_TEMPORAL_ADDRESS=127.0.0.1:7233 npm run test:expiry:workflow
```

It checks a 60 second card expiring on its own, after one early answer from a database
clock 5 seconds behind, with the cancelled tool result, the receipt, the audit rows, the
closed workflow, one patch marker, two timers, and a replay of the history; an answer
before a 600 second deadline winning and cancelling the timer; no marker or timer
without a deadline; and that histories recorded by the previous release's workflow source
(`tests/proof/fixtures/pre-expiry-workflow.ts.txt`), including a card left waiting under
it and answered under this release, replay with this release's workflow.

Not claimed: the Temporal run covers Pi only; a Claude card's expiry follows the same
workflow path and is exercised against the store only. Codex is exercised at
`proposeLive`, not with a running Codex process. A routine's expiry runs against the
dispatcher and the store, not the routines service proof. A decision racing the timer is
exercised against the store, not in a Temporal run. Clock skew is simulated by moving a
card's `expires_at`, not by skewing a clock.
