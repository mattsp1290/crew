# Append-only audit trail

Crew stores approval decisions, admissions, cancellation intents and committed
results, but those rows say what the state is, not who changed it or when. The
public AG-UI tail keeps only the last 256 events per conversation. Migration 21
adds a durable record of each action, readable and exportable by its owner
through `GET /v1/audit`.

## Contract

Each row in `birbcrew_ts.audit_events` records one fact:

- `event_id`: a database identity that increases with every row. It is the only
  ordering and pagination key. IDs are shared by all owners and are not
  contiguous. Gaps reflect other owners' events, rolled-back writes, suppressed
  duplicates and the jump at each restore (see below).
- `owner_id`: the tenant whose state changed. A foreign key binds the member to
  that owner. When a conversation is present, a row trigger
  (`audit_events_conversation_binding`) looks it up as the row is inserted and
  refuses the row with `23503` unless it finds the conversation with that owner
  and member. A conversation the lookup cannot see is refused even if it commits
  before the insert ends: one not yet committed when the trigger runs, or, under
  REPEATABLE READ, one committed after the transaction's snapshot. A conversation
  the trigger finds keeps its owner and member until commit, because the binding
  columns are immutable and a foreign key stops the conversation from being
  deleted. So every committed row names a conversation of its own owner and
  member, whoever wrote it, including direct SQL, unless an administrator disables
  the triggers. Crew's writers append after creating or reading the conversation
  in the same transaction.
- `occurred_at`: the database clock (`clock_timestamp()`) when the row was
  inserted, inside the state change's transaction. It is not the commit time.
- `actor_kind`/`actor_id`: who performed the action. Today this is `owner` (with
  the owner ID) or `system` (with no ID) for work Crew carries out itself. A
  scheduled routine acts with its owner's authority, so the rows its firings cause
  name the owner; Crew's own decisions about a routine (a skipped or settled window,
  disabling it after ten failures) name the system.
- `initiator_kind`/`initiator_id`: what started the request the action belongs to.
  Migration 23 records it on the request's durable admission
  (`request_admissions.initiator_kind`/`initiator_id`) once, when the request is
  admitted, and it never changes afterwards. For an event tied to a request, the
  audit insert itself copies that initiator, inside the same transaction, so no
  caller chooses it. An owner admission stores no `initiator_id`; the audit row
  names the owner ID. A request with no admission row is recorded as
  owner-initiated, as before migration 23: requests admitted by workflow histories
  older than `bounded-conversations-v1`, trusted-context effects, whose lane
  records no admission, and a request refused under its member's usage budget
  (`usage.request_refused`, whose payload names the routine instead when a routine's
  firing submitted it). `member.spawned`, `member.instructions_set`,
  `member.instruction_packs_attached`, `conversation.opened`, `conversation.handed_off`,
  the routine facts, the memory facts, the budget facts, the webhook facts and the
  instruction pack facts belong to no request and name the acting owner. Migration 25 adds the
  second kind, `routine`, with the routine's ID: an admission records it only from
  the routine's firing row (see
  [scheduled routines](scheduled-routines.md#what-a-firing-records)). Migration 27
  adds the third, `handoff`, with the handoff's ID: an admission records it only for
  the request a [conversation handoff](handoffs.md#the-reserved-first-request)
  reserved, with exactly its transcript. Named CHECK
  constraints (`audit_events_initiator_check` and
  `request_admissions_initiator_kind_check`) allow only these three kinds, and a
  routine or a handoff only on a request-tied audit row. No operator or application
  kind exists yet. Operator CLI commands (`npm run members`) act as the owner they name.
  Standing grants (migration 24) added no kind: a call a grant approves keeps its
  request's initiator, and `approval.auto_approved` names the system as its actor.
- `event_type`, `member_id`, `conversation_id`, `request_id` and a small
  `payload` object. `member_id` is null only for the `webhook.*` and
  `instruction_pack.*` types, which belong to the owner and to no member (migrations
  32 and 33, `audit_events_member_check`).

The audit row is written in the **same transaction** as the change it records, so
a rolled-back change leaves no row, and a change committed by a release that
includes migration 21 cannot lack one. Processes of an earlier release still
running against the migrated database commit changes without rows; see
[Retention, upgrade and recovery](#retention-upgrade-and-recovery). Every
event type has a natural key: a partial unique index, which the insert names as
its `ON CONFLICT` target. Temporal activity retries, replayed idempotent requests,
concurrent duplicates and repeated cancellation deliveries append nothing new. Any
other conflict, such as a duplicate primary key, still fails the transaction. A
database trigger rejects every `UPDATE`, `DELETE` and `TRUNCATE` on the table,
including zero-row statements.

Payloads contain identifiers, SHA-256 digests, choices and statuses only. They
never contain prompt or reply text, tool arguments or results, notes, member memory
text, tokens or credentials. Memory rows carry no digest of their text either: the
owner can delete an entry, and a digest kept in this table would let an export holder
confirm a guess of the deleted text. Instruction pack rows carry only pack IDs, for the
same reason: a pack no member has can be deleted. Member instructions are never erased, so their row
carries the SHA-256 of the text, never the text. `src/service/audit.ts` validates each payload against a strict schema
before insert, so extra fields are refused. The prompt digest is the hex SHA-256 of
the exact UTF-8 text, the same digest that admission already stores. A handoff's
transcript digest is the hex SHA-256 of the transcript it quoted, which is also the
prompt digest of the target's first request. The argument
digest is the one shown on the public approval card: a SHA-256 over the tool name,
operation ID and note.

These digests, and the instructions digest, are unsalted fingerprints of the text, not
secrets. Anyone holding an export can confirm a guess, and can recover short or
predictable text ("yes", "run the tests", a templated prompt or role) by trying
candidates. Identical text has the same digest for every owner, so pooled exports link
those requests and members across owners. Treat
an exported trail with the same care as the prompts and notes themselves. A later
audit version may switch to a keyed per-owner digest.

## Event types

The registry is the `auditEvents` object in `src/service/audit.ts`.
`audit_events_type_check` in `src/service/sql/021-audit.sql`, widened by
`024-standing-grants.sql`, `025-routines.sql`, `026-memories.sql`, `027-handoffs.sql`, `028-approval-expiry.sql`, `029-member-instructions.sql`, `031-usage.sql`, `032-webhooks.sql`, `033-instruction-packs.sql` and `036-delegation-audit.sql`, lists the same types.
Each widening replaces the whole constraint, so the last widening lists every type.
A test checks that the two lists match. `GET /v1/capabilities` lists them under
`audit.eventTypes`.

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `member.spawned` | owner | `spawn` inserts a member | member | `spawnRequestId`, `engine`, `profile`; `capabilityDigest` when the member has [capabilities](member-capabilities.md) |
| `conversation.opened` | owner | `openConversation` inserts a conversation | conversation | `{}`, or `routineId` when a routine firing opened it |
| `request.accepted` | owner | `recordAcceptance` commits the durable admission | conversation + request | `promptDigest` |
| `approval.decided` | owner | `decideLocked` stores a choice: Claude/Pi cards, Pi child cards and Codex live calls. `choice` may be a standing choice | `approvalId` | `approvalId`, `invocationId`, `toolName`, `argumentDigest`, `choice` |
| `grant.created` | owner | A standing choice creates a grant; on the card's conversation and request | `grantId` | `grantId`, `approvalId`, `scope` |
| `approval.auto_approved` | system | `proposeLocked` inserts a call a standing grant approved, with no card | `approvalId` | `approvalId`, `invocationId`, `toolName`, `argumentDigest`, `grantId` |
| `approval.expired` | system | `expireTurn` cancels a request whose Claude/Pi card was undecided at its [deadline](approval-expiry.md) | `approvalId` | `approvalId`, `invocationId`, `toolName`, `expiresAt` |
| `grant.revoked` | owner, or system for `recovery_restore` | The owner revokes a grant, or a restored installation resumes; on its conversation for a conversation grant | `grantId` | `grantId`, `reason` |
| `work_item.committed` | system | `settleLocked` inserts the work-item receipt, including Codex live dispatch | `receiptId` | `receiptId`, `approvalId` |
| `request.cancellation_requested` | owner | First durable cancellation fact: the v1 intent, or the cancellation marker written by the legacy cancel route | conversation + request | `receiptId` when the v1 intent came first; `policy: "fail_closed"` when a routine's policy requested it |
| `request.finished` | system | `commitTurn` (`completed`), `rejectAccepted` (`cancelled`/`failed`), `rejectUnstartedAdmission` (`failed`), final `reconcileTurn` or delegation quarantine (`uncertain`) | conversation + request | `status`, optional `reason` |
| `delegation.started` | system | `ChildStore.begin` admits the first child segment | child | `childId`, `role`, `engine`, `profile` |
| `delegation.finished` | system | A child settles as completed, failed, or cancelled | child | `childId`, `outcome`, and `code` for failure |
| `trusted_effect.completed` | system | The trusted-context lane records that an `effect` tool completed | `operationId` | `operationId`, `toolName` |
| `routine.created` | owner | a routine is created | routine + revision | `routineId`, `revision`, `schedule`, `approvalPolicy`, `promptDigest`, optional `approvalDeadlineSeconds` |
| `routine.enabled` | owner | a routine is enabled | routine + revision | `routineId`, `revision` |
| `routine.disabled` | owner, or system after ten consecutive failures | a routine is disabled | routine + revision | `routineId`, `revision`, `reason` |
| `routine.deleted` | owner | a routine is deleted | routine + revision | `routineId`, `revision` |
| `routine.firing_settled` | system | a routine's window is skipped, or its firing succeeds or fails | routine + window | `routineId`, `scheduledFor`, `status`, optional `reason` |
| `memory.created` | owner | a [member memory](memories.md) entry is created | entry | `memoryId` |
| `memory.deleted` | owner | an entry is deleted and its text erased | entry | `memoryId` |
| `memory.suspended` | system | a restored installation resumes and suspends an active entry | entry | `memoryId`, `reason` (`recovery_restore`) |
| `conversation.handed_off` | owner | a [conversation handoff](handoffs.md) commits; on the source conversation | handoff | `handoffId`, `targetConversationId`, `targetMemberId`, `firstRequestId`, `carriedTurns`, `omittedTurns`, `uncertainTurns`, `transcriptDigest` |
| `member.instructions_set` | owner | `spawn` inserts a member with [instructions](member-instructions.md) | member | `digest` (SHA-256 of the text), `bytes` |
| `usage.budget_set` | owner | a member's [usage budget](usage-metering.md) is set or its limit changes | member + revision | `revision`, `tokenLimit`, `period` |
| `usage.budget_cleared` | owner | a member's usage budget is cleared | member + revision | `revision` |
| `usage.request_refused` | system | admission refuses a request because its member used its budget; the only refused call the trail records | conversation + request | `tokenLimit`, `usedTokens`, `period`, `windowStart`, `budgetRevision`, optional `routineId` |
| `approval.requested` | system | `proposeLocked` inserts a call no standing grant approved: a card or question became pending | `approvalId` | `approvalId`, `invocationId`, `toolName`, `argumentDigest` |
| `webhook.created` | owner | a [webhook endpoint](webhooks.md) is created; no member | endpoint + revision | `webhookId`, `revision` (1), `host`, `kinds`, `format` (absent on rows from before migration 34, whose endpoints are `crew`) |
| `webhook.enabled` | owner | an endpoint is enabled; no member | endpoint + revision | `webhookId`, `revision`, `host` |
| `webhook.disabled` | owner, or system for `consecutive_failures` and `recovery_restore` | an endpoint is disabled; no member | endpoint + revision | `webhookId`, `revision`, `host`, `reason` |
| `webhook.deleted` | owner | an endpoint is deleted and its URL and secret erased; no member | endpoint + revision | `webhookId`, `revision`, `host` |
| `instruction_pack.created` | owner | an [instruction pack](instruction-packs.md) is created; no member | pack | `packId` |
| `instruction_pack.deleted` | owner | a pack no member has is deleted and its text erased; no member | pack | `packId` |
| `member.instruction_packs_attached` | owner | `spawn` inserts a member with instruction packs | member | `packIds`, in the order the model reads them |

`approval.decided` names the deciding owner as its actor. Through the gateway, the
owner comes from the bearer token at `POST .../human`. The operator CLI names the
owner directly. `request.finished` statuses match the integration
API statuses. A Claude turn that becomes uncertain and is then recovered to a
pending decision is not finished. The row is written only when reconciliation
closes recovery, or when a later commit completes the request.

## Route

`GET /v1/audit` requires the bearer token like every other route. The owner comes
only from that token. Rows of other owners are never returned. A `conversationId`
filter for another owner's conversation returns an empty page, not `404`.

| Parameter | Meaning |
| --- | --- |
| `after` | Return events with a larger `eventId`. Decimal, default `0`. |
| `limit` | Default 100 in both formats. At most 1000 for JSON and 10000 for CSV (the hard row cap). |
| `conversationId` | Only events for this conversation. |
| `memberId`, `eventType`, `actorKind`, `initiatorKind`, `initiatorId`, `from`, `to` | Only events that match: see [audit filters](audit-filters.md). |
| `format` | `json` (default) or `csv`. |

Filters combine with AND and never change the cursor rules below.
Query validation is strict. An unknown or repeated parameter, or a malformed or
out-of-range value, returns `400 invalid_input`. Other methods return `405`.

```json
{
  "apiVersion": "1",
  "events": [
    {
      "eventId": "42",
      "occurredAt": "2026-11-12T08:15:30.123456Z",
      "type": "approval.decided",
      "actor": { "kind": "owner", "id": "local" },
      "initiator": { "kind": "owner", "id": "local" },
      "memberId": "UUID", "conversationId": "UUID", "requestId": "UUID",
      "payload": { "approvalId": "UUID", "invocationId": "UUID", "toolName": "record_work_item",
        "argumentDigest": "64 hex", "choice": "approve" }
    }
  ],
  "nextAfter": "42",
  "hasMore": false
}
```

Event IDs are decimal strings because they are 64-bit. Pass `nextAfter` as the
next `after`. It is the last returned ID, or your own `after` for an empty page.
`hasMore` is true when more rows already existed at read time. To tail the trail,
keep the last `nextAfter` and poll.

`format=csv` returns as `text/csv` the same rows that JSON returns for the same
parameters. It uses RFC 4180 quoting and CRLF line endings, with a header row:
`eventId,occurredAt,type,actorKind,actorId,initiatorKind,initiatorId,memberId,conversationId,requestId,payload`.
The payload cell is its JSON. Empty cells are nulls. The `Audit-Next-After` and
`Audit-Has-More` headers carry the cursor. To export more than one page, pass
`limit=10000` and loop on `Audit-Next-After` while `Audit-Has-More` is `true`.

Spreadsheets run a cell that starts with `=`, `+`, `-`, `@`, tab or carriage return
as a formula. Owner IDs are free text from the operator's gateway configuration and
appear in the `actorId` and `initiatorId` cells. Any cell that starts with one of
those characters, or with `'`, is written with one extra leading `'`, the usual
mitigation, so a spreadsheet shows it as text. The file stays plain RFC 4180. A
program reading the CSV recovers each exact value by removing one leading `'` from
any cell that starts with it. No other column can start with these characters.
JSON responses are not changed.

### Pages never skip a late commit

An identity value is allocated at insert, before commit. A transaction holding a
lower ID can therefore commit after a higher ID is already visible. A reader that
had paged past that higher ID would never see the lower one.

To prevent this, a statement trigger (`audit_events_append_order`) takes a shared
advisory lock before any insert draws its ID. The writer holds that lock until
commit. This applies to every writer, including direct SQL. The identity is
declared `CACHE 1`, because the argument needs IDs drawn in order and a session's
cached IDs would not be.

A read polls for the same lock exclusively with `pg_try_advisory_xact_lock`. It
gets the lock only when no allocated ID is still uncommitted. It then records the
largest committed ID as a horizon and returns rows only up to it.

A read never queues ahead of writers. It holds the lock for one index lookup,
which is the most it can delay a writer. It can wait for an in-flight state change
to commit, polling with a backoff that grows from 10 ms to 200 ms (about 30
attempts). If it cannot get the lock within 5 s, it answers `503` with
`{"error":"audit_unsettled"}` and `Retry-After: 1`. Retry the same read. Nothing was
skipped. It never returns a page that a later commit can fill in behind the cursor.

The lock is shared by all owners. Every audited transaction in Crew appends its row
as its last step, then runs only database statements and commits. None waits for the
application, Temporal or a native turn after appending. A read therefore waits out
its 5 s window only while audited writes overlap continuously, or while a writer
process has stalled between its insert and its commit: frozen, paused, or cut off
from the database. Until PostgreSQL ends that session, every owner's read answers
`audit_unsettled`. PostgreSQL notices a vanished client only through TCP keepalives,
so set the server's `tcp_keepalives_idle`, `tcp_keepalives_interval` and
`tcp_keepalives_count` well below the usual two-hour system default. A frozen process
whose host still answers keepalives holds the lock until it resumes or is killed. Do
not set `idle_in_transaction_session_timeout` for the application role. Native
admission keeps a transaction open for a whole native turn by design, and the timeout
would end it.

## Retention, upgrade and recovery

Rows are retained with the database. There is no TTL and no deletion API.
Trusted-context erasure removes content but leaves audit rows, which hold none.
Migration 21 does not backfill history: members, admissions and decisions made
before it have no audit rows. The gateway and every `npm run members` command,
including the worker, apply pending migrations before they serve, so the first
upgraded one to start applies migration 21.

Code without migration 21 writes no audit rows, and nothing stops it. A gateway,
worker, supervisor host or operator CLI of an earlier release skips the migration,
keeps committing spawns, admissions, decisions, cancellations and results against
the migrated database, and leaves no row or other mark of the gap. So stop every
process of the previous release before the first upgraded process starts, rather
than rolling the upgrade through running instances. Rolling back to an earlier
release breaks completeness for as long as it runs. An earlier release also does
not move the audit identity when it accepts a restore, so once a later release
writes to that timeline again, its new IDs can repeat ones consumers hold. A
release that includes migration 21 cannot accept such a generation instead:
acceptance requires the application commit and lockfile of the release that
captured it. So prefer generations captured by a release that includes migration
21, and move the identity by hand after an earlier release accepts a restore, as
[below](#after-an-earlier-release-accepted-a-restore) describes.

Migration 21 creates the table and only references existing ones. Its foreign keys
take `SHARE ROW EXCLUSIVE` and `ACCESS SHARE` on `members` and `conversations` until
the migration commits. Of Crew's own statements, only writes to those two tables
conflict: the inserts of a spawn or a conversation open. The migration waits for
those in flight, and new ones wait for the migration. Reads, row locks and the
transaction a running native turn holds do not conflict, so a live upgrade does not
stall conversation traffic. Like migrations 014 and 017, which also reference
`conversations`, it sets no `lock_timeout`. No conflicting holder waits for anything
that queues behind the migration, so every wait ends. Spawns and opens are short,
except that an open with project-note capture configured runs its `git` and `bn`
commands, each limited to 10 s, before it commits.

Migration 23 adds the initiator to `request_admissions` and records every existing
admission as owner-initiated. It locks only that table, in `ACCESS EXCLUSIVE` mode,
until the migration commits. Its constant default fills existing rows from the
catalog, without a rewrite or scan, and its CHECK constraints are added `NOT VALID`,
so the lock is held briefly. It waits for transactions already using the table:
admissions, rejections, cancellation intents, turn starts, reconciliation, status
reads and request-tied audit appends, none of which waits for application work
while holding it. A running native turn's admission transaction holds `ROW SHARE`
on `turns` (or `native_launches` for Codex) and `ACCESS SHARE` on a few other
tables, never on `request_admissions`, so a live upgrade does not wait for native
turns. Like migration 21 it sets no `lock_timeout`: a session outside Crew that
holds a lock on the table, such as an open `psql` transaction or a running
`pg_dump`, delays it, and statements on the table queue behind it meanwhile.

The migration then drops the default, so every admission must name its initiator.
Processes of an earlier release fail rather than record one without it. Their
admission activity fails with a not-null violation and Temporal retries it; if no
upgraded worker takes a retry within the activity's 60 s schedule, the
conversation's workflow fails, as after any failed admission. Their v1 cancel
backfills admissions the same way and fails for every request that has a turn,
even one already admitted. Stop every process of the previous release before the
first upgraded one starts, as for migration 21.

Migration 24 replaces `audit_events_type_check` with a wider constraint, `NOT VALID`,
in one `ALTER TABLE`, and adds one partial unique index for the three
[standing grant](standing-grants.md#upgrade) event types. It holds `ACCESS EXCLUSIVE`
on `audit_events` until the migration commits, so audited writes and audit reads wait
for it. The constraint is not checked against existing rows. Building the index reads
the table once.

Migration 25 widens `audit_events_initiator_check` and `audit_events_type_check`
the same way, adds two partial unique indexes for the routine facts and widens the
admission CHECK. It takes `request_admissions` and `audit_events` together without
queueing for either, so it never deadlocks with an admission or a commit and never
waits for a native turn; [scheduled routines](scheduled-routines.md#upgrade-and-recovery)
lists its locks. The index builds read `audit_events` once each under its exclusive
lock.

Migration 26 replaces `audit_events_type_check` the same way, with every earlier
type and the three memory types, and adds one partial unique index for them. It takes
`audit_events` together with `members` and `conversations` without queueing, so it
never waits for a native turn; [member memory](memories.md#upgrade) lists its locks.

Migration 27 replaces `audit_events_type_check` and `audit_events_initiator_check`
the same way, with every earlier type and kind plus `conversation.handed_off` and
`handoff`, widens the admission CHECK, and adds one partial unique index. It takes
`request_admissions` and `audit_events` together with `members` and `conversations`
without queueing, so it never deadlocks with an admission or a commit and never waits
for a native turn; [conversation handoff](handoffs.md#upgrade) lists its locks.
Previous-release processes must be stopped first, and rollback is unsupported.

Migration 28 replaces `audit_events_type_check` the same way, with every type 27 lists plus
`approval.expired`, and adds one partial unique index for it. It takes `audit_events`
together with the four other tables it alters without queueing;
[approval expiry](approval-expiry.md#upgrade-in-flight-workflows-and-recovery) lists its
locks.

Migration 29 replaces `audit_events_type_check` the same way, with every type 28 lists plus
`member.instructions_set`, and adds one partial unique index for it. It takes
`audit_events` together with `members` without queueing;
[member instructions](member-instructions.md#upgrade) lists its locks.

Migration 30 adds three indexes for the filters and changes no constraint or
trigger. It holds `SHARE` on `audit_events`, taken the same way, so audited writes
wait for the index builds; applied alone, from version 29, reads continue.
[Audit filters](audit-filters.md#upgrade-and-recovery) lists its locks.

Migration 31 replaces `audit_events_type_check` the same way, with every type 29 lists
plus the three usage types, and adds two partial unique indexes for them. It takes
`audit_events` and `routine_firings` together with `members` and `native_launches`
without queueing, so it never waits for a native turn;
[usage metering](usage-metering.md#upgrade-and-recovery) lists its locks.

Migration 32 drops `NOT NULL` from `member_id`, adds `audit_events_member_check`,
which allows a null member only on the `webhook.*` types, and replaces
`audit_events_type_check` with every type 31 lists and the five new ones, all
`NOT VALID` and without a rewrite, and adds two partial unique indexes. It takes only
`audit_events`, without queueing; after 31 in one transaction it already holds that
table. [Outbound webhooks](webhooks.md#upgrade) lists its locks. `memberId` is `null`
on `webhook.*` rows in JSON, and their CSV cell is empty.

Migration 33 replaces `audit_events_member_check`, so that a null member is also allowed on
the two `instruction_pack.*` types, and `audit_events_type_check`, with every clause 32 lists
and the three pack types, both `NOT VALID` and without a rewrite, and adds two partial unique
indexes. It takes `audit_events` together with `members` without queueing;
[instruction packs](instruction-packs.md#upgrade) lists its locks.

The audit table carries the `recovery_write_barrier` trigger, so held installations
refuse audit writes and recovery capture accepts the table. The manifest
inventory counts its rows. `pg_dump`/`pg_restore` keep the rows and the identity
position. Restore creates the append-only trigger after it loads the data, so the
trigger does not interfere and still protects the restored copy. Reads, including
`GET /v1/audit`, work while an installation is held or restored, because they take
only an advisory lock. Like the recovery protocol, this assumes trusted database
administrators. The trigger does not stop a database owner who drops it or uses
replication-role bypass.

Restoring a generation rewinds the trail to that recovery point. Events committed
after it on the previous timeline are gone from the trail, along with the state
changes they recorded. The dump saves the identity's position, so on its own the
restored identity would reissue IDs that the previous timeline had already handed
out, and a consumer whose cursor had passed them would skip the new events. A
fixed jump from the restored maximum would not help when one generation is
restored to two targets in turn: both would jump to the same place. A jump to the
database clock would depend on every target's clock running ahead of every
earlier one's.

Accepting the restore (`npm run recovery -- accept-restore`) therefore moves the
identity to `epoch × 2^44`. The epoch comes from the recovery fence, which is
never restored: each transfer of authority to a new instance raises it by one, and
a retried acceptance gets the same epoch and sets the same value again. Timeline
`e` draws its IDs from `e × 2^44` up to `(e + 1) × 2^44 - 1`. The original
timeline, before any restore, is epoch 0 and starts at 1. Every restored timeline
therefore starts above every ID an earlier timeline drew, whichever target or
generation it came from, whatever the database clocks say. This holds while:

- the fence's state is never reset, replaced or rolled back;
- no timeline draws 2^44 IDs (about 1.8 × 10^13);
- the installation makes fewer than 2^19 (524,288) transfers, so the last range
  ends at 2^63 - 1, the largest `bigint`.

Before it transfers authority, acceptance computes from the restored database the
lowest epoch whose range lies above every ID the restored identity has drawn, and
passes it to the fence as `minimumEpoch`. The fence takes the larger of that and
its own next epoch. So a restore whose identity is already past the fence's next
epoch, because a timeline overran its range or the fence lost its epoch, still
starts above every ID in the restored database. A fence that lost its epoch cannot
see IDs that other timelines drew after this dump was taken, so never reset it.

Two refusals leave authority with the held source, which can resume: the restored
identity has already drawn an ID in the last epoch's range, or the fence's next
epoch would reach 2^19. Acceptance checks the first, and the fence the second,
before anything changes. One refusal comes after the transfer: a fence that
ignores `minimumEpoch` or returns no epoch, such as one written for an earlier
release. The target's database stays held and the source can no longer resume.
Upgrade the fence as [the recovery guide](coordinated-recovery.md#source-fencing-and-restore)
describes, then retry `accept-restore` with the same target instance UUID: the
retried transfer raises the stored epoch to the minimum and returns it.

Across a restore, a consumer sees this:

- Its saved `after` cursor stays valid and never skips a new event.
- Events it holds with IDs above the restored maximum no longer exist, and no page
  returns them. Once the operator reports a restore, a consumer that keeps copies
  should re-read from an earlier cursor and drop the copies the trail no longer
  returns.
- IDs jump to a multiple of 2^44 (17592186044416). They have 14 digits after the
  first restore and at most 19. From the 512th restore on they are at least 2^53,
  more than a JavaScript number or a double holds exactly. Keep them as strings,
  and compare them as 64-bit integers: as strings, IDs of different lengths sort
  wrongly.

The response does not carry the epoch, because recovery state is never exposed
through the gateway.

### After an earlier release accepted a restore

A generation captured while a release without migration 21 ran, before the
upgrade or after a rollback, can be accepted only by that release, and it leaves
the identity where the dump put it. Move the identity by hand once, for the
timeline that will serve, before any process of a release with migration 21 runs
on it. Do it after the earlier release's `accept-restore` and before `resume`,
while the restored installation is held: its write barrier refuses every audit
insert before the insert draws an ID, and `setval` is not a table write, so the
barrier permits it. If the earlier release has already resumed the timeline, stop
every Crew process first; that release draws no audit IDs, so none were drawn.

The steps below are for the included `FileRecoveryFence`, whose directory is
`$FENCE`; run the SQL against the restored database as the schema owner.

1. Stop every Crew process and recovery command of either release. Take the
   fence's lock, so that no recovery command can run until you release it:
   `mkdir -m 700 "$FENCE/lock"`. If `lock` already exists, a recovery command is
   running or crashed. Establish which before you go on, as for any lock debris.
2. Read the fence's stored epoch `S`, the `epoch` in `$FENCE/epoch.json`. A
   missing file means 0 only if no release with migration 21 has ever
   transferred authority; otherwise it is lost, and the
   [recovery guide](coordinated-recovery.md#if-the-fence-epoch-file-is-lost-or-damaged)
   says how to choose `S`. Read the epoch `D` of the restored identity's position
   and its highest ID:

   ```sql
   SELECT greatest((SELECT last_value FROM birbcrew_ts.audit_events_event_id_seq),
                   (SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events)) >> 44;
   ```

   The new epoch is `E = max(S, D) + 1`. It must be below 524,288.
3. Raise the fence's epoch to `E` before the identity moves, with an atomic
   replace:

   ```sh
   (umask 077 && printf '{"epoch":%d}' "$E" > "$FENCE/.epoch-manual")
   sync "$FENCE/.epoch-manual"
   mv "$FENCE/.epoch-manual" "$FENCE/epoch.json"
   sync "$FENCE"
   ```

4. Move the identity, writing `E` as a number:

   ```sql
   SELECT setval(pg_get_serial_sequence('birbcrew_ts.audit_events', 'event_id'),
                 E::bigint << 44, false);
   ```

5. Release the lock: `rmdir "$FENCE/lock"`.
6. Check that `$FENCE/epoch.json` holds `E`, and that
   `SELECT last_value, is_called FROM birbcrew_ts.audit_events_event_id_seq`
   returns `E × 2^44` and `f`. Then `resume`, with either release. The first audit
   event a release with migration 21 writes on this timeline has ID `E × 2^44`,
   and the next transfer gets epoch `E + 1`.

The fence's epoch rises before the identity moves, so a crash between the steps
leaves it higher than needed, never lower; repeat from step 1. If a release with
migration 21 already wrote to the timeline before the repair, the IDs it drew
above the dump's position may repeat ones consumers hold. The repair stops any
further repeats, and consumers that keep copies should re-read from a cursor below
the dump's highest ID.

## Not covered

- The trusted-context lane's own request lifecycle (submit, dispatch, rotation,
  held/release, recovery to uncertain, erasure) is not audited. Only completed
  `effect` tool calls are. Its requests are submitted by the operator's trusted
  application, not through an owner HTTP action. Modelling it needs an application
  initiator, which this migration does not allow yet. Its read-tool calls are not
  audited. An effect whose completion is never recorded has no audit row. This
  happens after process death, a deadline, or erasure before settlement. The
  effect stays `uncertain` in the trusted receipts.
- Operator CLI actions are indistinguishable from the same owner's gateway
  actions.
- Requests admitted by workflow histories older than `bounded-conversations-v1` have
  no durable admission and so no `request.accepted` and no recorded initiator. Their
  rows name the owner, the only possible initiator then. The v1 cancel backfill
  records an owner-initiated admission for such a request but does not invent a
  `request.accepted`.
- If a workflow is terminated externally before `reconcileTurn` runs, its started
  turn has no `request.finished` row.
- Reads are not audited: status, snapshots, observation and audit reads.
  Previews, text deltas, native process launches and stops are not audited either.
- `delegation.started` records first-segment admission, before native process launch.
  It does not prove that a provider received a request. Approval resumes add no second
  start fact. A budget refusal has only `delegation.finished` with `budget_exhausted`.
  Both facts inherit the parent request's initiator and omit task text and digests.
- Child admissions and outcomes from before migration 036 are not backfilled.
  A child already running at upgrade may finish without a start fact. Quarantine
  does not claim a child finished while its native stop remains unconfirmed.
- Only the first cancellation fact is kept. If the legacy route cancels first, a
  later v1 intent's `receiptId` is not added to the trail. The request status still
  returns that receipt.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump`/`pg_restore`, or
set `BIRBCREW_RECOVERY_POSTGRES_CONTAINER`.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:audit
npm run test:routines
npm run test:memories
npm run test:instructions
npm run test:api
node --test tests/service/store.test.ts tests/service/rollover-client.test.ts
npm run test:recovery
node --test tests/service/approvals.test.ts tests/service/codex-calls.test.ts \
  tests/service/trusted-context.test.ts tests/service/codex-registration.test.ts
```

`audit.test.ts` runs against real PostgreSQL. Through the HTTP gateway and
`GET /v1/audit` it checks:

- the rows that appear after each action (spawn, open, submit, decision,
  work-item effect, completion, cancellation, rejection), with actor and
  initiator;
- that prompts, notes, replies and tokens are absent from JSON and CSV;
- owner isolation, including conversation filters;
- keyset paging, CSV/JSON row equivalence and quoting, and query validation;
- a reader that waits for a late commit instead of skipping it, while other
  writers proceed;
- a writer left open past the read window: `503 audit_unsettled` with
  `Retry-After`, after about 30 polls.

By direct SQL it checks:

- one row per fact across concurrent duplicates, retries and replays, including
  reconciliation and quarantine;
- that appending a sample of every registered type twice leaves one row each,
  so every `ON CONFLICT` key matches its index;
- that a Claude turn handed to recovery records no `request.finished` until its
  recovered decision commits, and then only `completed`. The native session
  restore is replaced by a given proposal;
- rejection of `UPDATE`, `DELETE` and `TRUNCATE`, unknown types, other
  initiators, conversations of another owner or member, null natural keys and
  extra payload fields;
- rejection of a conversation that another owner commits after the binding
  trigger looked for it but before the foreign key check. A test-only trigger,
  rolled back afterwards, holds the insert on an advisory lock until that commit;
- spreadsheet formula prefixes in CSV cells, and that a plain RFC 4180 reader
  recovers the exact values;
- migration 21 on a version-20 database with members and conversations: the locks
  it takes on existing tables, that it completes while a native turn holds its
  admission and that turn still writes to its conversation, and that the identity's
  cache is 1;
- migration 23 on a version-21 database with admissions: that it locks only
  `request_admissions` and neither rewrites nor scans it, that a running native
  turn holds no lock on that table, that the migration completes while the turn
  holds its admission, that existing admissions become owner-initiated with no
  `initiator_id`, that an admission naming no initiator (including the previous
  release's cancel backfill), an unknown kind, or an owner with an ID is refused,
  and that a recorded initiator cannot be updated;
- that a request's audit rows copy the initiator its admission recorded (shown
  with a second kind admitted only inside a rolled-back transaction that widens
  both CHECKs), that a request without an admission row is still recorded as
  owner-initiated, and that an admission given a bare string or no initiator is
  refused before anything is written;
- migration 24 on a version-23 database with a pending card: the exact locks it
  takes, that `deferred_calls` is neither rewritten nor scanned, that it completes
  while a native turn holds its admission, and that its constraints are `NOT VALID`;
- that the TypeScript and SQL registries match, for event types and for
  initiator kinds.

Run the suites one after another, as above. Gateway-starting suites
(`audit.test.ts`, `integration-api.test.ts`) each run the background cancellation
flush. Run concurrently against one database, they can deliver each other's
pending intents.

`trusted-context.test.ts` checks the single `trusted_effect.completed` row for a
replayed effect. The recovery suite restores a real `pg_dump` archive and compares the audit rows.
It confirms the restored copy stays append-only and readable while held. Another
test lets the source run past the recovery point, restores the generation, lets
the target draw its whole range of 2^44 IDs, then restores the same generation
again. The second target's IDs pass all of the first one's, which a clock-based
jump would allow only if that target's clock were about 203 days ahead. A saved
cursor returns each new event, every transfer raises the epoch by one, a retried
acceptance does not, and each target starts at its epoch times 2^44. Other tests
restore an identity already past the fence's next epoch, with the fence's epoch
file missing or behind, and check that new IDs start above both its committed rows
and an ID drawn by a transaction that rolled back. They refuse an exhausted epoch
before authority moves and resume the source, refuse a fence that returns no epoch
and then accept the retry with an upgraded fence and the same target, and show
that a transfer interrupted between its epoch and state writes never hands out
an earlier epoch again.

Not claimed: these suites call the store, approval and child-store functions the
way Temporal activities do. They do not run a Temporal worker or native SDK. The
Temporal service proofs (`npm run test:api:service`, `scripts/verify-members`) do
not assert audit rows. Codex live answers and dispatch share the audited
`decideLocked`/`settleLocked` paths, but no test drives them through `answerLive`
or `settleLive` and then reads the trail. A trusted effect whose conversation has
vanished fails rather than commit without its row, but the foreign key from
trusted sessions makes that unreachable, so no test drives it.
