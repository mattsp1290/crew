# Crew: move Pi onto the Switchboard adapter (package C3)

Paths are relative to the Crew repository. Work in a new worktree made from
`origin/main`.

## Goal and prerequisite

Goal: Pi members run through the Switchboard Pi host adapter inside Crew's
confined worker. Crew no longer uses the vendored AG-UI Pi package, and the
Pi SDK is imported only by the host-side files in the allowlist of success
criterion 1.

Prerequisites: C2b and S4 merged; a Switchboard tarball from `main` at or
after the S4 merge that contains all three host adapters; gate G3.

## Evidence

- `src/service/pi-launch.ts` supervises the worker under the launcher, relays
  every model request with the operator's `ModelRuntime`, publishes text from
  the provider events it relays, and dispatches trusted tools on the host.
  It imports `PI_ATTRIBUTION` and `VERSION`. `src/service/pi-channel.ts` is
  the wire format.
- `src/service/pi-worker.ts` runs the SDK with a provider that forwards model
  requests to the host, and imports `runTrustedSession` from
  `src/service/trusted-pi-session.ts`.
- `src/service/pi-session.ts` replays an in-memory session each segment,
  uses the vendored `@ag-ui/pi` translator to confirm committed call
  identifiers and the reply, loads the `@birbcrew/pi-subagents` extension
  inline for `delegate_task`, replaces the SDK's placeholder tool result
  with the host's result, and asserts the exact tool catalog.
- `src/service/pi-tools.ts` defines the proposal tool with `terminate: true`.
  `src/service/pi-state.ts` defines the checkpoint (up to 128 turns plus a
  pending turn).
- `src/service/pi.ts` verifies the worker's result: it extends the prior
  checkpoint, its replies equal the model output the host relayed, its tool
  results equal what the host built. It mirrors the SDK's system-entry
  shape and imports `contentText` and `toToolDeclaration`.
- `src/service/live-profiles.ts` and `proxy-profiles.ts` build `ModelRuntime`
  values for the host side.
- `packages/pi-subagents/`; eleven files under `src/service/` import
  `@birbcrew/pi-subagents`.
- `src/service/trusted-pi.ts`, `trusted-pi-session.ts`.
- Tests: `tests/fixtures/engines/pi/` (`durable.test.ts`,
  `protected.test.ts`, `delegation.test.ts`, `confinement.test.ts`,
  `index.mts`, which imports `@earendil-works/pi-agent-core`),
  `tests/service/child-launch.test.ts`.

## Change surface

- `vendor/switchboard/`, `package.json`, `package-lock.json`: the tarball; Pi
  packages at the versions the Pi host adapter declares; remove `@ag-ui/pi`;
  delete `vendor/ag-ui/ag-ui-pi-0.0.1.tgz` and its entries in
  `vendor/ag-ui/README.md` and `manifest.json`. State the end state of
  `vendor/ag-ui/`: it keeps `codex-packages.json` and `manifest.json` only
  if something still reads them; otherwise the directory is deleted with its
  assertions in `tests/fixtures/engines/artifacts.test.ts` and
  `scripts/verify-adapters`.
- `src/service/pi-worker.ts` and `pi-session.ts`: a worker that opens the
  adapter in state mode with the host model stream function (the descriptor
  relay), the imported session state, the profile's host tools, the
  delegation tool as a host inline tool, and `instructions`; it returns the
  segment result and the exported state over the channel. It keeps the
  assertions that the tool catalog is exact and that no extension loaded.
- `src/service/pi-tools.ts`: the proposal tool becomes a host tool
  declaration.
- `src/service/pi.ts`: keep the three verification checks, now run against
  the adapter's published state schema. Replace the mirrored system-entry
  shape with the adapter's exported predicate.
- `src/service/pi-state.ts`: the checkpoint state is the adapter's exported
  state plus the pending set; keep the turn and size limits.
- `src/service/pi-launch.ts`, `pi-channel.ts`: keep. Text is published only
  from the provider events the host relays, as today, never from facts the
  worker asserts.
- Delegation: a `delegate_task` batch is a pending set of host tool calls and
  is continued as a set. Keep `packages/pi-subagents/` for its role limits
  unless nothing imports it after this change; say which.
- Delete: `src/service/trusted-pi.ts`, `trusted-pi-session.ts`, the trusted
  session import in the worker, and the Pi cases in
  `tests/service/trusted-native-members.test.ts`.
- `tests/fixtures/engines/pi/index.mts` imports `@ag-ui/pi`, `@ag-ui/core`,
  `@earendil-works/pi-ai`, `pi-agent-core` and `pi-coding-agent`. Move it
  onto the Switchboard adapter where it stood in for the member lane; the
  import rule covers `src/service/` only, so imports that remain in a test
  fixture are listed in the pull request, not in the allowlist.
- `tests/proof/verify-members.mts`: the archive-name patterns for the Pi
  AG-UI package match nothing after this change; remove them.
- `tests/fixtures/engines/artifacts.test.ts`: remove the Pi AG-UI archive
  pin; version assertions; the final allowlist for the import rule.
- Docs: `docs/verification.md`, `docs/member-profiles.md`,
  `docs/feature-comparison.md` rows 5 and 22, `vendor/ag-ui/README.md`,
  `docs/decisions.tsv`.

## Behaviour that must hold

- The worker has no socket and no credential. Every launcher denial in
  `tests/fixtures/engines/pi/confinement.test.ts` holds with the adapter
  loaded.
- A protected call pauses and resumes across a worker replacement. A call
  for another operation is rejected. One call identifier never carries two
  results.
- Sibling child results arrive once, in order; role limits hold.
- An in-flight stream stops with no checkpoint.
- Usage comes from the replies the host relayed.
- A mixed batch fails the segment with a typed failure.
- A conversation whose checkpoint predates this change closes with a clear
  outcome (test with a pre-switch checkpoint fixture).

## Tests and acceptance

- The five test files under `tests/fixtures/engines/pi/` pass, with every
  changed assertion listed and justified.
- `tests/service/child-launch.test.ts`, `supervisor.test.ts`,
  `member-cancel.test.ts`, `usage-capture.test.ts`,
  `npm run test:child-targets`, `npm run test:delegation-control:workflow`.
- `npm run typecheck`, `npm test`, `npm run test:proxy`.
- Gate G2. Owner review (what reaches a model).

## Exclusions

Pi extensions, Claude and Codex children.
