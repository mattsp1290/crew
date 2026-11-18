# Scheduled routines

Every turn used to start with an owner's call: `POST /v1/conversations/{id}/requests`,
the members CLI or a consumer's dispatcher. Migration 25 adds routines. A routine
is an owner's cron schedule, one of their members and a fixed prompt. The gateway
submits the prompt at each window with nobody present, in a new conversation, and
the request records `routine` and the routine's ID as its initiator, so audit rows
and later policy can tell a scheduled run from a person's.

## Contract

A routine has:

- `routineId`: a UUID the database generates. It is never reused, even after the
  routine is deleted.
- `memberId`: one of the owner's members. A foreign key to
  `members (owner_id, member_id)` binds the routine to its owner.
- `schedule`: a five-field cron expression, evaluated in UTC (`timezone: "UTC"`).
- `prompt`: the text every firing submits, 1 byte to 16 KiB of valid UTF-8 without
  NUL, the same rule as a request's `text`.
- `approvalPolicy`: `wait` or `fail_closed` (see
  [Approvals with nobody present](#approvals-with-nobody-present)).
- `state`, `disabledReason`, `consecutiveFailures`, `nextWindow` and `createdAt`.

The definition (member, schedule, prompt and policy) never changes. A database
trigger refuses an update to it, as `001-members.sql` does for members. To change a
schedule, create a new routine and delete the old one.

An owner can have at most 20 enabled routines. A row trigger enforces the limit in
the database: it takes a transaction-level advisory lock keyed by the owner, then
counts the owner's enabled routines, on every insert or update that enables one. The
lock serialises concurrent creates and enables for one owner until they commit, and
under `READ COMMITTED` the count, a later statement, sees each of them. A
`REPEATABLE READ` or `SERIALIZABLE` writer would count with its older snapshot;
Crew uses neither.

### Schedules

Five space-separated fields: minute (0-59), hour (0-23), day of month (1-31), month
(1-12) and day of week (0-7, where 0 and 7 are Sunday). A field is a comma list of
`*`, `N`, `N-M`, `*/S`, `N-M/S` or `N/S` (from N to the field's maximum). Names,
macros such as `@hourly`, and `?`, `L`, `W` and `#` are refused, as are tabs and
repeated spaces. When the day-of-month and day-of-week fields are both restricted
(neither is exactly `*`), a day matches if either matches, as in Vixie cron;
otherwise it must match both. Unlike Vixie cron, a field such as `*/2` counts as
restricted. `src/service/routine-schedule.ts` is the parser; it adds no dependency.

Windows must be at least 15 minutes apart. The check is conservative: it uses the
minute field alone, taking the smallest step between listed minutes and the gap
across the hour, `60 - last + first`. That bound is exact when every hour is
scheduled. Otherwise it refuses some legal schedules: `0,50 9 * * *` is refused
(bound 10 minutes) although its windows are 50 minutes and 23 hours 10 minutes
apart. Use two routines for such a schedule. A schedule that matches no time within
nine years, such as `0 0 30 2 *`, is refused as never firing.

### Routine states

| Transition | From | To | Effect |
| --- | --- | --- | --- |
| create | | `enabled` | `nextWindow` is the first window after now; counts toward the limit |
| disable | `enabled` | `disabled`, reason `owner` | `nextWindow` cleared |
| exhaust | `enabled` | `disabled`, reason `consecutive_failures` | the tenth consecutive failure, in the same transaction |
| enable | `disabled` | `enabled` | failure count reset, `nextWindow` from now, limit rechecked |
| delete | `enabled` or `disabled` | `deleted` | a tombstone that keeps its history and ID |

`routineTransitions` in `src/service/routines.ts` lists them, and
`transitionRoutine` applies every one. Repeating the current state (disabling a
disabled routine, deleting a deleted one) changes nothing and returns the routine,
keeping its reason. Enabling or disabling a deleted routine fails `409
routine_deleted`. A trigger refuses any change to a deleted routine and any `DELETE`
of a routine row.

### Firings

Each window a routine reaches is recorded once, in `routine_firings`, keyed by
`(routine_id, scheduled_for)`:

| Status | Meaning |
| --- | --- |
| `claimed` | The window fired: its conversation and request UUIDs are stored and the dispatcher holds a lease to open and submit it |
| `admitted` | Crew admitted the request; it is queued or running |
| `waiting` | The request waits for a human decision |
| `succeeded` | The request completed |
| `failed` | See `reason` |
| `skipped` | The window did not fire; see `reason` |

`firingTransitions` lists the moves after a window is recorded as `claimed` or
`skipped`: `claimed` to `admitted` or `failed`; `admitted` to `waiting`,
`succeeded` or `failed`; `waiting` back to `admitted`, or to `succeeded` or
`failed`. `moveFiring` applies each one. A settled firing never changes, and a
trigger keeps a firing's identity fixed.

| Reason | Status | Counts as a failure |
| --- | --- | --- |
| `missed` | `skipped` | no |
| `overlap` | `skipped` | no |
| `owner_unavailable` | `skipped` | yes |
| `rejected` | `failed`: opening or admitting was refused for good | yes |
| `approval_required` | `failed` (or `waiting` until then): a `fail_closed` request reached a human decision | yes |
| `approval_expired` | `failed`: a card of the firing's request reached the routine's [approval deadline](approval-expiry.md) undecided | yes |
| `turn_failed`, `turn_cancelled`, `turn_uncertain` | `failed`: the request's receipt ended `failed`, `cancelled` or `uncertain` | yes |
| `usage_limit` | `failed`: admission refused the request because the member used its daily [usage budget](usage-metering.md) | yes |

An open refused with `409 memory_limit`, because the member's [memory](memories.md)
with the project notes would not fit its engine, is such a refusal: the firing fails
`rejected` and counts. So is `409 instructions_limit`, when the member's
[instructions](member-instructions.md) and [instruction packs](instruction-packs.md) with
the project notes would not fit. It names no
other reason, so check the member's entries and instructions when a Codex member's
firings start failing `rejected`.

A success resets the consecutive-failure count. A failure adds one, and the tenth in
a row disables the routine with reason `consecutive_failures`, in the transaction
that records it. Only an enabled routine counts. A firing claimed before the routine
was disabled and re-enabled still counts after the re-enable reset the count.

**One conversation per firing.** An uncertain turn or a cancellation closes a
conversation to new turns, and a failed request rejects the requests queued behind
it, so one long-lived conversation would break for good. A fresh conversation also
keeps one run's tool output from steering the next.

**Identity.** The claim draws the conversation and request UUIDs once, inside the
transaction that records the window. Every attempt to open and submit the firing
reuses them, so a retried firing is the same request under
[Identity and equivalence](integration-api-v1.md#identity-and-equivalence) and runs
at most once. The firing then goes through the same path as an owner's request:
`MemberClient.open` (with the gateway process's project notes, as
`POST /v1/conversations` captures them) and `MemberClient.accept`, the workflow's
`acceptTurn` update and its SQL admission.

**Missed windows are skipped, never replayed.** A window fires only if the gateway's
dispatcher was armed at or before it and the window is at most 5 minutes late. A
dispatcher is armed when it starts, and again when it sees the installation active
after a recovery hold. A window more than 5 minutes late is recorded as `skipped`
for `missed`. Only the latest window is recorded: earlier windows of the same gap
leave no row. A window less than 5 minutes old that this dispatcher was not armed
for is left alone, for another, armed, gateway to fire; once it is 5 minutes late,
any gateway records it as missed. So windows that fall while every gateway is down,
or while the installation is held for recovery, are never run late.

**Overlap.** While a routine has an open firing (`claimed`, `admitted` or
`waiting`), its next window is recorded as `skipped` for `overlap`. A partial unique
index allows one open firing per routine.

**Ambiguous outcomes.** After an attempt to open and submit, the dispatcher looks
for the request's admission row, which alone decides that the firing was admitted. A
refusal (a `MemberStoreError` other than `busy`, a rejected Temporal update or
invalid input) with no admission row fails the firing with `rejected`. Anything else,
such as a timeout, a lost connection or a held installation, is never counted: the
firing stays `claimed`, and when its 2-minute lease expires a dispatcher retries it
with the same identity. Each attempt has a 60-second Temporal deadline. A firing
that can never be admitted, for example because Temporal is unreachable or
project-note capture keeps failing, stays `claimed`, and the routine's later windows
are skipped for `overlap`. A claimed firing is driven to its end even if the routine
is disabled or deleted meanwhile.

### Approvals with nobody present

A routine's request reaches a human decision like an owner's.

- `wait`: the card stays in the conversation snapshot's `pendingApprovals` (or
  `pendingQuestions`) and the firing shows `waiting`. Find it from the firing's
  `conversationId`, then decide it through `POST /v1/conversations/{id}/human`. Pi
  and Claude cards wait durably. A Codex card expires after its live-call deadline,
  which leaves the turn `uncertain`, so the firing fails `turn_uncertain`. A routine
  created with `approvalDeadlineSeconds` bounds the wait: a Pi or Claude card still
  undecided at the deadline cancels the request and fails the firing
  `approval_expired` (see [approval expiry](approval-expiry.md)).
- `fail_closed`: when the dispatcher sees the firing's request `waiting`, it records
  `approval_required` on the firing first and then requests cancellation through
  the v1 durable cancellation intent, the same path as
  `POST .../requests/{id}/cancel`. If that request is lost, the next observation
  asks again. Cancellation, not an automatic deny, because `choose_next_step` has
  no deny choice. However the request then ends, even with a committed reply after
  the cancelled card, the firing fails with `approval_required`.

[Standing approval grants](standing-grants.md) match only owner-initiated requests, so
a routine's request always gets a card, and the card offers no standing choice.

## What a firing records

The initiator stays in SQL: it is never a Temporal workflow or update argument.
`recordAcceptance`, the workflow's admission activity, is the one place an admission
is written. Its caller attests only the owner; the routine dispatcher calls it
through `MemberClient` like the gateway and the CLI do. Inside the admission
transaction, after it locks the conversation, it looks up a firing row keyed by the
request's conversation and request UUIDs, with a share lock. If one exists, the
admission records `routine` and that routine's ID, but only when the firing is still
`claimed`, the conversation belongs to the routine's owner and member, and the text
is the routine's prompt; otherwise the admission is refused with `409 conflict`. A
caller that names any initiator other than the owner is refused. So no request body
or caller can choose the initiator, and a person cannot submit other text under a
firing's identity. The firing history shows a claimed firing's identity, so its owner
can submit that identity with exactly the routine's prompt before the dispatcher
does; by [identity and equivalence](integration-api-v1.md#identity-and-equivalence)
that is the routine's request, recorded as the routine's, and the dispatcher's
attempt then finds it admitted. An owner's own request in a routine's conversation,
under a new request UUID, is the owner's.

The share lock orders an admission against the dispatcher settling the claim, which
locks the firing row and then, in a separate statement with a fresh snapshot, checks
for the admission: either the admission commits first and the firing becomes
`admitted`, or the firing is failed first and the admission is refused.

Request receipts carry `initiator: {"kind": "routine", "id": "<routineId>"}`, and
every request-tied audit row copies it, as [the audit trail](audit-trail.md)
describes. A routine acts with its owner's authority, so rows its firing causes
(`conversation.opened`, `request.accepted`, a `fail_closed` cancellation) name the
owner as actor, as an operator CLI command does. `conversation.opened` names the
routine in its payload (`routineId`), read from the firing row, and
`request.cancellation_requested` carries `policy: "fail_closed"` when the routine's
policy asked for it. The routine's own facts are below; the owner's lifecycle actions
name the owner, and Crew's own decisions (a skipped or settled window, disabling the
routine after ten failures) name the system:

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `routine.created` | owner | a create inserts the routine | routine + revision | `routineId`, `revision` (1), `schedule`, `approvalPolicy`, `promptDigest` |
| `routine.enabled` | owner | enable | routine + revision | `routineId`, `revision` |
| `routine.disabled` | owner, or system for `consecutive_failures` | disable, or the tenth consecutive failure | routine + revision | `routineId`, `revision`, `reason` |
| `routine.deleted` | owner | delete | routine + revision | `routineId`, `revision` |
| `routine.firing_settled` | system | a window is skipped, or a firing succeeds or fails | routine + window | `routineId`, `scheduledFor`, `status`, optional `reason` |

`revision` rises with every lifecycle change, so each change has its own natural
key. These rows belong to no request, so their initiator is the owner, as for
`member.spawned`. The routine's prompt is never in the trail, only its digest.

## Routes

All routes need the bearer token. The owner comes only from it; another owner's
routine is `404 not_found`. Bodies are strict: an unknown field, including an
`initiator` or `ownerId`, fails `400 invalid_input`.

| Route | Purpose |
| --- | --- |
| `POST /v1/routines` | Create `{ "requestId", "memberId", "schedule", "prompt", "approvalPolicy" }`, optionally with `approvalDeadlineSeconds`; `201` with the routine |
| `GET /v1/routines?after=&limit=` | The owner's routines in every state, including deleted ones, ordered by `routineId`; `{ apiVersion, routines, nextAfter, hasMore }` |
| `GET /v1/routines/{routineId}` | One routine, including a deleted one |
| `POST /v1/routines/{routineId}/enable` | Body `{}`; `200` with the routine |
| `POST /v1/routines/{routineId}/disable` | Body `{}`; `200` with the routine |
| `DELETE /v1/routines/{routineId}` | Tombstone; `200` with the routine |
| `GET /v1/routines/{routineId}/firings?before=&limit=` | Firing history, newest first; `{ apiVersion, firings, nextBefore, hasMore }` |

`requestId` makes a create idempotent: the same owner sending the same `requestId`
and body gets the same routine back, whatever its state now, including a deleted
one. A different body with that `requestId` fails `409 conflict`. A create or enable
past the limit fails `409 routine_limit`. A `memberId` the owner does not have fails
`404 not_found`. A schedule that does not parse, is too frequent or never fires
fails `400 invalid_input`.

```json
{
  "apiVersion": "1", "routineId": "UUID", "memberId": "UUID", "schedule": "*/15 * * * *",
  "timezone": "UTC", "prompt": "Check the nightly build", "approvalPolicy": "wait",
  "state": "enabled", "disabledReason": null, "consecutiveFailures": 0,
  "nextWindow": "2026-11-12T08:15:00.000Z", "createdAt": "2026-11-12T08:03:12.421Z"
}
```

A firing is `{ scheduledFor, status, reason, conversationId, requestId, recordedAt,
settledAt }`. `conversationId` and `requestId` are null only for a skipped window.
For an open firing they lead to the request's receipt
(`GET /v1/conversations/{conversationId}/requests/{requestId}`) and to the
conversation snapshot with any pending card. Pages are keyset pages on
`scheduledFor`: pass `nextBefore` as the next `before`. `limit` defaults to 100 on
both lists and is at most 100 routines, because each carries its prompt, or 1000
firings. Query parameters are strict like the audit route's.
`GET /v1/capabilities` lists the limits and policies under `routines` and adds
`routine` to `initiatorKinds`.

## The dispatcher

Every gateway runs a dispatcher (`RoutineDispatcher`) beside its cancellation
outbox, on its own unreferenced 1-second interval that the gateway clears when it
closes; neither keeps the process alive. A pass that is still running when the next
interval fires is joined, not repeated. Each pass:

1. Reads the recovery phase. A held or restored installation disarms the dispatcher
   and the pass ends, writing nothing.
2. Claims up to 32 due enabled routines with `FOR UPDATE SKIP LOCKED` and, in that
   transaction, records each window as claimed or skipped and advances
   `next_window`.
3. Re-leases claims whose lease expired, then opens and submits every claim it
   holds, with a 60-second Temporal deadline each. The pass waits at most 75 s for
   them: an attempt stalled longer, for example on a database connection that stopped
   answering, carries on alone, and this gateway does not start another attempt for
   that firing while it runs.
4. Observes up to 32 open firings, each at most every 5 seconds, by reading their
   request receipts, and settles them.

The dispatcher's own transactions give up on a lock after 10 s (`lock_timeout`), so a
blocked pass fails and the next one retries. A window this gateway is waiting on for
an armed replica is left out of the claim batch, so it cannot crowd later windows
out. Nothing is logged when a pass fails: the firing history (missed windows,
firings left `claimed`) is the record.

All times come from an injected clock and reach SQL as parameters, so the tests set
them. `SKIP LOCKED` and the firing primary key make several gateways on one database
safe: two gateways never fire one window twice. With several gateways:

- give every gateway the same token map. A gateway counts the routine of an owner it
  does not know as `owner_unavailable`, a failure, so ten windows of an owner removed
  from one gateway's map disable that owner's routines;
- a gateway that starts or restarts is not armed for the windows of the last 5
  minutes, but another, armed gateway still fires them;
- a firing whose gateway stopped mid-attempt is retried by any gateway after its
  2-minute lease, with the same identity.

The gateway cannot see whether a profile's credential works, which only the worker checks.
A firing whose profile is unavailable is admitted, its turn fails or becomes
uncertain in the worker, and the firing fails, counting toward the limit of ten.

## Cost and retention

Every firing that runs opens its own conversation. A successful one leaves an idle
open member workflow (it waits for more turns until its generation limit), its
Temporal history, and for Claude and Codex members a native session directory under
`BIRBCREW_STATE_DIR`; Pi keeps its checkpoint in PostgreSQL. Every window also adds a
`routine_firings` row and at least one audit row. At the 15-minute minimum one
routine fires 96 times a day; an owner with 20 such routines adds 1,920
conversations, open workflows and, for Claude or Codex, session directories a day,
about 700,000 a year. There is no retention API and this change adds none: size
Temporal persistence and the native volume for it, or schedule less often.

## Upgrade and recovery

Migration 25 creates the two tables and widens three CHECK constraints on existing
tables, `request_admissions_initiator_kind_check`, `audit_events_initiator_check`
and `audit_events_type_check`, by dropping and re-adding each `NOT VALID`, as
migrations 21 and 23 describe, and adds two partial unique indexes on
`audit_events`. Existing rows are neither rewritten nor checked. Until `migrate()`
commits it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17.11) | Why |
| --- | --- | --- |
| `members` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the routines foreign key |
| `request_admissions` | `ACCESS EXCLUSIVE` | the initiator CHECK |
| `audit_events` | `ACCESS EXCLUSIVE`, `SHARE` | the CHECKs and the two index builds |

Crew's transactions take `request_admissions` and `audit_events` in both orders: an
admission inserts its row and then its audit row, while a commit's audit insert locks
`audit_events` before it reads the admission. A migration that held one of them while
it queued for the other could deadlock with such a transaction, and the loser could
be a running turn's commit. So the migration first takes all three tables with
`LOCK ... NOWAIT` inside a subtransaction and, if any is busy, releases them, sleeps
20 to 100 ms and retries. It never waits in a lock queue, so it neither joins a
deadlock nor holds up other sessions while it waits. A running native turn's
admission transaction holds only `ACCESS SHARE` on `members`, which these modes
allow, and nothing on the other two tables, so a live upgrade never waits for a
turn. If the migration cannot get all three locks within 60 s it fails with `55P03`,
applies nothing, and the process exits; start it again. While it holds them, spawns,
admissions and audited writes wait for it. The two index builds read `audit_events`
once each: about 0.15 s for one million rows (419 MB) on the verification host with a
warm cache. As for every migration, stop every process of the previous release
first (see [persistent deployment](persistent-deployment.md#upgrades)).

Both tables carry the `recovery_write_barrier` trigger, so a held installation
refuses a claim and recovery capture accepts and counts them. The dispatcher also
stops at a hold by itself. A firing that was `claimed` at the recovery point is
restored `claimed` and re-driven with its stored identity once its lease has
expired, never under a new one. The gateway is consumer ingress: see
[coordinated recovery](coordinated-recovery.md#scheduled-routines-are-consumer-ingress).

## Not covered

- Time zones and daylight-saving time, month and day names, and macros.
- Changing a routine's definition, or a prompt that varies between firings.
- Retention or cleanup of firing conversations, workflows and session directories.
- An explicit owner action to retry or abandon a stuck `claimed` firing.
- A routine-level view in the audit trail. `initiatorId` selects the rows of a
  routine's requests ([audit filters](audit-filters.md)), but the routine's own
  lifecycle and firing rows carry `routineId` only in their payloads, which no
  filter reads.
- A gateway that should serve requests but not fire routines: every gateway runs the
  dispatcher.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump`/`pg_restore`,
or set `BIRBCREW_RECOVERY_POSTGRES_CONTAINER`.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:routines
npm run test:recovery
```

`routine-schedule.test.ts` checks the grammar, next windows in UTC (including the
2100 leap rule and either-day matching), the minimum interval with its stated
conservative refusal, schedules that never fire, and that every accepted sample
schedule's windows over 2,000 steps are at least 15 minutes apart.
`routines.test.ts` runs against real PostgreSQL, each dispatcher scenario in a fresh
database with a settable clock and MemberClient doubles that open and admit through
the real store. It checks:

- strict bodies, the prompt and schedule limits, idempotent create, `409` on a
  changed body, `404` for another owner's routine or member, query validation, the
  lifecycle and its audit rows, and the definition, tombstone and delete triggers;
- the limit of 20 under 25 concurrent creates and under concurrent re-enables, and
  an uncommitted 20th routine making a 21st create wait on the owner's lock and then
  fail;
- two dispatchers at the same instant firing twelve due routines exactly once each,
  with one identity and one admission each;
- an ambiguous error before admission keeping the firing claimed and uncounted until
  its lease expires, then admitting the same identity; an error after admission
  settling as admitted;
- missed, unarmed, overlapping and owner-unavailable windows;
- refusals failing firings, a success resetting the count, the tenth failure
  disabling the routine with a system `routine.disabled` row, and re-enabling;
- `fail_closed` recording `approval_required`, writing one durable cancellation
  intent attributed to the routine, and failing even after a committed reply, while
  `wait` leaves the card in `pendingApprovals` and completes after approval;
- no firing rows while the installation is held, a refused direct write, and windows
  of the hold skipped after resume;
- receipts and audit rows naming the routine; a body with `initiator` refused; a
  caller naming a routine refused; other text under a firing's identity refused and
  the identical request recorded as the routine's; another member refused a firing's
  conversation;
- a refusal that races an earlier attempt's admission settling as `admitted`, a
  stalled attempt that neither holds up later passes nor is retried by its own
  gateway, and waiting windows that do not crowd a due one out of the claim batch;
- the gateway's dispatcher firing on the gateway's clock and stopping when it closes;
- migration 25 on a version-24 database: its locks, that it rewrites neither table
  and leaves the constraints `NOT VALID`, that it never queues while an admission
  transaction holds `request_admissions` and that transaction's audit append is not
  held up, and that it completes while a native turn holds its admission.

`recovery.test.ts` restores a real `pg_dump` taken while a firing was claimed,
checks that capture counted both tables, and shows the restored firing admitted with
its stored identity and one admission.

The service proof needs Docker, Linux and Temporal CLI 1.10.0, like the other
service proofs:

```sh
npm run test:routines:service
```

It runs the real gateway, Temporal worker and Pi fixture provider: a firing that
completes in its own conversation with routine attribution in the receipt and the
audit trail; a `wait` routine whose card appears in `pendingApprovals` and completes
after approval through `/human`; a `fail_closed` routine that requests cancellation
and fails `approval_required` with no work item; and a gateway killed while its
firing is claimed and blocked in admission, after which the next gateway runs the
same identity exactly once. It makes a window due by setting `next_window` to the
database clock rather than waiting for a cron window.

Not claimed: the proof covers Pi only. Claude's durable waiting card and a Codex
card expiring to `uncertain` follow the existing engine contracts and are not run
with routines. The PostgreSQL suites call the store and dispatcher directly with
MemberClient doubles; only the service proof runs Temporal. Clock skew between
gateways, a dispatcher armed across a hold too short to see, and the 60 s migration
deadline expiring are not exercised.
