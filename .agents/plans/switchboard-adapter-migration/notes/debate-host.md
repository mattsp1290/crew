# Host advocate brief: what stays in Crew (2026-11-18)

Position: Crew moves onto Switchboard (SB) adapters. The library gets engine wire knowledge. It gets nothing that needs a database, a launcher or a policy.

Method: read at the cited lines; nothing was executed. Crew cites are local `main` `775fd72`, one commit behind `origin/main` `ef86e62`, which changes no driver file. SB cites are `origin/main` `ef2dc4c`. `comparison.md` is cited as "cmp".

## The ten seams

### 1. Session checkpoints
- **Claim.** Crew keeps the checkpoint record and the compare-before-resume rule. SB returns an opaque `SessionReference` and a native-history fingerprint (size, digest, last terminal) for Crew to store and compare. The Pi adapter imports and exports in-memory session state.
- **Why the host.** The checkpoint is selected under the conversation row lock and fenced by token, attempt and prompt digest (`supervisor-host.ts:74-96`), and it commits with the turn. Pi's checkpoint is the whole session, because the launcher refuses the `utimes` locking that file sessions use (`pi-worker.ts:13`). SB caps `opaque` at 8,192 characters (`src/core/sessions.ts:36-38`), so that state cannot be a `CheckpointReference`. OpenBot: "two stores remembering the same thread is how they come to disagree" (cmp).
- **Library.** Locating and parsing native history (`codex.ts:46-74` knows `state_5.sqlite` and rollout paths), the fingerprint, resumed-identity checks.
- **Cost and risk.** Without the fingerprint, Crew keeps reading rollout files itself, which is reaching around the adapter.
- **Strength.** Strong for the record. Native-format parsing is conceded.

### 2. Process launch and process group
- **Claim.** Crew keeps the launcher, environment, process group, kill and reap evidence. SB needs only its existing rule: a host-supplied spawn function or borrowed channel, and a stated process owner (`boundaries.md:122-134`).
- **Why the host.** `native_launches.stopped` is written only after the group answers `ESRCH` (`supervisor-host.ts:38-48`, `:238-240`). Only the group owner can prove that. The Landlock allow-list names Crew's source tree and per-invocation ports (`member-launch.c:244-251`, `:263-268`): it is policy. SB's private Codex stack already "never spawns, kills, retries" (`execution.ts:46-47`). t3code's adapter spawns, and its cancel can only report "its processes may still be running" (cmp).
- **Library.** Arguments, native configuration, protocol, an exit observation.
- **Cost and risk.** The supervisor layers and launcher stay. The exported Codex adapter spawns its own probes and copies `process.env` (`adapters/codex/src/index.ts:86-88`, `:104-121`); that must end, or Crew cannot use it.
- **Strength.** Strong: the library's own rule and its only complete stack agree.

### 3. Pi worker, relayed model requests, result verification
- **Claim.** Crew keeps the worker process, the descriptor-3 channel, the relay and the host-side check of the result. SB's Pi adapter must load inside a host-owned worker and take an injected provider stream function and tool executor.
- **Why the host.** The worker has no credentials and cannot open a socket (`member-launch.c:158-162`; `pi-worker.ts:12`). SB's own record says "Extension hooks alone cannot enforce a mandatory proxy policy" and that copying Crew's confinement "would discard required native behavior in a reusable library" (`pi-selection.md:57`, `:84`). Verification exists because "the host no longer trusts its answer" (`pi.ts:85-88`); a trust boundary cannot be delegated to the party it distrusts.
- **Library.** Session creation, events, proposals, state import and export, raw usage.
- **Cost and risk.** `pi-launch.ts`, `pi-channel.ts` and `pi.ts` stay. `sdkSystemEntries` mirrors SDK internals (`pi.ts:72-82`); the adapter should export that predicate.
- **Strength.** Strong on process and transport, moderate on verification.

### 4. Codex member lane
- **Claim.** The transport is conceded: app-server, in SB. Crew keeps the hold: durable proposal, settlement, delivery confirmation and deadline (`codex-live.ts:35-69`, `codex-calls.ts`). SB must stop refusing `item/tool/call` (`interaction.ts:26`) and surface it as a host callback with a delivery event.
- **Why conceded.** Exec mode cannot hold a dynamic tool ("dynamic tool calls are not supported in exec mode", `docs/member-capabilities.md` on `origin/main`, SDK assumptions). Crew's trusted lane already speaks the protocol (`trusted-codex.ts:98-113`). The earlier verdict already sent this lane to the app-server (steward, J). With no stored conversations to preserve, nothing argues for keeping exec.
- **Library.** Everything on the wire. `codex-mcp.ts` is deleted.
- **Cost and risk.** Whether the app-server times out a held call before 120 seconds is recorded as unknown in the same table. It needs one proof before the switch.
- **Strength.** Conceded for transport, strong for the hold.

### 5. Pausing for a human, resuming across restart
- **Claim.** Crew keeps the approval ledger, the receipt digest bound at launch (`supervisor-host.ts:133-139`), the choice to end the process at the pause, and recovery scheduling (`activities.ts:69-93`). SB exposes a `pending` terminal carrying the native call, a continuation accepted by a fresh process, and a no-model-call "inspect pending" read.
- **Why the host.** Survival across restart is a stored row. t3code sets `pendingRequestsSurviveRestart: false` in every adapter; OpenBot survives only because the host owns the decision (cmp, pattern 1). SB's own approval "lives in memory and is settled `lost`" (`interaction.ts:70`), and its core already models the tool continuation (`src/core/interaction.ts:56-59`).
- **Library.** Native deferral, transcript checks that the call is unanswered, the `binding.json` provenance (`claude-worker.ts:39-59`, `:88-93`). Conceded: those are engine-format knowledge.
- **Cost and risk.** Claude defers one call at a time and Codex has only a live hold. The adapter must declare this as a capability, or Crew branches on engine names as t3code does.
- **Strength.** Strong.

### 6. Cancellation evidence and uncertain outcomes
- **Claim.** Crew keeps the evidence standard and the no-replay rule. SB needs nothing new: per-write `not-sent` or `uncertain` (`boundaries.md:212`) and no claim of termination (`:118`).
- **Why the host.** `uncertain` is written under the conversation lock with attempt fencing (`supervisor-host.ts:251-266`), and a stop is confirmed only by the stored `stopped` flag (`:268-276`). Both comparisons leave uncertain outcomes to the host (cmp, pattern 3).
- **Library.** The interrupt request and terminal classification.
- **Cost and risk.** Little.
- **Strength.** Strong, and probably uncontested.

### 7. Events, redaction, receipts, the public wire
- **Claim.** Translation is conceded to the adapter. Crew keeps the fold, item receipts (`supervisor-runner.ts:59-60`), projection and byte limits. No new mechanism: SB already says the host owns payload limits and durable replay (`boundaries.md:264`, `:270`).
- **Why the host.** The wire is replayed from PostgreSQL by cursor. A per-run in-process projection cannot serve a reconnect, which is the steward's finding A.
- **Library.** Typed events with native identifiers, in order.
- **Cost and risk.** Tool-argument previews are Crew policy over a generic argument-delta event. The adapter must emit deltas, not only completed calls.
- **Strength.** Conceded for translation, strong for the wire.

### 8. Credentials
- **Claim.** Crew keeps the signing relay and the per-turn sign-in read. SB accepts a host-resolved endpoint and scoped key, and stops reading `process.env` (`adapters/claude/src/index.ts:74-76`).
- **Why the host.** The engine holds only a random relay key; upstream headers are "never returned to the member SDK" (`proxy-relay.ts:8`). SB's Codex broker has the engine run a Node helper against a unix socket (`proxy.ts:12-17`, `:167`). Crew's launcher grants execute on the Codex binary alone (`member-launch.c:236`), so as I read it that helper cannot run there and the adapter must report `unavailable` (`boundaries.md:130`). I did not run this. Subscription passthrough is outside SB v1 (`boundaries.md:46`) and token refresh is refused (`interaction.ts:27`), so that lane can only be the host's.
- **Library.** Provider configuration, route principal, model pinning. Rename `litellm-proxy` (`route.ts:11-12`) to a generic proxy purpose; the steward's trigger has arrived.
- **Cost and risk.** The relay stays. Its URL must satisfy the route's `/v1` rule.
- **Strength.** Strong for the relay, moderate for the rename.

### 9. Usage
- **Claim.** Extraction is conceded. Crew keeps the usage record, written once before the outcome commits (`supervisor-host.ts:214-215`), plus prices and budgets. SB reports raw native counters.
- **Why split.** The Codex app-server gives running totals, "neither is per-request usage, and nothing is summed" (`execution.ts:119`). The delta needs Crew's stored prior total. Pi usage must come from replies the host relayed, not from the worker (`pi.ts:87-88`). t3code: the adapter reports and the host prices (cmp).
- **Cost and risk.** Low.
- **Strength.** Conceded for parsing, strong for the ledger.

### 10. Child and cross-engine drivers
- **Claim.** Targets, roles, consent, budget and the kill switch stay in Crew (`activities.ts:51-63`; `crew-69mf`). SB needs nothing: a child is another adapter session the host opens, and delegation is a host-run tool.
- **Why the host.** Engine subagents are off in Crew (`codex.ts:171`) and in SB under a route (`proxy.ts:75-81`). OpenBot removes the engine's agent tool (cmp).
- **Library.** Nothing beyond need 2. SB's `DelegationTarget` stays unused by Crew.
- **Cost and risk.** `crew-1rcl` holds, because children use the same adapter. The Pi adapter must let the host register the delegation tool.
- **Strength.** Strong.

## The unmet needs

1. **System context.** Crew composes the content (`supervisor-runner.ts:53`). SB adds one `instructions` option and places it: Claude `systemPrompt`, Codex `developer_instructions`, Pi addendum. Both comparisons split it this way. The adapter must say whether placement is per session or per turn. Strength: moderate. The mechanism is a real library change.
2. **Host-run tools.** Catalog, gate, ledger and execution are Crew's: "Crew will run every such tool itself, outside the model's sandbox, behind one approval gate" (`docs/member-capabilities.md`, `origin/main`). SB adds tool definitions, a host callback keyed by native call, and a delivery event, and picks the native carrier. Engine built-ins are switched off by host configuration, not hardcoded. Strength: strong.
3. **Images in tool results.** Conceded as library work: the result becomes content parts. Every Crew path is text today (`codex-mcp.ts:42`, `trusted-codex.ts:104`). Crew keeps size limits and storage. I did not verify each engine's native image support. Strength: conceded.
4. **Confinement proofs.** See A.

## A. The proof chain is not a library runtime obligation

1. **What the chain proves.** `j3r0` asks for confinement "before any native SDK import" and holds that "plain successful exit cannot establish no denied attempts". As I read it, that is a safety standard for SB's own qualification runs, with an attempt observer. `jrvo`, `i72g` and `ftwo` are ptrace prerequisites for that observer. `ftwo`'s spike reports `INCONCLUSIVE`, and `jrvo` records a crashed harness and over 20,000 changed lines.
2. **What the library promises.** "Core defines no launcher" (`boundaries.md:134`). The obligation is to work under host confinement and report `unavailable`, not to supply confinement.
3. **Precedent.** The private Codex stack has native proofs in CI on a borrowed channel, without the chain.
4. **Crew enforces already.** Landlock, seccomp, `no_new_privs` and a parent-death signal; exit 126 instead of an unconfined run (`docs/verification.md:48-66`, `:160-166`); a real Pi turn in `tests/fixtures/engines/pi/confinement.test.ts`. A Pi worker with no socket makes `525r` moot for Crew: whatever an extension registers, it cannot dispatch.
5. **No second host gains.** AgentUI runs on macOS; Linux ptrace results give it nothing. Neither comparison proves confinement in its adapter layer.

Proposal: re-gate `yejc` and `rlsx` on "runs under a host-supplied launcher or worker, shown by a host-side test". Keep the chain as a separate hardening track.

Concessions. Crew does not restrict Claude's network (`docs/verification.md:62-63`), and the Node process that imports the Claude SDK is not launcher-confined (`claude.ts:128-143`), so Crew does not meet `boundaries.md:129` for Claude today. Starting that worker through the launcher, as Pi's is, closes it in Crew. The compile half of `4k6g` stays a library duty; `yejc` stalled on a real type error. `525r` remains valid for hosts that run Pi extensions unconfined.

## B. Smallest contract and order

Contract, seven parts:
1. Host-supplied spawn or channel, environment and native configuration. No ambient reads, no self-spawn.
2. Start or resume by opaque reference, plus the fingerprint.
3. One segment per call, ending `complete`, `pending` with the native call, or `failed` with write status.
4. A continuation by native call identifier on a fresh process, and inspect-pending.
5. Tool definitions, a host callback and a delivery event.
6. An instructions string.
7. Typed events with native identifiers and raw usage.

No store, retries, approval policy or launcher.

Keep `TurnDriver` and `DriverResult` (`activities.ts:19-41`) fixed. The layers above the driver then do not change, and the native service proofs verify each move.

Order:
1. **Codex.** `mebb` is nearest and the private stack exists. One change moves the member lane to the adapter and deletes `codex.ts`, `codex-mcp.ts` and `trusted-codex.ts`; the trusted lane has no production caller (`facts.md`). Needs: the tool callback and the hold-duration proof.
2. **Claude.** Both sides already use `spawnClaudeCodeProcess` (`claude-worker.ts:106-112`; `adapters/claude/src/index.ts:150`). Needs: deferral, continuation, inspect-pending. Deletes `claude-worker.ts` and Crew's direct use of the vendored AG-UI adapter.
3. **Pi.** Last: the largest host remainder, a provisional selection, and the in-worker loading requirement.

Each move bumps Crew to SB's exact SDK peer and removes the native driver in the same change.
