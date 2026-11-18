# Conversation ownership

## TypeScript members

An owner spawns a member with a fixed engine and execution profile. Each conversation under that member has its own Temporal workflow, native session and PostgreSQL checkpoints. The authenticated gateway submits commands and serves the committed AG-UI event stream to independent observers.

Pi and Claude release the inference worker during a confirmed human wait. Pi can delegate to two child workflows with separate native sessions and one shared write budget. Codex keeps its invocation-scoped MCP call open until the owner responds or the deadline expires. SQL records the decision, effect receipt and confirmation of native delivery separately. On interruption, clients can distinguish a proven zero-effect call from a committed receipt with unknown delivery. See the [gateway contract](member-gateway.md).

### Named child targets

An operator profile declares destinations by fixed role in `childTargets`. `registerProfiles` seals each parent engine and profile on its first registration. The seal contains either legacy mode or the initial named role map. A separate active-role array can only shrink. Existing profiles and members remain legacy when migration 037 runs.

Member spawn copies the currently active destinations into immutable `child_target_consent`. Spawn and owner-scoped member listing return that original identity with its current availability. Each destination includes engine, profile, model, canonical provider host, and account digest. The projection reads consent and availability in one SQL snapshot. The API request remains `{engine, profile, requestId}`. The model still proposes only `{role, task}`.

`ChildStore.delegate` resolves each role against both the member's consent and current profile authority. It pins the target's model and writes the full versioned identity inside `pi_children.role_profile.target`. Missing or removed named roles fail without a legacy fallback. SQL independently checks fixed instructions, tools, model, and the actual joined parent consent, and prevents changes to any stored role profile. Profile registration, spawn, removal, and child insertion serialize through the same engine/profile advisory lock, including writes from older binaries.

Removal blocks child insertion after the removal commits. A child recorded before removal may start, retry, or resume after approval on its recorded destination. Every native admission reads the owned child generation and compares its engine, profile, model, provider host, and account digest with the loaded configuration before a provider call. Configuration drift fails closed. Removal introduces no cancellation or deadline change.

Only Pi parents and Pi children execute. A named Pi target needs the fixed role's tools but does not need permission to delegate. Claude and Codex declarations can describe future analyst destinations and report `unsupported_engine`. Claude parents permit only analyst. Codex parents cannot declare recorder, and Codex children cannot receive tools. The drivers still refuse non-Pi child execution. Children receive no conversation context, member instructions, or instruction packs.

Workflow keys carry only engine and profile. Activities read the authoritative child row and reject an incorrect queue before reserving a launch. The full versioned target makes an old strict reader refuse the child even on the correct queue. Historical two-field targets remain available for inspection and settlement but cannot launch after migration 037. Untargeted legacy Pi children retain their execution path. Replay does not compare activity queues, so this runtime refusal remains necessary.

Restore activation clears every named profile's active roles in the same transaction that retires restored external authority. Seals and member consent remain intact. Enabling new delegation requires a new profile name. Recorded children remain held until existing recovery reconciliation permits activation. An older backup cannot retain removals that happened after its recovery point.

See [Configure named child destinations](member-profiles.md#configure-named-child-destinations) for registration and upgrade steps. `npm run test:child-targets` covers registry authority, races, migration refusal, actual Pi execution, budgets, approval resume, and legacy workflow replay.

## Historical Python proof

One Temporal workflow owns each conversation. Its stable ID derives from the
conversation UUID. Durable Updates accept and deduplicate input, validate human
decisions, and request cancellation. The main workflow loop processes inputs in
order. It never depends on a process-local lock.

A conversation carries a versioned coworker definition, its owner, selected
Beans notes, accepted inputs, agent run attempts, a versioned human request,
resolved decisions, and finalized framework messages. The four-input limit
bounds the proof. Workflow IDs cannot be reused. Continue-As-New, workflow reset,
and replacement are unsupported. A future implementation must preserve accepted
request identities and ordering across those operations before lifting the limit.

## Execution and storage

Pydantic AI's `TemporalDurability` routes model and tool calls into activities.
`AgentEventStream` publishes native events and stays open for the conversation's
entire lifetime. The benign tool inserts a synthetic work item under a unique
operation ID derived from the conversation and accepted request. A retry reads
the existing result. The failpoint waits after commit and before return so the
verifier can kill the worker at that boundary.

`CallDeferred` produces a framework human-input request. The workflow stores its
ID, version, expected principal, and tool-call ID, then waits durably. The HTTP
human endpoint supplies the authenticated principal to a Temporal Update. A
matching repeated decision is a no-op. Another version or conflicting decision
is rejected. The resumed agent receives `DeferredToolResults`.

Application tables live in their own PostgreSQL database. Temporal's development
service uses its own SQLite file. No application code reads Temporal's database.
PostgreSQL stores finalized Pydantic AI messages without converting them back
from client data. It also stores the AG-UI rendering with stable finalized IDs.
Temporary streamed content never replaces that history. The persistence activity
returns canonical message fields through Temporal history, so workflow replay
does not rewrite prior framework timestamps.

## Observation and reconnect

A retryable projection activity consumes the supported Temporal native event
stream and passes it through `AGUIAdapter.transform_stream`. PostgreSQL stores
each projected event under a unique segment and ordinal key. The projector
normalizes generated message IDs and omits optional wall-clock event timestamps
so a retry can finish a partially published stream. The workflow awaits projection before publishing the finalized snapshot.

An AG-UI observation connection starts with `RUN_STARTED`, then sends messages
and state snapshots. Internal agent segments appear as standard AG-UI steps.
The observation endpoint never submits a prompt. Two SDK clients can observe it
independently. A disconnect closes that HTTP stream without cancelling work.

A snapshot and its finalized-state cursor come from one PostgreSQL row.
The live publication cursor is separate. Subsequent events start after the
finalized-state cursor, so a mid-run reconnect replays the unfinished segment. A finalized message snapshot replaces the client's
provisional messages, avoiding duplicate finalized history. The store keeps a
bounded tail of 256 events when saving authoritative state. A supplied cursor must equal the current snapshot cursor. Any other cursor
returns HTTP 410 before streaming. Arbitrary token-cursor resume is unsupported. A cursor that expires during a stream
produces a `CURSOR_EXPIRED` run error and closes the stream. Reconnect then requires a fresh snapshot.
Terminal conversations close their observation stream with an AG-UI terminal event.
The proof does not promise indefinite token replay. Model activity retries may
repeat provisional token text. Finalized snapshots remain authoritative.

## Cancellation and trust

Cancellation is an authorized command with a requested acknowledgement followed
by a persisted outcome. It does not roll back an effect that already committed.
The synthetic effect store remains the record of that effect. Cancellation is
never inferred from HTTP disconnection.

Generated local bearer credentials map to two test principals. Configuration
stores their hashes. The fixture client file holds the local tokens with mode
0600. Every conversation read or command checks ownership. These credentials do
not choose a production login system. Temporal and PostgreSQL are trusted local
services bound to loopback for the proof.

No route accepts a provider endpoint, credential, coworker instructions, or tool
registry from an AG-UI client. The selected Beans context is captured by setup,
from a clean temporary hub with no remotes, and retained with the conversation.

Framework timestamps describe the values captured when history is first
finalized. A workflow replay before that first save can generate a request
timestamp later than its recorded model response. These timestamps are not an
execution-order clock. Temporal history and stable input ordinals establish
ordering. Finalized timestamp values remain unchanged after later replay.

The HTTP stale-cursor rejection and PostgreSQL event pruning are exercised.
The defensive in-stream CURSOR_EXPIRED branch is not exercised by this proof.
Worker OpenTelemetry emissions may include framework replay emissions. Offline
Temporal Replayer telemetry is stored separately and excluded from live-worker
telemetry checks. Span counts are emission counts, not model-request counts.
