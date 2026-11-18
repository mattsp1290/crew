# Execution handoff

Implementation has not occurred, except packages S0a and P0.

## Repositories and standing rules

- Crew: this repository, base branch `main`. Work only in a new worktree made
  from `origin/main`. The main checkout is shared.
- Switchboard: `mattsp1290/switchboard`, base branch `main`. Set
  `SWITCHBOARD_REPO` to a new worktree or clone made from `origin/main`. Do
  not work in the original checkout's `main` (it is behind) or in any
  sibling `switchboard-*` worktree.
- AgentUI: `mattsp1290/agentui`, base branch `main`. Set `AGENTUI_REPO` to a
  new worktree made from `origin/main`.
- Beans: use the binary at `$HOME/.local/bin/bn` (another `bn` on the path is
  incompatible), with `--project crew`, `--project switchboard` or
  `--project agentui`. Run mutating commands one at a time. Each package
  owner notes progress on its issue.
- Never run `tests/proof/replay-traces.mts`. Never run
  `scripts/verify --mode fixture` without `--engine`.
- PostgreSQL for tests runs on tmpfs in a container with a unique name
  prefix, removed with its volume at exit. Do not prune or delete Docker
  volumes, images or caches that the package did not create.
- No paid provider. No credential value in a prompt, a log or a pull request.
- A Switchboard change that this plan did not foresee gets a two-advocate
  argument (library and host) before its pull request opens, and the pull
  request body records the verdict
  ([09-debate-evidence.md](09-debate-evidence.md)).

## Work packages in dependency order

| ID | Repository | Result | Depends on | Detail |
| --- | --- | --- | --- | --- |
| S0a | Switchboard (Beans) | AgentUI gate moved | done | [01](01-gates-probes-and-contract.md) |
| P0 | Switchboard | Probe results for assumptions A1 to A8 | done (pull request #69) | [01](01-gates-probes-and-contract.md) |
| R0 | Switchboard (Beans) | Issue re-scope list accepted by the owner (gate G4) | P0 | [01](01-gates-probes-and-contract.md) |
| S0b | Switchboard | Proof chain re-scoped; isolated-import gate; `j3r0` closed | none | [01](01-gates-probes-and-contract.md) |
| C0a | Crew | Engine-fixture workflow green on `main` | none | [03](03-crew-codex-migration.md) |
| A1 | AgentUI | `agentui-wtdo` and its blockers closed | none | [08](08-packaging-agentui-and-closeout.md) |
| S1 | Switchboard | Host-facing adapter contract, core types, conformance suite | P0 | [01](01-gates-probes-and-contract.md) |
| C0b | Crew | Codex at 0.169.0 on the native driver | C0a | [03](03-crew-codex-migration.md) |
| S2 | Switchboard | Codex host adapter; `mebb` closed | S1, gate G4 | [02](02-switchboard-codex-adapter.md) |
| S3 | Switchboard | Claude host adapter; `ishc` closed | S0b, S1, gate G4 | [04](04-switchboard-claude-adapter.md) |
| S4 | Switchboard | Pi host adapter; `rijp` closed | S0b, S1, gate G4 | [06](06-switchboard-pi-adapter.md) |
| C1 | Crew | Codex on the adapter; native Codex driver and trusted Codex file deleted | C0b, S2 | [03](03-crew-codex-migration.md) |
| C2a | Crew | Claude worker confined | C1 | [05](05-crew-claude-migration.md) |
| C2b | Crew | Claude on the adapter; vendored AG-UI Claude adapter deleted | C2a, S3 | [05](05-crew-claude-migration.md) |
| C3 | Crew | Pi on the adapter; vendored AG-UI Pi package deleted | C2b, S4 | [07](07-crew-pi-migration.md) |
| S5 | Switchboard | Packaging and mapping qualification; `3g7b`, `bzn9` closed | S2, S3, S4, A1 | [08](08-packaging-agentui-and-closeout.md) |
| A2 | AgentUI | Switchboard pin moved; checks green | S5 | [08](08-packaging-agentui-and-closeout.md) |
| C4 | Crew | Trusted lane gone, docs final, `crew-0n8g` closed | C1, C2b, C3, S5, A2 | [08](08-packaging-agentui-and-closeout.md) |

## Parallelization

- R0, S0b, S1, C0a and A1 start at once. They touch different repositories
  or disjoint files.
- S2, S3 and S4 may run in parallel after S1, each in its own worktree. They
  share `package.json`, `src/index.ts`, `scripts/verify-package.mjs`,
  `.github/workflows/ci.yml` and `docs/architecture/boundaries.md`; the
  coordinator merges one pull request at a time and each owner merges `main`
  into its branch (no rebase, no force-push).
- C1, C2a, C2b and C3 are serial. They share `package.json`,
  `vendor/switchboard/`, `native/member-launch.c`,
  `tests/fixtures/engines/artifacts.test.ts`, the trusted-lane tests and
  shared docs.
- One owner per pull request. A fix round or a follow-up goes to a fresh
  owner with the original brief, every later directive, and the prior
  report and branch.

## Verification per package

Switchboard: `npm ci`, `npm run build`, `npm run check`, `npm run lint`,
`npm test`, `npm run test:native-isolated` (after S0b),
`npm run verify:package`; `npm run test:codex-guarded` for S2;
`npm run verify:agui` for S5. Switchboard's CI does not run `build` or
`verify:package` today; package S2's first pull request adds them. Node 24.22.3 and npm 11.19.1 on Linux; on a
macOS host, run in a Linux container. CI (`.github/workflows/ci.yml`) green.

Crew: `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, the
engine's fixture tests, the service tests the package file names,
`npm run test:proxy`, `npm run test:usage:capture`, `npm run test:api`,
`npm run test:recovery`. Crew is Linux-only; on a macOS host use a Linux
Node 24.22.3 container with PostgreSQL 17 on tmpfs and the launcher built by
`scripts/build-native`. Service proofs that need Temporal, Landlock and
Docker together run in CI; the pull request's CI run is then the proof, and
the report says so.

AgentUI: `npm ci`, `npm run verify`, `node scripts/verify-agui-fork.mjs`,
with exactly Node 24.22.3 and npm 11.19.1, on Linux.

Never claim a check that did not run. Report each unverified behaviour.

## Review and merge gates

- Two independent reviewers per pull request read the diff against its base,
  not the author's summary. Valid findings are applied; each rejected
  finding gets a one-line reason; a non-trivial fix gets its own review.
- The coordinator merges after green CI and two approvals.
- Owner review before merge: S1 (`auth.ts`); the route pull requests of S2,
  S3 and S4; S4's stream-function pull request; C1, C2a, C2b and C3
  (launcher policy, credentials, what reaches a model); C4 (deleting a
  documented feature).
- Gate G1: met in P0.
- Gate G4: the owner has accepted package R0's re-scope list before S2, S3 or
  S4 opens a pull request that closes an issue.
- Gate G2: on each Crew switch, every job of the native-service matrix in
  `.github/workflows/integration-api.yml`, its `actual-service` job, and the
  engine-fixture workflow pass on the pull request.
- Gate G3: as defined in file 08 under package A2.

## Where each preserved behaviour is proved (success criterion 5)

| Behaviour | Test or proof |
| --- | --- |
| Temporal and PostgreSQL admission | `npm run test:api`, `tests/proof/integration-api.mts` (CI `actual-service`) |
| Recovery fencing | `npm run test:recovery`, `.github/workflows/recovery-qualification.yml` |
| Authorization | `tests/service/gateway-auth.test.ts` in `npm test` |
| Approval and question tools | `tests/fixtures/engines/*/protected.test.ts`, `codex/qualification.test.ts`, `tests/service/supervisor.test.ts` (engine-fixture workflow) |
| Proxy routes | `npm run test:proxy`, `.github/workflows/proxy-qualification.yml` |
| ChatGPT-subscription Codex members | `tests/service/codex-subscription.test.ts`, `tests/fixtures/engines/codex/native.test.ts` |
| Native session resume | `tests/fixtures/engines/*/durable.test.ts`, `codex/native.test.ts` |
| Codex built-in tools | `tests/fixtures/engines/codex/native.test.ts` (confined image read) and the new declared-tools assertion |
| Refusal of ambient configuration | `tests/fixtures/engines/codex/native.test.ts` |
| Cancellation and uncertain outcomes | `tests/service/member-cancel.test.ts`, `supervisor.test.ts` |
| Public HTTP routes | `npm run test:api`, `npm run check:openapi`, `npm run test:client` |

## Rollback

There are no Crew users and no flags. The Crew switches share files, so
rollback is last-in-first-out: revert the most recent switch's merge commit
first. Otherwise fix forward. A Switchboard package is rolled back by
reverting its merge and re-pinning Crew to the previous tarball. AgentUI's
pin move (A2) is rolled back by reverting its pull request. Stored
conversations created after a switch may not resume after its revert.

## Definition of done

1. Success criteria 1 to 7 in [00-overview.md](00-overview.md) hold.
2. `crew-0n8g` is closed with links to the Crew pull requests and the
   Switchboard tarball revision.
3. `bn blocked --project switchboard` lists none of `mebb`, `ishc`, `rijp`,
   `3g7b`, `bzn9`.
4. `agentui-wtdo` is closed, and AgentUI's CI is green on the new pin.
5. `docs/feature-comparison.md` in Crew states the commit it describes.

## Deferred work and follow-ups

- The observer research track: `switchboard-jrvo`, `-i72g`, `-ftwo`.
- `switchboard-525r` and a Pi mode with extensions.
- Frontend tools and frontend restore (`switchboard-5py2`, `-qx63`, `-v8wc`,
  `-h3rv`, `crew-1rcl`, `crew-avzm`).
- Wiring Crew's capability tools to the adapters' host-tool mechanism.
- Images in tool results.
- Claude and Codex child drivers (`crew-69mf`).
- Moving AgentUI onto the host adapters, and removing the text adapters.
- Live provider and macOS qualification in Switchboard.
- Removing the stale Switchboard worktrees, if the owner approves.
