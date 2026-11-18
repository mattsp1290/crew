# Gates, probes and the host-facing adapter contract (S0a, P0, R0, S0b, S1)

All five packages are Switchboard work. Paths are relative to the Switchboard
repository unless a path starts with `crew:`.

## Package S0a: move the AgentUI gate (done)

Owner decision D17. Applied on 2026-11-18: `agentui-wtdo` was removed as a
blocker of `switchboard-mebb` and `switchboard-rlsx`, with a note on each.
`switchboard-3g7b` still lists it. `bn dep cycles --project switchboard`
reports none. Check: `bn show switchboard-mebb --project switchboard` lists
only closed blockers.

## Package P0: probes before the contract (done; pull request #69)

Results are in [00-overview.md](00-overview.md). The text below is the
package as it was specified.

### Goal and prerequisite

Goal: settle assumptions A1 to A8 in [00-overview.md](00-overview.md) with the
real engine binaries, before the contract is fixed. Prerequisite: none.

### Evidence

- `switchboard-yejc` says to pin and probe "before committing to
  implementation APIs".
- `crew:docs/member-capabilities.md` (section on SDK assumptions) records
  facts read from Claude SDK 0.3.306 and Codex 0.167.1, and lists three
  unknowns: the Codex held-call timeout, deferral in a Claude batch, and
  dynamic tools after resume.
- `switchboard-qx63` asks whether Codex dynamic tools survive a resume.
- Existing native proof harnesses: `spikes/codex-native/` and the
  `codex-native` job in `.github/workflows/ci.yml` (x64 only).

### Change surface

- `spikes/host-tools/` (new, beside `spikes/codex-native/`): probe scripts
  for Codex and Claude that run the pinned real binaries against a synthetic
  model server on loopback, in a container with no other network.
- `docs/qualification/host-tool-probes.md` (new): one row per assumption with
  the command, the observed result and the versions.
- No change to packaged source.

### Probes

1. A1: declare one host tool, have the model call it, hold the reply 121,
   151 and 171 seconds with the transport bounds Crew will pass, then answer.
2. A2: declare a tool at `thread/start`; resume the thread in a second and a
   third process; the model calls the tool in each.
3. A3: compute the history fingerprint at segment end, after process exit and
   at next open; compare.
4. A4: read native `total` and `last` across three resumed turns.
5. A5: real Claude CLI at the pinned version, a loopback HTTP MCP server with
   a bearer, a PreToolUse hook that defers; exit; resume in a new process;
   the tool result reaches the next model request exactly once.
6. A6: the same with two tool calls in one assistant message, one a host
   tool. Record exactly what the CLI does with each call.
7. A7: read the type definitions of Claude SDK 0.3.323 and the generated
   Codex 0.169.0 app-server protocol; list every difference from the
   recorded facts.
8. A8: load the Pi SDK in a process under a seccomp profile that denies
   sockets, fork and file locking; run one turn with an injected model
   stream function.

### Acceptance

The qualification document exists with a result for every row. Gate G1 is
evaluated from A1, A2 and A5. Two reviewers confirm each recorded result
against the probe output.

## Package R0: the issue re-scope list (owner gate G4)

### Goal and prerequisite

Goal: every Switchboard issue that packages S2 to S5 will close has either
unchanged acceptance text that the package tests, or a re-scope recorded on
the issue as an owner decision. Prerequisite: P0 (done).

### Evidence

- `switchboard-ylju` and `switchboard-y84s` are titled "Implement ...
  approvals continuation and cancellation". Their acceptance asks for
  fixtures covering approve, deny and invalid continuation, cancel while
  streaming, tool and waiting, uncertain effect and delivery, and no forced
  allow-all, and their scope is bridging native tool, approval and
  delegation capabilities while preserving native policy.
- `switchboard-mebb` and `switchboard-ishc` name fault schedules that this
  plan's adapters do not all exercise: approval pending while other protocol
  traffic arrives, queued final tool and event delivery at shutdown, and
  background work that may outlive a controller.
- `switchboard-o6dg` says "No history import/rewrite"; the Pi host adapter's
  state mode imports a session state the host supplies.
- File reservations differ from this plan's layout: `switchboard-ishc`
  reserves `src/adapters/claude/index.ts`, `-ylju` reserves
  `src/adapters/claude/interaction.ts`, `-km2q` reserves `examples/node/**`,
  `-apbp` reserves `tests/consumers/**`.
- The issues say required gaps block acceptance and scope is not silently
  shrunk.

### Work

1. Read the full text of `switchboard-mebb`, `-ishc`, `-rijp`, `-ylju`,
   `-y84s`, `-o6dg`, `-p0mr`, `-k20g`, `-six1`, `-ck2y`, `-vtzi`, `-s85t`,
   `-rc08`, `-km2q`, `-apbp`, `-3g7b`, `-bzn9`.
2. For each, write a three-column table: acceptance item; what this plan
   builds and tests; verdict (kept, re-scoped, or moved to a named follow-up).
   Use the reserved file paths where the issue reserves them, and change this
   plan's layout to match unless there is a stated reason not to.
3. Present the tables to the owner in one message. Record the owner's answer.
4. After acceptance: edit each affected issue's description to the re-scoped
   text with a note citing the decision; create the follow-up issues (native
   approval bridging for Claude and Pi, the dropped fault schedules, a Pi
   mode with history discovery but no import) at priority 3, blocking
   nothing; create issues for work this plan adds that has none (Codex host
   dynamic tools, the host-declared provider route).

### Acceptance

Gate G4 is recorded on `switchboard-mebb`, `-ishc` and `-rijp`. No issue that
a later package closes has acceptance text the package does not test.

## Package S0b: re-scope the proof chain and add the isolated-import gate

### Goal and prerequisite

Goal: the Claude and Pi adapter issues no longer wait on the ptrace observer
chain, and Switchboard's own runs stop importing native SDKs unconfined.
Prerequisite: gate G0, which is met.

### Evidence

- `switchboard-yejc` is blocked by `switchboard-4k6g`, which is blocked by
  `switchboard-j3r0`, which is blocked by `switchboard-ftwo`, `-i72g` and
  `-jrvo`. `switchboard-rlsx` is blocked by `switchboard-525r`, itself
  blocked by `switchboard-j3r0`.
- The chain exists to make a ptrace test observer trustworthy.
  `docs/architecture/boundaries.md` says core defines no launcher and an
  adapter must work under host confinement.
- `npm test` imports the real Claude and Pi SDKs today
  (`tests/adapters/claude/runtime.test.mjs`,
  `tests/adapters/pi/runtime.test.mjs`) with the developer's home directory
  intact.
- A tripwire pattern exists at `scripts/support/codex-guard/tripwire.mjs`.
- A probe that covers most of the gate exists only in the original
  Switchboard checkout's ignored notes, at
  `.audit/confinement-audit-probe/linux.mjs`. It is not in a fresh clone;
  the coordinator supplies a copy to the package owner.

### Decision D18, as recorded

Four advocates argued it, including one assigned to defend finishing the
chain and one assigned to split the engines. All four concluded the same:

1. `switchboard-jrvo`, `-i72g` and `-ftwo` stop blocking any adapter issue
   and continue as research at priority 4.
2. `switchboard-j3r0` is narrowed to the isolated-import gate below and no
   longer depends on `switchboard-ftwo`.
3. `switchboard-4k6g` keeps its compile-boundary criteria; its confinement
   clause is satisfied by the isolated-import gate.
4. `switchboard-525r` applies only to a Pi mode with extensions enabled.
   `switchboard-rlsx` no longer depends on it; its description is edited to
   say that the host-owned mode loads no extensions and that the
   extensions-enabled mode reports `unavailable` until `525r` closes.
5. `switchboard-yejc`'s description is edited to cite this decision, because
   its text says required gaps block acceptance.
6. The host proves its own launcher (Crew package C2a for Claude; the
   existing Pi confinement test).

### Change surface

- Beans, one mutating command at a time, each with a note citing the owner
  decision of 2026-11-18: `bn dep remove switchboard-j3r0 switchboard-ftwo`;
  `bn dep remove switchboard-rlsx switchboard-525r`; description edits for
  `switchboard-j3r0`, `-4k6g`, `-525r`, `-rlsx`, `-yejc`; priority 4 for
  `-jrvo`, `-i72g`, `-ftwo`; `bn dep cycles --project switchboard`.
- `scripts/isolated-native-tests.mjs` (new): runs the SDK-importing tests in
  a Linux container with no network, a read-only root, only the packed
  package and fixtures mounted, decoy credential files at the paths the SDKs
  look for, under `strace`. It fails on any access to a decoy, any network
  attempt or any unexpected program launch, even when the run exits 0.
- `package.json`: an npm script `test:native-isolated` (new). The `test`
  script stops matching the SDK-importing test files; a tripwire in the
  ordinary run fails if a native SDK module is loaded.
- `tests/`: move or tag the SDK-importing tests so both scripts select the
  right set. Three controls, each a fixture that exits 0: one reads a decoy
  credential, one attempts a network connection, one launches a program.
- `.github/workflows/ci.yml`: a job for `test:native-isolated`, with a time
  limit sized from a measured run.
- `docs/qualification/native-import-isolation.md` (new): the configuration
  and the stated limit (it does not defend against a thread that rewrites
  its own system-call arguments).

### Acceptance

- `bn dep tree switchboard-ishc` and `bn dep tree switchboard-rijp` contain
  none of `jrvo`, `i72g`, `ftwo`.
- `npm test` loads no native SDK (the tripwire passes).
- `npm run test:native-isolated` passes, and each of the three controls
  fails the gate.
- `switchboard-j3r0` is closed with links.

## Package S1: the host-facing adapter contract

### Goal and prerequisite

Goal: one written contract, with core types, that the three host adapters
implement and Crew builds against. Prerequisite: P0.

### Evidence

- `src/core/contracts.ts`: `AdapterIdentity`, `AdapterRegistration`,
  `AdapterInstance`, `Outcome`, `AdapterError`.
- `src/core/interaction.ts`: `PendingInteraction`, `PendingApproval`,
  `InteractionContinuation`, `ToolTarget`, `ToolOutcome`,
  `parseInteractionContinuation`, with an exact-target-set rule.
- `src/core/sessions.ts`: `SessionReference`, `CheckpointReference`.
- `src/core/dispatch.ts`: `createDispatchOperation`.
- `src/core/auth.ts`: `createAuthContext`, `CredentialResolver`, and a proxy
  credential whose purpose is the literal `litellm-proxy`.
- `src/core/capabilities.ts`: `Capability`.
- `src/core/frontend-restore.ts` and `docs/architecture/frontend-restore.md`.
- `src/adapters/codex/execution.ts` already takes a host-lent channel and a
  host attestation of process exit.
- The text adapters compile as separate projects with `rootDir: "src"`
  (`adapters/claude/tsconfig.json`) and import nothing from core. Issue file
  reservations name `src/adapters/claude/index.ts` and
  `src/adapters/pi/index.ts`.
- AgentUI re-exports named root symbols and checks that the root entry loads
  no adapter and no native SDK at run time.

### Change surface

- `docs/architecture/host-adapter-contract.md` (new): the contract, the
  verdict table D1 to D12 with reasons copied from
  [09-debate-evidence.md](09-debate-evidence.md), the P0 results that shaped
  each capability, and what the host owns.
- `docs/architecture/boundaries.md`: link the contract; correct the layering
  table.
- `src/core/host-adapter.ts` (new): only the types that core lacks. Reuse
  `PendingInteraction`, `InteractionContinuation`, `ToolOutcome`,
  `SessionReference`, `Capability` and the dispatch observations; do not
  declare parallel types.
- `src/core/auth.ts`: add a host-declared provider route beside the existing
  proxy purpose (additive; the `litellm-proxy` literal stays valid). Owner
  review.
- `src/index.ts`: export the new types. The root entry must still load no
  adapter and no native SDK.
- `src/testkit/`: a fake host adapter, a conformance suite that runs against
  any adapter that implements the contract, and the `host-launcher`
  scenario (a denial by the host launcher surfaces as an operation error or
  `unavailable`, never as a fallback).
- `tests/core/`, `tests/package.test.mjs`.

The contract, in conceptual terms. Names are proposed until the implementer
confirms them against core:

1. **Open.** Options carry: a host-supplied spawn function or channel; the
   complete environment and native configuration (nothing ambient is read);
   a process-owner declaration; `instructions` text; host tool declarations
   (name, description, JSON schema), fixed for the life of the native
   session; a provider route; an option that switches the engine's own
   subagents off; the engine built-in tools the host wants left on; and
   either nothing (new session) or a `SessionReference` plus an optional
   expected history fingerprint (resume).
2. **Run one segment.** The result is one of: `complete` (text, raw native
   usage); `pending` (a `PendingInteraction` set of host tool calls with
   exact native identity and arguments, plus usage); `failed` (a typed
   failure whose write status is `not-sent` or `outcome-unknown`, from
   `createDispatchOperation`). The host records intent before the adapter
   dispatches.
3. **Continue.** A continuation answers the whole pending set, as
   `InteractionContinuation` requires. Whether it may be delivered to a
   session opened in a fresh process is a per-adapter `Capability`.
4. **Inspect.** A read of unanswered host tool calls from native state with
   no model call, where the engine allows it; otherwise `unsupported`.
5. **Fingerprint.** A history fingerprint operation. Whether it is valid at
   segment end or only after host-attested process exit is stated per
   adapter, from probe A3.
6. **Events.** Ordered typed facts: text delta, tool-call start, argument
   delta, tool-call end, tool delivery, usage, and opaque native items.
7. **Interrupt.** Returns terminal-observed, interrupted, or
   unconfirmed-within-bound. It never signals a host-owned process.
8. **Capabilities.** Host tool calls that may be pending from one assistant
   message (one for Claude, by probe A6; a second deferred call in the same
   message is a typed failure, never a silent loss); whether a continuation
   works in a fresh process; inspect; fingerprint timing; whether usage is
   per segment or cumulative; whether tool declarations may change after
   session creation (they may not, on any engine).

The contract holds no store, no retry, no approval policy and no launcher.
An option a host omits defaults to native behaviour.

### Layout and export names (decided in this package; defaults given)

- Exports: `./host/codex`, `./host/claude`, `./host/pi` (new). The text
  adapters and their exports are unchanged (D16).
- Layout default: the Codex host adapter lives at
  `src/adapters/codex/index.ts` (new) in the root project. The Claude and Pi
  host adapters live in new separate projects beside the text adapters
  (proposed `adapters/claude-host/` and `adapters/pi-host/`), because the
  root project compiles with declaration checks on and the Claude SDK's
  declarations fail there. Each references core through the built root
  declarations by TypeScript project reference. If the reference approach
  fails `verify:package`, fall back to self-importing the package name, and
  record the choice in `docs/architecture/boundaries.md`.
- Peers: each host adapter declares the exact native versions it was proved
  against. The Claude host adapter declares `@modelcontextprotocol/sdk`. The
  Codex host adapter does not import `@openai/codex-sdk`; it exports the
  qualified native binary version as a constant.

### Tests and acceptance

- `npm run check`, `npm run lint`, `npm test`, `npm run verify:package`,
  `npm run test:native-isolated`.
- The conformance suite passes against the testkit fake.
- Gate G3: AgentUI's `npm run verify` passes on a tarball built from this
  pull request (the procedure is in file 08, package A2, run without
  committing to AgentUI).
- Two reviewers approve; the owner approves the `auth.ts` change.

### Exclusions

No change to `createAguiProjection`, the AG-UI mapping, or a text adapter.
