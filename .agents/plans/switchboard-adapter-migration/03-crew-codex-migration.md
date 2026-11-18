# Crew: move Codex onto the Switchboard adapter (packages C0 and C1)

Paths are relative to the Crew repository. Work in a new worktree made from
`origin/main`.

## Package C0: prepare (two pull requests)

### C0a: an engine-fixture workflow

Goal: CI runs the tests that pin each engine's approval, resume, recovery
and cancellation behaviour, so that gate G2 means something.

Evidence: `tests/proof/verify-members.mts` runs, per engine, the fixture
tests under `tests/fixtures/engines/<engine>/` and
`tests/service/supervisor.test.ts`, `member-cancel.test.ts` and
`codex-live*.test.ts`. No workflow invokes it. `npm test` lists only the
artifacts test, the consumer test, `codex/qualification` and
`pi/confinement`. Without `--engine` the script also runs
`tests/proof/replay-traces.mts`, which the standing rules forbid.

More evidence: with `--engine`, `tests/proof/verify-members.mts` skips
`tests/service/closure.test.ts`, `supervisor.test.ts` and
`member-cancel.test.ts` (they run only when no engine is selected), and it
runs `supervisor.test.ts` for Claude and Pi but not Codex. Its per-engine
lists name tests by pattern, and a pattern that matches nothing passes.

Change surface:
- `.github/workflows/engine-fixtures.yml` (new): a matrix over `claude`,
  `codex`, `pi` that runs `scripts/setup --mode fixture` and
  `scripts/verify --mode fixture --engine <engine>` on a GitHub-hosted Linux
  runner, with the path filters `integration-api.yml` uses and a
  `workflow_dispatch` trigger. It never runs the script without `--engine`.
- `tests/proof/verify-members.mts`: with `--engine`, also run
  `closure.test.ts`, `supervisor.test.ts` and `member-cancel.test.ts` for
  that engine, including Codex; fail if any name pattern matches no test.

Acceptance: a `workflow_dispatch` run on `main` passes for all three engines
before any switch, and its run identifier is recorded on `crew-0n8g`. A test
that success criterion 5 cites may not be quarantined; if one fails on
untouched `main`, fix it in this pull request or stop and report.

### C0b: bump Codex on the native driver

Goal: separate the version bump from the driver rewrite.

Change surface: `package.json` and `package-lock.json` (`@openai/codex` and
`@openai/codex-sdk` to 0.169.0); `vendor/ag-ui/codex-packages.json`; the
version assertion in `tests/fixtures/engines/artifacts.test.ts`;
`packaging/executor.Dockerfile`; `docs/in-cluster-executor.md` if it names
the version.

Acceptance: every workflow green, including C0a's Codex job and
`.github/workflows/proxy-qualification.yml`, which runs the subscription
test. The Python executor shares the Codex binary and sign-in with members
and no workflow tests it: run `uv run --group dev pytest tests/execution`
and build `packaging/executor.Dockerfile` once on a non-shared runner, or
state that the executor at the new version is unverified. Any behaviour
difference is recorded in the pull request and in
`docs/member-capabilities.md`'s SDK assumptions section, together with the
four differences P0 found.

## Package C1: the Codex switch

### Goal and prerequisite

Goal: Codex members run through the Switchboard Codex host adapter. Crew's
SDK exec driver, its loopback MCP server, the raw app-server client and the
trusted Codex file are gone.

Prerequisites: C0 and S2 merged; a Switchboard tarball built from
Switchboard `main` at or after the S2 merge; gate G3 passed for that
revision.

### Evidence

- `src/service/codex.ts`: SDK exec; the launcher as `codexPathOverride`; a
  private `CODEX_HOME`; three provider forms; `developer_instructions`; a
  read-only sandbox; one MCP server entry only on turns that carry
  `input.mcp`; refusal of ambient files; rollout verification (path pattern,
  size, digest, trailing `task_complete`) after the process has exited; the
  prior usage total re-read from the rollout at resume.
- `src/service/codex-mcp.ts` (loopback MCP, per-call bearer);
  `src/service/codex-live.ts` (hold up to 120 seconds, receipt check that
  the text the engine reports equals the text returned);
  `src/service/codex-calls.ts` (`proposeLive`, `settleLive`,
  `confirmDelivery`, `interruptLive`, `cancelLive`; live deadline up to 170
  seconds); `src/service/workflow.ts` (`liveProposal` signal).
- Above the driver: `src/service/activities.ts` types `DriverInput.mcp` from
  `codex-mcp.ts`; `src/service/supervisor-runner.ts` calls `runLiveTool` and
  `codexItemWriter`; `src/service/profiles.ts` refuses a child, a
  continuation or child results for Codex.
- `src/service/codex-items.ts`, `usage-capture.ts`,
  `codex-subscription.ts`, `codex-executable.ts`, `trusted-codex.ts`.
- `native/member-launch.c` Codex mode: write on `CODEX_HOME`, read on the
  workspace, TCP to the provider port and the MCP port.
- Tests: `tests/fixtures/engines/codex/` (`qualification.test.ts`,
  `native.test.ts`, `index.mts`, `qualification-worker.mts`, `sdk.mts`);
  `tests/service/codex-calls.test.ts`, `codex-live*.test.ts`,
  `codex-chat.test.ts`, `codex-mcp.test.ts`, `codex-registration.test.ts`,
  `codex-subscription.test.ts`, `proxy-members.test.ts` (imports
  `codex-mcp.ts`), `trusted-native-members.test.ts`;
  `tests/proof/temporal-tls.mts` (asserts a `liveProposal` signal);
  `tests/proof/coordinated-recovery.mts` (imports `answerLive`).
- Pins: `package.json`; `vendor/switchboard/` (tarball, `switchboard.json`
  with a `copiedFrom` field naming AgentUI, README);
  `vendor/ag-ui/codex-packages.json` and `manifest.json`.

### Change surface

- `vendor/switchboard/`: the new tarball; `switchboard.json` records the
  Switchboard revision, tree, digests and "built from Switchboard `main`"
  in place of `copiedFrom`; the README says what Crew now imports and keeps
  the rule that workflow code must not import Switchboard.
- `package.json`, `package-lock.json`: the tarball; remove
  `@openai/codex-sdk` (the host adapter does not use it); keep
  `@openai/codex` at the version the adapter exports as qualified; leave
  `@modelcontextprotocol/sdk` at its current version, because the vendored
  Claude adapter still depends on it until C2b.
- `src/service/codex.ts`: a `TurnDriver` over the adapter. It spawns the
  app-server through the launcher and lends its standard streams as the
  channel; passes the complete environment, `instructions`, the profile's
  one host tool, the built-in tools to leave on (D23), the sandbox settings,
  and the provider route for the profile's credential form; runs one
  segment; maps the result to `DriverResult`.
- Live hold: `src/service/codex-live.ts` waits on the adapter's
  `PendingInteraction` instead of an MCP request, then answers through the
  adapter. The `liveProposal` signal, the ledger in `codex-calls.ts`, the
  deadlines and the receipt check stay. `DriverInput.mcp` in
  `activities.ts` becomes a host-tool hold handle typed in `codex-live.ts`;
  `supervisor-runner.ts` and `profiles.ts` change only where they named the
  MCP type.
- `src/service/codex-items.ts`: consume the adapter's typed facts.
- Checkpoint: add the adapter's fingerprint and a prior usage total to the
  Codex checkpoint state in `codex.ts`. Take the fingerprint after the
  process has exited if probe A3 required that. First segment: prior total
  is zero. Delete Crew's rollout path, size and digest checks and the
  `state_5.sqlite` read.
- `src/service/usage-capture.ts`: Codex usage is the adapter's `total` minus
  the stored prior total, or `last` if probe A4 failed.
- `native/member-launch.c`: Codex mode drops the MCP port and grants the
  per-thread `sqlite_home` and `log_dir` directories. Owner review.
- Delete: `src/service/codex-mcp.ts`, `src/service/trusted-codex.ts`,
  `tests/service/codex-mcp.test.ts`, `tests/fixtures/engines/codex/sdk.mts`,
  and the Codex cases in `tests/service/trusted-native-members.test.ts`.
  `src/service/trusted-native.ts` refuses the Codex engine until C4 removes
  the lane.
- Edit tests that imported deleted files: `tests/service/proxy-members.test.ts`,
  `tests/fixtures/engines/codex/index.mts`, `qualification-worker.mts`.
- The Codex fixture provider, `tests/fixtures/engines/codex/provider.mts`,
  throws unless a tool is named for the MCP server or a dynamic namespace is
  passed, and serves `/responses` at the root. Update it for dynamic tools
  and for the endpoint rules S2 fixed, and update every caller that passes no
  namespace: `tests/proof/fixture-profiles.mts` (used by the TLS proof and
  others), `tests/proof/proxy-restart-fixtures.mts`,
  `tests/service/usage-capture.test.ts`, `tests/service/proxy-members.test.ts`.
- `tests/proof/verify-members.mts`: remove `codex-mcp` from the Codex list
  and add the new tests.
- Base-URL handling in `src/service/codex.ts` (it strips a trailing slash)
  follows the trailing-slash policy S2 fixed.
- `request_user_input` (decision D23): before changing anything, record what
  today's SDK exec lane does when the model calls it. Then answer the
  adapter's pending interaction with a fixed decline, or reproduce the
  recorded behaviour.
- `tests/fixtures/engines/artifacts.test.ts`: the tarball pin; the version
  assertions of success criterion 3 for Codex; the import rule for Codex
  files.
- `vendor/ag-ui/codex-packages.json`: keep it if the executor image or a test
  still reads it; otherwise delete it and its assertion.
- Docs: `docs/member-profiles.md`, `docs/member-gateway.md`,
  `docs/verification.md`, `docs/native-conversation-bounds.md`,
  `docs/approval-expiry.md` (the Codex deadline text is already stale),
  `docs/feature-comparison.md` rows 8, 9 and 13, `docs/decisions.tsv`.

### Behaviour that must hold

- One approval card, one settlement and at most one delivery per protected
  call. The receipt check still runs.
- A stop is confirmed only by a reaped process group. Worker loss during a
  segment ends in `uncertain`, never a resend.
- All three credential forms work, including the ChatGPT subscription read
  per turn.
- Ambient configuration is refused, and image reads stay confined to the
  conversation's storage.
- A conversation whose checkpoint predates this change closes with a clear
  outcome. A test loads a pre-switch checkpoint fixture and asserts it.
- Workflows in flight across the deploy may fail; nothing drains them.

### Tests and acceptance

- The existing driver-boundary tests pass, with every changed or deleted
  assertion listed and justified in the pull request:
  `tests/fixtures/engines/codex/qualification.test.ts` and `native.test.ts`
  (approve, deny, interrupt, cold resume, damaged history, subscription
  credential, ambient refusal, confined image read, hard kill).
- New assertions: the model request contains exactly the declared tools; the
  pre-switch checkpoint closes cleanly.
- `tests/service/codex-calls.test.ts`, `codex-live*.test.ts`,
  `codex-chat.test.ts`, `codex-subscription.test.ts`, `supervisor.test.ts`,
  `member-cancel.test.ts`, `usage-capture.test.ts`,
  `proxy-members.test.ts`.
- `npm run typecheck`, `npm test`, `npm run test:proxy`,
  `npm run test:usage:capture`, `npm run test:api`, `npm run test:recovery`.
- Gate G2 on the pull request. `tests/proof/temporal-tls.mts` and
  `tests/proof/coordinated-recovery.mts` keep their assertions (the live
  hold and its `liveProposal` signal are kept); only their shared fixture
  profile changes, as listed above.
- A native test calls `request_user_input` and asserts the turn's outcome.
- Owner review (launcher policy, credentials, what reaches a model).

### Exclusions

Codex children, capability tools, frontend tools.
