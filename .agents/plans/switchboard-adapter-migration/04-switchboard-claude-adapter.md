# Switchboard: the Claude host adapter (package S3)

Paths are relative to the Switchboard repository unless a path starts with
`crew:`. This package closes `switchboard-ishc` and, beneath it,
`switchboard-4k6g`, `-yejc`, `-p0mr`, `-k20g`, `-ylju`, `-ck2y` and `-s85t`.

## Goal and prerequisite

Goal: a public Claude host adapter on the Claude Agent SDK that implements
the S1 contract, with host-run tools and a pause that survives a process
restart.

Prerequisites: S0b and S1 merged; gate G1 passed for assumption A5.

## Evidence

- `adapters/claude/src/index.ts` is the text adapter on SDK 0.3.323. It stays
  unchanged; AgentUI uses it.
- The text adapter compiles as a separate project with `skipLibCheck: true`.
  `scripts/verify-package.mjs` asserts emitted declarations contain no
  `@anthropic-ai` reference. `switchboard-yejc` stalled on a TS2304 error for
  `HeadersInit` in the MCP package's declarations, raised because the SDK
  imports `McpServer`. A draft selection record is on branch
  `feat/switchboard-yejc-claude-selection`
  (`docs/qualification/claude-selection.md`).
- SDK facts from `crew:docs/member-capabilities.md`, re-read at 0.3.323 in
  package P0: a PreToolUse hook fires for every tool and may answer allow,
  deny, ask or defer; a deferred call ends the run with the pending call
  recorded and a new process resumes and is asked again; defer works only
  when the call is alone in its assistant message, and in a batch the CLI
  ignores it and denying the siblings does not help; in-process SDK MCP
  tools cannot be resumed after a defer; the SDK accepts
  `spawnClaudeCodeProcess`.
- The vendored AG-UI Claude adapter Crew uses today serves host tools from a
  loopback HTTP MCP server with a random bearer, Host and path checks, and
  `listen(0)`.
- `tests/adapters/claude/fixture.mjs` is a scripted stand-in that emits
  canned frames. It proves nothing about defer, hook replay or transcripts.
- Issue acceptance texts require: external-session discovery with typed
  outcomes (`p0mr`); deny, stale, duplicate and transport-loss continuations
  (`ylju`); credentials rotated across requests and across resume (`s85t`);
  visible feature conflicts (`ck2y`).

## Change surface (one or more pull requests per issue; each under 750 lines)

The Claude host adapter shares its SDK and MCP peer versions with the text
adapter, because npm declares peers per package, not per export. A version
bump therefore changes what AgentUI installs and triggers gate G3.

- `adapters/claude-host/` (new project; see the layout decision in file 01),
  with `src/index.ts`, `session.ts`, `tools.ts`, `events.ts`, `route.ts`,
  all new. `package.json`: export `./host/claude`, build and check scripts,
  and the exact peers (`@anthropic-ai/claude-agent-sdk`,
  `@modelcontextprotocol/sdk`).
- `switchboard-4k6g`: a test project compiles the packed package under the
  strict policy with declaration checks on and no DOM library, reproduces
  the `HeadersInit` failure as a named control, and shows the adapter's
  emitted declarations compile without it. If the SDK's own declarations
  cannot compile there, keep them behind the adapter project's boundary and
  record why in `docs/qualification/claude-selection.md` (new on `main`).
- `switchboard-yejc`: the selection record, completed from P0's results.
- `switchboard-p0mr`: session discovery with typed outcomes, a
  `SessionReference`, the fingerprint operation, verify-before-resume.
- `switchboard-k20g`: turn execution over a host spawn function passed to
  `spawnClaudeCodeProcess`; the complete environment from the host; no read
  of `process.env`; typed facts with argument deltas; raw usage; interrupt.
- `switchboard-ylju`: host tools.
  - A loopback HTTP MCP server inside the adapter. It binds first and reports
    its port to the host (or accepts a listening socket from the host). It
    requires a per-segment bearer, checks the Host header and the path, and
    refuses anything else.
  - A PreToolUse hook defers a host tool call that is alone in its message.
    The segment result is `pending`.
  - A continuation resumes the session, answers the replayed hook, and the
    tool handler returns the host's result. The handler refuses any call for
    which no pending entry was recorded, so an ignored deferral cannot run a
    tool.
  - One host tool call per assistant message is deferred, whether its
    sibling calls are allowed or denied (probe A6). A message with two or
    more host tool calls yields a typed `failed` for the segment before any
    is deferred, because the CLI would resume only the last and silently
    lose the others. Three or more calls in one message were not probed;
    test it natively here.
  - Continuations that deny, that are stale, that duplicate an answered
    call, and that lose their transport each have a defined typed outcome.
  - Inspect reads the unanswered call from the transcript.
- `switchboard-ck2y`: `instructions` as the system prompt; native
  configuration passes through only when the host sets it; a conflict
  between a host option and a native feature is a visible typed error.
- `switchboard-s85t`: the provider route from S1; the credential resolver is
  called per request where the SDK allows and otherwise per segment, and the
  capability says which; a test rotates the credential across requests and
  across a resume. Owner review.
- `.github/workflows/ci.yml`: a job that runs the native tests below.

## Tests and acceptance

Native tests use the pinned real Claude CLI and SDK against a synthetic
Messages server on loopback, inside the isolated container from S0b. Tests
against `tests/adapters/claude/fixture.mjs` are labelled controlled and close
no issue.

1. The S1 conformance suite against this adapter (native).
2. Open, run, resume by reference; a fingerprint mismatch is refused.
3. A host tool is deferred; the process exits; a fresh process continues;
   the next Messages request contains exactly one result for the original
   tool-use identifier.
4. Inspect reports the unanswered call with no Messages request.
5. A host tool call with a sibling built-in or denied call is deferred and
   resumed. A message with two host tool calls yields the typed failure and
   no handler runs. The same with three calls.
6. A direct call to the MCP endpoint without the bearer, with a wrong Host,
   or for a call with no pending entry is refused.
7. Interrupt returns a typed result and signals nothing.
8. A host spawn function that refuses to launch yields `unavailable`.
9. Each issue's named fault schedules and continuations.
10. Credential rotation across requests and across resume.

A fixture recording the options Crew will pass is added for
`switchboard-apbp`.

Acceptance: gate G4; `npm run build`, `npm run check`, `npm run lint`,
`npm test`, `npm run test:native-isolated`, `npm run verify:package`; the
A5 and A6 probes pass on Linux x64 in CI; CI green; gate G3; two reviewers per pull request; owner approval
for the route pull request; each issue closed against its own text.

## Exclusions

Live provider qualification, macOS, native subagents, any change to the text
adapter.
