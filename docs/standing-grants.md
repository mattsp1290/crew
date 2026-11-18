# Standing approval grants

Before migration 24, every protected `record_work_item` call opened an approval
card, and the owner answered `approve` or `deny` once per call. An owner can now
answer a card with one of two standing choices. The call is approved, and a grant
lets later calls of the same member proceed without a card. Crew records which
grant approved each such call, and observers and the audit trail show it.

## Choices

A card in `state.pendingApprovals` keeps `choices: ["approve", "deny"]`. A card
that can create a grant also has a separate field:

```json
"standingChoices": ["allow_conversation", "allow_always"]
```

A client written before this release renders `choices` and never offers a standing
choice. Answer through `POST /conversations/{id}/human` as for any card:

| Choice | Effect |
| --- | --- |
| `allow_conversation` | Approve this call. Later calls in this conversation proceed without a card while the conversation accepts requests. |
| `allow_always` | Approve this call. Later calls in every conversation of this member proceed without a card until revoked. |

The response reports the choice: `{"approvalId": "UUID", "decision": "allow_always"}`.
Crew stores the decision as `approve` together with the scope chosen on that card,
and reads both back as the standing choice. Repeating the same choice returns it
again. Any other choice on an answered card returns `409`, as before. Card `version`
and `policyVersion` stay 1.

Only a top-level `record_work_item` call of a request that the owner started can
use or create a grant. Crew reads the initiator from the request's durable
admission (migration 23). These calls never offer `standingChoices`, never match a
grant, and answer `409` to a standing choice:

- `choose_next_step` questions, which ask for an answer rather than permission;
- Pi child calls, whose invocation is a child rather than the request;
- requests with no admission row, such as those admitted by workflow histories
  older than durable admission: a missing admission is not the owner;
- requests admitted for any other initiator: a [routine](scheduled-routines.md)
  firing or the first request a [handoff](handoffs.md) reserved. A kind this release
  cannot read fails the proposal instead of matching a grant, and a standing answer
  on a card for a request of such a kind fails as a server error (`503`) rather than
  creating a grant.

Trusted-context tools never reach approval cards. Their own `authorize()` decides
them (see [trusted application context](trusted-application-context.md)).

A grant names the owner, the member, the conversation for `allow_conversation`
(none for `allow_always`), the tool `record_work_item`, policy version 1 and the
initiator kind `owner`. It does not constrain arguments: `operation_id` must equal
the request ID, so `note` is the only free argument, and a granted call may record
any note. A later change to the tool's arguments raises the policy version, and no
existing grant matches it.

No route creates a grant. Only an owner's answer on a real card does. There are no
deny grants, wildcard tools, or grants across members or owners.

## What a grant does

`ApprovalStore.proposeLocked` looks for a grant in the transaction that inserts the
call, while holding the conversation row. If an active grant covers the call, Crew
inserts the call already decided `approve` and naming that grant. It opens no card.
The decision is fixed at that first insert. Temporal activity retries and replays
read it back from PostgreSQL. A conversation grant is preferred to a member grant
when both match.

Every limit still applies. A request records at most one work item, so a second
granted call in the same request settles as `budget_exhausted`. A request still has
at most 16 calls. Codex still allows two open live calls per member and enforces each call's
deadline, and cancellation and native stops still close the call. Settling,
receipts and results follow the same code as an approved card.

The Claude and Pi workflow normally waits for the owner's answer after a proposal.
For a granted call it continues to settlement at once. That step is behind the
Temporal patch `standing-grants-v1`, which is recorded only for a granted call, so
histories without one replay unchanged. Codex needs no workflow change: the live
MCP call is proposed inside the native turn, and its first settlement poll finds it
approved and dispatches it.

## What observers see

A granted call produces the same tool-call frames as a carded one
(`TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`), then a `STATE_SNAPSHOT`
with no pending card for it and with an entry naming the grant, then the
`TOOL_CALL_RESULT`. The phase stays `running`.

```json
"grantedCalls": [
  { "requestId": "UUID", "approvalId": "UUID", "grantId": "UUID", "scope": "conversation" }
]
```

`grantedCalls` is absent until a grant first approves a call in the conversation. It
keeps the most recent 16 entries, the per-request call cap. The audit trail keeps
every one. Creating or revoking a grant publishes nothing, so a member-wide grant
never republishes the snapshots of the member's conversations. A Codex call also
keeps its `state.liveOperations` entry. The request status is `running`, never
`waiting`, while a granted call settles.

## Routes

Both routes are under `/v1`, need the bearer token, and take the owner only from it.
Another owner's member or grant returns `404`. A query parameter returns `400`, and
another method returns `405`.

`GET /v1/members/{memberId}/grants` lists the member's active grants, oldest first,
and at most 20 others, most recently ended first:

```json
{
  "apiVersion": "1",
  "memberId": "UUID",
  "active": [
    { "grantId": "UUID", "memberId": "UUID", "conversationId": null, "scope": "member",
      "choice": "allow_always", "toolName": "record_work_item", "policyVersion": 1,
      "approvalId": "UUID", "createdAt": "2026-11-12T08:15:30.123456Z", "status": "active" }
  ],
  "inactive": []
}
```

`approvalId` is the card whose answer created the grant. `status` is `active`,
`revoked` (with `revokedAt` and `revocationReason`: `owner` or `recovery_restore`), or
`conversation_closed`.

`POST /v1/members/{memberId}/grants/{grantId}/revoke` with body `{}` returns
`{"apiVersion": "1", "grant": { ... }}`. Revoking again returns the same grant and
`revokedAt`.

## Revocation and races

Revocation sets `revoked_at` and never deletes. Database triggers refuse deleting a
grant, revoking it twice, clearing a revocation, and changing any other column. It
affects later proposals only. **A call that a grant approved before the revocation
stays approved and can still record its work item.** Revocation does not interrupt it.

A proposal holds its conversation row and reads the grant `FOR SHARE`. Revoking a
conversation grant takes that conversation row first, as observation publication
does, then the grant row. Revoking a member grant updates the grant row. So either
the revocation commits first and the call gets a card, or the revocation waits until
the proposal commits and the call stays approved. Two concurrent `allow_always`
answers for one member leave one active grant (a partial unique index on the key) and
one creation event. Both answers report `allow_always`.

A conversation grant ends, with `status: "conversation_closed"`, when its
conversation stops accepting requests: its committed turns reach the conversation's
limit, a [handoff](handoffs.md#sealing) has sealed it, or a cancellation, an uncertain
turn or a rejected admission has closed it. A
conversation workflow that fails without leaving one of those facts keeps its grant
listed as `active` until revoked, although no new call can be proposed there.

Part of this is checked in the database. A row trigger looks up the card that
created a grant and refuses the grant (`23503`) unless the card belongs to the same
owner and member, was answered with the grant's scope and, for a conversation grant,
is in the same conversation. A CHECK allows a scope or a grant reference only on an
approved top-level `record_work_item` call. As for audit rows, a card the lookup
cannot see is refused rather than left to the foreign keys. Which calls a grant
covers is decided by the query in `src/service/grants.ts` alone; no trigger repeats
it for the calls a grant approves.

## Audit

Migration 24 widens the closed registry (see [the audit trail](audit-trail.md)):

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `approval.decided` | owner | As before; `choice` may be a standing choice | `approvalId` | as before |
| `grant.created` | owner | A standing answer creates a grant; on the card's conversation and request | grant | `grantId`, `approvalId`, `scope` |
| `approval.auto_approved` | system | A grant approves a call as it is proposed | call | `approvalId`, `invocationId`, `toolName`, `argumentDigest`, `grantId` |
| `grant.revoked` | owner, or system for `recovery_restore` | A grant is revoked; on its conversation for a conversation grant | grant | `grantId`, `reason` |

Each fact is written in the transaction of the change it records. A request's rows
copy the initiator its admission recorded, which is always the owner for a granted
call. Standing grants need no new initiator kind.

## Recovery

`tool_grants` carries the `recovery_write_barrier` trigger, and the recovery manifest
counts its rows. A restore rewinds grants to the recovery point, so it can bring back
grants revoked after it. When a restored installation resumes, Crew revokes every
grant that is not already revoked, with reason `recovery_restore`, and audits each
one with the system as actor. This runs in the transaction that makes the
installation active, after locking each affected conversation, so a crash leaves
neither and a retried `resume` repeats it. A held source that resumes without a
restore keeps its grants. After a restore the owner answers cards again to create new
grants.

## Upgrade

Migration 24 adds two nullable columns and two CHECK constraints to
`deferred_calls`, creates `tool_grants`, widens `audit_events_type_check`, and adds
one unique index to `audit_events`. Until `migrate()` commits it holds `ACCESS
EXCLUSIVE` on `deferred_calls` and `audit_events` and `SHARE ROW EXCLUSIVE` on
`members` and `conversations` (foreign keys), as measured with `pg_locks` on
PostgreSQL 17. It takes them in the order Crew's transactions use those tables, so it
cannot deadlock with them. The new columns have no default, and every new constraint
on an existing table is `NOT VALID`, so neither table is rewritten and
`deferred_calls` is not scanned. Building the index reads `audit_events` once: about
0.15 s for two million rows with a warm cache on the test host. Meanwhile proposals,
decisions, settlements and audited writes and reads wait.

A running native turn's admission transaction holds no conflicting lock, so the
migration does not wait for it, and the turn keeps writing to its conversation. The
Codex live path touches `deferred_calls` only in short transactions. Like migrations
21 and 23 it sets no `lock_timeout`. A session outside Crew holding a lock on these
tables, such as an open `psql` transaction or `pg_dump`, delays it.

Stop every process of the previous release before the first upgraded one starts, as
for migrations 21 and 23. A worker of the previous release replaying a history in
which a granted call skipped the wait would wait for an answer that never comes. A
gateway or activity of the previous release refuses standing choices. Rolling back to
a release without standing grants is not supported once a conversation workflow has
taken a standing answer or run a granted call: the earlier workflow code neither
accepts a standing choice nor skips the wait, so such histories do not replay on it.

## Security

Crew has one bearer token per owner. It cannot tell a person answering a card from an
automated consumer holding the same token. **Whoever holds the owner's token can
create a standing grant by answering a card, and every later call it covers then
runs with no person involved.** An `allow_always` grant hands the member's
`record_work_item` calls to every holder of that token until it is revoked.

Once a grant exists, no person sees the calls it covers. The member records a work
item with whatever `note` the model chose, including when untrusted content in the
conversation prompted the call. A card never showed the note either, but each call
needed a person. A grant belongs to the member, not to its profile's instructions or
model, so it survives an operator changing those.
Authentication and permission changes need human review before merge (see the
README).

## Not covered

- Grants do not expire with time. Only revocation, a closed conversation or a restore
  ends one.
- The list of active grants is not bounded: one per open conversation of the member,
  plus one member-wide grant. Only the ended grants are limited to 20.
- The operator CLI's `pending` command does not show `standingChoices`. Its `decide`
  command accepts them, acting as the owner it names.
- A grant cannot be scoped to arguments, a time window or a number of calls.
- Revocation never interrupts or undoes a call already approved.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases, with `BIRBCREW_PG_BIN` naming PostgreSQL 17 `pg_dump` and
`pg_restore` (or `BIRBCREW_RECOVERY_POSTGRES_CONTAINER`).

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:grants
npm run test:audit
npm run test:recovery
node --test tests/service/approvals.test.ts tests/service/codex-calls.test.ts
```

`standing-grants.test.ts` runs against real PostgreSQL through the HTTP gateway, an
official AG-UI client and `GET /v1/audit`. It checks that:

- a card offers `standingChoices` while `choices` stays `["approve", "deny"]`;
- a standing answer reports its choice, repeats it, and refuses a different one;
- the next call in scope is approved with no card and names the grant, in the call,
  the snapshot and the observer's frames, and its request reads `running`;
- a second granted call in a request gets `budget_exhausted` and the 17th call is
  refused;
- `allow_conversation` stays in its conversation, `allow_always` covers the member's
  other conversations, and neither reaches another member or owner;
- requests with no admission row, Pi child calls and `choose_next_step` never use or
  offer a grant, and an admission naming an unreadable initiator fails closed;
- revocation leads back to a card, repeats harmlessly, returns `404` to other owners,
  and leaves an already approved call approved;
- a revocation racing a proposal either commits first (card) or waits (approved), and
  two concurrent `allow_always` answers create one grant and one event;
- the database refuses grants bound to another owner, member or conversation, deletes,
  repeated revocations and other updates;
- the audit rows above appear once, with actor and payload, and hold no note.

`codex-calls.test.ts` checks a Codex live call approved by a grant at its first
settlement poll, with the deadline and member capacity still enforced.
`audit.test.ts` applies migration 24 to a version-23 database with a pending card:
the exact locks, no rewrite or scan of `deferred_calls`, that it completes while a
native turn holds its admission, that the constraints are `NOT VALID`, and that the
old card takes a standing answer. `recovery.test.ts` restores a real `pg_dump`
archive taken before a revocation and shows the resumed target revoking every grant
with `recovery_restore`, while the source that resumed without a restore kept its
own.

With Temporal CLI 1.10.0, Docker, Landlock ABI 4 and the native launcher, the
service tests drive the real worker and SDK fixtures:

```sh
node --test --test-name-pattern='granted call|allow_always lets' \
  tests/service/observation.test.ts tests/service/codex-live.test.ts
npm run test:rollover
node tests/proof/admission-compatibility.mts
node tests/proof/progress-compatibility.mts
```

The service tests need the PostgreSQL, Temporal and fixture workers that
`scripts/verify-members` starts, and it runs them. Claude and Pi observers see a
granted second request run with no card. The test reads that workflow's history:
no `standing-grants-v1` marker after the carded first request, one after the granted
second request, and the whole history replays. Codex runs a granted live call in another conversation of the member. The replay
proofs show histories without a granted call replaying unchanged.

Not claimed: a live provider account, or any way to tell a person from an automated
client holding the owner's token. No committed proof replays a workflow history that
an earlier release recorded; the replay proofs record their own histories with this
release.
