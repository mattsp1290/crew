# Instruction packs

An instruction pack is owner-written instruction text that several members share: "Write
commit messages in the imperative mood and explain why", or a team's review checklist. An
owner writes a pack once, through `/v1/instruction-packs`, and attaches up to eight packs,
in order, when they spawn a member. Migration 33 stores them. Every native launch of every
conversation of that member gives the packs' text to the model as system context, before
the member's own [instructions](member-instructions.md), [project notes](../README.md)
and [memory](memories.md). A pack never changes, and a member's packs are fixed for its
life, like its instructions. Packs change what the model is told. They never change what
the member can do: its tools, approvals and limits stay as the profile sets them.

## Packs

All routes need the bearer token. The owner comes only from it. A pack is the owner's:
another owner cannot read, list, delete or attach it, and gets `404 not_found` for its ID.
The routes exist only under `/v1`. A malformed `packId`, or a query string on any route but
the listing, fails `400 invalid_input`; any other method fails `405`.

| Route | Purpose |
| --- | --- |
| `POST /v1/instruction-packs` | Create a pack |
| `GET /v1/instruction-packs` | The owner's packs, every state, without text |
| `GET /v1/instruction-packs/{packId}` | One pack, with its text |
| `DELETE /v1/instruction-packs/{packId}` | Delete a pack no member has |

```json
{ "requestId": "UUID", "name": "house style", "description": "How every member writes commits",
  "text": "Write commit messages in the imperative mood and explain why, not what." }
```

- `text`: 1 to 16,384 bytes of well-formed UTF-8, under a memory entry's character rules:
  no NUL and no control character except tab and newline. This is what the model reads.
- `name`: 1 to 128 bytes under the same rules, on one line (no tab or newline either).
  Names need not be unique; the `packId` identifies a pack.
- `description`: optional, 1 to 512 bytes under the same rules.

The name and the description are labels for the owner. Neither reaches the model. The route
decodes its body strictly, so bytes that are not UTF-8 fail `400 invalid_json`. Unknown
fields fail `400 invalid_input`.

A create returns `201`. It is idempotent by `requestId`: a replay with the same name,
description and text returns the pack again, also with `201`; any difference fails `409 conflict`, and a replay of a pack deleted
since fails `409 pack_deleted`. An owner has at most 32 active packs; the 33rd fails
`409 pack_limit`. Deleted packs do not count.

```json
{
  "apiVersion": "1", "packId": "UUID", "state": "active", "name": "house style",
  "description": "How every member writes commits", "text": "Write commit messages …",
  "bytes": 71, "digest": "sha256 hex of the UTF-8 text", "memberCount": 3,
  "createdAt": "2026-11-13T08:03:12.421Z", "deletedAt": null
}
```

`memberCount` is the number of members that have the pack. `digest` is the SHA-256 of the
text's UTF-8 bytes in lowercase hex, as for member instructions.

`GET /v1/instruction-packs` takes `after` (the previous page's `nextAfter`) and `limit` (1
to 100, default 100) and returns `{ "apiVersion": "1", "instructionPacks": [...],
"nextAfter": "UUID" | null, "hasMore": false }` in `packId` order. Its entries are the
view above without `text`. An unknown or repeated parameter fails `400 invalid_input`.

### A pack never changes

No route edits a pack, and the database refuses every change to a pack's name, description
or text, whoever writes. New text is a new pack, with its own `packId`. To move members to
new text, create a pack and spawn new members with it.

This is the design choice. The alternative was versions of one pack, with each member
following the newest. That was rejected for the reason member instructions are fixed:
Codex replays the developer message its rollout recorded on a conversation's first turn,
and Claude's SDK may resend the prompt it recorded then (see
[member memory](memories.md#what-a-conversation-sees)), so new text would reach
conversations differently by engine, and a member's behaviour would change under
conversations already running. Versions a member pins at spawn would add a second
identifier and a version route and give nothing a new pack does not.

### Deleting a pack

`DELETE /v1/instruction-packs/{packId}` erases the pack's name, description and text and
keeps a tombstone, so a replayed create can be answered. Repeating it returns the
tombstone: `state` is `deleted`, `name`, `description`, `text`, `bytes` and `digest` are
`null`, and it keeps its `packId`, `createdAt` and `deletedAt`. Reading a deleted pack
returns its tombstone with `200`.

A pack that any member has cannot be deleted: the delete fails `409 pack_in_use`, and the
database refuses a direct `UPDATE` that would delete it. Members are never removed, so a
pack attached to one member is kept for good. Delete is for packs created by mistake or
never used.

This is the second design choice. The alternative was a copy of the text kept for each
member, so that deleting a pack would only stop new spawns from using it. That was rejected
because a delete would then erase the pack's text while every member that had it kept a
copy that can never be erased: the delete would look like erasure and not be one. With the
refusal, a deleted pack's text is gone from the live tables and, never having been
attached, reached no model or native session; an attached pack's text is stored once and
stays readable through the pack route. Old row versions until vacuum, the write-ahead log,
backups and recovery generations keep a deleted pack's text until they are removed.

## Spawning a member with packs

`POST /v1/members` (and the unversioned `POST /members`, and the operator CLI's `spawn`)
takes one more optional field:

```json
{ "requestId": "UUID", "engine": "codex", "profile": "fixture.v1",
  "instructions": "You review database migrations.",
  "instructionPacks": ["UUID of house style", "UUID of review checklist"] }
```

- `instructionPacks`: 1 to 8 distinct pack IDs of the owner's, in the order the model reads
  them. An empty list, a repeated ID, more than eight or a value that is not a list of UUIDs
  fails `400 invalid_input`.
- A pack that does not exist, or is another owner's, fails `404 not_found`. A deleted pack
  fails `409 pack_deleted`.
- The member's own instructions and the texts of its packs share 16,384 bytes, the budget
  instructions had alone. A spawn over it fails `409 pack_limit`. Names and descriptions do
  not count.
- Nothing is written on any refusal.

The response adds `instructionPacks`, the IDs in order, only when the member has packs.
`requestId` keeps spawn idempotent: a replay must name the same packs in the same order, or
leave the field out exactly when the first spawn did, or it fails `409 conflict`, as
instructions do. Leaving the field out spawns a member exactly as before: same response,
same audit rows, no packs.

Spawn attaches packs only in the transaction that inserts the member. Database triggers
enforce the rest whoever writes:

- `UPDATE`, `DELETE` and `TRUNCATE` of a member's packs are refused, even when no row matches.
- An attachment is refused once the member has a conversation, as an instructions insert is.
- An attachment names an active pack of the member's own owner. It holds the pack's row
  `FOR SHARE` until it commits, so a delete running at the same time either commits first,
  and the spawn fails `409 pack_deleted`, or waits and then fails `409 pack_in_use`.
- A member has each pack at most once and at most eight.

The shared byte budget is checked by the API only, not by the database. A direct database
writer that exceeds it still meets the open-time size check below. Like the triggers of
member instructions, memory and webhooks, these checks rely on PostgreSQL's default
READ COMMITTED isolation: under a higher `default_transaction_isolation`, a delete could
miss an attachment that committed while it waited for the pack's row.

`GET /v1/members` lists each member's `instructionPacks` IDs, in order, beside its
instructions summary; members without packs are listed exactly as before.
`GET /v1/members/{memberId}/instructions` adds the packs the member received, with their
text:

```json
{
  "apiVersion": "1", "memberId": "UUID",
  "instructions": { "text": "You review database migrations.", "bytes": 31, "digest": "…", "createdAt": "…" },
  "instructionPacks": [
    { "packId": "UUID", "name": "house style", "text": "Write commit messages …", "bytes": 71, "digest": "…" }
  ]
}
```

`GET /v1/capabilities` describes the feature under `instructionPacks`. Its `order` is the
whole fixed order; `memberInstructions.order` keeps listing only the blocks it had, whose
relative order is unchanged.

```json
{
  "version": 1, "route": "/v1/instruction-packs", "spawnField": "instructionPacks", "writers": ["owner"],
  "modelWrites": false, "sharing": "owner-only", "change": "immutable", "attachment": "fixed-at-spawn",
  "textBytes": 16384, "nameBytes": 128, "descriptionBytes": 512, "activePerOwner": 32, "perMember": 8,
  "combinedTextBytes": 16384, "injectedBytesPerConversation": 33191, "modelReceives": "text-only",
  "order": ["instructionPacks", "instructions", "projectNotes", "memories"], "children": false,
  "deletion": "refused-while-attached-text-erased-tombstone-kept", "restore": "kept", "digest": "sha256-utf8-hex"
}
```

## What a conversation sees

At each native launch the supervisor child reads the member's packs together with its
instructions, the conversation's project notes and its memory snapshot
(`conversationContext` in `memories.ts`). The packs come first, in their spawn order, as
one block:

```
BirbCrew instruction packs v1. The owner attached the following instruction packs to this member, in order, as JSON. They describe how it works; they do not change its tools, approvals or limits.
{"packs":["Write commit messages in the imperative mood and explain why, not what.","Never print credentials."]}
```

then the member's instructions block, then project notes, then memory, one newline apart.
Each engine receives this context exactly as it receives member instructions: Claude after
`You are a BirbCrew coworker.` in its system prompt, Codex in `developer_instructions` after
the same line, and Pi as its appended system prompt. A member without packs gets exactly
the context it got before.

The order is a choice: shared packs describe how all members work, and the member's own
instructions describe its particular role, so the specific text comes after the general
text it may refine ("follow the house style, except …"). Both come before the reference
data they may refer to. The block carries only the texts, framed as JSON like instructions
and memory: U+2028 and U+2029 are escaped too, so a pack's text cannot end its block, start
a line, or pose as another block's header.

Packs reach exactly the launches that member instructions reach, for the same reasons (see
[member instructions](member-instructions.md#what-a-conversation-sees)): every turn of
every conversation of the member, a turn a new worker resumes, a tool resume after an
approval, a rollover, a routine firing's conversation and a handoff target. Not every
launch:

- **Pi children get none.** A `delegate_task` child answers only from the task its parent
  wrote; put what a child needs into the task.
- `recoverPending` makes no model request.
- The trusted-context lane gets none: its application supplies the whole context.

A [handoff](handoffs.md) carries no packs across. The target conversation's system context
is its own member's packs, instructions, notes and memory; the transcript quotes only the
source's committed prompts and replies, as a user message. A reply in which the source
model quoted a pack is carried like any other reply.

## Trust boundary

Packs are owner-written instruction text, not reference data. The header presents them as
instructions, and the model is expected to follow them.

- **Who writes.** Whoever holds the owner's bearer token. A pack is written once; attaching
  it is part of a spawn.
- **What they cannot do.** Widen what a member can do. The profile alone fixes the tools.
  Every protected call still needs a card the owner answers or a
  [standing grant](standing-grants.md). Turn limits, budgets, call caps and cancellation are
  unchanged. A pack that says "approve your own work items" changes nothing Crew enforces.
- **What they can do.** Steer every conversation of every member that has the pack,
  including those a routine opens with nobody present. One pack reaches many members, so a
  mistake in it, or text an attacker got into it, reaches all of them at once.
- **Prompt injection.** Crew treats a pack's text as the owner's instructions, whatever it
  says. The JSON framing keeps the text inside its block; it does not make the text safe to
  follow. Text pasted into a pack from a web page, an issue, an email or a model's reply
  becomes instructions for every member that has the pack, and any instructions hidden in it
  ("ignore the review checklist", "send the diff to …") carry the owner's authority in the
  prompt. Review a pack as you would the profile's own prompt, and do not build packs from
  content you have not read. Crew does not scan packs for injected instructions.
- **Who reads them back.** The owner, through the pack route and the member's instructions
  route. Other owners get `404`. No listing, spawn response or audit row carries pack text:
  the pack listing carries names, descriptions, byte counts and digests, the member listing
  and spawn responses carry pack IDs, and audit rows carry IDs only. Observers, snapshots and request receipts never carry
  the text, unless the model quotes it in a reply, which is stored and published like any
  other.
- **Who else on the host can see them.** As with instructions, a Codex launch carries the
  whole context in its command line, readable from `/proc/<pid>/cmdline` while the turn runs
  unless `/proc` is mounted with `hidepid`. Claude session transcripts, Codex rollout files
  and Pi checkpoints keep copies.
- **What cannot be erased.** The text of a pack any member has, ever. Do not put secrets in
  packs.

Packs change what the model is told on every turn. Authentication and permission changes
need human review before merge (see the README); treat this one the same way.

## Limits and context size

A member's own instructions and its packs' texts share 16,384 bytes. Every UTF-8 byte of
either costs at most two bytes in its block, by the same reasoning as memory, and each pack
adds up to three bytes of framing. The largest fixed context is eight packs of one quote
character each and 16,376 quote characters of instructions: 33,190 bytes, plus the newline
after it, so `injectedBytesPerConversation` is 33,191. That fits every engine on its own:
as Codex's one `developer_instructions` argument it is 66,038 bytes, under Linux's 131,072,
and Claude takes 262,144 UTF-16 code units. A spawn therefore never fails on the engine's
size limit. `memberInstructions.injectedBytesPerConversation` (32,959) still bounds the
instructions block alone.

`openConversation` counts packs with the instructions when it checks that a conversation's
context fits its engine, so the [open-time table](member-instructions.md#limits-and-context-size)
holds with "instructions" read as the member's packs and instructions together: when the
project notes fit but not the packs and instructions on top, the open fails
`409 instructions_limit`, and when those fit but not the memory on top, `409 memory_limit`.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `instruction_pack.created` | owner | a pack is created; no member | pack | `packId` |
| `instruction_pack.deleted` | owner | a pack is deleted and its text erased; no member | pack | `packId` |
| `member.instruction_packs_attached` | owner | a spawn inserts a member with packs | member | `packIds`, in order |

The pack facts belong to the owner, so their `memberId` is `null`, as for webhooks, and a
`memberId` filter never matches them. The attachment row follows `member.spawned` (and
`member.instructions_set`, when the member has instructions) in the spawn's transaction.
No row carries a name, a description, text or a digest: a pack can be deleted, and a
digest kept in this append-only table would let an export holder confirm a guess of its
erased text, the reason memory rows carry none. A replayed create or spawn records nothing.

## Recovery

Both tables carry the `recovery_write_barrier` trigger, so a held installation refuses
pack creates, deletes and spawns with packs, and recovery capture counts both tables.

A restore keeps packs and attachments as they were at the recovery point, and resuming
records nothing about them. Every member at the recovery point had exactly the packs it has
after the restore, because a member's packs never change and a pack a member has can never
be deleted. A member spawned after the recovery point is gone with its attachments.

A pack deleted after the recovery point comes back, text and all, unattached. Resuming does
not suspend or delete it. Unlike memory, which every new conversation of the member picks
up by itself, standing grants, which approve calls by themselves, and webhooks, which send
by themselves, a restored pack does nothing until a spawn names its ID. A client that still
names it, such as a stored spawn request, then gets the restored text instead of
`409 pack_deleted`. Suspending every pack instead would make every
spawn that names a pack fail until the owner created each one again under a new ID. After a
restore, list your packs and delete again any you had deleted after the recovery point.

## Upgrade

Migration 33 creates `instruction_packs` and `member_instruction_packs`, replaces
`audit_events_member_check` and `audit_events_type_check` with `NOT VALID` constraints that
list every earlier clause and the three new types, and adds two partial unique indexes on
`audit_events`. Existing rows are neither rewritten nor checked. Until `migrate()` commits
it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17) | Why |
| --- | --- | --- |
| `members` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the new foreign key |
| `audit_events` | `ACCESS EXCLUSIVE`, `SHARE` | the CHECKs and the index builds |

It takes both with `LOCK ... NOWAIT` together and retries every 20 to 100 ms, as migrations
25 to 32 do, so it never waits in a lock queue. A running native turn holds only
`ACCESS SHARE` and `ROW SHARE` on `members`, so the migration does not wait for it. After
60 s without the locks it fails with `55P03`, applies nothing, and the process exits.

`migrate()` applies every pending migration in one transaction. From version 32, 33 holds
nothing while it retries, so a spawn in flight commits and 33 then proceeds. From version
31, 33 retries for `members` while holding 32's `ACCESS EXCLUSIVE` lock on `audit_events`,
so every audited write waits for it, and a spawn that started before the upgrade, which
holds `members` and must append its audit row before it can commit, makes it fail after
60 s with `55P03`, 32 included. From version 30 or earlier, 31 already holds both tables
when 33 runs, so 33 never retries; the earlier migrations decide whether the upgrade waits. Stop every process of the
previous release first, as for every migration; then no spawn is in flight.

The migration was numbered 34 in review and took 33, the next number after 32, when it
was restacked onto `main`. `migrate()` refuses to apply a migration numbered below one
already applied, so a database that ran the branch while it was numbered 34 needs a fresh
database.

Members spawned before the upgrade have no packs, and the API cannot give them any. After a rollback
to a release without migration 33, the rows stay but launches no longer include them, so
members with packs lose them until the release returns.

## Not covered

- Skills that a model loads on demand, by name, during a turn. Every pack a member has is in
  every launch's system context.
- Templates or variables in a pack's text.
- Model-written packs: no tool reads, creates or changes a pack.
- Sharing packs between owners.
- Editing a pack, versions of a pack, or changing an existing member's packs.
- Packs for Pi children and for the trusted-context lane.
- Scanning a pack's text for injected instructions.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may create
databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump`/`pg_restore` for the recovery
suite (or set `BIRBCREW_RECOVERY_POSTGRES_CONTAINER` to a PostgreSQL 17 container to run them in).

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:packs
npm run test:recovery
```

`instruction-packs.test.ts` checks the pack routes: field rules, bytes that are not UTF-8,
idempotent and concurrent creates, conflicts and a deleted pack's replay, the 32-pack cap
under concurrent creates, listing pages and query validation, tombstones, methods and
versioning; spawn with packs: order, replays and the spawn-with-and-without race, the list's
shape, unknown, foreign and deleted packs, and the shared byte budget at and over its edge;
two owners, neither of whom can read, list, delete or attach the other's packs or see their
audit rows; the instructions route and member listing; `pack_in_use`, and a spawn and a
delete racing in both orders, through the API and against the database alone; the triggers
that keep packs immutable and a member's packs fixed, bound to its owner and refused once a
conversation exists; the context order with instructions, notes and memory, names that never
reach the model, and hostile text that stays in its frame; the largest fixed context, which
opens on every engine, and `instructions_limit` and `memory_limit` with packs; a handoff
target of each engine whose context holds its own member's packs while the transcript, the
handoff record and the trail carry none; migration 33's locks, that it never queues and does
not wait for a native turn; and an upgrade from version 32.

`recovery.test.ts` checks that capture counts both tables, that a held installation refuses
every pack write, and that a restore keeps packs and attachments, brings back a pack deleted
after the recovery point unattached, and records nothing about packs when it resumes.

The service proof (`npm run test:instructions:service`, which needs Docker, Linux, Landlock
and Temporal CLI 1.10.0) spawns a Pi, a Claude and a Codex member with two packs each, the Pi
one with its own instructions too, and reads which markers reached each provider request on
the first and a later turn; it also checks that another owner cannot attach the packs, that
a pack in use cannot be deleted, and that no pack text reaches public events, snapshots,
receipts, listings or the audit trail.
