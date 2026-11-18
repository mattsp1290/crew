# Switchboard: the Codex host adapter (package S2)

Paths are relative to the Switchboard repository unless a path starts with
`crew:`. This package closes `switchboard-mebb`.

## Goal and prerequisite

Goal: a public Codex host adapter, built on the app-server stack, that
implements the S1 contract with host-run tools and admits Crew's three
credential forms.

Prerequisites: S1 merged; gate G1 passed for assumptions A1 and A2. Start
from current `origin/main` (pull request #68, `switchboard-pvvq`, may have
merged; it pins approvals off under a proxy route, which fits this design
because the host adapter runs with approval policy `never`).

## Evidence

- Modules with native proofs in CI: `src/adapters/codex/transport.ts`,
  `sessions.ts`, `execution.ts`, `interaction.ts`, `features.ts`, `route.ts`,
  `proxy.ts`, `proxy-helper.ts`, `wire.ts`. Records:
  `docs/qualification/codex-execution.md`, `codex-interaction.md`,
  `codex-native-api.md`, `codex-selection.md`.
- `src/adapters/codex/index.ts` does not exist. The export `./codex` is the
  SDK text adapter in `adapters/codex/src/index.ts`; it stays.
- `interaction.ts` refuses `item/tool/call` with `-32601`. `features.ts`
  marks dynamic tools as fixed at `thread/start`.
- `sessions.ts` refuses an operation unless `sqlite_home` and `log_dir` are
  absolute and outside the Codex home; requires a native login in direct
  mode; in route mode requires `auth.command` and refuses `env_key`.
  `route.ts` requires kind `litellm-proxy`, an endpoint ending `/v1`, and
  hashes the endpoint into the session principal.
- `docs/architecture/boundaries.md` says `handlerTimeoutMs` bounds hold time
  for the whole transport.
- `crew:src/service/codex.ts` configures three provider forms: a fixture
  provider with no auth; the relay, with `env_key`, on a new loopback port
  each turn (`crew:src/service/proxy-profiles.ts`,
  `crew:src/service/proxy-relay.ts`); and a ChatGPT subscription bearer with
  an account header. It refuses `auth.json` as ambient configuration.
- `crew:native/member-launch.c` grants the Codex process write access only to
  its `CODEX_HOME` and read access to the workspace, and execute on the
  Codex binary only.
- `crew:src/service/trusted-codex.ts` speaks app-server JSON-RPC with dynamic
  tools and is the reference for wire shapes.
- Open issues on the same ground: `switchboard-qx63`, `-v8wc`, `-h3rv`
  (frontend restore on the real app-server).

## Design points that need an argument first

The owner requires each Switchboard change to be argued. Before the pull
request for each of these opens, run a two-advocate argument (library and
host) and record the verdict in the pull request body:

1. The session principal. A host that starts a new loopback relay per turn
   needs a principal that does not change with the port. Proposed: the host
   declares a stable route identity, and the endpoint's host and port are
   excluded from the hash when the host marks the endpoint as its own
   loopback relay.
2. Admitted credential forms and their endpoint rules. Proposed: a
   host-supplied bearer form (`env_key` plus headers the host sources from
   its environment) and a no-auth form for loopback endpoints, beside the
   existing helper form. This is decision D21. The existing rules require a
   `litellm-proxy` kind, a canonical URL and a path ending `/v1`, and
   `proxy.ts` refuses headers. Crew's subscription endpoint is
   `https://chatgpt.com/backend-api/codex` with an account header, and its
   fixture provider serves `/responses` at the root. So the bearer and
   no-auth forms need their own endpoint rules: no `/v1` requirement, a
   stated trailing-slash policy (Crew strips it; a canonical origin-only URL
   keeps it), and headers allowed.
3. Where `sqlite_home` and `log_dir` live for a confined host. Proposed: the
   host passes both; Crew places them in a per-thread directory beside
   `CODEX_HOME` and grants them in the launcher.

## Change surface (one or more pull requests per issue; each under 750 lines; work with no issue gets one in package R0)

- `src/adapters/codex/index.ts` (new): composes the modules into an adapter
  that implements the S1 contract. `package.json`: export `./host/codex`.
  Dynamic tools need `initialize.capabilities.experimentalApi` set to true;
  the adapter sets it and the contract document says so.
- `src/adapters/codex/interaction.ts`: surface `item/tool/requestUserInput`
  as a pending interaction (decision D23) so that a host can answer it.
- `src/adapters/codex/interaction.ts` and `features.ts`: send `dynamicTools`
  from host declarations at `thread/start`; accept `item/tool/call` for
  declared tools and surface each as a `PendingInteraction`; answer with
  content items; keep refusing calls for undeclared tools. Remove the
  fixture-only marking.
- `src/adapters/codex/execution.ts`: `instructions` as developer
  instructions; raw usage; the fingerprint operation with the timing that
  probe A3 established; pass through the host's choice of engine built-in
  tools (D23) and sandbox settings, which the host sets.
- `src/adapters/codex/route.ts`, `sessions.ts`, `proxy.ts`: the host-declared
  provider route from S1 with the three design points above. Report
  `unavailable` for the helper form when the host declares it cannot run a
  helper. Owner review.
- `docs/qualification/codex-native-api.md`, `codex-interaction.md`: the new
  rules and proofs.
- `tests/adapters/`, `tests/qualification/`, and a named CI job (extend
  `codex-native` in `.github/workflows/ci.yml`; add an arm64 runner or state
  that proofs ran on x64 only).

## Behaviour and invariants

- The adapter never executes a tool and never fabricates a tool result.
- A held call lives as long as the app-server process and its channel. The
  capability "fresh-process continuation" is `unsupported` for Codex. A host
  that needs a pause longer than the hold must end the turn itself; the
  adapter offers no workaround (owner decision in `switchboard-9wpi`).
- Process loss during a held call yields `failed` with `outcome-unknown`.
- The engine's shell is off unless the host enables it. A test asserts that a
  patch attempt is refused under the read-only sandbox the host passes.
- Ambient configuration is never read: a test places `config.toml`,
  `AGENTS.md` and `auth.json` in the working directory and home and asserts
  none reaches the model request.

## Tests and acceptance

The S1 conformance suite runs against this adapter with the real app-server
binary and a synthetic model server (native). The issue's named fault
schedules run as integrated tests: duplicate versus independent open,
interrupted handshake, late events from an old generation, a tool call
pending while other traffic flows, process loss after acceptance, terminal
fact versus observer detach, ownership release.

Native proofs in CI:

1. A declared host tool is offered, called and answered; the next provider
   request contains exactly one output for the original call identifier.
2. The tool is callable on turns 2 and 3 after resume in fresh processes.
3. A login-less home, a no-auth loopback endpoint whose port changes every
   turn, three turns in three processes: every turn opens and resumes.
4. The same with the bearer form and an account header, against a
   path-shaped endpoint (`/backend-api/codex`, no `/v1`) and against an
   origin-only endpoint, with and without a trailing slash.
5. A hold of 171 seconds with the transport bounds a host passes.
6. `view_image` and `request_user_input` are available when the host leaves
   them on, and absent when it does not. The synthetic model calls
   `request_user_input`; the host answers; the turn completes.
7. Proofs 1, 2 and 5 also run on Linux x64 in CI.

A fixture that records the options Crew will pass (the shape, not a
dependency on Crew) is added to `tests/qualification/` for
`switchboard-apbp`.

Acceptance: gate G4; `npm run build`, `npm run check`, `npm run lint`,
`npm test`, `npm run test:codex-guarded`, `npm run test:native-isolated`,
`npm run verify:package` (CI does not run `build` or `verify:package`
today; the first pull request of this package adds both to
`.github/workflows/ci.yml`); CI green; gate G3 if the root entry changed; two
reviewers per pull request; owner approval for the route pull request;
`switchboard-mebb` closed with links.

## Exclusions

Live provider qualification (`switchboard-une2`, `-ov4y`), macOS
(`switchboard-e2oc`), frontend restore (`switchboard-qx63`, `-v8wc`,
`-h3rv`), any change to the text adapter.
