# Advocate brief: finish the chain first (option 2)

SB cites: `origin/main` `ef2dc4c` and `.audit/`. Crew cites: local `main`. Nothing was run.

## What the gate protects

The rule is stated in `.audit/native-compiler-judgment.md:124`: "Omission alone is not isolation: SDKs can use OS home lookup." It asks for denial of "production-home/config reads and existence checks", writes outside the fixture, network and process execution, and for rejection of a package that "catches prohibited-access errors and exits successfully". The plan supports it: discovery must "never scan unrelated homes" (`switchboard-plan.md:50`). I found no sentence in the owner's own voice. The text is agent-written under the owner's account. The one clearly human act is the jrvo size waiver, so the owner chose to keep paying for this gate.

## What the earlier advocates missed

1. **The danger is in SB's own runs, where there is no host.** The full adapters enable tools (Claude Bash, Pi extensions that run code at load), scan native history and read config. On the owner's Mac, a wrong fixture path or an SDK fallback to `os.homedir()` reaches the real `~/.claude` and `~/.pi`, credentials included, and exit 0 cannot show otherwise. "Never scan unrelated homes" is a claim about attempts, so only an attempt observer can verify it.
2. **The gate is already breached.** `npm test` imports the real Claude SDK (`adapters/claude/src/index.ts:5`, through `tests/adapters/claude/runtime.test.mjs:6`) and the Pi SDK (`adapters/pi/src/index.ts:4-7`) with no confinement and `HOME` intact, in CI and on the Mac. Option 1 makes that breach the norm for adapters that run tools and discovery.
3. **Crew's launcher does not cover the import.** The Node process that imports the Claude SDK is forked without confinement (`src/service/claude.ts:128-143`). Only the CLI goes through the launcher. Claude's network is unrestricted (`docs/verification.md:62-63`). Landlock does not mediate metadata (`member-launch.c:140`), so the existence checks that j3r0 requires to be denied still succeed. The Pi worker can read all of Crew's `node_modules` (`:264`). "Run qualification inside Crew's launcher" therefore does not meet the standard as written.
4. **macOS gets nothing.** AgentUI runs on macOS and the owner develops on macOS. The `sandbox-exec` probe produced zero diagnostics for a caught SQLite read and a DNS attempt (`native-import-confinement-grounding.md`, macOS paragraph). "Confinement is the host's job" leaves AgentUI with no tested boundary.
5. **Erosion.** Re-gating on "a host-side test" turns a library qualification rule into an assumption about the host.

## Where my position fails

Finishing `jrvo` -> `i72g` -> `ftwo` is the wrong cost for the safety property.

- **Threat model.** The ptrace custody chain exists to defeat a thread that rewrites a pathname between the tracer's read and the kernel's read. The judgment that selected it says the traces "support the narrow race premise, not an escape" (`observer-mechanism-judgment.md:7`). The grounding note claims no security against hostile native code (`native-import-confinement-grounding.md:78`). The SDKs are careless, not adversarial. Custody from birth defends against an attacker the plan does not assume.
- **Original scope.** "Original requirements do not prescribe ptrace" (`decisions.tsv:164`). A kernel-audit alternative was left unselected, not rejected (`j3r0` log).
- **Cost and evidence.** `jrvo` reached V34/V35 at about 22,000 lines against a 749-line cap. Its best run refused at control 1204 of 1397. Its last journey run ended in a Python SIGSEGV of unknown cause. The source is on another host and not on the remote. `i72g` (646 lines estimated) and `ftwo` (695 lines estimated, its spike INCONCLUSIVE) have not started on a working base. A realistic estimate is weeks or more, and success is uncertain.
- **Precedent.** Codex was qualified, without the chain, in a container with no network, a read-only root and no host mounts (`native-qualification-preflight.md:13`).
- **Cheaper observers.** seccomp user notification has the same pointer race. eBPF or fanotify would need their own proofs. For code that does not attack, the sound tool is to keep production state out of reach, plus a best-effort trace.

The evidence defeats option 2 as literally stated.

## What I would choose as owner

Option 1, amended: re-scope the gates, but replace the chain with a cheaper SB-owned gate for SB's own runs rather than dropping it. Option 3 does not help, because it leaves Pi waiting through `j3r0` on the same ptrace chain, the wrong tool.

## Smallest defensible version

Replace `j3r0`'s dependency on `ftwo` with a new gate of a few hundred lines. Most of it exists in `.audit/confinement-audit-probe/linux.mjs`.

- **Container.** Every SB run that imports a native SDK, including today's `tests/adapters/{claude,pi}`, runs in a pinned Linux container. It uses `--network none`, a read-only root, `cap-drop ALL`, `no-new-privileges`, a non-root UID and `env -i`, and mounts only the packed package and fixture, read-only. Docker Desktop covers the Mac.
- **Canaries.** The container's fresh home holds sentinel files at real paths such as `.claude/.credentials.json` and `.pi/agent/auth.json`.
- **Failure conditions.** `strace -f` fails the run on any open or stat of a canary path, any socket or connect, or any exec outside an allow-list, even on exit 0. A sentinel in any output also fails it.
- **Present/absent check.** Run the test from `confinement-premise.md` once.
- **Narrowed claim.** "No production state reachable, no network, sensitive-path attempts observed for code that does not race its own syscall arguments." The race limit is stated openly.
- **Downstream.** `4k6g` keeps its strict compile half against this gate, and `525r` proceeds under it. `jrvo`, `i72g` and `ftwo` become research.

This keeps the property the owner paid for and ends the unconfined imports already on `main`.
