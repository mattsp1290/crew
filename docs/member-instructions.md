# Member instructions

An owner can give a member a role when they spawn it: "You review database migrations
and never propose schema changes yourself." Migration 29 stores the text. Every native
launch of every conversation of that member gives it to the model as system context,
before any [project notes](../README.md) and [member memory](memories.md). The text is
fixed for the life of the member, like its engine and profile. Instructions change what
the model is told. They never change what the member can do: its tools, approvals and
limits stay as the profile sets them.

## Contract

`POST /v1/members` (and the unversioned `POST /members`, and the operator CLI's
`spawn`) takes one more optional field:

```json
{ "requestId": "UUID", "engine": "pi", "profile": "fixture.v1",
  "instructions": "You review database migrations and never propose schema changes yourself." }
```

- `instructions`: 1 to 16,384 bytes of well-formed UTF-8, under the same character
  rules as a memory entry. No NUL and no control character except tab and newline.
  Carriage return, escape, DEL and the C1 range are refused, and so are `null`, an
  empty string and any value that is not a string. The HTTP spawn routes now decode
  their body strictly, as the memory route does, so bytes that are not UTF-8 fail
  `400 invalid_json` instead of becoming U+FFFD. This is the one change a client
  written before this feature can see: a body with malformed UTF-8 used to fail later,
  usually `409 unknown_profile`. The operator CLI still reads its input as before, so
  malformed bytes there become U+FFFD.
- Leaving the field out spawns a member exactly as before: same response, same audit
  row, no instructions.

The response adds `instructions` only when the member has them:

```json
{ "ownerId": "owner", "memberId": "UUID", "engine": "pi", "profile": "fixture.v1",
  "instructions": { "bytes": 73, "digest": "sha256 hex of the UTF-8 text" } }
```

`requestId` keeps spawn idempotent. A replay must repeat the instructions exactly, or
leave them out exactly when the first spawn did. Other text, added text or missing
text with the same `requestId` fails `409 conflict`, as another engine or profile
does.

### Fixed for the life of the member

Instructions are written only in the transaction that inserts the member. No route
replaces or deletes them. To give a role different text, spawn another member. Database
triggers enforce this whoever writes:

- `UPDATE`, `DELETE` and `TRUNCATE` of `member_instructions` are refused, even when no
  row matches.
- A member has at most one row: the member ID is the primary key.
- An insert is refused once the member has a conversation. The insert takes the member
  row `FOR UPDATE`, which waits for any open in flight and makes later opens wait for it,
  so every conversation sees the same instructions, or none, from its first launch on.
- A foreign key to `members (owner_id, member_id)` binds the row to its owner.

This is the design choice. The alternative was a route that replaces the text, with
each conversation keeping a snapshot of the revision it opened with, as memory does.
That was rejected for three reasons. Codex replays the developer message its rollout
recorded on a conversation's first turn, and Claude's SDK may resend the prompt it
recorded then (see [member memory](memories.md#what-a-conversation-sees)), so a
replacement would reach conversations differently by engine. A restore could bring back
text the owner had replaced. And a fixed role keeps a conversation's behaviour the same
across turns, worker replacement, rollover and restore with no snapshot table at all.
The cost: grants, memory and routines stay with the old member when you spawn a new one,
and the text can never be erased.

## Routes

All routes need the bearer token. The owner comes only from it.

| Route | Purpose |
| --- | --- |
| `POST /v1/members` | Spawn, with optional `instructions` |
| `GET /v1/members/{memberId}/instructions` | The text, its byte count, its digest and when it was set; a member with [instruction packs](instruction-packs.md) also carries `instructionPacks` |
| `GET /v1/members` | Each member with instructions carries `instructions: { bytes, digest }`, and each with packs `instructionPacks` |

```json
{
  "apiVersion": "1", "memberId": "UUID",
  "instructions": { "text": "You review database migrations and never propose schema changes yourself.",
    "bytes": 73, "digest": "…", "createdAt": "2026-11-12T08:03:12.421Z" }
}
```

`instructions` is `null` for a member without them. Another owner's member, or one that
does not exist, is `404 not_found`. A malformed ID or any query parameter fails
`400 invalid_input`; any method but `GET` fails `405`. The route exists only under
`/v1`.

`digest` is the SHA-256 of the text's UTF-8 bytes in lowercase hex, so an owner can check
which text a member has against their own copy without fetching it. The listing carries
no text; members without instructions are listed exactly as before.

`GET /v1/capabilities` describes the feature under `memberInstructions`:

```json
{
  "version": 1, "spawnField": "instructions", "route": "/v1/members/{memberId}/instructions",
  "writers": ["owner"], "modelWrites": false, "change": "fixed-at-spawn", "textBytes": 16384,
  "injectedBytesPerConversation": 32959, "order": ["instructions", "projectNotes", "memories"],
  "children": false, "restore": "kept", "digest": "sha256-utf8-hex"
}
```

## What a conversation sees

At each native launch the supervisor child reads the member's instructions together with
the conversation's project notes and memory snapshot (`conversationContext` in
`memories.ts`). It puts the instructions first:

```
BirbCrew member instructions v1. The owner gave this member the following instructions as JSON. They describe its role; they do not change its tools, approvals or limits.
{"instructions":"You review database migrations and never propose schema changes yourself."}
```

then the project notes, then memory, one newline apart. A member spawned with
[instruction packs](instruction-packs.md) gets their block first, before its instructions:
the shared text before the member's own. Claude receives the whole
context after `You are a BirbCrew coworker.` in its system prompt, Codex in
`developer_instructions` after the same line, and Pi as its appended system prompt,
after the profile's own instructions or that line. A member without instructions gets
exactly the context it got before.

The order is a choice: the owner's description of the role comes before the reference
data it may refer to, and a block that never changes leads the prompt. The rejected
order, instructions after notes and memory, would put the role after data the model is
told to treat as reference.

The instructions are owner-authored, so the header presents them as instructions, not
as reference data. They are still framed like memory: the JSON keeps the text in one
string, and U+2028 and U+2029 are escaped as well, so the text cannot end its block,
start a line, or pose as another block's header.

The read happens in the supervisor child, never in workflow code, so every native
launch gets the instructions: a conversation's first turn, later turns, a turn a new
worker resumes after its worker died, a tool resume after an approval, a rollover, the
conversations routine firings open, and the target of a [handoff](handoffs.md), which
opens like any other conversation of its member. No workflow, update or argument
changes, and no `patched()` marker is needed. Because the text never changes, what
Claude and Codex recorded on a conversation's first turn is what every later launch
sends.

Not every launch:

- **Pi children get none.** A `delegate_task` child runs with the fixed role prompt its
  delegation recorded and answers only from the task its parent wrote, as with notes
  and memory. The parent, which has the instructions, decides what to delegate and what
  to do with the result. Put what a child needs into the task. The alternative, giving
  children the parent's instructions, would change the recorded child profiles and let
  a role meant for the parent steer a helper whose prompt says to use only its task.
- `recoverPending` recovers a stopped Claude proposal without context; it makes no model
  request. The turn that resumes after the decision launches with the instructions.
- The trusted-context lane gets none: its application supplies the whole context.

A handoff carries no instructions across. Its transcript quotes only the source's
committed prompts and replies and reaches the target as its first user message, never
as system context; the target's system context is its own member's instructions, notes
and memory. The handoff record and its `conversation.handed_off` audit row hold
identifiers, counts and a digest. A reply in which the source model quoted its
instructions is carried like any other reply.

## Trust boundary

- **Who writes.** Whoever holds the owner's bearer token, once per member, at spawn.
- **What they cannot do.** Widen what the member can do. The profile alone fixes the
  tools. Every protected call still needs a card the owner answers or a
  [standing grant](standing-grants.md). Turn limits, budgets, call caps and
  cancellation are unchanged. An instruction such as "approve your own work items" or
  "you may run shell commands" changes nothing Crew enforces; the header tells the model
  so, but the guarantee comes from the code, not the header.
- **What they can do.** Steer every conversation of the member, including those a
  routine opens with nobody present. A model can follow the instructions in what it
  proposes and says. Review them as you would the profile's own prompt.
- **Who reads them back.** The owner, through the instructions route. Other owners get
  `404`. Listings, spawn responses and the audit trail carry only the digest and byte
  count. Observers, snapshots and request receipts never carry the text, unless the
  model quotes it in a reply, which is stored and published like any other.
- **Who else on the host can see them.** As with notes and memory, a Codex launch
  carries the whole context in its command line, readable from `/proc/<pid>/cmdline`
  while the turn runs unless `/proc` is mounted with `hidepid`, and kept by exec
  auditing such as auditd. Claude session transcripts, Codex rollout files under
  `BIRBCREW_STATE_DIR` and Pi checkpoints keep copies.
- **What cannot be erased.** The text, ever. Do not put secrets in instructions.

Instructions change what the model is told on every turn. Authentication and permission
changes need human review before merge (see the README); treat this one the same way.

## Limits and context size

Every UTF-8 byte of the text costs at most two bytes in the block, by the same reasoning
as memory: `"`, `\`, tab and newline become two bytes, U+2028 and U+2029 become six from
three, and other characters keep their own bytes. The largest block is 16,384 quote
characters: 32,958 bytes, plus the newline after it, so `injectedBytesPerConversation`
is 32,959. That block fits every engine on its own: Claude takes 262,144 UTF-16 code
units, and as Codex's one `developer_instructions` argument it is 65,786 bytes, under
Linux's 131,072. A spawn therefore never fails on size.

Instructions, notes and the memory snapshot never grow after a conversation opens, so
`openConversation` composes the context the way each launch will and refuses the open,
writing nothing, when it would not fit the member's engine:

| The member's engine can carry | Result |
| --- | --- |
| everything | the conversation opens |
| not the project notes alone | it opens as it did before memory and instructions existed, and its first launch fails as it did then |
| the notes and the instructions, but not the memory on top | `409 memory_limit` |
| the notes, but not the instructions on top | `409 instructions_limit` |

For a member without instructions this is the memory rule unchanged. A member's
[instruction packs](instruction-packs.md#limits-and-context-size) count with its
instructions here, so packs too large to sit beside the notes also fail `instructions_limit`. With instructions,
`memory_limit` means deleting entries helps; `instructions_limit` means the project notes
leave no room for this member's instructions, and only shorter notes or a member with
shorter instructions, or fewer or shorter packs, will open. On Codex, the largest instructions with 17 full memory
entries are refused with `memory_limit`, though either alone fits. On Claude, the largest
instructions fit beside the largest notes capture allows (257,500 code units) and three
full memory entries more do not. A routine firing whose open is refused fails with
`rejected`, like any refused open. A [handoff](handoffs.md) to the member opens its
target the same way, so it fails with the same code and writes nothing.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `member.instructions_set` | owner | a spawn inserts a member with instructions | member | `digest`, `bytes` |

It follows `member.spawned` in the same transaction, belongs to no conversation or
request, and never holds the text. Memory audits no digest because its text can be
erased, and a digest kept in an append-only table would let an export holder confirm a
guess of deleted text. Instructions are never erased, so the digest confirms only text
Crew keeps anyway, as `promptDigest` does for prompts. A replayed spawn records nothing.

## Recovery

The table carries the `recovery_write_barrier` trigger, so a held installation refuses
spawns with instructions and direct inserts, and recovery capture counts the table.

A restore keeps instructions as they were at the recovery point, and resuming records
nothing about them. Nothing an owner removed can come back, because nothing can be
removed: a member that existed at the recovery point had exactly that text, and a member
spawned after it is gone with its instructions. Memory is suspended on restore because
deleted text comes back, and grants are revoked because revoked grants come back;
neither applies here. Suspending instructions would instead change what each restored
member is, with no route to set them again, while its restored Claude and Codex sessions
kept the text anyway.

## Upgrade

Migration 29 creates `member_instructions`, replaces `audit_events_type_check` with a
`NOT VALID` constraint that lists every type, and adds one partial unique index on
`audit_events`. Existing rows are neither rewritten nor checked. Until `migrate()`
commits it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17) | Why |
| --- | --- | --- |
| `members` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the new foreign key |
| `audit_events` | `ACCESS EXCLUSIVE`, `SHARE` | the CHECK and the index build |

It takes both with `LOCK ... NOWAIT` together and retries every 20 to 100 ms, as
migrations 25 to 28 do, so it never waits in a lock queue. A running native turn holds
only `ACCESS SHARE` on `members`, so the migration does not wait for it. After 60 s
without the locks it fails with `55P03`, applies nothing, and the process exits. Stop
every process of the previous release first, as for every migration.

`migrate()` applies every pending migration in one transaction. From version 26 or
earlier, 27 already holds both locks 29 needs, so 29 never retries. From version 27,
29 retries for `members` while holding 28's `ACCESS EXCLUSIVE` locks, including the one
on `audit_events`, so every admission and audited write waits for it. A spawn that
started before the upgrade holds `members` and must append its audit row before it can
commit, so it can never let 29 in: the upgrade fails after 60 s with `55P03`, 28
included, and applies nothing. With the previous release stopped first, no spawn is in
flight.

Members spawned before the upgrade have no instructions and cannot be given any. After a
rollback to a release without migration 29, the rows stay but launches no longer include
them, so members with instructions lose their role until the release returns.

## Not covered

- Replacing, editing or erasing instructions; per-conversation instructions.
- Skills, templates or variables. Instruction text shared by several members is an
  [instruction pack](instruction-packs.md).
- Instructions for Pi children and for the trusted-context lane.
- Model writes: no tool reads or changes instructions.
- Keeping the context out of the Codex command line.
- Bidirectional or invisible Unicode characters are not refused; only control characters
  are.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may create
databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump`/`pg_restore`.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:instructions
npm run test:recovery
```

`member-instructions.test.ts` checks the spawn field's character and byte rules, bytes
that are not UTF-8, idempotent replays (also after the member has a conversation) and
concurrent duplicates, a spawn with instructions racing one without, conflicts on
changed, added or missing text, and an unchanged response without instructions; the
owner route, `404` for another owner, the listing's digest and byte count across pages,
that the supervisor gives Pi children no context, and no text in listings,
snapshots, audit JSON or CSV; the triggers that keep the row fixed, one per member, bound
to its owner and refused once a conversation exists, including an insert and an open
racing in both orders; the context order with notes and memory, unchanged context for
members without instructions, and hostile text that stays in its frame; the sizes above
and every row of the open-time table; a [handoff](handoffs.md) target of each engine
whose context leads with its own member's instructions while the transcript, the
handoff record and the audit trail carry neither member's, the insert trigger refusing
instructions once a handoff opened a conversation, and `instructions_limit` and
`memory_limit` refusing a handoff as they refuse an open; migration 29's locks, that it
never queues and does not wait for a native turn; and an upgrade from version 28.

`recovery.test.ts` checks that capture counts the table, that a held installation refuses
instruction writes, and that a restore keeps the instructions, removes those of a member
spawned after the recovery point, and records nothing about them when it resumes.

The service proof needs Docker, Linux, Landlock and Temporal CLI 1.10.0:

```sh
npm run test:instructions:service
```

It runs the real gateway, Temporal worker and fixture providers, and reads which markers
reached each provider request: Pi turns, a turn resumed by a new worker after its worker
was killed while it waited on an approval card, a routine firing, and the first and later
turns of Claude and Codex conversations, and a Claude handoff target's first turn, whose
system context holds its own member's instructions and whose transcript holds none; that
members without instructions and other owners' members see none; and that no text
reaches public events, snapshots, receipts, handoff records, listings or the audit
trail.
