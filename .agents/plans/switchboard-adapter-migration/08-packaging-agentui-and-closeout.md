# AgentUI, packaging and closeout (packages A1, S5, A2 and C4)

## Package A1: finish `agentui-wtdo` (AgentUI)

Paths are relative to the AgentUI repository. Owner decision D20.

### Goal and prerequisite

Goal: `agentui-wtdo` and its blockers are closed, so that
`switchboard-3g7b` can close. Prerequisite: none; A1 may run in parallel
with every Switchboard and Crew package.

### Evidence (Beans project `agentui`, read 2026-11-18; already stale)

Another session is active in AgentUI. After this evidence was read,
`agentui-omcs` was closed by AgentUI pull request #139, and a newer handoff,
`agentui-h-s55o`, records two Important review findings. Treat every item
below as a starting point and re-read it.

- `agentui-wtdo` ("Pin AG-UI PR49 fork artifacts and qualify complete
  package closure"): in progress, labelled post-MVP, blocked by
  `agentui-iqml`, `agentui-ed5a` and `agentui-srrm`. The fork archives are
  on `main`. Its last log entry defers the remaining qualification.
- `agentui-iqml` and `agentui-ed5a` (retained PR49 Pi test fixtures): in
  progress with no log. The reserved files exist on `origin/main` under
  `vendor/ag-ui/` (`qualification-fixtures/pi/adapter.test.ts` and
  `example.test.ts`). What remains is running them unchanged and closing.
- `agentui-srrm` ("Verify frozen PR49 fork package consumer on macOS"):
  open, blocked by `agentui-omcs`. It needs a macOS run with Node 24.22.3,
  npm 11.19.1 and BSD tar, must capture the platform, `TMPDIR` and code
  hashes, and must report a known upstream failure (the extensionless
  CommonJS Codex launcher fails when `TMPDIR` is inside an ESM project)
  honestly. Its status is an explicit hold until Linux publishes a new
  exact-source request.
- `agentui-omcs`: open; replaces the manual receipt gate with full CI
  qualification and retained artifacts; no edits landed.
- AgentUI's CI (`.github/workflows/verify.yml`) runs `npm run verify` and
  `node scripts/verify-agui-fork.mjs` on Linux arm64.

### Work, in order

1. Fetch AgentUI and read `origin/main`. Read `agentui-wtdo`, `-iqml`,
   `-ed5a`, `-srrm`, `-omcs` in full, and the handoffs they cite
   (`agentui-h-w659`, `agentui-h-senw`, `agentui-h-xbjc`, `agentui-h-s55o`).
   Find out whether another session is working on any of them (recent log
   entries, open pull requests, worktrees). If one is, stop and tell the
   coordinator, who asks the owner which session continues. Otherwise record
   on `agentui-wtdo` that this plan has taken it up.
2. `agentui-iqml`, `agentui-ed5a`: run the retained fixtures unchanged
   through the procedure `agentui-wtdo` names; close each with the output.
3. `agentui-omcs` is closed. Resolve the two open findings in
   `agentui-h-s55o` if they are still open.
4. `agentui-srrm`: it is scoped to a named candidate revision and evidence
   path. Record the new candidate (current `origin/main`) and its reservation
   on the issue, publish the exact-source request from Linux, then run the
   macOS verification on a Mac with the pinned Node and npm. The
   coordinator's host is macOS; the run happens in a new directory outside
   every repository checkout, with no credential in its environment.
5. Close `agentui-wtdo` against its own acceptance text. That text requires
   fresh full review and strict review gates, which are stricter than this
   plan's two reviews; run AgentUI's gate as the issue defines it.

### Acceptance

Each issue is closed against its own text with links to evidence. AgentUI's
CI is green. Nothing in AgentUI's Switchboard pin changes in this package.

### Risk

The macOS run may reproduce the known upstream failure. The issue requires an
honest report, not a pass; if its acceptance cannot be met because of an
upstream defect, stop and return to the owner with the evidence.

## Package S5: Switchboard packaging and mapping qualification

Paths are relative to the Switchboard repository. This package closes
`switchboard-3g7b`, `-km2q`, `-apbp` and `-bzn9`.

### Goal and prerequisite

Goal: the packed library is verified with all three host adapters.
Prerequisites: S2, S3, S4 and A1 merged or closed.

### Evidence

- `scripts/verify-package.mjs` checks the exports map, exact peers,
  optional-peer isolation and blocked deep imports. `npm run verify:agui`
  runs `scripts/verify-agui-matrix.mjs`.
- `switchboard-bzn9` requires a clean-install check of every adapter,
  isolation of the observability peer, licence reconciliation for the
  Apache-2.0 Codex `RequestId` leaf (`THIRD_PARTY_NOTICES.md`), and no Crew
  service dependency.
- `switchboard-km2q` asks for a full-adapter Node consumer and a host
  responsibility example. `switchboard-apbp` asks for Crew and AgentUI
  integration fixtures, including that a runtime keeps the renewable
  credential source and does not freeze a resolved bearer.

### Change surface (one pull request per issue)

- `switchboard-3g7b`: mapping tests in `tests/agui/` for the facts the three
  host adapters emit, using the fork artifacts A1 qualified.
- `switchboard-km2q`: an example consumer (new; place it where the
  repository's layout checks accept, proposed `tests/fixtures/consumer/`)
  that opens each host adapter with a host spawn function, a host tool and a
  provider route, and records intent before dispatch. It imports nothing
  from Crew.
- `switchboard-apbp`: the option-shape fixtures added in S2, S3 and S4 are
  completed and run; an AgentUI fixture exercises the text adapters as
  AgentUI drives them.
- `switchboard-bzn9`: `scripts/verify-package.mjs` clean-installs each
  adapter with only its own peers; asserts no SDK type in any emitted
  declaration; asserts the observability entry loads without
  `@opentelemetry/api`; `THIRD_PARTY_NOTICES.md` and `licenses/` reconciled.
- `README.md`, `docs/architecture/boundaries.md`: describe the host adapters.

### Acceptance

`npm run build`, `npm run check`, `npm run lint`, `npm test`,
`npm run test:native-isolated`, `npm run verify:package`,
`npm run verify:agui`; CI green; gate G3; two reviewers per pull request;
the four issues closed against their own texts.

## Package A2: move AgentUI's Switchboard pin (AgentUI)

### Goal and prerequisite

Goal: AgentUI runs on the Switchboard revision Crew pins, with no code change
beyond the pin. Prerequisite: S5 merged.

### Evidence

- `packages/host/package.json` installs one tarball as
  `@mattsp1290/switchboard` and as three aliases. A test requires that all
  four use the same artifact.
- Pin bookkeeping that tests enforce: the tarball under `vendor/`;
  `vendor/switchboard.json` (revision, tree, digests, qualification steps,
  log hashes, test count) and `vendor/qualification/<revision>/`; the three
  per-alias records; `package-lock.json`; a regenerated
  `docs/protocol/conformance.json` (`npm run protocol:matrix`);
  `vendor/README.md`.
- The dev-only testkit alias under `vendor/dev-qualification/` is a separate
  pin.

### Work

Follow `vendor/README.md`'s procedure for changing the pin. Build one tarball
from the Switchboard commit that closes S5, and use those exact bytes here
and in Crew's package C4. AgentUI's `vendor/README.md` makes no claim that a
rebuild on another machine reproduces the bytes, so the artifact is built
once and copied, never rebuilt. Update every record
above. Run `npm run verify` and `node scripts/verify-agui-fork.mjs` on Linux
with the exact Node and npm versions.

Gate G3, defined here once. For a Switchboard pull request that changes the
root entry, `./agui`, `./observability`, `./testkit`, a text adapter, the
exports map or a peer version: build a tarball from the pull request; in a
scratch copy of AgentUI at `origin/main`, install it under all four names
and regenerate the pin records the tests compare (the SHA-256 in
`vendor/switchboard.json`, the per-alias records, the lockfile entries and
`docs/protocol/conformance.json`), without the qualification logs; then run
`npm run build`, `npm run check` and `npm test`. G3 passes when the only
failing tests are those that require the retained qualification logs of a
real pin move, and each such failure is listed. Nothing is committed to
AgentUI. A change that makes `npm ci` fail in the scratch copy fails G3.

### Acceptance

AgentUI's CI is green on the new pin. The three text-adapter drivers
(`packages/host/src/claude-sdk-driver.ts`, `codex-sdk-driver.ts`,
`pi-driver.ts`) are unchanged. AgentUI's Crew provider (`examples/crew/` and
`vendor/crew-client/`) still passes its tests against Crew's `main`; if a
Crew switch changed something it relies on, the update lands here.

Rollback: revert this pull request; AgentUI returns to its previous pin.

## Package C4: Crew closeout

Paths are relative to the Crew repository.

### Goal and prerequisite

Goal: no native driver code, trusted lane, vendored AG-UI adapter or stale
document remains, and `crew-0n8g` is closed. Prerequisites: C1, C2b, C3, S5
and A2 merged.

### Change surface

- Delete the rest of the trusted lane (decision D22). It reaches further
  than its own files. First list every reference with a search for
  `trusted` across `src/`, `tests/`, `docs/`, `packages/client/` and
  `.github/`. Known so far:
  - the lane's files: `src/service/trusted-native.ts`,
    `trusted-native-types.ts`, `trusted-runner.ts`, `trusted-context.ts`
    (the capability foundation shares its canonical JSON helper through
    `canonical-json.ts`; keep that);
  - references in `usage.ts` (trusted requests and sessions), `audit.ts`
    (the `trusted_effect` event type), `handoffs.ts`, `memories.ts`,
    `project-notes.ts`, `store.ts`, `recovery.ts`, `cli.ts`, `domain.ts`,
    `pi-launch.ts`, `pi-channel.ts`, `pi-state.ts`;
  - the public surface: `/v1/capabilities` advertises `trustedContext`
    (`src/service/integration-api.ts`), `docs/integration-api-v1.md`
    describes the lane in several places, and the OpenAPI file and
    `packages/client` may carry it. Removing it is the stated exception to
    success criterion 5, and it changes `npm run check:openapi` and
    `npm run test:api` expectations;
  - migrations `src/service/sql/014-trusted-context.sql` and
    `015-trusted-receipt-authority.sql`. Leave the tables and their rows in
    place, stop writing to them, and remove them from the recovery
    inventory only if the recovery tests allow; dropping tables is a
    separate decision. Existing usage and audit rows that name the lane stay
    readable;
  - `tests/service/trusted-*.test.ts`, the `test:trusted` script,
    `.github/workflows/trusted-context.yml`,
    `docs/trusted-application-context.md`, `docs/feature-comparison.md`
    row 10, and every document that links the deleted page.
  Check whether AgentUI's Crew provider reads the `trustedContext`
  capability; if it does, update AgentUI in the same package.
- `package.json`: the final Switchboard tarball, the same bytes A2 vendored
  into AgentUI; a test compares the SHA-256 recorded in
  `vendor/switchboard/switchboard.json` with the value A2 recorded; remove every dependency no file imports. Keep
  `@birbcrew/switchboard-observability` only if the full package's
  `./observability` entry cannot replace it; say which.
- `vendor/switchboard/README.md`, `switchboard.json`: final text.
- `tests/fixtures/engines/artifacts.test.ts`: the import rule covers every
  file under `src/service/` with the final allowlist; the workflow-import
  test of success criterion 2 exists.
- `scripts/verify-adapters`: rewrite or delete if it describes vendored AG-UI
  adapters that no longer exist.
- `packaging/service.Dockerfile`, `packaging/executor.Dockerfile`: versions
  match `package.json`.
- Docs: `README.md`, `docs/architecture.md`, `docs/verification.md`,
  `docs/member-profiles.md`, `docs/persistent-deployment.md`,
  `docs/in-cluster-executor.md`, `docs/frontend-tools.md` (its statement
  that no Switchboard adapter executes tools), `docs/member-capabilities.md`
  (the SDK assumptions section now cites Switchboard's probe record),
  `docs/feature-comparison.md` (and the commit it describes),
  `docs/decisions.tsv`.
- Beans: close `crew-0n8g` with links; notes on `crew-avzm`, `crew-1rcl` and
  `crew-69mf` that the adapters are in place.

### Stale Switchboard worktrees (owner approval required)

Ten sibling worktrees of the original Switchboard checkout hold uncommitted
work from an abandoned handoff. A salvage read found none worth keeping as
is. Removal deletes uncommitted files, so it needs the owner's approval. If
approved: save each worktree's diff and untracked files as a patch archive
outside the repositories, then remove the worktree and its unpushed local
branch. Mine two first: the registration policy in
`switchboard-pi-registration` (for `switchboard-525r`) and the two findings
about Node's permission model in `switchboard-node-preflight` (for the
isolation document in S0b).

### Acceptance

- Success criteria 1 to 7 in [00-overview.md](00-overview.md) hold.
- `npm run typecheck`, `npm test`, every `test:*` script a workflow runs, and
  every workflow green on the pull request.
- `scripts/verify --mode fixture --engine <engine>` passes for each engine on
  a GitHub-hosted Linux runner.
