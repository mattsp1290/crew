# Advocate brief: split the gates by risk, not by engine (2026-11-18)

Assigned position: option 3. Checked against Switchboard `origin/main` `ef2dc4c` and Crew `ef86e62`.

## The split the evidence supports

The naive split (re-scope Claude, keep Pi behind the chain) is backwards.

- **Crew confines Pi best.** The Pi SDK runs inside the launcher with sockets, fork and `ptrace` denied (`native/member-launch.c:160-178`). Every model request crosses descriptor 3 (`pi-worker.ts:31-46`), discovered extensions are off (`pi-session.ts:66`), and `tests/fixtures/engines/pi/confinement.test.ts` proves the policy.
- **Crew confines Claude worst.** The Node process that imports the Claude SDK is forked unconfined with the relay key in its environment (`claude.ts:128-143`). Only the CLI goes through the launcher (`claude-worker.ts:106-110`), and its network is open (`docs/verification.md:62-63`).

If one engine had to wait, it would be Claude. Neither should wait on the chain, which closes neither gap: it is a Linux ptrace observer for Switchboard's own test imports. The supported split is by risk:

1. **Observing caught attempts** (`jrvo`, `i72g`, `ftwo`, `j3r0` as written): research that blocks nothing.
2. **Claims only the library can make**: Claude's typed boundary (`4k6g`, compile half) and Pi registration conflicts (`525r`). Each blocks one engine at one capability.
3. **Enforcement only a host can supply**: gates that host's adoption, per engine. In Crew, Pi is ready and Claude is not.

## Per issue

**`jrvo`, `i72g`, `ftwo`: block neither.** They exist only to make the tracer trustworthy. `jrvo` is about 22,000 lines, INCONCLUSIVE, and its best source is on neither this machine nor the remote. No replacement.

**`j3r0`: blocks neither as written.** Its rule, "before any native SDK import", is already not held. On `origin/main`, `npm test` imports both SDKs (`tests/adapters/pi/runtime.test.mjs:8-9`, `adapters/claude/src/index.ts:5`) in the CI `verify` job with no launcher. Two replacements:

- A Switchboard qualification-environment rule. Native imports and turns run only on an ephemeral runner or a `--network none` container with no host home, `env -i` and synthetic credentials, as the Codex native proofs do (`spikes/codex-native/qualify.mjs:53`). It enforces; it does not observe.
- A testkit launcher scenario that Switchboard writes and each host runs. Under a host spawn function (Claude) or a host worker with an injected stream (Pi), a denial is an operation error or `unavailable`, never a fallback (`boundaries.md:122-134`).

Lost: sight of denied-but-caught attempts and of `stat` probing.

**`4k6g`: the compile half blocks Claude only; the confinement clause is dropped.** `origin/main` already compiles both adapters as isolated projects with `skipLibCheck: true` and asserts that emitted declarations name no SDK (`verify-package.mjs:71,75`). Pi passed that way in `3s9g` with no further gate. Ask Claude for the same plus the `HeadersInit` control.

**`525r`: blocks Pi only, and only the cell "extensions enabled under a selected proxy route".** Detach it from `j3r0` and `rlsx` and attach it to `vtzi` and `rc08`. Until it passes, the adapter reports that combination as a policy conflict, which `switchboard-plan.md:73` already permits. The issue itself disclaims "arbitrary JavaScript isolation" and "actual routing", and `pi-selection.md` says enforcement needs "a host-controlled request boundary". So the real replacement is a host-supplied stream function, which is Crew's design.

**New host gate, Claude only.** Before Crew adopts the full Claude adapter, start `claude-worker.ts` through the launcher and limit TCP to the relay port, as Codex mode does (`member-launch.c:228,250`). Untested. It gates `apbp`, not `ishc`.

## Where option 1 is simply right

Four of the six rows are the same for both engines, and there my split adds nothing. Both earlier advocates already keep the `4k6g` compile half and the extensions-on `525r`. My split is their recommendation with three additions: `525r` gates a capability cell instead of all of `rlsx`; Claude gets a named host gate; `j3r0` gets an owned replacement. If that is too fine, option 1 loses little.

## Where option 2 has a point

- The text-only precedent is weaker than claimed. Those adapters force tools off. Full adapters turn native tools on, and then confinement is the only defence. AgentUI on macOS gets none from a Linux launcher, nor from the chain.
- "No SDK import until the gate qualifies" guards a real hazard: a developer machine with a live `~/.claude` and credentials. `npm test` already breaches it. Option 1 without a `j3r0` replacement ratifies the breach.
- Only the chain would show a caught attempt.

None of this justifies an unbounded cost on the critical path.

## My choice as owner

Option 3 in the risk form: option 1 for the tracer chain, plus two narrow library gates and one host gate. Not the naive form.

| Issue | Blocks Claude adapter | Blocks Pi adapter | Replacement gate | Owner of replacement |
| --- | --- | --- | --- | --- |
| `jrvo` | No | No | None; research | Switchboard (off path) |
| `i72g` | No | No | None; research | Switchboard (off path) |
| `ftwo` | No | No | None; research | Switchboard (off path) |
| `j3r0` | No | No | Qualification-environment rule; testkit launcher scenario | Switchboard writes both; the host runs the scenario on its launcher |
| `4k6g` | Yes, compile half only | No | Isolated project, declaration-leak assertion, `HeadersInit` control; confined Claude worker before Crew adopts | Switchboard (compile); host (launcher) |
| `525r` | No | Only extensions on under a proxy route | Policy conflict until proven; host-supplied stream function | Switchboard (conflict report); host (stream) |
