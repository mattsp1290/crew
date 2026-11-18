# Switchboard: the Pi host adapter (package S4)

Paths are relative to the Switchboard repository unless a path starts with
`crew:`. This package closes `switchboard-rijp` and, beneath it,
`switchboard-rlsx`, `-o6dg`, `-six1`, `-y84s`, `-vtzi` and `-rc08`.

## Goal and prerequisite

Goal: a public Pi host adapter that implements the S1 contract and runs
inside a process the host owns, with no socket and no credential of its own.

Prerequisites: S0b and S1 merged; assumption A8 holds.

## Evidence

- `adapters/pi/src/index.ts` is the text adapter on Pi SDK 1.5.2. It stays
  unchanged; AgentUI drives its session API directly.
  `docs/qualification/pi-selection.md` calls the selection provisional.
- Pi SDK facts from `crew:docs/member-capabilities.md`: custom tools have an
  `execute` function whose result may set `terminate: true`; `terminate`
  ends the turn only when every result in the batch sets it; sibling calls
  run in parallel by default; a `tool_call` extension event and the core's
  `beforeToolCall` hook fire before a tool; built-in tools run unsandboxed.
- `crew:src/service/pi-worker.ts` builds a `ModelRuntime` whose provider
  forwards every model request to the host. `crew:src/service/pi-session.ts`
  replays an in-memory session each segment, replaces the SDK's placeholder
  tool result with the host's result, loads delegation as an inline
  extension, and asserts the exact tool catalog. `crew:src/service/pi.ts`
  distrusts the worker and checks a per-turn structure.
- Crew's launcher denies `utimensat`, which Pi's file-backed session storage
  needs (probe A8); that is why Crew keeps Pi sessions in memory.
- Issue acceptance texts require: external-session discovery with typed
  outcomes (`o6dg`); deny, stale, duplicate and transport-loss continuations
  (`y84s`); credentials rotated across requests and resume (`rc08`); visible
  feature conflicts (`vtzi`). `switchboard-rlsx` was re-scoped in S0b.

## Change surface (one or more pull requests per issue; each under 750 lines)

- `adapters/pi-host/` (new project), with `src/index.ts`, `runtime.ts`,
  `session.ts`, `tools.ts`, `events.ts`, all new. `package.json`: export
  `./host/pi`, scripts and exact peers.
- `switchboard-rlsx`: the selection record for the host-owned mode.
- `switchboard-o6dg`: sessions in two modes. Directory mode gives native file
  sessions and discovery with typed outcomes. State mode imports a session
  state the host supplies and exports it at segment end. The state has a
  published schema with turn and segment boundaries that a host can parse
  and check; it is not opaque.
- `switchboard-six1`: turn execution. The host may supply a model stream
  function; the adapter builds a `ModelRuntime` whose provider calls it and
  opens no socket. The stream-function contract is stated in the adapter's
  own types and names no Pi SDK type, so a host worker can implement it
  without importing the SDK where it does not need to. Typed facts; raw usage per assistant message; interrupt.
- `switchboard-y84s`: host tools as `customTools` that return
  `terminate: true` with a placeholder result and record the pending call.
  A continuation replaces the placeholder with the host's result and
  continues; one call identifier never has two results. A batch is pending
  only if every call in it is a host tool; a mixed batch is a typed
  `failed`. Name the SDK mechanism that stops sibling execution (the
  `beforeToolCall` hook or forced sequential execution) and verify it.
  Defined typed outcomes for deny, stale, duplicate and transport loss.
  Inspect reads the pending set from session state.
- `switchboard-vtzi`: `instructions` as the system prompt addendum; the
  adapter exports the predicate that identifies the session entries the SDK
  writes for system context; a host may register its own inline tools;
  extensions are off in the host-owned mode and an extensions-enabled mode
  reports `unavailable`; conflicts are typed errors.
- `switchboard-rc08`: the provider route for hosts that supply no stream
  function; rotation tests. Owner review.
- `docs/qualification/pi-selection.md`; a CI job for the native tests.

## Tests and acceptance

Native tests use the real Pi SDK with provider HTTP replaced by a fixture,
inside the isolated container from S0b.

1. The S1 conformance suite against this adapter.
2. Import state, run, export state; the export extends the import and
   validates against the published schema.
3. With a host stream function, every model request reaches it and the
   process opens no socket, under a seccomp profile that denies sockets,
   fork and file locking.
4. A host tool pauses the segment; a fresh process with imported state
   continues; the model sees exactly one result for the call.
5. A mixed batch yields the typed failure and runs no sibling.
6. A batch of two host tools is pending as a set and is continued as a set.
7. Directory mode: discovery outcomes and resume.
8. Each issue's named fault schedules, continuations and rotation.

A fixture recording the options Crew will pass is added for
`switchboard-apbp`.

Acceptance: gate G4; `npm run build`, `npm run check`, `npm run lint`,
`npm test`, `npm run test:native-isolated`, `npm run verify:package`; CI
green; gate G3; two reviewers per pull request; owner approval
for the route pull request and for the stream-function pull request (what
reaches a model); each issue closed against its own text.

## Exclusions

Extensions, live provider qualification, native subagents, any change to the
text adapter.
