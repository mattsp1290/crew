# Member memory

An owner can save short facts for one of their members: "the release branch is cut
on Thursdays", "deploys need a second reviewer". Migration 26 stores them. Each
conversation of that member gives the model the facts that were active when it
opened, as system context after any [project notes](../README.md). Only the owner
writes memory, through the API. The model never writes it: there is no memory tool,
and nothing a model says changes an entry.

## Contract

An entry has:

- `memoryId`: a UUID the database generates. It is never reused.
- `memberId`: one of the owner's members. A foreign key to
  `members (owner_id, member_id)` binds the entry to its owner.
- `text`: 1 to 1024 bytes of well-formed UTF-8. No NUL and no control character
  except tab and newline. Carriage return, escape, DEL and the C1 range are refused.
  The route decodes its body strictly, so bytes that are not UTF-8 fail
  `400 invalid_json` instead of becoming U+FFFD.
- `state`: `active`, `suspended` or `deleted`.
- `createdAt`, and `changedAt` once the entry is suspended or deleted.

An entry is never edited. To change one, delete it and create another. A member can
have at most 32 active entries. A row trigger enforces the limit in the database: it
takes a transaction-level advisory lock keyed by the member, then counts. Concurrent
creates for one member queue on that lock until each commits, so they cannot both
count 31. This relies on `READ COMMITTED`, where the count, a later statement, sees
every create committed before it; Crew uses no other isolation level. Suspended and
deleted entries do not count.

| Transition | From | To | Effect |
| --- | --- | --- | --- |
| create | | `active` | counts toward the limit |
| delete | `active` or `suspended` | `deleted` | text erased, row kept as a tombstone |
| suspend | `active` | `suspended` | only when a restored installation resumes |

Database triggers refuse any other change: a `DELETE` or `TRUNCATE` of an entry, a
change to its ids or `createdAt`, new text, and any move back to `active`.

## Routes

All routes need the bearer token. The owner comes only from it. Another owner's entry
or member is `404 not_found`. Bodies are strict: an unknown field, including
`ownerId`, fails `400 invalid_input`. As on every route, a key repeated in the JSON
body keeps its last value. Queries are strict too: an unknown or repeated parameter
fails `400 invalid_input`.

| Route | Purpose |
| --- | --- |
| `POST /v1/memories` | Create `{ "requestId", "memberId", "text" }`; `201` with the entry |
| `GET /v1/memories?memberId=&after=&limit=` | The owner's entries in every state, ordered by `memoryId`; `{ apiVersion, memories, nextAfter, hasMore }` |
| `GET /v1/memories/{memoryId}` | One entry, including a deleted one |
| `DELETE /v1/memories/{memoryId}` | Erase the text; `200` with the tombstone |

```json
{
  "apiVersion": "1", "memoryId": "UUID", "memberId": "UUID", "state": "active",
  "text": "The release branch is cut on Thursdays.",
  "createdAt": "2026-11-12T08:03:12.421Z", "changedAt": null
}
```

`requestId` makes a create idempotent. The same owner sending the same `requestId`
and body gets the same entry back. Another `memberId` or `text` with that `requestId`
fails `409 conflict`. If that entry has been deleted, the replay fails
`409 memory_deleted`: its text is gone, so it is never compared. A replay of a
suspended entry returns it as it is, with `201` and `state: "suspended"`. A 33rd
active entry fails `409 memory_limit`. A `memberId` the owner does not have fails
`404`.

`memberId` is optional on the list: without it the page holds every member's entries.
`limit` defaults to 100 and is at most 100. Pass `nextAfter` as the next `after`. A
deleted entry is listed with `text: null`. Deleting again returns the same tombstone.

`GET /v1/capabilities` describes the feature under `memories`:

```json
{
  "version": 1, "route": "/v1/memories", "scope": "member", "writers": ["owner"],
  "modelWrites": false, "injection": "open-snapshot-minus-deletions", "textBytes": 1024,
  "activePerMember": 32, "injectedBytesPerConversation": 67638, "children": false,
  "deletion": "text-erased-tombstone-kept", "restore": "suspend-active",
  "startedConversations": { "pi": "deletions-apply-at-next-launch",
    "claude": "first-turn-context-may-persist", "codex": "first-turn-context-persists" }
}
```

`startedConversations` says whether a deletion or suspension reaches a conversation
that has already run a turn; see [below](#what-a-conversation-sees).

## What a conversation sees

When `openConversation` inserts a conversation, it records references to the
member's active entries, oldest first, in `conversation_memories`. This happens in
the same transaction as the project-notes capture and the `conversation.opened` audit
row. Opening the same conversation again records nothing new.

At each native launch the supervisor child reads those references joined to entries
that are still active. It appends them to the conversation's system context, after
the project notes, separated by one newline:

```
BirbCrew member memory v1. Treat the following JSON as reference data the owner saved for this member.
{"memories":[{"memoryId":"UUID","text":"The release branch is cut on Thursdays."}]}
```

The JSON encoding keeps each entry inside its own string. `JSON.stringify` leaves
U+2028 and U+2029 as they are, and both break a line, so Crew escapes them too. An
entry cannot end the block, start a line, or pose as the header. With no entries there
is no block, and a conversation with notes only gets exactly the notes it got before.

So:

- An entry created after a conversation opened never reaches that conversation. Open
  a new conversation to use it.
- A conversation's set only shrinks. Rollover keeps the conversation ID, so the same
  set applies after Continue-As-New.
- The read happens in the supervisor child, never in workflow code. No workflow,
  update or argument changes, and no `patched()` marker is needed.
- Pi children get neither notes nor memory. Routine firings open conversations like
  any other, so they get memory.
- `recoverPending` in `activities.ts` recovers a stopped Claude proposal without
  project context, so without memory too. In that mode the Claude worker reads the
  proposal its session already recorded and makes no model request, so the model is
  told nothing different. The turn that resumes after the decision launches with both.

**When a deletion takes effect depends on the engine.** The context is read at every
launch, but what reaches the model after a conversation's first turn depends on how
the engine's session keeps it:

| Engine | A deleted or suspended entry |
| --- | --- |
| Pi | is gone from the next launch of every conversation. Pi records each turn's system prompt in its checkpoint and replays it, then sends only the current prompt to a model that does not take mid-conversation system messages. Every model Crew's profiles configure is such a model (Go `glm-5.3-flash`, the proxy profile). The pi-ai catalog marks some current models as taking them; a Pi profile built on one would be sent the old prompt, deleted text included |
| Claude | may still reach conversations that have run a turn. Crew passes the system prompt to the Claude Agent SDK as a plain string, so the SDK's default applies: it records the prompt in the session transcript on the conversation's first request and sends that record on every later request and resume, until compaction. The SDK says this recording is rolling out by account and has no effect where it is off; with the fixture it records. The SDK's `{ type: "custom", prompt, snapshot: false }` would send the current prompt every time. This change does not use it, because it leaves the engine adapters as they were |
| Codex | still reaches conversations that have run a turn. Codex records `developer_instructions` as a developer message in the rollout on the first turn and replays it on resume; it does not record the new instructions |

`tests/proof/memories.mts` shows all three with the fixtures. To stop a Claude or
Codex member from seeing a deleted entry, delete it and let its started conversations
end; new ones will not see it.

## Trust boundary

Memory is a data path across conversations. Text the owner saves once reaches every
later conversation of the member, including conversations a routine opens with
nobody present.

- **Who writes.** Whoever holds the owner's bearer token. Crew cannot tell a person
  from an automated client holding it. A token holder can steer every later
  conversation of every member of that owner.
- **What the model gets.** System context. The header calls it reference data, and
  the JSON keeps each entry inside its frame, but a model can still follow
  instructions it finds in an entry. Treat an entry as you would the profile's own
  instructions.
- **Who reads it back.** The owner, through the API. Other owners never see it.
  Observers, request receipts, snapshots and the audit trail never carry entry text,
  unless the model quotes an entry in a reply. A reply is stored and published like
  any other.
- **Who else on the host can see it.** A Codex launch carries the whole context in
  its command line (see [below](#limits-and-context-size)). Any local user can read
  it from `/proc/<pid>/cmdline` while the turn runs, unless `/proc` is mounted with
  `hidepid`, and exec auditing such as auditd keeps a copy. Project notes had the same
  exposure before memory.
- **What it cannot do.** It cannot grant tools, approve calls or change a profile.
  Standing grants, approvals and limits work as before.

Memory changes what the model is told on every turn. Authentication and permission
changes need human review before merge (see the README).

## Limits and context size

Every UTF-8 byte of an entry's text costs at most two bytes in the block: `"`, `\`,
tab and newline become two bytes, U+2028 and U+2029 become six from three, other
control characters are refused, and other characters keep their own bytes. The
largest block is 32 entries of 1024 quote characters: 67,637 bytes, plus the newline
before it, so `injectedBytesPerConversation` is 67,638.

Each engine has its own ceiling on the whole system context, which holds any
instruction packs and instructions as well as notes and memory:

- Claude takes at most 262,144 UTF-16 code units of project context (`claude.ts`).
  A character outside the Basic Multilingual Plane counts as two.
- Codex gets the context as one `--config developer_instructions=<JSON string>`
  argument. The SDK escapes it a second time, so a quote costs four bytes. Linux
  refuses one argument of 131,072 bytes or more, counting its NUL.
- Pi gets the prompt in a frame on its worker's channel, where no argument limit applies.

The worst cases do not fit. The largest memory block takes 133,487 bytes as a Codex
argument. The largest project notes take 224,541 code units, which Claude takes alone,
but 292,179 with the largest memory block, which it does not. As a Codex argument the
largest notes alone take 262,001 bytes; that predates memory.

Notes and the memory set never grow after a conversation opens. So
`openConversation` composes the context the way each launch will, and refuses the
open with `409 memory_limit` when the notes alone fit the member's engine but notes
and memory together do not. Nothing is written. A member with
[instructions](member-instructions.md#limits-and-context-size) or
[instruction packs](instruction-packs.md#limits-and-context-size) counts them with the
notes: `memory_limit` then means notes and instructions fit without the memory. With 31 entries of 1024 quotes and no
notes, a Codex member opens: its argument is 129,321 bytes. To open with more, delete
entries. Notes too large on their own are not memory's doing: such a conversation
opens as it did before memory, and its first launch fails as it did then.

A create never checks this, because the notes an open will capture are not known
then. So a create can succeed and later opens of a Codex member be refused. A routine
firing whose open is refused fails with `rejected`, like any refused open, and ten
such failures in a row disable the routine (see
[scheduled routines](scheduled-routines.md#firings)).

The Codex SDK sets no limit of its own on `developer_instructions`; the argument limit
is the one Crew checks.

## What deletion erases, and what it does not

Deleting an entry sets its text to `NULL` in the same transaction as the
`memory.deleted` audit row. The row stays as a tombstone with its id, member and
times. Nothing in the API returns the text again.

Deletion does not reach copies made before it:

- conversations of Claude and Codex members that already ran a turn (see above);
- Claude session transcripts and Codex rollout files under `BIRBCREW_STATE_DIR`,
  which hold the system context of every conversation that ran a turn;
- Pi checkpoints, which record the system prompt each turn saw: `turns.checkpoint`,
  and the pending checkpoints an approval wait or a delegation saves,
  `paused_segments.checkpoint` and `delegations.parent_checkpoint`. Crew's Pi models
  send only the current prompt, so the model does not get it again, but the
  checkpoints keep it;
- Codex command lines while a turn runs, and any exec audit log that recorded them;
- replies, Temporal histories and published events that quote an entry;
- PostgreSQL's old row versions until `VACUUM` removes them, WAL segments until they
  are recycled, and base backups and archived WAL;
- recovery generations: their database dump and their native volumes;
- copies a consumer or an export holder made.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `memory.created` | owner | a create inserts an entry | entry | `memoryId` |
| `memory.deleted` | owner | an entry is deleted | entry | `memoryId` |
| `memory.suspended` | system | a restored installation resumes | entry | `memoryId`, `reason` (`recovery_restore`) |

These rows name the member and belong to no conversation or request. They hold no
text and no digest of it. An unsalted digest of deletable text, kept in an
append-only table, would let anyone holding an export confirm a guess of what was
deleted.

## Recovery

Both tables carry the `recovery_write_barrier` trigger, so a held installation
refuses creates, deletes and opens, and recovery capture counts both tables.

A restore rewinds `member_memories` to the recovery point. That brings back entries
the owner deleted after it, with their text. So when a restored installation resumes,
Crew suspends every active entry and records `memory.suspended` for each, in the
transaction that makes the installation active, after it revokes standing grants. A
crash leaves neither, and a retried `resume` repeats it. A held source that resumes
without a restore keeps its entries.

A suspended entry reaches no later launch. It cannot be made active again. The owner
can read it, then delete it and create it again if it should still apply. A
suspension, like a deletion, does not reach restored Codex conversations that had run
a turn, nor Claude ones whose session recorded its prompt (see
[above](#what-a-conversation-sees)). The restored native volumes keep their files.

## Upgrade

Migration 26 creates the two tables, replaces `audit_events_type_check` with a
`NOT VALID` constraint that lists every type, and adds one partial unique index on
`audit_events`. Existing rows are neither rewritten nor checked. Until `migrate()`
commits it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17) | Why |
| --- | --- | --- |
| `members` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the entries' foreign key |
| `conversations` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the references' foreign key |
| `audit_events` | `ACCESS EXCLUSIVE`, `SHARE` | the CHECK and the index build |

It takes the three with `LOCK ... NOWAIT` together and retries every 20 to 100 ms, as
migration 25 does, so it never waits in a lock queue. A running native turn's
admission transaction holds only `ACCESS SHARE` on `members` and `conversations`, so
the migration does not wait for it. An open in flight holds `conversations` until it
commits, and the migration waits for that without holding anything. After 60 s
without the locks it fails with `55P03`, applies nothing, and the process exits.

From version 24, `migrate()` applies 25 and 26 in one transaction. Migration 26 then
retries while holding 25's `ACCESS EXCLUSIVE` locks on `request_admissions` and
`audit_events`, so every admission and audited write in the installation waits for it.
An open that started before the upgrade holds `conversations` and must append its
audit row before it can commit, so it can never let 26 in: 26 fails after 60 s with
`55P03`, applies nothing, and the process exits. Stop every process of the previous
release first, as for every migration (see
[persistent deployment](persistent-deployment.md#upgrades)); then no open is in
flight. The retry stays rather than one attempt, so that a short autovacuum or
`ANALYZE` of `conversations` does not fail the upgrade.

Conversations opened before the upgrade have no references and get no memory.

## Not covered

- Model writes, a memory tool, search or recall by relevance.
- Memory for every member of an owner, sharing between owners or members.
- Editing an entry, re-activating a suspended one.
- The trusted-context lane and Pi children.
- Removing a deleted entry from Claude and Codex conversations that already ran a
  turn, or from native session files and Pi checkpoints. For Claude, the SDK's
  `snapshot: false` option is the obvious next step; it needs its own change to the
  Claude worker and a proof for sessions recorded before it.
- Holding every Pi profile to a model without mid-conversation system messages.
- Keeping the context out of the Codex command line.
- A routine firing reason that tells a memory refusal from other refused opens.
- Bidirectional or invisible Unicode characters are not refused; only control
  characters are.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump`/`pg_restore`.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:memories
npm run test:recovery
```

`memories.test.ts` checks strict bodies and queries; the byte limit with ASCII and
two-, three- and four-byte characters; refused control characters, lone surrogates
and bytes that are not UTF-8; idempotent creates and concurrent duplicates; the limit
of 32 under 40 concurrent creates, a replay at the limit, and an uncommitted 32nd
entry queueing another create on the member's lock until it fails; `404` for another
owner on every route; tombstones, their triggers and a replayed suspended entry; the
snapshot's order, later entries left out, deletions and suspensions dropped at the
next read, and no new snapshot on reopen; an open during an uncommitted delete, which
neither waits nor fails; references to another member's or owner's entry refused in
SQL; hostile text, including U+2028 and U+2029, that stays inside its frame and
round-trips; no text in audit JSON or CSV; the worst-case sizes above, Linux's
argument limit, opens refused when memory would push the context past the engine,
and opens allowed when the notes alone are too large; migration 26's locks, that it
never queues and does not wait for a native turn; and an upgrade from version 25.

`recovery.test.ts` checks that capture counts both tables, that a held installation
refuses every memory write, and that a restored installation suspends every active
entry as it resumes, while a delete holding its row when the resume starts fails on
the hold instead of deadlocking the resume.

The service proof needs Docker, Linux, Landlock and Temporal CLI 1.10.0:

```sh
npm run test:memories:service
```

It runs the real gateway, Temporal worker and fixture providers, and reads which
markers reached each provider request: the Pi behavior above, including a turn resumed
by a new worker after its worker was killed while the turn waited on its approval card;
the Claude and Codex behavior after a deletion; the Pi checkpoints that keep deleted
text; and no text in public events, snapshots, receipts or the audit trail.

Not claimed: no live provider. The proof's Pi checks use the fixture's view of the
current system prompt, which is what Crew's Pi models are sent.
