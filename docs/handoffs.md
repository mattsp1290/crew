# Conversation handoff

An owner can hand a conversation of one of their members to another of their members,
often one with a different engine, and continue there. Migration 27 stores each
handoff. A member's native session cannot cross engines, so only committed,
engine-neutral history crosses: the newest whole turns of the source, quoted verbatim.
The target is a fresh conversation. Its first request, which the handoff reserves,
carries that transcript to the target model as a user message, and the model
acknowledges it. The source is sealed: it keeps its history and receipts and admits no
new request.

## Contract

`POST /v1/conversations/{sourceId}/handoffs` with `{ "requestId", "memberId" }` does
this in one PostgreSQL transaction:

1. Checks that the source conversation and the target member are the token owner's.
   Either one of another owner, or one that does not exist, is `404 not_found`.
2. Refuses a source that is busy, attached to the trusted-context lane, already handed
   off, or has nothing to carry (see [Errors](#errors)).
3. Reads the source's committed turns and renders the transcript (see
   [What crosses](#what-crosses)).
4. Refuses a target member that has used its daily
   [usage budget](usage-metering.md#budgets) (`409 usage_limit`). This is the only budget
   check the reserved request gets (see [The reserved first request](#the-reserved-first-request)).
5. Opens the target exactly as `POST /v1/conversations` would for that member, with a
   UUID the server draws: the project-notes capture, the
   [member memory](memories.md) snapshot, the `409 memory_limit` and
   `409 instructions_limit` refusals and the `conversation.opened` audit row. Every
   launch of the target gets its member's [instruction packs](instruction-packs.md) and
   [instructions](member-instructions.md), as any conversation of that member does.
6. Inserts an immutable `conversation_handoffs` row: the source, the target, the
   client's `requestId`, a server-reserved `firstRequestId`, the transcript, its
   SHA-256 digest and the turn counts. The row seals the source.
7. Appends a `conversation.handed_off` audit row on the source.

The target may be any member of the owner, including the source's own member. After
the commit the handler submits the reserved request to the target through the normal
request path (`MemberClient.open`, then `accept`), as the routine dispatcher submits a
firing. A `201` means the handoff is committed. With `firstRequestAdmitted: true` the
reserved request has an admission record. An accepted admission runs like any other
turn; a rejected one never runs. The request's receipt says which.
With `firstRequestAdmitted: false` its submission was refused after the commit. Retry
with the same `requestId` a bounded number of times, for example three times over a
minute. If it stays `false`, the target's workflow has most likely closed, and no retry
heals that (see [Costs](#costs)).

`requestId` makes the POST idempotent. The same owner sending the same `requestId`,
source and `memberId` gets the same handoff back and never a second target. While the
reserved request has no admission, each retry submits it again. Once it has one, the
target's workflow owns it: a retry sends nothing to the target and returns the record,
and the request's receipt reports how it ended, which may be `failed` or `uncertain`.
So when a POST fails after its commit (the gateway died, Temporal was unreachable),
retry it with the same `requestId`: the retry submits the reserved request again. When
it answers `firstRequestAdmitted: false`, a retry helps only if the target's workflow
is still open. The same `requestId` with another `memberId` or another
source is `409 conflict`. A second handoff of a sealed source under any other
`requestId` is `409 handed_off`.

## Routes

All routes need the bearer token. The owner comes only from it. Bodies are strict:
an unknown field, including `ownerId` or any text, fails `400 invalid_input`. Neither
route takes query parameters. Neither is served without the `/v1` prefix.

| Route | Purpose |
| --- | --- |
| `POST /v1/conversations/{conversationId}/handoffs` | Hand the conversation off: `{ "requestId", "memberId" }`; `201` with the handoff |
| `GET /v1/conversations/{conversationId}/handoff` | The handoff that created this conversation (`incoming`) and the one that sealed it (`outgoing`); `404` when neither exists |

```json
{
  "apiVersion": "1", "handoffId": "UUID", "requestId": "UUID",
  "source": { "conversationId": "UUID", "memberId": "UUID", "engine": "claude" },
  "target": { "conversationId": "UUID", "memberId": "UUID", "engine": "codex" },
  "firstRequestId": "UUID", "firstRequestAdmitted": true,
  "carriedTurns": 6, "omittedTurns": 2, "uncertainTurns": 0,
  "transcriptBytes": 41873, "transcriptDigest": "hex SHA-256 of the transcript",
  "createdAt": "2026-11-12T19:03:12.421Z"
}
```

`GET .../handoff` returns `{ apiVersion, conversationId, incoming, outgoing }`, each a
record as above without `apiVersion`, or `null`. A conversation in the middle of a
chain has both. Neither route ever returns the transcript. The owner reads it as the
target's first user message in its snapshot, and the reserved request's receipt at
`GET /v1/conversations/{target}/requests/{firstRequestId}` reports
`initiator: { "kind": "handoff", "id": "<handoffId>" }`.

`GET /v1/capabilities` describes the feature under `handoffs`:

```json
{
  "version": 1, "route": "/v1/conversations/{conversationId}/handoffs",
  "readRoute": "/v1/conversations/{conversationId}/handoff", "delivery": "reserved-first-request",
  "initiatorKind": "handoff", "transcriptBytes": 65536, "promptBytes": 16384,
  "carried": "newest-whole-committed-turns", "source": "sealed-readable"
}
```

`initiatorKinds` is now `["owner", "routine", "handoff"]`.

## Errors

| Status | Error | When |
| --- | --- | --- |
| `400` | `invalid_input` | malformed body or IDs, unknown fields, any query parameter |
| `404` | `not_found` | the source or the member is not the owner's |
| `409` | `busy` | the source has a running turn, a turn waiting on a decision or its children, or an admitted request not yet started |
| `409` | `handed_off` | the source was already handed off; also any new request to a sealed source |
| `409` | `handoff_empty` | the source has no committed turn (uncertain turns do not count) |
| `409` | `handoff_too_large` | the source's newest committed turn alone does not fit the transcript budget |
| `409` | `trusted_conversation` | the source is attached to the [trusted-context lane](trusted-application-context.md) |
| `409` | `history_unavailable` | the source predates the public event ledger, or a committed prompt does not match its turn's digest |
| `409` | `memory_limit` | the project notes and the target member's instructions (and any packs) fit its engine but not with its memory, as for any open |
| `409` | `instructions_limit` | the project notes fit the target member's engine but not with its instructions (and any packs), as for any open |
| `409` | `usage_limit` | the target member has used its daily [usage budget](usage-metering.md#budgets) |
| `409` | `conflict` | the `requestId` was used with another source or member; on the target's request routes, the reserved request's ID sent with other text or with an approval deadline |
| `409` | `handoff_pending` | on the target's request routes: its reserved request is not admitted yet |
| `409` | `update_rejected` | after the commit: the target's workflow refused the reserved request's update, as a previous-release worker does with one over 16 KiB (see [Upgrade](#upgrade)); a retry with the same `requestId` succeeds only once that cause is removed |
| `503` | `retry_same_request` | the outcome may be unknown; retry with the same `requestId` |

The POST's refusals, `400`, `404` and the `409`s from `busy` to `conflict`, come before
or inside its transaction and write nothing: no target, no row, no seal, no audit row.
Such a refused POST leaves the source open. After the commit nothing is refused: the
POST returns the committed record, with
`firstRequestAdmitted: false` when the reserved request's submission was refused, or
answers `409 update_rejected` or `503 retry_same_request`. In every one of those cases a
retry with the same `requestId` re-drives the delivery. `409 request_rejected`, which
other request routes can answer, never reaches this POST.

## What crosses

The transcript is one text, at most 65,536 bytes of UTF-8: a constant header line the
server writes, then one line of JSON.

```
BirbCrew conversation handoff v1. The owner moved an earlier conversation with another coworker to you. ... Reply with a brief acknowledgement that you have read it.
{"sourceEngine":"claude","omittedTurns":2,"uncertainTurns":0,"turns":[{"ownerPrompt":"...","modelReply":"..."}]}
```

- Turns are the source's committed turns, oldest first, read from the conversation's
  turns and its snapshot, not from a workflow history. So they span every Temporal
  Continue-As-New generation of the source. The newest turns are kept and
  the oldest dropped, whole, until the rendered text fits; `omittedTurns` counts the
  dropped ones. Nothing is summarised or truncated. If the newest turn alone does not
  fit, the POST fails `409 handoff_too_large`: a turn can commit a reply of 65,536
  bytes, which can never fit beside its prompt and the header. Continue the source with
  one shorter turn, then hand it off.
- `ownerPrompt` is the committed user message of that turn's request, as the source's
  snapshot holds it, checked against the SHA-256 digest the turn recorded. A mismatch
  or a missing message fails `409 history_unavailable`.
- `modelReply` is the turn's committed reply after the same redaction observers get:
  every native call ID the source recorded becomes `[tool call]`.
- A source turn that was itself a handoff's first request has `ownerPrompt: null`. Its
  prompt was an earlier transcript, which holds model text; it is never quoted again,
  so model text is never relabelled as the owner's across a chain. Its reply, the
  acknowledgement, is carried.
- Uncertain turns are counted in `uncertainTurns` and never carried.
- The JSON keeps every prompt and reply inside its own string. JSON escapes the C0
  controls; the server also escapes the C1 controls (U+0080 to U+009F, NEL among them)
  and U+2028 and U+2029, which JSON leaves raw and which can each break a line. So no
  text can start a line or pose as the header. Member memory refuses control characters
  instead; a transcript quotes committed text as it is, so it escapes them.

Not carried: tool calls and their arguments, approvals and decisions, work items and
receipts, Pi child tasks and outputs, native sessions and checkpoints, the source's
instruction packs, instructions, project notes and memory (the target gets its own
member's, as system context, never in the transcript), standing grants, uncertain
turns, turns left out to fit, and the prompts of earlier handoff turns.

## The reserved first request

The handoff row is the only authority for the target's first request. At admission,
`recordAcceptance` reads it under the target conversation's row lock:

- The reserved `firstRequestId` is admitted only with text whose SHA-256 equals the
  stored digest and without an [approval deadline](approval-expiry.md); any other text,
  or `approvalDeadlineSeconds`, is `409 conflict`. Its admission records the initiator
  `{ kind: "handoff", id: <handoffId> }`. No caller can attest that initiator; the
  activity accepts only an owner attestation and derives the rest from SQL.
- Every other request to the target is `409 handoff_pending` until the reserved one is
  admitted: the owner's, the CLI's, and a routine firing's. Routines cannot name an
  existing conversation in any case: each firing draws a new conversation UUID.
- It is a model call on the target member. Each of its segments that returns is
  recorded in the [usage ledger](usage-metering.md) under the target, with the initiator
  `{ kind: "handoff", id: <handoffId> }`, and count toward the target's budget. The
  POST checks that budget before the commit. After the commit no budget check refuses
  the reserved request, even when the target's budget ran out in between: that refusal
  would leave the source sealed and the target `handoff_pending`. So the reserved request
  can take the target past its limit by one turn, as any admitted request can. Every
  other request to the target meets the budget as usual.
- Only the reserved request may carry more than 16,384 bytes. Every other request keeps
  the public limit: the gateway and integration API check it at the boundary, and
  admission checks it again by initiator, so the CLI or any internal caller is held to
  it too. No client flag can raise it.

An admission refused inside a conversation's Temporal workflow fails that whole
conversation, so `MemberClient.accept` and `submit` run the same checks before every
attempt to send a workflow update, including each retry while the workflow rolls over.
A refusal there leaves the workflow untouched.

A standing grant never covers the handoff turn. Grants cover only requests whose
admission names the owner, so a protected call the target model makes while
acknowledging the transcript gets a card, without standing choices. Later requests the
owner sends to the target are covered like those of any other conversation of the
member.

That card has no deadline: the server submits the reserved request without one, so the
card waits for an answer. Later requests to the target may carry `approvalDeadlineSeconds`
like any request. On the source, a card waiting on its deadline is `busy` like any
pending card. Once it expires, its request is cancelled as by an owner's cancel and its
turn goes on to its reply; the source can be handed off after that turn has ended.

## Sealing

A source with a handoff row admits no new request: `recordAcceptance` and
`MemberClient` refuse it with `409 handed_off`. Everything else stays: its snapshot and
observation stream, receipts and results of its requests, a resubmission of a committed
request (which returns the stored result), cancellation of an old request, and the
audit trail. The busy check and every admission lock the source's conversation row, so
a request is either admitted before the seal (and the handoff is refused as busy) or
refused after it. `MemberClient` refuses a sealed source before every attempt to send a
workflow update. A request that passed that check just before the seal committed is
refused at admission inside the source's workflow instead. The admission activity does
not retry a seal, so that update fails in about a second (`409 update_rejected`), and
that workflow then fails. The source admits nothing new either way, and its history and
receipts stay readable. The trusted-context lane cannot attach to either side of a
handoff.

A Claude turn whose worker failed after its native launch, on a profile with a protected
or human tool, is left uncertain while the workflow tries to recover it, for up to about
a minute. It is not busy, so a handoff in that window counts it in `uncertainTurns`. Its
recovery takes the same row lock and finds the seal, so the turn stays uncertain and
never resumes, asks for a decision or commits on the sealed source.

A conversation grant of a sealed source is listed as `conversation_closed`.

Sealing does not end the source's Temporal workflow; it stays idle, as any idle
conversation's does.

## Prompt delivery and limits

The public prompt limit stays 16,384 bytes for every owner and routine request. Every
internal path from `MemberClient` to the engine now allows 65,536 bytes: the workflow's
update validator, the store, the supervisor launch, the Claude worker command and the
Codex driver. Before this change the Claude command counted 16,384 UTF-16 code units; it
now counts 65,536 UTF-8 bytes.

Every engine gets the prompt outside its command line, so one budget fits every target:

| Engine | How the prompt arrives |
| --- | --- |
| Codex | The Codex SDK starts `codex exec --experimental-json` with only flags and `--config` overrides as arguments and writes the prompt to its stdin (`@openai/codex-sdk` 0.167.1, `dist/index.js`). The native launcher closes only descriptors 3 and above, so stdin reaches Codex. The 131,072-byte argument limit applies to `developer_instructions` (instruction packs, member instructions, notes and memory), not to the prompt |
| Claude | IPC to the Claude worker, then the Claude Agent SDK writes it to the Claude CLI's stdin (`--input-format stream-json`) |
| Pi | A frame on descriptor 3 to the confined Pi worker, which runs the Pi SDK |

The transcript is never in a command line, so `/proc/<pid>/cmdline` and exec auditing
do not see it.

## Trust boundary

- **The transcript is a user-rank message.** Model replies from the source reach the
  target as part of a user message. The header calls the transcript quoted data, not
  instructions, and the JSON keeps each prompt and reply inside its own string, but
  framing is not a security boundary: a model can still follow instructions it finds
  in a quoted reply, including text a source model copied from a tool result or a
  file. Hand off only conversations whose replies you would paste into a prompt
  yourself.
- **Who can hand off.** Whoever holds the owner's bearer token, between that owner's
  members only. Crew cannot tell a person from an automated client holding it.
- **What it cannot do.** It cannot grant tools, approve calls, carry approvals or grants,
  or change a profile. The handoff turn gets cards like a routine's turn would.
- **Who reads it back.** The owner: the target's snapshot and its observers carry the
  transcript as its first user message, as they carry any prompt. Receipts, the audit
  trail and the handoff routes never do.

## Costs

A handoff costs one model call, the acknowledgement, and one of the target's 128 turns.
That call, when it returns, is metered on the target member and counts toward its usage
budget.
The transcript stays in the target's native history, so engines that resend history
send up to 64 KiB of it again with every later turn. A model with a small context window
may refuse a large transcript; the reserved request then fails like any provider
failure and the target closes as any conversation with a failed turn does. The source
stays sealed, and the target has no committed turn to hand on, so that history can then
only be read.

A target whose Temporal workflow closes before its reserved request is admitted, for
example because the admission activity could not reach the database for its whole 60 s,
stays `handoff_pending` for good. The closed workflow cannot admit the reserved request,
so every retry of the POST answers `firstRequestAdmitted: false`, and the source stays
sealed. This release has no recourse for it.

The transcript is copied: into the handoff row, into the target's public snapshot and
events, its native session files and checkpoints, and Temporal history, where the
reserved request's update and its activity inputs each carry it. Erasing a handoff's text
from all of these is not supported.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `conversation.handed_off` | owner | a handoff commits; on the source conversation | handoff | `handoffId`, `targetConversationId`, `targetMemberId`, `firstRequestId`, `carriedTurns`, `omittedTurns`, `uncertainTurns`, `transcriptDigest` |

The target's `conversation.opened` row has an empty payload. The reserved request's
`request.accepted` and `request.finished` rows carry the initiator
`{ kind: "handoff", id: <handoffId> }`. No row carries transcript text.
[Audit filters](audit-filters.md) select the reserved request's rows with
`initiatorId=<handoffId>`, and every handoff's reserved requests with
`initiatorKind=handoff`. The `conversation.handed_off` row names the source
conversation and its member with the owner as initiator, so neither of those
filters returns it, and the target's `memberId` returns it only when the target is
the source's own member.
`transcriptDigest` is an unsalted SHA-256 of text that quotes prompts and replies, so,
as with prompt digests, anyone holding an export can confirm a guess of a whole
transcript.

A handoff sends no [outbound webhook](webhooks.md#handoffs-approval-expiry-and-usage-budgets);
the reserved request's finish is sent as `request.finished` for the target, with no
initiator and no transcript.

## Recovery

`conversation_handoffs` carries the `recovery_write_barrier` trigger, so a held
installation refuses handoffs and recovery capture counts the table. A restore rewinds it
with the rest of the database: handoffs committed after the recovery point disappear,
with their targets, and their sources are open again. A retry of such a handoff's
`requestId` then creates a new handoff with a new target UUID.

## Upgrade

Migration 27 creates `conversation_handoffs`, replaces
`request_admissions_initiator_kind_check` and `audit_events_initiator_check` (last set
by migration 25) and `audit_events_type_check` (last set by migration 26) with `NOT VALID`
constraints that list every kind and type, and adds one empty partial unique index on
`audit_events`. Existing rows are neither rewritten nor checked. Until `migrate()` commits
it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17) | Why |
| --- | --- | --- |
| `members` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the row's member foreign keys |
| `conversations` | `ACCESS SHARE`, `SHARE ROW EXCLUSIVE` | the row's conversation foreign keys |
| `request_admissions` | `ACCESS EXCLUSIVE` | the initiator CHECK |
| `audit_events` | `ACCESS EXCLUSIVE`, `SHARE` | the CHECKs and the index build |

It takes all four together with `NOWAIT` and retries every 20 to 100 ms, as migrations
25 and 26 do, so it never waits in a lock queue and never joins a deadlock. A running
native turn's admission transaction holds nothing that conflicts. After 60 s without the
locks it fails with `55P03`, applies nothing, and the process exits.

**Stop every gateway, worker and CLI process of the previous release before migrating.**
This is required here, not only advised: the workflow's update validator bound changed.
A previous-release worker validates turn requests at 16 KiB and launches native turns
with the old bounds, so it refuses a reserved request larger than that. A
previous-release gateway or worker also does not know the handoff row: it would admit
requests to a sealed source or to a target before its reserved request, record the
reserved request as the owner's, and fail to read a `handoff` initiator.

Rollback to a release without migration 27 is unsupported. An older release cannot read
a `handoff` initiator, so status reads and audit of those requests fail, and it ignores
every seal and reservation. It also cannot replay a target's workflow run that accepted a
reserved request over 16 KiB: replaying that update runs its handler, whose 16 KiB check
throws where the history scheduled the admission activity. That is a nondeterminism
failure, and the workflow task keeps failing until a worker of this release takes it.
The same happens to a previous-release worker left polling during a rolling update.

Changing the bound does not affect replay. Temporal does not run an update's validator
when it replays an accepted update (`run_validator` is false during replay in the
Temporal SDK core protocol). The update handler repeats the same check when it runs,
replay included, but the bound only widened, so every request a recorded history holds
still passes it. No workflow command changed. The offline replay
in `npm run test:rollover` replays captured histories with this release's workflow.

## Not covered

- Summarising, or carrying tool calls, approvals, work items, child outputs or native
  state. A turn too large to fit is never cut.
- Handing a conversation into an existing conversation, to another owner, or with nobody
  present: there is no routine or dispatcher for handoffs, because the owner is present
  and retries the POST.
- Undoing a handoff or unsealing a source, including after the target's first request
  failed. Deleting a handoff or its transcript.
- Trusted-context conversations, on either side.
- Per-engine budgets. Every engine takes the prompt outside its command line today; an
  engine that did not would need its own, smaller budget.
- A conversation whose workflow history predates durable admission (before migration
  16) records no admission, so only `MemberClient`'s check guards its seal. A request
  that passes that check just before a handoff commits can still start a turn there.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may create
databases.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:handoffs
```

`handoffs.test.ts` checks a handoff from each engine to another: the record, the parsed
transcript, the target opened fresh with the member's memory snapshot, the reserved
request admitted with the handoff initiator, the transcript as the target's first user
message, and the owner continuing there; `404` in both directions of owner isolation and
strict routes; `busy` for a running turn, a pending approval and a queued request; a
handoff and an admission on one source, each held on the row lock in turn, ending `busy`
or `handed_off`; a recoverable uncertain Claude turn whose recovery the seal refuses;
idempotent retries that heal a lost submission, concurrent retries that open one target,
and `requestId` conflicts; retries that send nothing once the reserved request is
admitted, whether it then ended uncertain or was rejected; a refusal after the commit that
returns the record unadmitted; a sealed source that refuses new requests and a second
handoff but keeps its snapshot, receipts and replays; refusals for an empty source, a
source with only an uncertain turn, a trusted-lane source, `memory_limit`, an incomplete
snapshot, a prompt that no longer matches its digest, and a newest reply of exactly 65,536
bytes, each writing nothing, with such a reply left out whole when older; a transcript of
exactly 65,536 bytes carried whole and one byte more leaving its oldest turn out; tail
fitting by whole turns, uncertain turns counted, native call IDs redacted; the reserved
request admitting only its digest and no approval deadline, before every other request
including a routine firing's, and never on a caller's attestation, with later target
requests taking a deadline that expires as anywhere; a source card that expires staying
`busy` until its turn ends, then handed off; the 16 KiB limit for every other request in
the target, through the routes and admission; `MemberClient` refusing before any workflow
update and again before each rollover retry, and admission refusing a seal or a pending
reservation without retrying; a chained handoff with `ownerPrompt: null`; C1 controls,
U+2028 and U+2029 kept escaped; an audit trail without text, the row's binding and
immutability; a standing grant that does not cover the handoff turn, a sealed source's
conversation grant listed as closed, and a tripwire that the target has no cardless call
any other conversation of the member would not, including for a request with no admission;
migration 27's locks, that it never queues and does not wait for a native turn, and a turn
admitted before the upgrade that can be handed off after it. `npm run test:usage` checks
that a target over its budget refuses the POST with nothing written, and that a reserved
request whose target's budget runs out after the commit is still admitted, then metered on
the target under the handoff initiator while the target's other requests are refused. `npm run test:recovery`
checks that capture counts `conversation_handoffs` and that a held installation refuses a
handoff and a direct insert.

The service proof needs Docker, Linux, Landlock and Temporal CLI 1.10.0:

```sh
npm run test:handoffs:service
```

It runs the real gateway, Temporal worker and fixture providers. For each target engine
it hands off a Pi conversation whose two turns, nearly all quotes and backslashes that
JSON escapes, render to exactly 65,536 bytes, waits for the target's first request to
complete, and reads the fixture provider's record of that
request: both turns' markers arrive in the messages and none in the system context, and
the fixture's reply shows it parsed the whole transcript. The owner then continues in the
target, and the source refuses a new request.

Not claimed: no live provider, and no model context window limit was exercised.
