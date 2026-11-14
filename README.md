# Crew

Crew runs durable Claude, Codex and Pi coding coworkers through their TypeScript SDKs. Temporal orders turns and human decisions. PostgreSQL stores the conversation and its AG-UI history. The original Python proof remains available.

## Repository name and compatibility

The canonical repository is [mattsp1290/crew](https://github.com/mattsp1290/crew),
formerly `mattsp1290/birbcrew`. Use the new URL for clones and Git remotes:

```sh
git clone https://github.com/mattsp1290/crew.git
git remote set-url origin https://github.com/mattsp1290/crew.git
```

This repository rename does not migrate existing installations or published
contracts. Python imports/distribution (`birbcrew`), the `@birbcrew/pi-subagents`
package, `BIRBCREW_*` configuration, persisted paths and identifiers, and native
prompt/protocol labels retain their existing names. Keep using the documented
commands and configuration. Historical milestone documents and captured evidence
also retain the name used when they were recorded.

Run `scripts/setup`, then `scripts/verify`. The verifier starts disposable local
services, generates credentials, uses an isolated Beans fixture, drives two
AG-UI SDK clients, injects process failures, and prints the evidence directory.

See [the verification procedure](docs/verification.md) for prerequisites and the
separate subscription journey. See [the design](docs/architecture.md) for state
ownership and limits. [The first milestone](docs/first-milestone.md) defines the
acceptance contract. Authentication and permissions require human review before
merge. This repository does not provide production authentication or deployment.

### Verify the three SDK integrations

On Linux with Docker, run `scripts/verify-adapters`. It installs the locked
production dependencies in a fresh consumer, then runs the official AG-UI HTTP
client with external networking disabled. Each SDK answers prompts in two
independent conversations, reports a provider failure, and cancels a streaming
reply when the client disconnects. The model responses are scripted locally.

For local development, use Node 24.22.3 and run `npm ci`, `npm run typecheck`,
and `npm test`. The TypeScript fixtures exercise all three integrations with real SDKs and local model responses. Package pins and rebuild
instructions are in [the adapter reference](vendor/ag-ui/README.md).

### Use an operator-controlled AI proxy

See [AI proxy profiles](docs/ai-proxy-profiles.md) for explicit Claude Messages,
Codex Responses and Pi Chat Completions routes, request-scoped credential renewal,
and offline/live validation instructions. Run `npm run test:proxy` after building
the native launcher; the tests require Linux Landlock support.

### Run durable Claude, Codex and Pi members

A member's SDK and execution profile are fixed at spawn. The TypeScript worker
uses Temporal to order turns and PostgreSQL to store the member, each
conversation's native checkpoint, and its committed replies. Claude and Codex also need
the same private state directory when a worker is replaced.

Run `scripts/setup --mode fixture` to install the locked dependencies and build
the native launcher. Run `scripts/verify --mode fixture` for the combined
TypeScript verification, or add `--engine claude`, `--engine pi`, or
`--engine codex` to exercise a single SDK. The verifier runs on Linux with
Docker, Git, Beans, a C compiler and Linux development headers. The
[verification procedure](docs/verification.md) describes kernel requirements,
the pinned toolchain and the optional redacted evidence file.

For an existing local installation, set `BIRBCREW_DATABASE_URL` to a dedicated
PostgreSQL database, `BIRBCREW_TEMPORAL_ADDRESS` to the Temporal endpoint,
and `BIRBCREW_STATE_DIR` to an absolute private directory on persistent storage.
These are trusted local operator commands. The owner field comes from the local
operator. Use the fixture profile to run without provider accounts. The
[persistent deployment guide](docs/persistent-deployment.md) covers the container
image, the Temporal namespace and mTLS settings, storage and the database role.

```sh
npm run members -- worker tests/proof/fixture-profiles.mts
```

Run the following commands in another terminal with the same database and
Temporal settings. Generate your own request and conversation UUIDs.
Substitute the member ID printed by the first command.

```sh
echo '{"ownerId":"local","requestId":"92090532-d939-43d9-847e-0e439eb74f6c","engine":"pi","profile":"fixture.v1"}' | npm run --silent members -- spawn
echo '{"ownerId":"local","memberId":"<member UUID>","conversationId":"c31bb038-d19e-46bc-a76d-a12526156a0e"}' | npm run --silent members -- open
echo '{"ownerId":"local","conversationId":"c31bb038-d19e-46bc-a76d-a12526156a0e","requestId":"d25a62d7-b003-43fb-a8a7-20ba04887508","text":"remember cedar"}' | npm run --silent members -- turn
```

Use `"engine":"claude"` or `"engine":"codex"` at spawn to select another SDK. In a fixture conversation,
send `recall` with a fresh request UUID to retrieve the remembered value. Reuse
the original request UUID and text to recover its recorded reply after a lost
acknowledgement. A new conversation admits 128 distinct requests; see
[bounded conversations](docs/bounded-conversations.md). If a worker
disappears during native generation, a replacement records the uncertain outcome
and closes that conversation to further turns.

To give conversations project notes, set `BIRBCREW_NOTE_INSTALLATIONS` on the
process that opens conversations. It names an operator-managed JSON file
mapping owner IDs to a source, for example
`{"local":{"root":"/tmp/birbcrew-local","project":"release","actor":"coworker"}}`.
Use a temporary installation containing a clean `hub` Git checkout on `main`
with no remotes. Crew captures up to two Beans memories when the conversation
opens. The root member uses that private snapshot on later turns and tool resumes,
even if the original hub is removed.

Use the [HTTP gateway guide](docs/member-gateway.md) to submit turns, decide
protected tool requests and attach independent AG-UI observers to these members.
The [audit trail](docs/audit-trail.md) records who spawned, opened, submitted,
decided, cancelled and completed what, and when. Each owner can page or export
their own trail as CSV through `GET /v1/audit`, and [filter](docs/audit-filters.md)
it by member, event type, actor or initiator kind, routine or handoff, and time window.
[Scheduled routines](docs/scheduled-routines.md) let an owner give a member a cron
schedule and a fixed prompt; the gateway submits each run in a new conversation,
with nobody present, and records the routine as the request's initiator.
[Outbound webhooks](docs/webhooks.md) tell an owner's HTTPS endpoint, through
`/v1/webhooks`, when a card or question becomes pending, a request finishes, a
routine firing settles or Crew disables a routine after ten failures in a row. Each
call to a `crew` endpoint is signed and carries only IDs and a status. A `slack` or
`ntfy` endpoint instead gets an unsigned, short readable message of the same IDs,
status and tool name, which a chat or push service shows to a person.

An owner can answer a work-item approval with a [standing grant](docs/standing-grants.md)
for the rest of the conversation or for every conversation of the member. Later calls
it covers proceed without a card and name the grant. Grants are listed and revoked
through `/v1/members/{memberId}/grants`. Crew cannot tell a person from an automated
client holding the owner's token, so a grant covers both.

An owner can give a request or a routine an [approval deadline](docs/approval-expiry.md)
of one minute to seven days. A Claude or Pi card still undecided at its deadline is
settled without a person: Crew cancels the request and records `approval.expired`.

[Usage metering](docs/usage-metering.md) records the token counts each engine reports
for every native segment that returns, one row per segment in the member lane and one
per request in the trusted-context lane, with a provider-billed cost or, from a price
table the operator supplies, an estimated one, kept apart; Crew ships no prices. An
owner reads totals per member and conversation through `/v1/usage` and can give a
member a daily token budget; a member at its budget is refused new requests with
`409 usage_limit`, as a soft cap.

An owner can save [member memory](docs/memories.md) through `/v1/memories`: up to 32
short facts per member. Each conversation of the member outside the trusted-context
lane gets the facts that were active when it opened, as system context framed as
reference data. Only the owner writes memory; the model cannot. Deleting a fact erases
its text, but Codex, and Claude where its SDK records the prompt, keep the context a
conversation's first turn saw, and native session files and Pi checkpoints keep copies.
Memory reaches every later conversation of the member outside that lane, so whoever
holds the owner's token can steer them all.

An owner can [hand a conversation off](docs/handoffs.md) to another of their members,
often of another engine, through `/v1/conversations/{conversationId}/handoffs`. The source
is sealed and stays readable. A fresh target conversation's first request carries a
verbatim transcript of the source's newest committed turns, up to 64 KiB, as a user
message quoted as data; tool calls, approvals and native state do not cross. The owner
continues in the target. Model replies from the source reach the target at user rank, so
hand off only conversations whose replies you would paste into a prompt yourself.

An owner can give a member [instructions](docs/member-instructions.md) when they spawn
it: up to 16,384 bytes describing its role. They are fixed for the life of the member,
come before project notes and memory in every native launch of its conversations except
a Pi child's and the trusted-context lane's, and never change its tools, approvals or
limits. Only the owner reads the text back, through `/v1/members/{memberId}/instructions`;
listings and the audit trail carry its digest.

An owner can write [instruction packs](docs/instruction-packs.md) through
`/v1/instruction-packs`, text several members share, and attach up to eight to a member when
they spawn it. A pack never changes, a member's packs are fixed for its life, and a pack any
member has cannot be deleted. Packs come before the member's own instructions in the same
launches and share their 16,384 bytes. They never change a member's tools, approvals or limits,
but the model follows them as the owner's instructions, so a pack built from untrusted text is
a prompt-injection path to every member that has it.
