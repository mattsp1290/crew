# Crew: move Claude onto the Switchboard adapter (packages C2a and C2b)

Paths are relative to the Crew repository. Work in a new worktree made from
`origin/main`.

## Package C2a: confine the Claude worker (before the switch)

### Goal and prerequisite

Goal: the Node process that imports the Claude SDK runs under the launcher,
and Claude's network is restricted. This is reviewed apart from the adapter
switch. Prerequisite: C1 merged (shared launcher file).

### Evidence

- `src/service/claude.ts` starts `src/service/claude-worker.ts` with `fork()`
  and an IPC channel, unconfined. The worker spawns the launcher, which runs
  the CLI with filesystem rules only (`docs/verification.md`).
- `native/member-launch.c`: network rules exist only for Codex and are
  connect-by-port; adding them for Claude raises its Landlock requirement
  from ABI 3 to ABI 4. The launcher closes inherited descriptors above a
  fixed number. Pi mode denies sockets, fork and non-thread clone, so it is
  not a model for a worker that must spawn the CLI and listen.
- Landlock restricts TCP bind and connect by port and does not restrict UDP.
  Landlock cannot limit which local process connects to a listener.
- `tests/fixtures/engines/pi/confinement.test.ts` is the pattern for a
  launcher test.

### Change surface

- `native/member-launch.c`: a Claude worker mode. Specify and implement:
  - filesystem: the conversation directory read-write; Node, the worker's
    code and its dependencies read-execute; the Claude CLI read-execute;
  - process: the worker may create the CLI process; `setsid` and `setpgid`
    stay denied; the CLI is launched through the existing Claude mode, and
    the nested launch is tested;
  - descriptors: the IPC channel to `claude.ts` survives the launcher's
    descriptor closing (pass its number, as Pi mode keeps its channel);
  - network: the CLI is launched nested inside the worker's Landlock domain,
    so the worker's rules bind the CLI too. The host therefore reserves the
    loopback MCP port before it starts the launcher (or binds the socket and
    passes the descriptor), and the worker's rules allow TCP bind and
    connect to exactly that port, plus TCP connect to the provider or relay
    port. The vendored adapter still in use during C2a binds an ephemeral
    port that is unknown when the rules are set; if it cannot be given a
    fixed port or a passed socket, C2a ships the filesystem and process
    rules only and the network rules move into C2b, with that stated;
  - names: a direct Claude profile reaches its provider by hostname, so
    name resolution must keep working. Either allow UDP and TCP to port 53
    or resolve in the host and pass the address; a blanket UDP denial is
    wrong. Raw sockets stay denied. A test uses a hostname endpoint with a
    fake resolver, because fixture tests on `127.0.0.1` would pass with
    resolution broken;
  - Landlock ABI 4 is required for Claude; refuse to start below it.
- `src/service/claude.ts`: start the worker through the launcher.
- `tests/fixtures/engines/claude/confinement.test.ts` (new): every denial
  above, plus a real fixture turn through the confined worker. Add it to the
  `test` script in `package.json` beside `pi/confinement`.
- `docs/verification.md`, `docs/persistent-deployment.md` (kernel
  requirement), `docs/feature-comparison.md` row 22.

### Acceptance

`npm test` including the new confinement test; the Claude job of the
engine-fixture workflow; gate G2; owner review (launcher policy).

## Package C2b: the Claude switch

### Goal and prerequisite

Goal: Claude members run through the Switchboard Claude host adapter. Crew no
longer uses the vendored AG-UI Claude adapter or imports the Claude SDK.

Prerequisites: C2a and S3 merged; a Switchboard tarball from `main` at or
after the S3 merge that also contains the Codex host adapter; gate G3.

### Evidence

- `src/service/claude-worker.ts` uses `ClaudeAgentAdapter` and
  `SessionBinding` from the vendored `@ag-ui/claude-agent-sdk` and
  `getSessionMessages` from the SDK. It offers the profile's tool as an
  AG-UI frontend tool; writes `binding.json` with provenance (thread, run,
  model, prompt digest, prior transcript digest); verifies a transcript
  digest on resume; recovers a stopped proposal without a model call in a
  recover mode that `src/service/claude.ts` invokes for
  `recoverClaudeProposal`; and borrows Pi's `ToolCallArgumentsStream` to
  parse partial arguments.
- `choose_next_step` has no arguments, so only run provenance ties a
  recovered proposal to its request.
- `src/service/trusted-claude.ts` and `trusted-claude-worker.ts` import the
  packages this switch removes; `tsconfig.json` includes all of
  `src/service/`. `tests/service/trusted-claude.test.ts`,
  `trusted-native-members.test.ts` and `usage-cost.test.ts` use the trusted
  Claude path.
- `package.json` pins `@anthropic-ai/claude-agent-sdk` 0.3.306 and
  `@ag-ui/claude-agent-sdk` from `vendor/ag-ui/claude-agent-sdk-0.0.8.tgz`.
- Tests: `tests/fixtures/engines/claude/` (`durable.test.ts`,
  `protected.test.ts`, `index.mts`), `tests/service/supervisor.test.ts`,
  `native-diagnostics.test.ts`.

### Change surface

- `vendor/switchboard/`, `package.json`, `package-lock.json`: the tarball;
  the Claude SDK and `@modelcontextprotocol/sdk` at the versions the Claude
  host adapter declares; remove `@ag-ui/claude-agent-sdk`; delete
  `vendor/ag-ui/claude-agent-sdk-0.0.8.tgz` and its entries in
  `vendor/ag-ui/README.md` and `manifest.json`.
- `src/service/claude-worker.ts`: rewritten over the adapter, keeping the IPC
  protocol to `claude.ts` (delta, tool arguments, result). It passes a spawn
  function that launches the CLI through the launcher, the complete
  environment, `instructions`, the profile's host tool and the provider
  route. Argument previews come from the adapter's argument-delta facts,
  which replace the worker's use of Pi's `ToolCallArgumentsStream`.
- Run provenance stays in Crew: the worker keeps writing and checking the
  record that ties a pending proposal to its thread, run, model and prompt
  digest. The adapter's fingerprint replaces only the transcript digest.
- Recover mode: the worker's recover mode calls the adapter's inspect
  operation, inside the confined worker. `src/service/activities.ts` does
  not call the adapter.
- `src/service/claude.ts`: map the fingerprint into the Claude checkpoint
  state.
- Delete: `src/service/trusted-claude.ts`, `trusted-claude-worker.ts`,
  `tests/service/trusted-claude.test.ts`, and the Claude cases in
  `tests/service/trusted-native-members.test.ts`. Move the
  `tests/service/usage-cost.test.ts` case that used the trusted Claude path
  onto the member lane or delete it with a stated reason.
  `src/service/trusted-native.ts` refuses the Claude engine until C4.
- `tests/fixtures/engines/claude/index.mts` imports `ClaudeAgentAdapter` from
  the vendored package as well as the SDK's in-memory session store; move it
  onto the Switchboard adapter.
- `tests/proof/verify-members.mts`: the archive-name patterns for the Claude
  AG-UI package match nothing after this change; remove them.
- `tests/fixtures/engines/artifacts.test.ts`: remove the Claude AG-UI archive
  pin; version assertions and the import rule for Claude files.
- Docs: `docs/verification.md`, `docs/member-profiles.md`,
  `docs/feature-comparison.md` row 9, `vendor/ag-ui/README.md`,
  `docs/decisions.tsv`.

### Behaviour that must hold

- A protected call pauses, survives a worker replacement, and resumes with
  the host's result. A mismatched proposal is rejected. A proposal recovered
  for a different run or prompt is rejected (new test).
- A stopped proposal is recovered without a model call.
- Claude cannot read a sibling owner's files; losing the host stops the CLI.
- One protected call per assistant message is deferred and resumed, with or
  without sibling calls (probe A6). A message with two protected calls fails
  the segment with a typed failure, which Crew maps to a failed turn; a
  test covers it.
- Context reaches the model through `instructions` within the byte limit.
- A conversation whose checkpoint predates this change closes with a clear
  outcome (test with a pre-switch checkpoint fixture).

### Tests and acceptance

- The existing driver-boundary tests pass with every changed assertion
  listed and justified: `tests/fixtures/engines/claude/durable.test.ts`,
  `protected.test.ts`, `confinement.test.ts`.
- `tests/service/supervisor.test.ts`, `member-cancel.test.ts`,
  `usage-capture.test.ts`, `proxy-members.test.ts`.
- `npm run typecheck`, `npm test`, `npm run test:proxy`,
  `npm run test:usage:capture`, `npm run test:memories:service`,
  `npm run test:instructions:service`.
- Gate G2. Owner review (credentials, what reaches a model).

### Exclusions

Claude children, capability tools.
