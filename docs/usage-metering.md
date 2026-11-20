# Usage metering

Crew used to record no token count and no cost, so an owner could not see or bound
what a member consumed, even though routines now run with nobody watching. Migration
31 adds a usage ledger: one row for each native segment, with the token counts the
engine's SDK reported. An owner reads totals for themselves, for each member and for
each conversation, and can give a member a daily token budget. When a member has used
its budget, admission refuses its new requests.

A segment can carry one of two costs, never both, and Crew reports them apart. A
billed cost is one the provider billed and the SDK passed on; today that happens only on
Pi, with a provider such as OpenRouter. An estimated cost comes from a price table the
operator supplies, computed when the segment's row is written and never again (see
[Estimated cost](#estimated-cost)). Crew ships no prices, so without that table Claude
and Codex segments have no cost, as before.

Both lanes are metered: the member lane, whose requests come through Crew's workflows,
and the [trusted-context lane](#the-trusted-context-lane), which a trusted backend
drives directly.

## What each engine reports

Crew reads what the pinned SDKs return for a finished segment. These figures come from
the type definitions in `node_modules`, the drivers, and runs against the local
fixture providers (`tests/service/usage-capture.test.ts`).

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| SDK | `@earendil-works/pi-ai` 1.5.2 | `@anthropic-ai/claude-agent-sdk` 0.3.306 (CLI 2.1.306) through the vendored AG-UI adapter 0.0.8 | Codex app-server 0.169.0 through Switchboard's host adapter |
| Where Crew sees it | `usage` and `model` on each reply the host relayed from the provider to the segment's confined worker (`pi-launch.ts`, `pi.ts`) | `result.usage` on the adapter's `RUN_FINISHED` event, and `model` on its `system:init` event (`claude-worker.ts`) | the host adapter's cumulative `token-usage.total` (`codex.ts`) |
| Input tokens | `input` + `cacheRead` + `cacheWrite` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `input_tokens`, which already includes cached tokens |
| Cached input | `cacheRead` | `cache_read_input_tokens` | `cached_input_tokens` |
| Cache writes | `cacheWrite` | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| Output tokens | `output` | `output_tokens` | `output_tokens` |
| Reasoning tokens | `reasoning` when the provider reports it | not reported | `reasoning_output_tokens` |
| Model | the one that answered: `responseModel` when the provider named a model other than the one requested, else `model`; null when the segment's calls name different models | as the CLI's `init` message reports it | the profile model; the host adapter does not name the model that answered |
| Billed cost | `cost.total` only when `cost.totalFromProvider` is true; otherwise pi-ai computed it from its model catalog, and Crew drops it | never: `total_cost_usd` is the SDK's estimate from a price lookup | never: nothing reported |
| Estimated cost | from the operator's table when the segment has no billed cost | from the operator's table | from the operator's table |
| Granularity | one model call per assistant message, summed over the segment | the one `query()` call that runs the segment | the native thread's running total |
| A worker replaced mid-segment | the call in flight is lost | the query in flight is lost | the turn in flight is lost |

Two of these needed a correction:

- **Codex reports a running total, not the turn's usage.** The host adapter's
  cumulative `token-usage.total` counts the whole native thread, carried across resumed
  turns. Against a fixture whose calls used 100, 200 and 300 input tokens, three turns
  reported 100, 300 and 600. Crew stores that total on the checkpoint as `priorTotal`
  and records the new total minus the previous one. A missing total, or any count that
  goes down, leaves the segment `unknown`.
- **A count of zero input means nothing was reported.** pi-ai and the Codex CLI fill
  usage with zeros when a provider sends none. A model call always reads some input, so
  a segment whose input total is zero is recorded as `unknown`, never as zero. Pi's
  fixture (faux messages) and the Codex Responses fixture both report zeros and are
  recorded as `unknown`. Claude's fixture reports 10 input and 10 output tokens per call.

Each Claude segment is a separate `query()` call in a new CLI process. A resumed
session reported only its own query's usage (10 and 10), not the session's. The
`usage` in the result covers the main agent loop. Crew's Claude members have no tools
that start subagents, so the main loop is every call Crew asks for. The SDK's
`modelUsage`, which would also count internal calls, does not reach the adapter's
events.

None of the three keeps usage for work that did not return. If a worker is replaced or
killed mid-segment, the segment's turn becomes `uncertain` and is never run again, so
its tokens are never recorded. A Claude proposal that `recoverPending` rebuilds from
the transcript makes no model call and records nothing, and the call that first
produced it is lost too.

## The ledger

`usage_ledger` has one row for each native launch of the member lane, keyed by the
launch's `(conversation_id, request_id, token)`, and one for each trusted-context
request (see [below](#the-trusted-context-lane)). The launch key is the primary key of
`native_launches`, and a foreign key binds the two. The supervisor reserves a launch's
generation once, in a committed transaction, before it starts the SDK process. So:

- A Temporal replay runs no activity, and so starts no launch.
- An activity retry of a turn either replays the committed reply or turns the turn
  `uncertain`. Neither starts a new launch. A resumed segment (after a decision or a
  delegation) gets a new generation, because it is new model work.
- A repeated `start` for a generation that already ran only observes it.
- The insert repeats the launch's execution identity (run, activity, attempt) and does
  nothing on conflict, so a retried write adds no row.

This follows the receipts (`codex_item_receipts`, work-item receipts): the row is keyed
by the identity that already makes the effect happen once.

The supervisor host writes the row after the runner returns a confirmed result and
before it commits that result (the reply, the card, the delegation or the child's
outcome). The model work has happened even if the commit then fails. A segment whose
driver returned no usage gets an `unknown` row, and so does one whose counts the
ledger's CHECKs would refuse: metering never costs a segment its result. A segment that failed, was cancelled
or whose runner died gets no row.

**Per segment, not per request.** Each SDK reports usage per invocation: Pi per
assistant message, Claude per `query()`, Codex per turn. A Crew segment is exactly one
such invocation. A request can span several segments (a proposal, the resumed answer,
Pi children), and some of them may never finish. Summing per request would need the
request to end first. Per-segment rows are written once, as each segment returns.

| Column | Meaning |
| --- | --- |
| `usage_id` | Identity, newest highest |
| `owner_id`, `member_id`, `conversation_id`, `request_id` | Whose segment it was |
| `token`, `child_id` | The launch generation, and the Pi child it ran for, if any; both null on a trusted-context row |
| `trusted_request_id` | On a trusted-context row only, the trusted request, equal to `request_id` |
| `engine` | `pi`, `claude` or `codex`: the engine that ran the segment. A child's row takes its child target's engine (always `pi` so far) and keeps the parent member's `member_id`, so a child's tokens count toward its parent member's budget |
| `state` | `reported`, or `unknown` when the SDK reported nothing usable |
| `model` | As the engine reported it (see the table above), at most 256 bytes, or null |
| `input_tokens`, `output_tokens` | Integers; both set exactly when `state` is `reported` |
| `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens` | Integers when the SDK reports them, else null |
| `cost_usd` | A provider-billed cost, else null |
| `estimated_cost_usd`, `estimate_price` | An estimate from the operator's price table and the rates it used, else both null |
| `recorded_at` | The database clock when the row was written |

CHECKs keep `unknown` rows free of counts and cost, keep a billed cost and an estimate
off the same row, and give every row exactly one of a launch token and a trusted
request. A statement trigger refuses every `UPDATE`, `DELETE` and `TRUNCATE`. Like
every table, both new tables carry the recovery write barrier.

## Routes

All routes need the bearer token. The owner comes only from it. Query parameters are
strict: an unknown or repeated parameter, or a malformed value, fails
`400 invalid_input`. `from` and `to` are optional instants such as
`2026-11-12T00:00:00Z`; a row counts when `from <= recorded_at < to`, and `from` must
come before `to`. A `memberId` or `conversationId` the owner does not have fails
`404 not_found`.

| Route | Purpose |
| --- | --- |
| `GET /v1/usage?from=&to=` | The owner's totals, the part routines started and the trusted-context lane's part |
| `GET /v1/usage/members?from=&to=&after=&limit=` | Every member of the owner, ordered by `memberId`, with totals and its budget |
| `GET /v1/usage/conversations?from=&to=&memberId=&after=&limit=` | Conversations with at least one row in range, ordered by `conversationId` |
| `GET /v1/usage/records?from=&to=&memberId=&conversationId=&before=&limit=` | Ledger rows, newest first |
| `GET /v1/usage/budgets/{memberId}` | The member's budget and its current window |
| `PUT /v1/usage/budgets/{memberId}` | Set the budget, body `{ "tokenLimit": 500000 }` |
| `DELETE /v1/usage/budgets/{memberId}` | Clear the budget |

Every total has this shape. `totalTokens` is input plus output, the number the budget
counts. `costUsd` is a decimal string summing the billed costs, or null when no row in
the set has one; `costReportedSegments` says how many did. `estimatedCostUsd` and
`costEstimatedSegments` do the same for estimates. A segment has at most one of the
two, so the two counts never overlap, and Crew never adds the two sums: an estimate is
not a bill. A consumer that wants one figure adds them itself and should say that part
of it is estimated.

```json
{
  "segments": 4, "unknownSegments": 1, "inputTokens": 1350, "outputTokens": 135,
  "totalTokens": 1485, "cachedInputTokens": 400, "cacheWriteTokens": 0,
  "reasoningTokens": 10, "costUsd": "0.25", "costReportedSegments": 1,
  "estimatedCostUsd": "0.0009", "costEstimatedSegments": 1
}
```

The summary is `{ apiVersion, from, to, total, routine, trusted }`. A member entry is
`{ memberId, engine, total, routine, trusted, budget }`, and a conversation entry
`{ conversationId, memberId, total, routine, trusted }`. `routine` counts only the
segments of requests whose admission recorded a routine as initiator, and `trusted` only
the trusted-context lane's; a [handoff's](handoffs.md) reserved request counts in
`total` only. A record's `lane` is `member` or `trusted`. Its `initiator` is the one its
request's admission recorded: `owner`, `routine` or `handoff`, the last two with their
ID. A request with no admission row counts as the owner's, as it does in the audit
trail: one from a workflow history older than durable admission, and every
trusted-context request. A member's `budget` is null or
`{ tokenLimit, period, revision, changedAt, windowStart, usedTokens }`.

A record is:

```json
{
  "usageId": "42", "recordedAt": "2026-11-12T08:03:12.421Z", "memberId": "UUID",
  "conversationId": "UUID", "requestId": "UUID", "childId": null, "lane": "member",
  "engine": "claude", "state": "reported", "model": "claude-sonnet-4-6",
  "inputTokens": 10, "outputTokens": 10, "cachedInputTokens": 0, "cacheWriteTokens": 0,
  "reasoningTokens": null, "costUsd": null, "estimatedCostUsd": "0.00018",
  "estimatePrice": { "input": "3", "cachedInput": "0.3", "cacheWrite": "3.75", "output": "15" },
  "initiator": { "kind": "owner" }
}
```

`estimatePrice` is null unless the row has an estimate; its rates are USD per million
tokens. These fields are additive: a consumer that ignores them reads the ledger as
before, and `costUsd` still means a billed cost only.

`limit` defaults to 100. It is at most 100 for members and conversations and 1000 for
records. Pass `nextAfter` as the next `after`, or `nextBefore` as the next `before`;
`hasMore` says whether another page exists. `usageId` is a decimal string. IDs are
drawn before a row commits, so a row can commit after a later one. A records page you
have already read past does not gain that row; the totals always include it. A
coordinated restore reissues the IDs drawn after its recovery point to new rows (see
[below](#upgrade-and-recovery)). Gateways are stopped while a restored installation is
held, so the operator reads its newest ID before `resume`
(`SELECT max(usage_id) FROM birbcrew_ts.usage_ledger`) and gives it to consumers that
mirror records; each drops the rows it holds above that ID and reads again.

`GET /v1/capabilities` describes the feature under `usage`: the states, the token and
cost rules, the estimate's field, source, setting and unit (`estimate`), the lanes, what
each engine reports, the budget period, which lanes the budget counts and which it
refuses (`lanesCounted`, `lanesRefused`), the refusal codes (`refusal` and
`refusalClosingConversation`), and that a restore rewinds the ledger and reissues record
IDs. `cost` and each engine's `cost` still describe `costUsd`, which is still a billed
cost only, so their values are unchanged; each engine gains `estimate`, and Pi
`modelSource`. One existing value changed, because it stopped being true: Codex's
`model`, from `not-reported` to `from-rollout-turn-context`.

## Estimated cost

Crew ships no prices and never will: prices change, providers discount, and a wrong
built-in price is worse than none. The operator, who knows what each account pays,
supplies them. Set `BIRBCREW_USAGE_PRICES_PATH` on the worker to the absolute path of a
JSON file:

```json
{
  "version": 1,
  "unit": "usd-per-million-tokens",
  "models": {
    "claude-sonnet-4-6": { "input": "3", "output": "15", "cachedInput": "0.3", "cacheWrite": "3.75" },
    "gpt-5.4": { "input": "1.25", "output": "10", "cachedInput": "0.125" }
  }
}
```

- **Keys** are models exactly as the ledger records them; read `model` from
  `/v1/usage/records` to see the names. From 1 to 512 models: an empty table is refused,
  so to estimate nothing, unset the setting.
- **Rates** are USD per million tokens, written as decimal strings with at most six
  decimal places, from `0` to `999999.999999`. A number, an exponent or a seventh
  decimal place is refused, so no binary fraction enters the table. `input` and `output`
  are required. `cachedInput` (cache reads) and `cacheWrite` default to `input`: OpenAI
  charges nothing extra for a cache write, Anthropic charges more, so set `cacheWrite`
  for Claude models. There is no reasoning rate: output already includes reasoning
  tokens, and both providers bill them as output.
- **Startup.** The worker and its supervisor host read the file once, when the worker
  starts; restart the worker to change prices. A malformed file stops the worker with an
  error that names the setting and the failing entry's position, never the file's
  contents. Without the setting nothing is estimated, as before. A table built in code
  (see [the trusted lane](#the-trusted-context-lane)) is checked entry by entry by the
  same rules, and `runTrustedRequest` refuses one that breaks them before it claims a
  request.

When the supervisor host writes a segment's row, it prices the segment if it is
`reported`, names a model the table prices, and has no billed cost:

```
estimate = (input − cachedInput − cacheWrite) × input rate
         + cachedInput × cachedInput rate + cacheWrite × cacheWrite rate
         + output × output rate                       (all ÷ 1,000,000)
```

A part the engine did not report (null) is not guessed: it counts as ordinary input. A
segment whose parts add up to more than its input gets no estimate. The arithmetic is
exact: a rate with six decimal places per million tokens is a whole number of
picodollars per token, so Crew multiplies integers (BigInt) and stores the result in
`numeric(22, 12)`, the largest possible segment included. The row keeps the four rates
it used in `estimate_price`. The ledger is append-only, so a later price never rewrites
an earlier row, and a retried write for a launch already recorded adds nothing under
any table. Totals sum `numeric` in PostgreSQL, so they never drift either.

Which model is priced matters, so each engine's model was checked:

- **Claude.** The CLI's `system:init` message names the model the main loop runs, which
  is the profile's model. Usage covers that loop only, so the two match.
- **Codex.** The host adapter does not name the model that answered. Crew prices the
  profile model, which is the name the member was launched with.
- **Pi.** pi-ai sets `responseModel` when the provider names a model other than the one
  requested, as a router or a fallback does. Crew records the model that answered, and
  none when the segment's calls disagree, so a routed call is priced as the model that
  ran it, or not at all. pi-ai sets it whenever the provider's model string differs, and
  many OpenAI-compatible providers answer with a dated snapshot name (a request for
  `gpt-4o` answered as `gpt-4o-2024-08-06`); such a member's rows record the snapshot
  name from this release on, so price that name. The built-in OpenCode Go profile already
  refuses a response from another model.

A segment without a model, or with one the table does not price, has no estimate.

An estimate is what the segment would cost at the rates in the table. It is not what
the provider charged: Crew cannot see discounts, batch or long-context tiers, cache
writes priced by how long they are kept, or that a subscription account (Codex on a
ChatGPT plan, Pi on OpenCode Go) is not billed per token at all. Leave a model out of the table when an
estimate for it would mislead. The provider's own bill stays the source of truth.

## The trusted-context lane

The [trusted-context lane](trusted-application-context.md) recorded no usage before this
change, for three reasons:

- Its drivers returned only text and a checkpoint (`trusted-native.ts`, `trusted-pi.ts`,
  `trusted-claude.ts`). The Codex trusted lane has been removed.
- Its runner, `runTrustedRequest`, runs in the embedding backend's process, not the
  supervisor host, which was the one place rows were written.
- A ledger row needed a `native_launches` row (migration 31's foreign key), which
  belongs to a member-lane turn. A trusted conversation has no turns: `open()` refuses a
  conversation that has any, and member-lane admission refuses a trusted conversation.

Each trusted driver now returns what its SDK reported, through the same capture
functions as the member lane: Pi the replies the host relayed to its confined worker for
the request; Claude the sum of the request's queries, one per tool round trip, and
`unknown` if any query reported nothing usable. `runTrustedRequest` writes one row per trusted
request with the same writer, after the native turn returns and before the reply
commits, priced from the operator's table like any other row. It reads
`BIRBCREW_USAGE_PRICES_PATH` in the embedding process, once; pass a table as its fifth
argument to use another. Either way a malformed table throws before the request is
claimed, never after its tools have run; read it when the backend starts
(`operatorPrices()` in `usage-prices.ts`) to fail then.

The row is bound to the trusted request's generation and the token its start claimed,
not to a launch: its `token` and `child_id` are null and `trusted_request_id` names the
request. A trusted request runs at most once, under one token, so its ID identifies the
model work as a launch generation does, and a unique index keeps one row per request.
The unit is coarser than the member lane's: there each segment of a request has its own
row, while a trusted request is one row, written only when its whole native turn
returns. A trusted request that fails, is cancelled or loses its lease to a rotation
records nothing, including the model calls it had already finished (a Claude tool round
trip, a Pi or Codex tool call), so the lane undercounts more on failure. One whose
commit then finds the generation stale keeps its row, because the tokens were spent.

The lane's guarantees do not change. The row holds counts and a model name, never the
context, prompt, reply or tool data; nothing enters Temporal. `erase()` leaves the row,
as it leaves the audit trail's `trusted_effect.completed` rows, and for the same reason:
it is metadata, not content. A trusted request has no admission row, so its record
names the owner as initiator, as the audit trail does for the lane's effects, with
`lane: "trusted"`; use `lane`, not `initiator`, to tell the lane's spending apart. The
owner sees the lane's token counts through `/v1/usage` without the trusted application's
`authorize` callback being asked, as with those audit rows. Counts are metadata, but not
nothing: `outputTokens` approximates a reply's length and `inputTokens` the size of the
context, prompt and tool results, including for a request whose reply `authorize` later
withheld, one from an earlier generation and one in an erased conversation. An
application for which those sizes are sensitive should not give that owner an
integration API token. A record's `estimatePrice` also shows the operator's rates to the
owner.

## Budgets

An owner can give each member one token budget. The window is the current UTC
calendar day of the database clock, from midnight to midnight. A budget counts input
plus output tokens of the member's `reported` rows recorded in the window, in both
lanes: a trusted-context conversation's tokens are the member's too. Only the member
lane is refused, though; the trusted lane has no admission that consults the budget,
so its requests run whatever the budget says. Budgets count tokens, not money. Input
includes cache reads and writes, so a long Codex or Claude conversation that rereads
its context counts that context every time. That context includes the member's
[instruction packs](instruction-packs.md), [instructions](member-instructions.md), project notes and memory, which every launch
sends again. Crew meters them as input like the rest; no token limit applies to them
apart from the member's budget, and their byte limits when a conversation opens are
unchanged. `unknown` rows count nothing. A budget applies to one member
across all its conversations, the owner's requests and its routines alike, and a
handoff to the member is checked against it once (see
[Conversation handoff](#conversation-handoff)). The limit is a whole number from 1 to
10^12.

`PUT` with the limit the budget already has changes nothing and writes no audit row.
Any other `PUT` sets the limit and raises the budget's revision by one. `DELETE`
clears it, and clearing a member without a budget changes nothing. A cleared budget
keeps its row, so revisions keep rising. A database trigger refuses a deleted row, a
changed member and any revision step other than one.

```json
{
  "apiVersion": "1", "memberId": "UUID",
  "budget": { "tokenLimit": 500000, "period": "utc_day", "revision": 1, "changedAt": "2026-11-12T08:03:12.421Z" },
  "window": { "start": "2026-11-12T00:00:00.000Z", "end": "2026-11-13T00:00:00.000Z" },
  "usedTokens": 1234, "remainingTokens": 498766, "admitting": true
}
```

### Admission

When a member's used tokens are at or over its limit, a new request is refused with
`409 usage_limit`. Nothing is admitted: the request has no receipt, and the same
request can be sent again later. The check runs twice:

1. `MemberClient`, before every attempt to send the request to the workflow, including
   each retry while the workflow rolls over. This is the check that answers in
   practice. The workflow never sees the request, and the conversation stays open. It
   is the last of `MemberStore.checkAdmission`'s checks: a sealed source
   (`409 handed_off`), a target whose handoff request is not yet admitted
   (`409 handoff_pending`) and a prompt over 16 KiB are refused first. For a member with
   a budget it then locks the conversation and makes `recordAcceptance`'s checks again,
   with the conversation's request bound (`409 input_limit`) and a routine firing's terms
   (`409 conflict`), so a request is refused, and audited, under the budget only when
   admission would refuse it for the budget alone.
2. `recordAcceptance`, the admission transaction, after it has locked the
   conversation and made the same checks. This is the enforcing check. It catches
   usage recorded, or a budget set or lowered, between the two checks. Its refusal
   fails the admission activity without retries, as a seal's does. Like any refused
   admission, that closes the conversation to new turns, so `MemberClient` reports it
   as `409 usage_limit_closed`: send the request again in a new conversation. That
   conversation stays closed even though later requests to it, while the member is
   over budget, get the first check's plain `usage_limit`. A routine firing fails
   `usage_limit` either way.

The first check reads nothing more for a member without a budget, and leaves a
trusted-context conversation to admission, which refuses it as before.

A request that already has an admission row or a turn is never refused, so a retry
gets the answer it got before. A running segment is never interrupted for budget.
Before each child's first launch, Crew checks the parent member's reported usage
under the parent conversation lock. If that usage has reached the limit, the child
settles with `budget_exhausted` and a `delegation.finished` audit fact. It starts no
native process. That outcome survives retries and later budget resets.

An admitted child is not checked again. Its approval resume runs even if the budget
is exhausted while the owner decides. Parent continuation also runs. A Pi delegation
has at most two parent segments and two children with at most two segments each,
for six bounded segments per request. Usage arrives after segments return, so this
remains a soft cap. Siblings and other conversations can start before their earlier
usage is reported, and unknown usage contributes nothing to the budget.

A routine firing goes through the same admission. When its member is over budget, the
firing fails with reason `usage_limit`. That counts as a failure, so the tenth
consecutive one disables the routine as the
[scheduled routines](scheduled-routines.md) switch-off does. The firing has already
opened its conversation and started its idle workflow, as every firing does.

### Conversation handoff

A [handoff's](handoffs.md) reserved first request is a model call on the target member,
with a transcript of up to 64 KiB. Each of its segments that returns is recorded under
the target and counts toward the target's budget, and their records name the initiator
`{ kind: "handoff", id }`. The target's budget is checked once, inside the handoff's
transaction before it commits: a target at or over its budget refuses the POST with
`409 usage_limit`, and, like the handoff's other refusals, that writes nothing, not even
a `usage.request_refused` row. After the commit, no budget check refuses the reserved
request, even if the target's budget ran out in between. A refusal then would leave the
source sealed and the target `handoff_pending`: until the window or the budget allowed
the request if `MemberClient`'s check refused it, and for good if the workflow's own
admission did, because that refusal closes the target's workflow. So the
reserved request can take the target past its limit by one turn, as any request
admitted before the limit can. Every other request to the target meets the budget as
usual.

### Approval expiry

An [approval deadline](approval-expiry.md) that expires a Claude or Pi card cancels its
request, as an owner's cancel does. The segment that proposed the card had already
returned, so its row is in the ledger and keeps counting toward the member's window and
the owner's totals. The workflow then resumes the native session with a cancelled tool
result under a new launch generation, and that segment, which writes the turn's reply,
is metered too. The budget never refuses it: the request was admitted before it ran. A
Codex live card's deadline interrupts its running turn instead, which ends `uncertain`
and, like any segment that does not return, records nothing. A routine firing whose
card expires fails `approval_expired`, not `usage_limit`.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `usage.budget_set` | owner | a budget is set or its limit changes | member + revision | `revision`, `tokenLimit`, `period` |
| `usage.budget_cleared` | owner | a budget is cleared | member + revision | `revision` |
| `usage.request_refused` | system | admission refuses a request under the budget | conversation + request | `tokenLimit`, `usedTokens`, `period`, `windowStart`, `budgetRevision`, optional `routineId` |

Refused HTTP calls left no audit row before this. A budget refusal is the first that
does, for three reasons. It is Crew's own decision under a policy the owner set, not a
malformed or unauthenticated call. The owner needs to see it, because a routine stopped
by the budget runs with nobody watching. And it has a natural key: it names a request
identity in a conversation the owner already has, so retrying the same request adds no
row. A client that sends new request IDs in a loop adds one row per ID. The refused
request has no admission, so the row names the owner as initiator, and `routineId`
names the routine whose firing submitted it, as `conversation.opened` does.

The [audit filters](audit-filters.md) take the three types like any other:
`eventType=usage.request_refused` returns the refusals, and `memberId` and
`conversationId` narrow them. Because a refusal names the owner as initiator,
`initiatorKind=routine` and `initiatorId=<routineId>` do not return a routine's
refusals; no filter reads `routineId` from the payload.

A refused request sends no [outbound webhook](webhooks.md#handoffs-approval-expiry-and-usage-budgets),
because it never finishes; a routine's refused firing is sent as
`routine.firing_settled` with status `failed`.

Pricing adds no audit type. The price table is the operator's deployment configuration,
like a profile, not an owner's action through the API, and Crew audits neither. Each
estimate keeps the rates it used on its own append-only row, which is the record an
owner needs to see why two like segments cost differently. A trusted-context request's
row is not audited either, as no member-lane row is.

## Telemetry

The `model.invoke` span gains `usage.state` and, when the segment reported counts,
`usage.input_tokens` and `usage.output_tokens`. It carries no model name and no cost.
The turn runner that ends the span exits before the supervisor host prices the segment,
so an estimate on the span would need a second pricing path outside the writer; the
ledger and `/v1/usage` are where cost is read. The trusted-context lane emits no spans,
as before.

## Upgrade and recovery

Migration 31 creates the two tables and replaces two CHECK constraints NOT VALID:
`audit_events_type_check`, last set by migration 29, adding the three types to its 22,
and `routine_firings_reason_check`, last set by migration 28, adding the failure reason
`usage_limit`. Existing rows are neither rewritten nor checked. Each replacement repeats
the whole predicate it replaces, clause for clause, so `migrate()` refuses to apply a
migration numbered 27 or above whose version is below one already applied: applied
later, it would silently drop what the newer one allowed. Releases up to 26 shipped
migration 22 after 26, so earlier gaps still apply. Until `migrate()` commits it holds
`SHARE ROW EXCLUSIVE` on `members` and `native_launches` for the foreign keys, and
`ACCESS EXCLUSIVE` on `audit_events` and `routine_firings`. As in migrations 25 to 30, it
takes all four with `NOWAIT` and retries, so it never waits in a lock queue. Applied
alone, from version 30, it holds nothing while it retries; applied with 27 to 30 in one
transaction, it retries while holding their locks. A running native turn's admission
transaction holds only `ACCESS SHARE` and row share locks, which these modes allow, so a
live upgrade never waits for a turn. After 60 s without the locks it fails with `55P03`
and applies nothing. Turns that started before the upgrade are metered when their
segments return.

Migrations 27 to 30 (handoff, approval expiry, member instructions and audit filters)
come before 31. A development database that ran a build of this feature from before
they were merged holds 31 without them. Every gateway, worker and CLI process then
refuses to start with `Migration 27 would apply after migration 31` and applies
nothing. Applying them there would be wrong: 27 to 29 would each replace 31's type
CHECK with one that lacks the usage types, and 28 would fail to find the reason CHECK
it replaces. Recreate such a database, or restore a backup taken before that build. Do
not delete its `schema_versions` row.

A database that was at version 30 when it ran such a build is not refused: 31 applied
above 30, with the CHECKs as they stood before 27 to 30, and this release finds 31
applied and starts. From then on the database refuses, with `23514`, every
`conversation.handed_off`, `approval.expired` and `member.instructions_set` audit row
and every firing that fails `approval_expired`, so the actions that write them fail. On
a database at version 31 this query returns `f` in either column in that case:

```sql
SELECT bool_or(conname = 'routine_firings_reason_check' AND pg_get_constraintdef(oid) LIKE '%approval_expired%') AS reasons,
       bool_or(conname = 'audit_events_type_check' AND pg_get_constraintdef(oid) LIKE '%member.instructions_set%') AS types
  FROM pg_constraint WHERE conrelid IN ('birbcrew_ts.routine_firings'::regclass, 'birbcrew_ts.audit_events'::regclass);
```

Recreate it, restore a backup taken before that build, or run this release's two
`ALTER TABLE` statements from `031-usage.sql` (the reason CHECK and the type CHECK) on
it by hand.

Migration 35 adds `estimated_cost_usd`, `estimate_price` and `trusted_request_id` to
the ledger, all nullable without a default, so no row is rewritten; drops `NOT NULL`
from `token`; and adds three CHECKs and a foreign key to `trusted_requests`, all
`NOT VALID`, so no row is scanned. Rows written before it keep no estimate: the price
table never reaches back. It builds one partial unique index, which holds no row but
reads the whole ledger once under the lock below, so that pause grows with the ledger's
size. Until `migrate()` commits it holds `ACCESS EXCLUSIVE` on `usage_ledger` and
`SHARE ROW EXCLUSIVE` on `trusted_requests`, taken with `NOWAIT` and retried as 25 to 32
do. Only short statements hold either table, and a running trusted turn's lease reads
`trusted_requests` under `ACCESS SHARE`, which the migration's mode allows. `migrate()`
refuses to apply a lower-numbered migration after it.

From this release a member's budget also counts its trusted-context requests, which
were not recorded before, so a member that serves both lanes reaches its limit sooner.
Its member-lane requests, its routines' firings (ten consecutive `usage_limit` failures
disable a routine) and handoffs to it are then refused, while its trusted requests are
not. Review such members' limits after upgrading.

A coordinated restore rewinds the ledger and the budgets with the rest of the
database, and Crew changes neither when the restored installation resumes:

- **Ledger.** Rows recorded after the recovery point are gone. Those tokens were spent,
  so until the window ends the budget counts less than the member used. Crew cannot
  rebuild them: the native sessions do not hold reliable counts. The provider's own
  bill stays the source of truth. The ledger's identity resumes at the recovery point,
  so new rows get `usageId`s the discarded rows had. Unlike the audit trail, whose
  identity a restore moves past every earlier ID, the ledger keeps no fence epoch.
- **Budgets.** A budget set, changed or cleared after the recovery point returns to its
  earlier state, so a restore can bring back a higher limit or none at all. A standing
  grant restored that way is revoked on resume, because revoking is always safe. A
  budget has no safe value to fall back to: Crew cannot know the newer limit, and
  inventing one could stop work the owner allowed. So it leaves budgets as restored.
  After a restore, check each member's budget with `GET /v1/usage/budgets/{memberId}`
  and set it again.
- **Estimates.** An estimate lives on its row, so it is rewound with the row and never
  recomputed. The price table is a file outside the database, so a restore leaves it as
  the operator last set it, and rows written after resume use it.

## Not covered

- Built-in prices. Without the operator's table, or for a model it does not price, a
  segment has no cost unless the provider billed one.
- What a provider actually charged, beyond what Pi passes on: an estimate is the
  table's rates times the counts (see [Estimated cost](#estimated-cost)).
- A budget refusal in the trusted-context lane. Its tokens count toward the member's
  budget, but nothing refuses its requests.
- Tokens of segments that fail, are cancelled or lose their worker. The budget
  undercounts them.
- Calls the Claude CLI makes outside the main agent loop, if any.
- Budgets per owner, money budgets, other windows, and a warning before the limit.
  Budgets count tokens; an estimate never refuses anything.
- Retention or deletion of ledger rows.

## Validation

Use Node 24.22.3 on Linux, a C compiler for `scripts/build-native`, and a disposable
PostgreSQL 17 database whose role may create databases.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:usage
npm run test:usage:capture
npm run test:trusted
npm run test:recovery
```

The integration API workflow's `consumer-contract` job runs both after `npm run build`,
which builds the native launcher the capture suite starts Claude, Codex and Pi through.

`usage-capture.test.ts` runs the real drivers against the local fixture providers. It
checks that Codex records each turn's share of the running total over three resumed
turns, and `unknown` when the provider sends no usage; that Claude records each query's
own usage for a chat turn, a proposal and its resumed answer; and that Pi records each
call through pi-ai's Chat Completions adapter, including a proposal and its resumed
answer, and `unknown` for the faux fixture. It starts the real supervisor host and
runners, with no Temporal, and checks one ledger row per launch for all three engines,
no second row for a repeated start, and the `model.invoke` attributes. It also checks
the mapping rules: a billed cost kept only when billed, counts that go down or cannot be
read. It checks the model each engine names: Codex's from its rollout, the last turn's
only and none when that turn's entries disagree, and Pi's answering model, including a
routed answer taken from the reply the host relayed to the confined worker. It prices
segments with every part of the input, exactly at the largest counts and rates the
ledger and table accept, and refuses an estimate with no table, no price, no model, a
billed cost, nothing reported or parts larger than the input; it refuses every kind of
malformed price table, names no contents in the error, and stops a worker and a
supervisor host started with one. The real supervisor host, reading the table from its
environment, writes the Claude segment's estimate and rates.

`usage.test.ts` runs against PostgreSQL. It checks one row per launch, bound to the
launch's execution, the CHECKs on `reported` and `unknown` rows, a refused row kept as
`unknown`, and the append-only ledger; the totals, routine subtotal, pages, time ranges
and strict queries of every route, with another owner seeing nothing and getting 404 for
this owner's IDs; setting, repeating, changing and clearing a budget and their audit
rows; refusal at both checks and through the gateway, one audit row per refused request,
no refusal of an admitted or running request, the soft cap, the UTC day window, and the
mapping of the admission activity's failure; a handoff to a target over its budget
refused with nothing written, and a reserved request admitted and metered on the target
under the handoff initiator although the target's budget ran out after the commit;
requests refused as handed off, pending their handoff, over their conversation's request
bound, over the prompt bound or reusing a routine firing's identity with other text,
which get that refusal from both checks and no budget refusal; a seal, an admission, a
started turn or the trusted lane that commits while the pre-check waits for the
conversation, each seen under its lock; a request whose card expired, with both the
segment that proposed the card and the one that resumed with the cancelled result
metered and counted; a routine firing failing `usage_limit` until the routine is
disabled, refused once by the pre-check and once on the race path, both naming the
routine, and found by `eventType` and not by `initiatorId`; migration 31 on a version-30
database, its locks, no rewrite, NOT VALID CHECKs, both CHECKs read back from PostgreSQL
and compared clause for clause with 29's and 28's, and no wait for a running turn;
`migrate()` refusing to apply a migration below one already applied, including on a
database that ran this feature before 27 to 30, while a database that lacks migration
22, as releases before 27 left some, still upgrades; every firing reason the dispatcher
names being one the reason CHECK allows; the capabilities' usage values, which it pins;
and a held installation refusing usage writes.

`usage-cost.test.ts`, which `npm run test:usage` runs with it, covers cost, the trusted
lane and migration 35. For cost it checks an estimate written with the rates it used and
kept when the price rises, a table that skipped validation costing a segment its
estimate but never its counts, a retried write adding nothing under another price, a
billed segment never estimated, unpriced, unnamed and unknown segments left without
one, billed and estimated totals kept apart in every route, another owner's estimate in
neither owner's totals or records, and the CHECKs that keep the two apart. For the
trusted lane it checks one row per trusted request, none for a stale claim or another
owner, the `trusted` lane and owner initiator in records and its part of every total,
its tokens in the member's budget, the row surviving `erase()`, the lane CHECKs and
keys, and a table built in code that the file rules refuse stopping `runTrustedRequest`
before it claims a request. Migration 35 is applied to a version-34 database: no
rewrite, its locks, NOT VALID constraints, a retry instead of a queue while a ledger
write holds the table, no wait for a running trusted turn's lease, and earlier rows left
unestimated.
`audit.test.ts` runs every audit filter over two owners' usage rows in JSON and CSV.

`recovery.test.ts` (it needs PostgreSQL 17 `pg_dump`, as the other recovery tests do)
restores a real dump taken after a budget and a segment were recorded. It checks that
capture counts both tables, that a held source refuses a budget change, and that after
more usage and a tighter limit on the source the restored installation has the earlier
limit and the earlier total, unchanged by resume, and admits the request the source
refused.

`trusted-runner.test.ts` (`npm run test:trusted`) runs `runTrustedRequest` with the real
Pi, Claude and Codex SDKs against fixtures that report usage, through a tool round trip
and a context rotation, and checks one priced row per trusted request with the counts
of every model call it made.

`npm run test:api:service` (the integration API workflow's `actual-service` job, with
Temporal) gives its worker a price table and reads `/v1/usage` back over HTTP: each of
six Claude and six Codex turns carries its estimate, the Codex model comes from its
rollout, Pi's fixture reports nothing, and the owner's billed and estimated totals stay
apart. The other service proofs run the same supervisor host but do not read the ledger.
So these are not exercised end to end: a refusal by the admission activity inside a real
workflow (the mapping is tested with a constructed failure), the workflow closing that conversation,
a handoff's reserved request metered through Temporal, and a gateway's dispatcher firing
a routine on Temporal. A Pi child's segment is recorded by the same insert with its
`childId`. `npm run test:child-targets` runs one child workflow through Temporal and the
supervisor and reads its row, and prices child rows by the model each reported, but no
test reads the ledger after a whole delegation. Real providers were not called, so the
field mappings and model names rest on the SDK types and the fixtures, and no estimate
has been compared with a provider's bill.
