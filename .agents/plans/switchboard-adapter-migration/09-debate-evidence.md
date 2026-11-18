# Debate evidence: where two other systems draw the adapter boundary

This file records the comparison that decisions D1 to D12 in
[00-overview.md](00-overview.md) rest on. The owner asked that each change to
Switchboard be argued, with OpenBot and t3code as comparisons. Two advocates
argued every seam, one for the library and one for the host; both read the
study below and the sources it cites. Their full briefs are in `notes/` beside this file
(`debate-host.md`, `debate-library.md`, and for the proof chain
`chain-finish.md` and `chain-split.md`), with the grounded facts in
`notes/facts.md`. The notes are a record of the argument, not plan text.

A Switchboard change that this plan did not foresee (for example the session
principal rule in package S2) gets its own short two-advocate argument before
its pull request opens, and the pull request body records the verdict.

## The study (read 2026-11-18)

Condensed from a read-only study. t3code at `8cf97b5f`, OpenBot at `5ec28bc`.
Clones may be re-created with
`git clone --depth 1 https://github.com/pingdotgg/t3code` and
`git clone --depth 1 https://github.com/CopilotKit/OpenBot`. Paths are relative
to each repository. OpenBot's `server/` and `toolkit/` are not in its tree at
that commit (the server ships as an image), so OpenBot host-side claims rest on
docs, `shared/`, `api/` and comments in the harness code.

## t3code

- Seam: `ProviderAdapterV2` in
  `packages/provider-core/src/server/ProviderAdapter.ts` (`getCapabilities`,
  `planSelectionTransition`, `openSession` returning a session runtime with
  required `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`,
  `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`,
  `rollbackThread`, `forkThread`, an `events` stream, and about 17 optional
  members). The adapter emits product-vocabulary events
  (`packages/contracts/src/orchestrationV2.ts`); the host only ingests.
- A `ProviderHost` port gives providers paths, settings and credential
  storage; providers never reach into `apps/server`.
- Protocol clients (`packages/effect-codex-app-server`, `packages/effect-acp`)
  are product-agnostic and schema-generated; adapters sit on top.
- Sessions: host persists session, thread and turn refs; "Provider-thread
  resumption is not a capability. It is a required adapter primitive"
  (`docs/orchestration-v2/provider-capability-system.md`).
- Approvals: the engine raises the request; the adapter parks an in-memory
  deferred and emits `runtime_request.updated`; the host persists it and
  commits the user's resolution before delivery. Every adapter sets
  `pendingRequestsSurviveRestart: false`; recovery marks live requests
  expired. Stated reason: "Do not imitate a missing mode by answering
  approvals in T3: T3's check is weaker than the agent's own enforcement"
  (`docs/internals/adding-a-provider.md`).
- Tools: the engine runs native tools; the app's own tools run in the host
  behind an app-owned MCP endpoint that the adapter injects.
- Process: the adapter spawns and tears down the engine; the host owns the
  session lifetime and passes a runtime mode that the adapter maps to the
  engine's native sandbox and approval policy.
- Cancellation: host calls `interruptTurn` with a 15-second bound; a timeout
  is surfaced as "its processes may still be running"; confirmation is the
  adapter's native terminal event.
- Death mid-call: host. Process-bound effects are cancelled, replay-safe ones
  requeued, and an optional continue prompt tells the model to check for side
  effects.
- Usage: adapter reports tokens; a driver-supplied reader parses native
  transcripts; the host prices.
- Context: shared instruction text in provider-core; each adapter decides how
  to deliver it (Claude `appendSystemPrompt`, Codex developer instructions).
- Test kit: recorded native transcripts replayed through the real orchestrator
  and adapter (`packages/provider-testing`, `docs/orchestration-v2/testing-strategy.md`).
- Stated principle: "Complexity belongs at the adapter boundary. Orchestration
  stays pure" (`AGENTS.md`).
- Leaks: about 15 host branches on driver names; `approvalPolicy` and
  `sandboxPolicy` typed as unknown pass-throughs; Pi breaks the
  native-enforcement rule with a `tool_call` hook that asks the host; the ACP
  flavor interface has about 60 optional hooks.

## OpenBot

- Seam: AG-UI over HTTP and SSE. Host sends a `RunAgentInput` whose
  `messages` are two server system messages plus the whole restored thread;
  private `forwardedProps` keys carry the run assertion, the deployment tool
  names and the model choice. Contract text:
  `agent-langgraph-ts/src/run.ts`, `shared/harness_contract.py`.
- Sessions: host. "Nothing may depend on the harness remembering an earlier
  run"; the harness is stateless and replays the thread each run
  (`agent-claude-sdk/src/replay.py`).
- Approvals: host. The policy gateway decides; a pending decision is a
  persisted row; the run ends at the approval and a new run carries the
  result. The harness drops AG-UI `resume`.
- Tools: host. Deployment tools execute in the host through a signed callback;
  other tools end the run for the surface to answer; Claude Code's built-in
  tools are stripped because they "run in this container instead, ungoverned
  and unapproved" (`agent-claude-sdk/src/adapter.py`).
- Process: the harness is a long-lived container; confinement of actions is
  the host's (per-person computer containers, egress proxy).
- Cancellation: host aborts the stream; the harness interrupts the engine;
  no stop confirmation in the protocol.
- Death mid-call: host. Claimed rows with leases; a lost outcome becomes
  `OUTCOME_UNKNOWN` and is not repeated; `openbotSendOnce` turns off the
  engine's own retries when the host retries.
- Usage: no ledger visible.
- Context: host composes content; the harness places it and fits it to a
  token budget.
- Subagents: host; the engine's own agent tool is removed.
- Test kit: `shared/harness_contract.py` runs a harness against a fake model
  provider and asserts on the HTTP body the provider receives.
- Stated principle: "The translation belongs on OpenBot's side, in one place,
  where every remote Bot is governed the same way" and "two stores
  remembering the same thread is how they come to disagree".
- Leaks: harness-id special cases; private AG-UI extensions; host logic
  ported "rule for rule" into a harness; harnesses double as model proxies.

## Side by side

| Responsibility | t3code | OpenBot |
| --- | --- | --- |
| Process and sandbox | split | split |
| Credentials and model | split | split |
| Session and restart | split (host refs, adapter native resume) | host |
| Event translation | adapter | adapter |
| Tools | split (engine native, host MCP) | host |
| Approval | split (adapter holds live callback) | host (run ends, new run resumes) |
| Cancellation | split, with timeout and "may still be running" | split, no confirmation |
| Death mid-call | host | host |
| Usage | split | absent |
| Prompt and context | split | host content, adapter placement |
| Subagents | split | host |
| Test kit | recorded transcripts through real adapter | fake provider, assert on HTTP body |

Patterns:
1. Opposite bets on engine state. t3code keeps native sessions; OpenBot makes
   the harness forget. OpenBot's bet is what lets its approvals survive a
   restart; t3code's live approvals do not.
2. Opposite bets on enforcement. t3code trusts the engine's native sandbox and
   approvals; OpenBot strips engine tools and runs governed tools in the host.
3. Both leave uncertain outcomes to the host and never auto-replay effects.
4. Both let the adapter classify failures and the host decide retries.
5. Both put the test fake at the outermost process boundary, never a mocked
   adapter.
6. In both, goals, compaction, plan credentials and model routing leaked
   through the seam as name checks or side-channel fields.
