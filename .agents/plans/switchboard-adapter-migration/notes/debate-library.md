# Debate brief: the library advocate

Sources, read-only: Crew `origin/main` ef86e62 (the local `main` is behind it), Switchboard (SB) `origin/main` ef2dc4c, AgentUI `origin/main` e5db45f, t3code 8cf97b5f, OpenBot 5ec28bc, and the Beans `switchboard` and `crew` issues. "bnd" means SB `docs/architecture/boundaries.md` and "fr" means SB `docs/architecture/frontend-restore.md`. Nothing was run.

## The test I apply

A responsibility belongs in SB when it encodes how to drive a particular SDK (its file formats, hooks and quirks) and a second host would need the same knowledge. Policy stays with the host: who may do what, what is durable, and when to retry. AgentUI is a real second host. It already runs SB's `./claude` adapter and lists "interactive tool approvals, LiteLLM, renewable credentials, attachments" as remaining work (`agentui docs/integration/switchboard/claude.md:12-21,61-62`). The owner's decision that compatibility is not required removes the two strongest objections from 2026-11-14: exact-version session binding, and a byte-stable public wire. Several "stays with Crew" verdicts should therefore be reopened.

## The ten seams

### 1. Session checkpoints
- **Claim.** Each adapter returns a `CheckpointReference` (bnd:146). Its opaque token is the adapter's digest of native history at the end of the turn. `resume` accepts an optional expected checkpoint and verifies it before writing. The Pi adapter accepts a host session store (load and append entries) in place of a directory.
- **Why the library.** Crew re-implements native formats: the Codex `state_5.sqlite` index, rollout path patterns and `task_complete` markers (`src/service/codex.ts:45-73`), and Claude transcripts (`claude-worker.ts:39-59`). SB's private Codex sessions read the same history through `thread/read` (bnd:228-242), and bnd:153 already makes validating native references an adapter duty. Two readers of one format will drift. AgentUI refuses "missing or mismatched saved sessions" (`agentui claude.md:31-32`). t3code makes resume "a required adapter primitive" (comparison.md:25-27). Now that stored data may break, exact `nativeVersion` binding (bnd:144) strands nothing Crew must keep.
- **What the host still does.** Stores checkpoints, decides whether to require them, owns the correlation map (bnd:147), and keeps Pi's session bytes.
- **Cost and risk.** Moderate, in `p0mr` (Claude) and in `o6dg` and `six1` (Pi). Codex needs only the digest. A host that passes no expected checkpoint gets native behaviour. The 8192-unit opaque limit (bnd:151) cannot carry Pi's 4 MiB session, which is why Pi needs the store.
- **Strength.** Strong: duplicated parsing of native formats is the clearest drift across the two repositories.

### 2. Process launch and process groups
- **Claim.** Every adapter takes a host `spawn`. For Pi, the adapter instead runs inside a host process. The adapter declares that the host owns the process. Under host ownership, `close` and interrupt never signal the process, and the adapter reports exit only from facts the host attests.
- **Why the library.** This is already SB's rule (bnd:122-134) and the 2026-11-14 verdict, and SB's private Codex execution already works this way (bnd:246,249). The SDK hooks differ per engine: Claude's `spawnClaudeCodeProcess`, Codex's executable override, and the app-server channel. Mapping between them is library knowledge. AgentUI runs hosts over SSH (`agentui boundaries.md:28,54`).
- **What the host still does.** Keeps `native/member-launch.c` (280 lines of Landlock and seccomp, which refuse `setsid` and `setpgid`; `docs/verification.md:48-60`). Kills and reaps the process group, and holds reap evidence before it writes `stopped` (`supervisor-host.ts:203-204,239`).
- **Cost and risk.** Small: acceptance criteria on `k20g`, `six1` and `mebb`. Today's exported adapters spawn directly with `process.env` (`adapters/claude/src/index.ts:74-78,150-161`). A host that passes nothing keeps that default.
- **Strength.** Strong, and nobody contests it.

### 3. The Pi worker
- **Claim.** The Pi adapter accepts a host-supplied model stream function and a host tool executor. When the host asks, it uses in-memory sessions and loads no extensions, so it needs no sockets or credentials of its own.
- **Why the library.** Crew's worker builds a `ModelRuntime` with a host-registered provider whose `stream` crosses descriptor 3 (`pi-worker.ts:26-47`). SB's `525r` is building the same seam: "a genuine nominal ModelRuntime per native session-factory generation" with "host-owned providers". Two implementations of one SDK seam argue for keeping one.
- **What the host still does.** Owns the worker process, the descriptor-3 channel and the launcher. It also keeps the result verification in `pi.ts:84-125`, which encodes Crew's choice to distrust its own worker.
- **Cost and risk.** Moderate, in `six1`, `vtzi` and `rc08`. With extensions off, `525r`'s five mutation guards have nothing to guard, so this mode need not wait for `525r`.
- **Strength.** Moderate for injection. I concede the worker and the verification.

### 4. The Codex member lane
- **Claim.** SB's app-server adapter supports host dynamic tools. It sends `thread/start.dynamicTools` from a host declaration, surfaces `item/tool/call` as a pending host call, and answers with `contentItems`. Crew's member lane moves to it from SDK exec with a loopback MCP server.
- **Why the library.** SB refuses `item/tool/call` today (`src/adapters/codex/interaction.ts:26`), but it needs the call for frontend tools anyway. A warm reply was seen in a fixture (`features.ts:108`, fr:83), and `5py2` gives SB "native definitions, complete pending batches, original-call restore". Crew already speaks this protocol in its trusted lane, which has no caller (`trusted-codex.ts:98-104,138`). It also records that dynamic tools need app-server, not the SDK (`docs/member-capabilities.md:719`). Crew runs three Codex clients today: SDK exec (`codex.ts`), raw JSON-RPC (`trusted-codex.ts`), and an app-server it starts only to read sign-in (`codex-subscription.ts:131,180`).
- **What the host still does.** Keeps the call ledger states (`codex-calls.ts`), approvals and hold limits.
- **Cost and risk.** Moderate. It needs a new issue after `mebb`, shared with `5py2`, so `mebb` is not delayed. The native API is experimental, and Crew's 120 s and 170 s holds are unqualified (`member-capabilities.md:720`).
- **Strength.** Strong.

### 5. Pausing a tool call and resuming it across a restart
- **Claim.** Generalize SB's frontend-restore contract (fr:5-12,63-73) from frontend tools to all host tools. The adapter emits a pending batch with exact native identity and a checkpoint. After a restart it reports a `RestoreObservation` from native state, and it carries out `paired-repair`: Claude resumes with a `tool_result`, Pi calls `appendMessage` then continues, and Codex calls `inject_items`. Claude's recovery of a stopped proposal becomes the Claude adapter observing an unanswered `tool_use`.
- **Why the library.** Crew does this per engine in three places (`claude-worker.ts:74-93`, `pi-session.ts:40-50`, `codex-live.ts:35`). For Claude it already depends on a third-party adapter's deferral (`claude-worker.ts:126-144`). The constraints are facts about each SDK: Claude defers only a call that is alone in its message, and in-process MCP tools cannot be restored (`member-capabilities.md:716-718`). AgentUI's restart recovery and frontend tools need the same mechanism (`agentui claude.md:31-32`; `5py2`).
- **What the host still does.** Keeps durable pending rows, decisions, receipts, and the choice of mechanism. SB persists nothing (fr:11).
- **Cost and risk.** Moderate to large, in `ylju`, `y84s` and `5py2`. Every `paired-repair` cell is `unavailable` today (fr:83), so this is real native qualification. t3code declines the restart case (`pendingRequestsSurviveRestart: false`, `ClaudeAdapterV2.ts:519`), and OpenBot avoids it by ending the run. A host that chooses `defer` leaves native state untouched.
- **Strength.** Strong.

### 6. Cancellation evidence
- **Claim.** `interrupt()` returns a typed native result: terminal observed, interrupted, or unconfirmed within a bound. A turn reports `outcome-unknown` with its evidence.
- **Why the library.** SB already does this for Codex (bnd:250-251) and in `createDispatchOperation` (bnd:363-395). t3code has the same shape, with a 15-second bound and "may still be running" (comparison.md:40-42).
- **What the host still does.** Holds reap evidence, finalizes `uncertain`, and never resubmits (bnd:39-41).
- **Cost and risk.** Small. It is already in the acceptance of `k20g`, `six1` and `mebb`.
- **Strength.** Moderate: the library's part is small, and the decisive evidence, the reaped process group, is Crew's.

### 7. Event translation, redaction, receipts and the public wire
- **Claim.** Adapters emit normalized facts (text, tool start, arguments and end, reasoning, usage) into `createAguiProjection`. There is one actor per native segment, and each segment ends as an AG-UI run carrying `pendingToolCallIds`.
- **Why the library.** Both comparison projects put translation in the adapter (comparison.md:102). Crew already hands Claude's translation to the vendored AG-UI adapter and then re-parses its events (`claude-worker.ts:157-202`). AgentUI already uses the projection (`agentui boundaries.md:19`). Without a compatibility requirement, Crew can adopt tuple IDs in place of `toolCallId == approvalId`.
- **What the host still does.** Owns redaction policy, item receipts, cards, cursors, the durable wire and replay (SB `docs/protocol/ag-ui.md:117`).
- **Cost and risk.** Moderate, in `3g7b` and `iddr`. Crew's public IDs change, which the owner now permits.
- **Strength.** Moderate: strong for translation. I concede redaction and the wire.

### 8. Credentials
- **Claim.** Widen the `litellm-proxy` route to a host-declared proxy (endpoint, protocol, and a credential resolver called per request), so that Crew's signing relay is just a proxy route. The adapter writes each engine's native configuration for it. The per-turn ChatGPT sign-in check becomes the Codex adapter's `account/read`.
- **Why the library.** Pointing Codex `model_providers`, Claude's base URL and a Pi provider at a proxy is SDK knowledge that SB already has for LiteLLM (bnd:234). The 2026-11-14 steward accepted a generic proxy label "when an adapter needs it" (`sb-debate-steward.md:188-190`), and this migration is that moment.
- **What the host still does.** Runs the relay, resolves upstream credentials, and approves accounts.
- **Cost and risk.** Small to moderate, in `src/core/auth.ts`, `s85t` and `rc08`. Changes to auth need owner review.
- **Strength.** Moderate.

### 9. Usage
- **Claim.** Each adapter reports usage per turn in the native fields, plus canonical token meanings. Hosts set prices and budgets.
- **Why the library.** Crew parses usage separately for each SDK (`usage-capture.ts:65-156`), including diffing Codex rollout totals. SB's execution already does this for Codex (bnd:247), and `six1` includes it for Pi. In t3code the adapter reports and the host prices.
- **What the host still does.** Keeps prices, budgets and the ledger.
- **Cost and risk.** Small; it is existing scope.
- **Strength.** Strong.

### 10. Children and cross-engine drivers
- **Claim.** SB has no child driver. A child is an ordinary turn with host instructions and host tools (needs 1 and 2), plus a native-subagents-disabled option that each adapter enforces natively. SB already pins Codex `multi_agent` off under a route (bnd:234).
- **Why the library.** Turning off an engine's own agent tool is SDK knowledge, and OpenBot does it in the harness (comparison.md:86).
- **What the host still does.** Owns targets, seals, budgets, roles, routing and the delegate tool (`crew-69mf`).
- **Cost and risk.** Small.
- **Strength.** Conceded for orchestration; moderate for the option.

## Four unmet needs

### Need 1. Host-injected system context
- **Claim.** An `instructions` input per session and per turn, which the adapter places: Claude's system prompt, Codex developer instructions, Pi's system prompt.
- **Why the library.** Crew places it separately for each engine (`claude-worker.ts:115`, `trusted-codex.ts:138`, `pi-worker.ts:61`). t3code passes host context to its adapters (`ProviderAdapter.ts:590,656-659`), and OpenBot's harness adds host text to Claude's `append` (`agent-claude-sdk/src/adapter.py:796-804`).
- **What the host still does.** Writes the content.
- **Cost and risk.** Small, in `k20g`, `six1` and `mebb`.
- **Strength.** Strong.

### Need 2. Host-run tools offered to the model
- **Claim.** The host declares tools for each turn (name, description, JSON schema). The adapter offers them through the native mechanism and surfaces each call as a pending host call with exact native identity. The host answers with a `ToolOutcome`. A capability reports limits such as Claude's solo-call deferral.
- **Why the library.** Crew's own SDK table is per-engine knowledge (`member-capabilities.md:713-722`). OpenBot's harness builds Claude's in-process MCP server from host tools (`adapter.py:704-733`), and t3code injects an app-owned MCP endpoint (`ProviderAdapter.ts:661-690`). Frontend tools are the same mechanism with the client as the executor (`5py2`), and AgentUI lists tool approvals as remaining work.
- **What the host still does.** Runs the tool, and owns the gate, capability sets and the ledger.
- **Cost and risk.** Large, and the biggest new surface. It is best built once, together with `5py2`. No issue exists for it yet.
- **Strength.** Strong.

### Need 3. Images in tool results
- **Claim.** `ToolOutcome` content admits image parts, mapped to each engine's native form: Claude image blocks, Codex `inputImage`, Pi image content.
- **Why the library.** Content mapping differs per SDK. `5py2` already requires "errors/media", and AgentUI lists attachments.
- **What the host still does.** Produces the images and bounds their size.
- **Cost and risk.** Small to moderate, inside `5py2`.
- **Strength.** Moderate.

### Need 4. Who proves confinement
- **Claim.** SB owns the contract (bnd:129-132) and a testkit scenario that any host launcher must pass: a denial surfaces as an operation error or `unavailable`, never as a fallback. Proving a confinement mechanism belongs to whoever ships that mechanism.
- **Why the library.** I concede the substance. Crew's launcher is the confinement that actually runs, and a proof about SB's ptrace observer says nothing about Landlock.
- **What the host still does.** Proves its own launcher.
- **Cost and risk.** Removes work from SB.
- **Strength.** Conceded for the proof itself.

## A. The proof chain should not gate the adapters

The chain is now the only open SB blocker on both adapters. Every blocker of `yejc` except `4k6g` is closed, and `rlsx` waits only on `525r` and `agentui-wtdo`. By its own disposition, `jrvo` is at its 34th version: about 22,000 changed lines across 70 files after a human waived its 749-line cap. Its last run ended in a Python SIGSEGV of unknown cause, and it has no pull request or merge. `i72g` is open behind it, `ftwo` waits on `i72g`, and the spike's verdict is still INCONCLUSIVE. Meanwhile bnd:134 says "Core defines no launcher", and adapters must work under host confinement.

So SB should ship the Claude and Pi adapters with a host launcher:
- Keep `4k6g`'s compiler and declaration gate, since the `yejc` HeadersInit stall is real library work, but drop its "pass proven confinement" clause.
- Let `525r` proceed without `j3r0`, and only for the mode with extensions enabled.
- Run qualification imports inside Crew's launcher or a container without network.

The chain can continue as research off the critical path.

## B. Swap one engine at a time, against a neutral contract tested by Crew

Delete each Crew driver in the same pull request that adopts its adapter, with no flag, as `crew-1rcl` and `crew-avzm` already require. Delete the unused trusted lane once its dynamic-tool knowledge has moved into SB. Order: Codex (closest to done), then Claude, then Pi.

Shape the contract neutrally, in t3code's form: open, resume, start a turn, interrupt, respond, events and capabilities. Do not use Crew's `DriverResult` vocabulary (`activities.ts:37-41`), which describes workflow state; Crew keeps a thin shim instead. Crew should, however, be the host that accepts each adapter. SB's own record says to follow Crew's driver seams "as starting evidence" (`switchboard-contract-and-acceptance.md:7`) without making Crew's restrictions defaults (`switchboard-decisions.md:10`). So every option Crew drives must default to native behaviour, and must either name its second user or report `unavailable`.
