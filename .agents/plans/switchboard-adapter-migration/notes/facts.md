# Switchboard integration: grounded facts (2026-11-18)

Working notes for the debate and the plan. Every claim was read from source by
an explorer on 2026-11-18; re-check against the cited file before relying on
it. Crew paths are relative to the Crew repo, `main` at `ef86e62` or later.
Switchboard paths are relative to the Switchboard repo, `origin/main` at
`ef2dc4c` (the local `main` checkout there is 43 commits behind; read with
`git show origin/main:<path>`).

## The owner's answers that bound the plan

- No active users or external consumers of Crew or Switchboard.
- Backward compatibility is not required: stored PostgreSQL and Temporal data,
  native session files, configuration and existing clients may break.
- No feature flags.
- We own both repositories and may change Switchboard, but each change is
  argued (Crew or Switchboard) first, with OpenBot and t3code as comparisons.

## Switchboard today

- Package `@mattsp1290/switchboard@0.0.0`, private, ESM, Node `>=24.22.3 <25`,
  no registry; consumers pin a commit-named tarball. Exports: `.`, `./agui`,
  `./testkit`, `./pi`, `./codex`, `./claude`, `./observability`.
- Exact optional peers: `@openai/codex-sdk` 0.169.0,
  `@anthropic-ai/claude-agent-sdk` 0.3.323, Pi packages 1.5.2,
  `@ag-ui/core` 1.0.4. Crew pins Codex 0.167.1 and Claude 0.3.306.
- The three exported adapters (`adapters/{claude,codex,pi}/src/index.ts`) are
  text-only: tools forced off, no approvals, no usage, no LiteLLM, no
  discovery, static credentials, and Claude and Codex spawn their own CLI with
  environment copied from `process.env`.
- A private Codex app-server stack exists under `src/adapters/codex/`
  (transport, sessions, execution, interaction, features, route, proxy) with
  native proofs in CI. No export reaches it. `item/tool/call` (dynamic tools)
  is refused with `-32601`; tool and delegation continuations are unsupported;
  an approval lives in memory and is settled `lost` on process loss.
- Core contracts (`src/core/`): sessions, events (`createEventStream`),
  interaction (`PendingApproval`, `InteractionContinuation`, `ToolOutcome`),
  dispatch (`createDispatchOperation`), auth (`createAuthContext`,
  `CredentialResolver`), frontend restore. `docs/architecture/boundaries.md`
  states what the host owns: authorization, credential resolution, durable
  intent and outcomes, storage, replay, recovery, workflow retries.
- Launcher rule for adapters (`docs/architecture/boundaries.md`, added in #43):
  accept a host-supplied executable or spawn function, take only the host's
  environment and configuration, state who owns the process, work under host
  confinement, report `unavailable` rather than fall back.
- Open pull request #68 pins Codex `approval_policy="never"` under a LiteLLM
  route (issue `pvvq`, an owner decision of 2026-11-17).

## Switchboard issue graph (Beans project `switchboard`)

Four blockers of `crew-0n8g`, all claimed by this session:
- `mebb` complete Codex adapter: only `agentui-wtdo` (pin AG-UI PR49 fork
  artifacts, in progress) blocks it. Remaining: compose the private modules
  into a public entry and run the integrated fault suites.
- `ishc` complete Claude adapter: needs `ylju` (approvals, continuation,
  cancellation) and `s85t` (LiteLLM routing, renewable auth). Chain:
  `yejc` (qualify integration and reuse boundary; stalled 2026-11-13 on a
  strict-TypeScript failure in MCP 1.32.2 `HeadersInit`) -> `p0mr` (discovery
  and native session references) -> `k20g` (native turn execution and
  cleanup) -> `ylju`; `k20g` -> `ck2y` (preserve native configuration and
  feature hooks) -> `s85t`.
- `rijp` complete Pi adapter: `rlsx` (qualify integration and reuse boundary)
  -> `o6dg` (discovery) -> `six1` (turn execution) -> `y84s` (approvals) and
  `vtzi` (configuration and hooks) -> `rc08` (LiteLLM).
- `bzn9` packed exports: needs `km2q` (full-adapter consumer and host
  responsibility example) and `apbp` (qualify remaining Crew and AgentUI
  adapter integration), both behind `3g7b` (qualify AG-UI mappings across
  native adapters), which needs all three adapters.

A chain of confinement and custody proofs gates Claude and Pi:
`jrvo` (stopped-newborn sharing-family custody, in progress) -> `i72g`
(complete native sharing-family custody) -> `ftwo` (pathname observation
stability; the spike README calls it INCONCLUSIVE) -> `j3r0` (confined
installed module imports) -> `4k6g` (installed Claude compiler boundary) ->
`yejc`; and `j3r0` -> `525r` (Pi registration interposition) -> `rlsx`.

Ten sibling worktrees `switchboard-*` next to the Switchboard checkout hold
uncommitted work from an abandoned handoff (untouched since 2026-11-17),
including `switchboard-stopped-newborn` and `switchboard-birth-receipt`
(`jrvo`) and `switchboard-pi-registration` (`525r`).

## Crew's engine integration today

- Driver contract: `TurnDriver`, `DriverInput`, `DriverResult` in
  `src/service/activities.ts`; profiles map to drivers in
  `src/service/profiles.ts`. Six layers per segment: Temporal activity ->
  `supervisor.ts` -> `supervisor-host.ts` (reserves a `native_launches` row)
  -> `supervisor-runner.ts` (`withNativeAdmission`, spans) -> the engine
  driver -> result validation and commit.
- Claude: `claude.ts` forks `claude-worker.ts`, which uses the vendored
  AG-UI Claude adapter and spawns the CLI through `native/member-launch.c`.
- Codex member lane: `codex.ts` on the Codex SDK (exec), with a loopback MCP
  server (`codex-mcp.ts`) and a live-held call (`codex-live.ts`,
  `codex-calls.ts`). Codex trusted lane: `trusted-codex.ts` speaks raw
  app-server JSON-RPC with dynamic tools.
- Pi: `pi-launch.ts` supervises a confined `pi-worker.ts`; the host relays
  every model request and verifies the worker's result (`pi.ts`).
- A second "trusted" lane (`trusted-native.ts`, `trusted-*.ts`) has no
  production caller.
- Crew uses Switchboard only for `createEventStream` in
  `src/service/observer-hub.ts` (tarball pinned at `58c7922`, which contains
  no adapters) and a repackaged observability entry in `telemetry.ts`.
  Workflow code must not import Switchboard.

## Earlier recorded verdicts (2026-11-14 debate)

In the handoff directory named by Beans issue `crew-2xqx` (files
`sb-debate-advocate.md`, `sb-debate-steward.md`, `switchboard-plan-core.md`,
`switchboard-plan-agui.md`):
- Recommendation (c): Switchboard grows its adapters independently and Crew
  swaps one lane at a time, only after qualification and only where its seams
  fit. Moving Crew's drivers into Switchboard was rejected.
- Switchboard keeps the Codex app-server; Crew moves later, trusted Codex
  lane first, then the member lane.
- Launcher and configuration seams: accepted as adapter acceptance criteria.
- Dispatch, resumable projection, cross-process authority, diagnostics: no
  library change; they stay with Crew.
- Frontend tools (issue `crew-5t1v`): Switchboard owns native definitions,
  pending identities, original-call restoration, result delivery and AG-UI
  mapping; Crew owns authorization, durable calls, reservations, receipts and
  continuation decisions.
- Standing rules in `crew-2xqx`: Switchboard and AgentUI changes are argued by
  subagents before any pull request; permission changes need owner review; do
  not run `tests/proof/replay-traces.mts` on the shared host; no paid
  providers.
- Related issues say: no parallel native drivers (`crew-1rcl`); no direct
  native fallback or second adapter architecture (`crew-avzm`); do not import
  source spikes or substitute controlled core tests for native parity
  (`crew-0n8g`).

## The ten contested seams

1. Session checkpoint ownership (Crew's digest-verified checkpoints; for Pi
   the checkpoint is the session) versus Switchboard's `SessionReference`.
2. Process launch and process-group ownership (Crew's Landlock launcher and
   reap evidence before it writes `stopped`).
3. The Pi worker with host-relayed model requests and result verification.
4. The Codex member lane: SDK exec with a live MCP hold versus app-server.
5. Pausing a tool call for a human and resuming it, including across a
   process restart; Claude's recovery of a stopped proposal without a model
   call.
6. Cancellation evidence and uncertain outcomes.
7. Event translation versus redaction, item receipts and the durable public
   wire.
8. Credentials: Crew's per-request signing relay and per-turn ChatGPT sign-in
   read versus Switchboard's LiteLLM route with host-resolved credentials.
9. Usage normalization per SDK.
10. Child and cross-engine drivers (`crew-69mf`) versus no parallel native
    drivers.

Plus four needs no adapter provides: host-injected system context; host-run
tools offered to the model (the capability foundation now on Crew `main`,
`docs/member-capabilities.md`); images in tool results; and whether the
confinement proof chain is a Switchboard obligation or Crew's launcher's.

## Salvage assessment of the abandoned Switchboard worktrees (2026-11-18)

- None of the ten worktrees is worth salvaging as is. Six are superseded by
  work merged to `origin/main` or identical to it. None of their branches is
  on the remote and none has a pull request.
- The two `jrvo` worktrees (`switchboard-stopped-newborn`,
  `switchboard-birth-receipt`) hold early drafts that their own review notes
  rejected and that were never run. The most advanced `jrvo` work (a source of
  about 22,000 lines, frozen as "V35", best run refused at control 1204 of
  1397, verdict INCONCLUSIVE) is on another host and is not on the remote or
  this machine.
- `switchboard-pi-registration` (`525r`): a 116-line registration policy and
  its bypass-check list are worth mining; the rest is over its size cap and
  never compiled or run.
- `switchboard-node-preflight`: two findings worth keeping. Node's
  `--permission` does not deny `lstat` outside a grant, and runc injects
  `HOME`, so a confined entry point must use `env -i`.
- The agents' notes are in the Switchboard main checkout's ignored `.audit/`
  directory.

## What the confinement and custody chain is for

- Switchboard decided that before it imports any native SDK in its own tests
  it must show that the import runs under enforced OS and Node confinement,
  and that a forbidden attempt is seen even if the SDK catches the error and
  exits 0. Its chosen observer is a ptrace syscall tracer. A two-thread test
  showed another thread can rewrite a path between the tracer's read and the
  kernel's read, so every memory-sharing task must be in the tracer's custody
  from birth. `jrvo`, `i72g` and `ftwo` exist only to make that observer
  trustworthy. `j3r0` is the confinement proof itself. `4k6g` adds the Claude
  compile boundary (packed packages compile under strict policy with no
  skipped declaration checks, SDK types do not leak, the no-DOM `HeadersInit`
  error is reproduced as a control). `525r` proves host-owned Pi providers
  and routes survive extensions that re-register providers.
- The chain gates full qualification, not delivery: the text-only `./claude`
  and `./pi` adapters shipped without it.
- Inference by the explorer: a host that enforces confinement in the kernel
  does not need `jrvo`, `i72g` or `ftwo` for runtime safety. Crew's
  `native/member-launch.c` uses Landlock (checked against the object actually
  opened), denies `setsid` and `setpgid`, sets a parent-death signal, and in
  Pi mode denies sockets, fork and `ptrace`; the host kills and reaps the
  process group. Crew's Pi worker has no sockets and relays every model
  request, which meets the route half of `525r` by design. What Crew does not
  provide: visibility of denied-but-caught attempts, and blocking of metadata
  checks such as `stat`.
- `yejc` stalled on TS2304 for `HeadersInit` in MCP 1.32.2's transport
  declarations, raised because Claude SDK 0.3.323 imports `McpServer`. On
  `origin/main` this is worked around, not fixed: the Claude adapter compiles
  as a separate project with `skipLibCheck: true`, and
  `scripts/verify-package.mjs` asserts the emitted declarations contain no
  `@anthropic-ai` reference. `4k6g` still requires no skipped checks.
