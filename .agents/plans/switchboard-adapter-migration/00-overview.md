# Switchboard adapter migration: overview

Status: Ready. Two independent reviews and one adversarial review are
incorporated. Two packages ran while the plan was under review, because each
was decided or evidence-only: S0a (a Beans edit the owner decided outright)
and P0 (probes; Switchboard pull request #69). Nothing else is implemented.

Plan name: `switchboard-adapter-migration`. Beans issues: `crew-0n8g` (Crew);
`switchboard-ishc`, `switchboard-mebb`, `switchboard-rijp`,
`switchboard-bzn9` and the open issues beneath them (Switchboard);
`agentui-wtdo` and its blockers (AgentUI).

## Application context

```json
{
  "application_context": {
    "has_active_users": true,
    "backward_compatibility_required": false,
    "feature_flags": "not-appropriate",
    "confirmation_digest": "047278569a6db95547f4c4d4a583bfd4ab3a768310adcca1e2f1e8198642b0db",
    "confirmed_at": "2026-11-18T18:05:03Z"
  }
}
```

The owner first answered on 2026-11-18 that there were no active users or
external consumers, and then corrected that answer the same day: AgentUI
(`mattsp1290/agentui`) consumes Switchboard and must keep working, and
AgentUI may be updated when a Switchboard change requires it. The owner
confirmed the record above.

What this means for the plan:
- Crew's only consumer is AgentUI's Crew provider, which the owner also
  controls. Asked whether existing Crew conversations must survive a switch,
  the owner answered: "we own both repos. we can change what we need". So
  each Crew switch replaces a native driver outright. Stored PostgreSQL
  rows, Temporal histories and native session files from before a switch may
  become unusable, and workflows in flight may fail. Each switch states how
  a conversation from before it fails: as a closed conversation with a clear
  outcome, never a crash. If a switch changes anything AgentUI's Crew
  provider relies on in Crew's public API, the same package updates AgentUI.
- Switchboard has one consumer besides Crew. This plan adds to Switchboard and
  removes nothing AgentUI imports: the three text-only adapters and their
  export names stay as they are. AgentUI's own checks run against each new
  Switchboard tarball before Crew adopts it (file 08).
- No behaviour is gated behind a flag.

## Change type and affected areas

- Change type: dependency transition and internal re-architecture across
  three repositories that the owner controls.
- Crew (this repository): `src/service/` engine drivers and their workers,
  `native/member-launch.c`, `package.json` pins, `vendor/`,
  `tests/fixtures/engines/`, `tests/service/`, `tests/proof/`,
  `.github/workflows/`, `packaging/`, `scripts/` and `docs/`.
- Switchboard (`mattsp1290/switchboard`; the implementer sets
  `SWITCHBOARD_REPO` to a new worktree or clone made from `origin/main`):
  `src/core/`, `src/adapters/`, `adapters/`, `src/testkit/`, `scripts/`,
  `docs/architecture/`, `docs/qualification/`, `tests/`, `package.json`,
  `.github/workflows/ci.yml`, and the Beans project `switchboard`.
- AgentUI (`mattsp1290/agentui`; `AGENTUI_REPO`, a new worktree from
  `origin/main`): `vendor/`, `packages/host/package.json`,
  `package-lock.json`, `docs/protocol/conformance.json`, and the Beans
  project `agentui`.

## Requested outcome and success criteria

Outcome: Crew drives Claude, Codex and Pi through packaged Switchboard
adapters; every issue that blocks `crew-0n8g` is closed, or re-scoped by a
recorded owner decision; AgentUI still passes its own checks on the
Switchboard revision Crew adopts.

The work is complete when all of these hold:

1. Import rule. A test in `tests/fixtures/engines/artifacts.test.ts` asserts
   that under `src/service/` only the files in this allowlist import the
   named packages, and no other file imports any of
   `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`,
   `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
   `@earendil-works/pi-agent-core`, `@ag-ui/claude-agent-sdk`, `@ag-ui/pi`,
   `@modelcontextprotocol/sdk`:
   - `pi-launch.ts`, `pi.ts`, `pi-channel.ts`, `pi-state.ts`,
     `pi-worker.ts`, `live-profiles.ts`, `proxy-profiles.ts`:
     `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, because
     the host relays model requests, the worker builds the relay stream, and
     the host verifies the worker (decision D3).
   - Files that import `@birbcrew/pi-subagents` today keep doing so.
   The test is added in C1 with an allowlist that also names every file not
   yet switched (`claude-worker.ts`, `pi-session.ts`, the `trusted-*` files);
   C2b, C3 and C4 each remove entries. The list above is the end state. No
   package adds an entry that is not in its own change surface.
2. A second test asserts that the transitive runtime imports of
   `src/service/workflow.ts` contain no Switchboard module. Type-only imports
   (`import type`) do not count.
3. Crew's `package.json` pins one Switchboard tarball that contains the three
   full adapters. The installed `@openai/codex` binary version, the Claude
   SDK version, the Pi package versions and the MCP SDK version equal the
   versions that tarball declares as peers or exports as its qualified
   native versions. A test asserts each.
4. Every workflow under `.github/workflows/` passes on `main`, including the
   engine-fixture workflow that package C0 adds. Crew's workflows trigger
   only on pull requests and manual dispatch, so "passes on `main`" means a
   `workflow_dispatch` run on `main` whose run identifier is recorded on
   `crew-0n8g`.
5. The behaviours `crew-0n8g` names are each demonstrated by a named test or
   proof after the switches: Temporal and PostgreSQL admission, recovery
   fencing, authorization, the approval and question tools, proxy routes,
   ChatGPT-subscription Codex members, native session resume, the Codex
   built-in tools the member lane offers today (`view_image`,
   `request_user_input`), refusal of ambient engine configuration, and the
   public HTTP routes in `docs/integration-api-v1.md`. File 10 maps each to
   its test. One exception, by owner decision D22: the `trustedContext`
   capability and the text that describes the trusted lane are removed from
   the public API document and the OpenAPI file in package C4.
6. In Beans: `switchboard-mebb`, `-ishc`, `-rijp`, `-bzn9` and `-3g7b` are
   closed with evidence; `agentui-wtdo` is closed; `crew-0n8g` is closed.
7. AgentUI's `npm run verify` and `node scripts/verify-agui-fork.mjs` pass on
   the Switchboard revision Crew pins. One artifact is built from the
   Switchboard commit that closes S5, and the same bytes are vendored into
   both repositories; a test in each compares the recorded SHA-256.

## Scope, non-goals and constraints

In scope:
- A host-facing adapter contract in Switchboard, and full Codex, Claude and
  Pi adapters that meet it, added beside the existing text adapters.
- Moving Crew's three engine integrations onto those adapters, one engine per
  step, deleting the native driver and that engine's trusted-lane file in
  the same step.
- Deleting Crew's trusted lane (owner decision, 2026-11-18).
- Re-scoping Switchboard's proof chain (decision D18).
- Finishing `agentui-wtdo` and its blockers (owner decision, 2026-11-18), and
  moving AgentUI's Switchboard pin once at the end.

Non-goals:
- Running Crew's capability tools (file, shell, web) on an engine. The
  capability foundation in `docs/member-capabilities.md` stays unwired.
- Frontend tools (`docs/frontend-tools.md`, `switchboard-5py2`).
- Cross-engine child drivers (`crew-69mf`). Children keep running only on Pi.
  `crew-69mf` is in progress on the same driver files; its owner must rebase
  onto each switch, and no work for it is done here.
- Images in tool results. No success criterion needs them.
- Replacing Crew's public AG-UI projection.
- Moving AgentUI onto the full adapters. AgentUI keeps the text adapters.
- Any live paid provider run.

Constraints:
- Crew keeps durability: Temporal ordering, PostgreSQL fencing, the approval
  ledger, receipts, recovery, the launcher and process-group reaping.
- Switchboard holds no database, outbox, workflow engine or launcher.
- Workflow code in Crew must not import Switchboard.
- No parallel native driver in Crew (`crew-1rcl`, `crew-avzm`).
- Controlled tests never substitute for native parity (`crew-0n8g`): every
  adapter is proved against the real engine binary or SDK with a synthetic
  model server, and those tests are labelled native; tests against a scripted
  stand-in are labelled controlled and close no issue on their own.
- Standing rules from `crew-2xqx`: work in worktrees, never in a shared
  checkout; do not run `tests/proof/replay-traces.mts`; no full installs or
  image builds on the shared host beyond what a package names; PostgreSQL
  for tests on tmpfs with unique container name prefixes; no paid providers.
- Switchboard issues bound each change to under 750 implementation lines and
  say to split before dispatch. Each Switchboard package is delivered as one
  pull request per issue.
- Each Switchboard issue's own acceptance text is its acceptance. A package
  closes an issue only on tests that match that text, or after an owner
  decision recorded on the issue re-scopes it.
- Pull requests that change permissions, credentials, launcher policy, or
  what reaches a model need owner review before merge. The coordinator
  merges every other pull request after green CI and two independent
  approving reviews (owner decision, 2026-11-18).

## Findings that drive the design

Facts read from source on 2026-11-18 (Crew `main` at `ef86e62`, Switchboard
`origin/main` at `ef2dc4c`, AgentUI `origin/main` at `e5db45f`). All three
have moved since: Switchboard merged pull request #68, and AgentUI merged
#139, which closed `agentui-omcs`. Every package re-reads its evidence at
the current `origin/main` before it starts:

- Crew's driver contract is `TurnDriver`, `DriverInput` and `DriverResult` in
  `src/service/activities.ts`. Profiles select a driver in
  `src/service/profiles.ts`.
- For Claude and Pi the layers above a driver do not know the engine. For
  Codex they do: `DriverInput.mcp` is typed from `src/service/codex-mcp.ts`,
  and `src/service/supervisor-runner.ts` calls `runLiveTool` and
  `codexItemWriter`.
- Files that import an engine SDK or adapter package today:
  `claude-worker.ts`, `trusted-claude-worker.ts`, `codex.ts`,
  `codex-mcp.ts` (the MCP SDK), `pi-session.ts`, `trusted-pi-session.ts`,
  `pi-worker.ts`, `pi-launch.ts`, `pi.ts`, `pi-tools.ts`, `pi-state.ts`,
  `pi-channel.ts`, `live-profiles.ts`, `proxy-profiles.ts`, `trusted-pi.ts`,
  all under `src/service/`. `codex-executable.ts`, `codex-subscription.ts`
  and `trusted-codex.ts` run the Codex binary and import no SDK.
- Crew uses Switchboard today only for `createEventStream` in
  `src/service/observer-hub.ts` and an observability entry in
  `src/service/telemetry.ts`. The pinned tarball contains no adapter.
- Switchboard's three exported adapters are text-only and force tools off.
  A private Codex app-server stack under `src/adapters/codex/` has native
  proofs in CI and no export. It refuses `item/tool/call`, and
  `src/adapters/codex/features.ts` marks dynamic tools as fixed at
  `thread/start` and unsupported after start.
- Switchboard's Codex session rules (`src/adapters/codex/sessions.ts`) refuse
  an operation unless `sqlite_home` and `log_dir` are absolute and outside
  the Codex home; require a native login in direct mode; and in route mode
  require `auth.command`, refuse `env_key`, and require a `litellm-proxy`
  endpoint ending `/v1`. `route.ts` hashes the endpoint into the session
  principal, and a changed endpoint is a binding mismatch. Crew's three Codex
  credential forms (a fixture provider with no auth, a relay with `env_key`
  on a new loopback port every turn, and a ChatGPT subscription bearer with
  an account header) fit none of these today.
- Core already has `PendingInteraction`, `InteractionContinuation`,
  `ToolOutcome` (`src/core/interaction.ts`), `createDispatchOperation`
  (`src/core/dispatch.ts`) and restore types (`src/core/frontend-restore.ts`).
  An owner decision of 2026-11-16 (`switchboard-9wpi`) says Switchboard does
  not pick one restore workaround; the application chooses.
- Switchboard pins Codex 0.169.0 and Claude SDK 0.3.323; Crew pins 0.167.1
  and 0.3.306. Crew's vendored AG-UI Claude adapter pins 0.3.306 exactly.
- Crew's CI native-service matrix (`.github/workflows/integration-api.yml`)
  is split by suite, not by engine. The per-engine fixture tests and
  `tests/service/supervisor.test.ts`, `member-cancel.test.ts` and
  `codex-live*.test.ts` run only inside `tests/proof/verify-members.mts`,
  which no workflow invokes. Without `--engine`, that script also runs
  `replay-traces.mts`.
- AgentUI installs one Switchboard tarball (revision `c917973`) under four
  names and imports the root entry, `./agui`, `./observability`, `./testkit`
  and all three text adapters. Its `npm run verify` runs on Linux and checks
  the export names, SDK-free declarations and the pin records.

Probe results from package P0 (Switchboard pull request #69,
`docs/qualification/host-tool-probes.md` on that branch; real binaries,
synthetic model servers, Linux arm64 only, one run per scenario):

| # | Assumption | Result |
| --- | --- | --- |
| A1 | The Codex app-server holds a host tool call for 171 seconds under the transport bounds Crew uses | Holds at 121, 151 and 171 seconds, after start and after resume. A 15-second handler bound ends the call with `handler-timeout`. |
| A2 | A Codex tool declared at `thread/start` is callable after `thread/resume` in a fresh process | Holds in three fresh processes. `thread/resume` accepts a `dynamicTools` field and silently ignores it. The declaration lives in `CODEX_HOME`, not in the SQLite index. |
| A3 | A Codex history fingerprint is equal at segment end, after exit, and at next open | Holds. |
| A4 | Codex's native `total` usage continues across resume | Holds. `last` covers one model request only. |
| A5 | The real Claude CLI defers a lone host tool call and resumes it in a fresh process over loopback HTTP MCP | Holds, with exactly one result for the original identifier. |
| A6 | A Claude batch that contains a host tool | One deferred call per assistant message works, whether its siblings are allowed or denied. Two deferred calls in one message fail: only the second resumes and the first is lost with no error. Crew's recorded "refuted" entry is wrong on this point. |
| A7 | Claude SDK 0.3.323 and Codex 0.169.0 match the recorded facts | Four differences, listed in the probe document. |
| A8 | Pi loads and runs with sockets and fork denied | Holds for the in-memory configuration Crew uses. Crew's launcher denies `utimensat`, not a lock call; the SDK's file-lock path was not reached. |

Not yet verified: Linux x64, the Claude CLI under Crew's launcher, three or
more calls in one Claude batch, holds longer than 171 seconds. Packages S2
and S3 rerun their probes on x64 in CI before they close their issues.

## Key decisions

Each seam was argued by two advocates, one for the library and one for the
host, with t3code and OpenBot as comparisons
([09-debate-evidence.md](09-debate-evidence.md)).

| # | Seam | Switchboard owns | Crew keeps | Rejected |
| --- | --- | --- | --- | --- |
| D1 | Session checkpoints | Locating and parsing native history; a history fingerprint; a verify-before-resume check; for Pi, a published, host-parseable session state with segment boundaries | The checkpoint record, its fencing, run provenance, and the decision to require a match | A `CheckpointReference` that carries Pi's whole session |
| D2 | Process launch | Mapping a host-supplied spawn function or channel onto each SDK's hook; never signalling a host-owned process | `native/member-launch.c`, the environment, the process group, kill and reap evidence | An adapter that spawns and reaps |
| D3 | Pi | An adapter that loads inside a host-owned worker and takes an injected model stream function | The worker process, the channel, the relay, text publication from relayed events, and verification of the worker's result | Moving the relay or the distrust check into the library |
| D4 | Codex member lane | The app-server transport with host dynamic tools | The call ledger, the live hold, settlement, delivery confirmation and deadlines | SDK exec with a loopback MCP server |
| D5 | Pause and resume | The existing core types (`PendingInteraction`, `InteractionContinuation`) for host tool calls; a read of what is pending with no model call; a per-adapter capability that says whether a continuation works in a fresh process | The approval ledger, receipts, the choice to end the process at a pause, the restore decision, and recovery scheduling | An adapter that picks a restore workaround or fabricates a tool result |
| D6 | Cancellation | An interrupt with a typed result that never claims termination | Reap evidence, the `uncertain` record and the no-replay rule | Trusting an adapter's cleanup as proof |
| D7 | Events | Typed facts in order, with argument deltas and native identifiers | Redaction, item receipts, the durable public wire and replay | Replacing Crew's projection |
| D8 | Credentials | A host-declared provider route: endpoint, protocol, credential form, and a principal that is stable across a host's per-turn loopback endpoints | The signing relay, upstream credentials, account approval, and the per-turn ChatGPT sign-in read | A LiteLLM-only route; a credential helper the launcher cannot execute |
| D9 | Usage | Raw native counters per segment | The ledger, prices, budgets, and the stored prior total for Codex | Summing in the library |
| D10 | Children | An option that switches an engine's own subagents off | Targets, roles, budgets, the delegation tool and the kill switch | A child driver in the library |
| D11 | System context | One `instructions` input, placed per engine | The content | Per-engine placement code in Crew |
| D12 | Host-run tools | Tool declarations fixed at session creation, a pending host call keyed by native identity, a delivery fact, and capabilities that report limits | The catalog, the gate, the ledger and execution | Engine built-in tools as the mechanism |

Further decisions:

- D13, order: Codex, then Claude, then Pi.
- D14, contract shape: Switchboard's contract is neutral and reuses core
  types. Crew keeps `TurnDriver` and adapts each adapter to it in the driver
  file. Codex's live hold also touches `activities.ts` and
  `supervisor-runner.ts`; file 03 lists those edits.
- D15, no dual path in Crew: the pull request that adopts an adapter deletes
  that engine's native driver and trusted-lane file. The Codex SDK pin bump
  is separated into package C0 so that a regression can be attributed.
- D16, additive in Switchboard: full adapters are new exports (proposed
  `./host/codex`, `./host/claude`, `./host/pi`). The text adapters and their
  exports are unchanged.
- D17, AgentUI gate (owner, 2026-11-18): `agentui-wtdo` stops blocking the
  adapter-integration issues and blocks only `switchboard-3g7b`. Done.
- D18, proof chain (owner said the coordinator's recommendation would stand,
  2026-11-18): the ptrace observer chain comes off the adapters' path;
  `switchboard-j3r0` is narrowed to an isolated-import gate. File 01.
- D19, merging (owner, 2026-11-18): as stated under Constraints.
- D20, finish line (owner, 2026-11-18): finish `agentui-wtdo` in AgentUI so
  that `switchboard-3g7b` and `switchboard-bzn9` can close. File 08.
- D21, subscription (owner, 2026-11-18): ChatGPT-subscription Codex members
  keep working. Switchboard's route admits the host-supplied bearer form.
  This reverses Switchboard's "not in v1" position and is owner-reviewed.
- D22, trusted lane (owner, 2026-11-18): delete it. Each engine switch
  deletes that engine's trusted file and its tests; C4 deletes the rest.
- D23, Codex built-in tools: `view_image` and `request_user_input` stay
  available on the member lane, because `crew-0n8g` says to preserve native
  features. Under the app-server a call to `request_user_input` arrives as a
  server request that Switchboard refuses today. Package S2 surfaces it as a
  pending interaction, and package C1 answers it with a fixed decline that
  tells the model no person is attached, unless a probe of today's SDK exec
  lane shows a different existing behaviour, which C1 then reproduces. A
  native test calls the tool and asserts the turn's outcome.
- D24, issue scope (owner, 2026-11-18): where a Switchboard issue's text asks
  for more than Crew needs, the issue is re-scoped by a recorded owner
  decision and the dropped scope moves to follow-up issues that block
  nothing. Package R0 writes the exact re-scope list, and the owner sees it
  once, before any adapter code.
- D25, Crew data (owner, 2026-11-18): existing Crew conversations and
  workflows in flight need not survive a switch.

## Change model

Before:

```text
Temporal activity -> supervisor -> supervisor-host -> supervisor-runner
  -> claude.ts -> claude-worker.ts -> vendored AG-UI adapter -> Claude SDK
  -> codex.ts  -> Codex SDK (exec) + loopback MCP (codex-mcp.ts, codex-live.ts)
  -> pi.ts     -> pi-launch.ts -> pi-worker.ts -> pi-session.ts -> Pi SDK
```

After:

```text
Temporal activity -> supervisor -> supervisor-host -> supervisor-runner
  -> claude.ts -> launcher-confined worker -> Switchboard Claude host adapter
  -> codex.ts  -> Switchboard Codex host adapter (host channel, host tool)
  -> pi.ts     -> pi-launch.ts -> pi-worker.ts -> Switchboard Pi host adapter
```

## Risks and stop/go gates

- Gate G0: met. The coordinator reported decision D18 to the owner on
  2026-11-18.
- Gate G1: met. Assumptions A1, A2 and A5 held in package P0.
- Gate G2: on each Crew switch, every job of the native-service matrix, the
  `actual-service` job and the engine-fixture workflow pass on the pull
  request.
- Gate G3: defined once, in file 08 under package A2. It runs on each
  Switchboard pull request that changes the root entry, `./agui`,
  `./observability`, `./testkit`, a text adapter, the exports map or a peer
  version.
- Gate G4: the owner has seen and accepted package R0's re-scope list before
  S2, S3 or S4 opens a pull request that closes an issue.
- Risk: Switchboard `origin/main` moves (pull request #68 is open). Each
  Switchboard pull request starts from current `origin/main`.
- Risk: `agentui-wtdo` needs a macOS run. File 08 names what needs a Mac.

Unresolved decisions:

| Decision | Class | Owner | Unblock action |
| --- | --- | --- | --- |
| The re-scope list for `mebb`, `ishc`, `ylju`, `y84s`, `o6dg`, `km2q`, `apbp` | Blocking for S2, S3, S4 and S5 (gate G4); not for S0b, S1, C0, A1 | Repository owner | Accept or amend package R0's list |
| Export names for the full adapters | Non-blocking; default D16 | Coordinator | Fixed in package S1 |
| Source layout for the Claude and Pi host adapters | Non-blocking; default in file 01 | Coordinator | Fixed in package S1 |
| Remove the ten stale Switchboard worktrees | Non-blocking | Repository owner | Approve the cleanup in file 08 |

## Document map

- [01-gates-probes-and-contract.md](01-gates-probes-and-contract.md):
  packages S0a, P0, R0, S0b and S1.
- [02-switchboard-codex-adapter.md](02-switchboard-codex-adapter.md): S2.
- [03-crew-codex-migration.md](03-crew-codex-migration.md): C0 and C1.
- [04-switchboard-claude-adapter.md](04-switchboard-claude-adapter.md): S3.
- [05-crew-claude-migration.md](05-crew-claude-migration.md): C2a and C2b.
- [06-switchboard-pi-adapter.md](06-switchboard-pi-adapter.md): S4.
- [07-crew-pi-migration.md](07-crew-pi-migration.md): C3.
- [08-packaging-agentui-and-closeout.md](08-packaging-agentui-and-closeout.md):
  A1, S5, A2 and C4.
- [09-debate-evidence.md](09-debate-evidence.md): the comparison the
  decisions rest on.
- [10-execution-handoff.md](10-execution-handoff.md): ordered packages,
  verification, gates and the definition of done.

No cross-repository request documents are needed: the owner controls all
three repositories, and each has a Beans project.
