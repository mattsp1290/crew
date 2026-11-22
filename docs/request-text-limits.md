# Request text limits

Cursor and OpenCode profiles accept `requestTextBytes`, an integer from 16,384
through 65,536 UTF-8 bytes. Omission means 16,384. The prompt and document share
this budget. This is a byte bound, not a provider token-context guarantee.
Replies remain bounded to 65,536 bytes and each text conversation still has one
turn. Text members do not gain instructions, handoffs, tools, or usage metering.

## Configure and discover

Trusted profile modules set the field beside `accountId`, outside driver options:

```ts
profiles.set("cursor-report.v2", {
  accountId: "report-account",
  requestTextBytes: 65_536,
  cursor: { model: "composer-2", apiKey: credential, cwd: "/srv/reports" },
});
```

Live JSON accepts the same optional field inside `cursor` or `opencode`.
It is copied to the top-level profile, never to an SDK option or credential map.
A fresh installation can configure its built-in `cursor.v1`/`opencode.v1` this
way. Registration is immutable: an already registered `cursor.v1` at 16,384
stays at 16,384. Changing its value fails startup. Use a **new profile name in a
trusted module and a new member** to adopt a different value. Existing members
and conversations keep their policy. No profile setter or automatic rebind exists.

`GET /v1/members` includes `requestTextBytes` for every text member, using the
registered PostgreSQL policy, scoped to the authenticated owner. Native listings
omit it. Spawn responses do not promise the field. Clients reading an older
server or a response without it must assume 16,384, never a larger value.
Historical text members with no profile registration use 16,384 until the first
registration; a first registration may retain or raise that fallback. HTTP spawn
requires a published profile. Once registered, the policy is immutable.

## Submission and error order

Both `/v1/conversations/{id}/requests` and legacy
`/conversations/{id}/inputs` enforce the same text-member policy before any
workflow call. An N+1-byte fresh request returns HTTP 400 with exactly
`{"error":"invalid_input"}`. It creates no admission, turn or native launch;
the conversation can accept a valid request with that UUID afterwards.

The server parses strict body keys and nonempty, well-formed decoded text without
NUL first. It then resolves the owner-scoped conversation. A missing or foreign
conversation returns 404. A fenced text conversation returns 410 `conversation_erased`
before digest comparison or size validation. For an unfenced conversation, a reused request UUID compares exact text and deadline
terms before the text-member size decision: changed valid text returns 409
`conflict`, including text above the profile or internal ceiling. Exact replay
keeps its recorded outcome; it does not consume another turn. No Unicode,
line-ending or whitespace normalization occurs. Existing malformed-wire decoding
is unchanged. Empty text, NUL and unpaired surrogates remain invalid; other
controls retain their prior validity, with OpenCode's separate prompt restrictions.

A second fresh valid UUID returns 409 `input_limit`. OpenCode still refuses a
slash-prefixed line or forbidden control with 409 `conflict` before it takes the
turn. A reply above 65,536 bytes leaves the request receipt `uncertain`, with no
committed reply. Repeating that request returns 409 `conflict`; choosing a new
UUID cannot bypass the one-turn budget. Reconcile using the original receipt.

Raw JSON is independently capped at 128 KiB. Escapes, keys and identity fields
count toward that transport cap: 65,536 quote characters fit the decoded policy
but exceed the raw cap and return 413 `request_too_large`. A supported decoded
size does not promise every JSON encoding fits. The portable client permits the
structural envelope; the server owns the contextual byte decision. Native HTTP
requests still use 16 KiB, even for a reserved handoff. Native owner and routine
admission remain 16 KiB; internal reserved native handoffs remain 64 KiB.

Size refusals emit `request_text_refused` diagnostics with conversation/request
IDs, profile, limit and byte count. Prompt and reply content are never logged.

## Persistence and qualification

`request_admissions` and `turns` store prompt digests. Input text also appears in
`public_snapshots.messages`, the retained tail of up to 256 `public_events`, and
Temporal update, admission/turn activity and history payloads. Replies remain
in `turns.reply`, observations and history. Session-directory cleanup does not
erase those copies. PostgreSQL has no automatic content TTL. Temporal retention
is controlled by the deployment. [Owner content erasure](integration-api-v1.md#erase-text-conversation-content)
clears retained SQL and enrolled volume copies after closure and positive writer proofs.
Temporal history remains until retention; WAL, backups and provider copies remain outside this operation.

The offline fixture uses synthetic Cursor/OpenCode doubles, PostgreSQL 17,
Node 24.22.3 and Temporal CLI 1.10.0. It exercises 16,384, 32,768 and 65,536-byte
profiles; both HTTP routes; no-workflow-call refusal; recovery on the same
conversation; exact replay/conflict; maximum input plus maximum reply; snapshots,
observer bootstrap and complete history replay. Escaped JSON is included.
See `tests/fixtures/request-text-sizing.json` for measured budgets. Set
`BIRBCREW_TEXT_EVIDENCE_DIR` to retain histories and sizing output from
`tests/service/text-member-gateway.test.ts`. The emitted `sizing.json` uses
the checked-in record format and can replace the fixture after a deliberate
requalification. Tests compare stable prompt/reply digests and converter sizes
while checking every current payload/event against the recorded budgets. The dedicated `text-members` CI job
runs both text-member suites and shared-validation tests without paid inference.

A text conversation completes its public one-turn outcome below the normal
four-turn rollover threshold. Current runs close naturally after the turn. The
checked-in idle history captures predate owner erasure and remain replay fixtures. Sizing
waits for all activities and the workflow task to settle, then verifies the
recorded admission/turn inputs and exact reply before measuring and replaying
the complete recorded history prefix. The maximum-size path has no
Continue-As-New. Existing rollover regressions test native routing independently.
The erasure-aware workflow uses a patch marker to preserve replay of older idle histories.

## Upgrade and recovery

Back up the existing database normally. Migration 043 adds a defaulted immutable
column without resetting content or rebinding registrations. It retries the
DDL lock with NOWAIT for at most five seconds, keeping later profile readers
out of the lock queue. Exhaustion aborts the whole migration, including the
version record. The CHECK enforces new writes without scanning old rows,
whose new column already defaults to a valid 16,384. Drain calls and retry if
the migration cannot acquire the lock.

Upgrade **all workers first**, while the old gateway still admits at most 16 KiB.
Record worker revision and queue-poller evidence that no old worker can take
large work. Then deploy the gateway, register the new profile, verify discovery
and run a synthetic request. Existing profiles stay unchanged. Enabling larger
profiles requires passing qualification against the deployment's effective
Temporal payload/message limits; local fixture headroom does not configure a
production installation.

For rollback, stop **all** submissions to larger-profile members, including
small requests, from gateways, routines and CLI submitters. Keep new workers
serving until accepted-but-unadmitted and in-flight work is drained. Enumerate
affected conversations through members/profiles and reconcile original update
IDs using Temporal history and receipts. Pending SQL counts or an empty pending
activity list alone do not prove idle: also inspect pending workflow tasks,
unresolved accepted updates and any successor run, with submitters quiesced.
Keep queue/revision evidence. An old gateway rejects a large POST with 400;
GET receipts can still recover committed results.

**Worker downgrade is not an available recovery procedure unless the operator
can prove this drain predicate and rehearse the old binary against the migrated
database.** If the runtime cannot prove idle, or the rehearsal fails, keep the
new workers and forward-fix. Retain the additive column and all content; do not
reset the database or edit immutable profile authority. No production rollout
or rollback is performed by the fixture tests.
