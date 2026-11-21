# Switchboard package

Crew installs the private ESM package `@mattsp1290/switchboard@0.0.0` from a
commit-named tarball. Its version never changes, so the filename and
[the pin record](switchboard.json) carry its identity: the source repository,
revision and tree, the license, the archive's SHA-256 and its npm integrity.
No registry publication is claimed.

This pin is a pack of Switchboard source revision
`562f0291fce6fbf07ac5df02b81574bc3a09ca7b`. It is not a copy of an AgentUI blob.
The AgentUI byte-identity copy applied only to
`switchboard-58c7922d8fade3617cc86fedcf41677f897025ef.tgz`.

The gateway uses only the root entry's `createEventStream`, for the observer
fan-out (see [the gateway guide](../../docs/member-gateway.md)). Nothing imports
the `./agui` entry. Workflow code must not import Switchboard: the root entry
loads `node:fs` and other built-ins that the Temporal workflow bundle refuses.
`src/core/events.ts` is unchanged from
`58c7922d8fade3617cc86fedcf41677f897025ef` to this revision, so that root entry
still exports the same event stream.

`@cursor/sdk@1.4.2` is an exact optional peer of this pack. Crew depends on
that version directly because it imports `@mattsp1290/switchboard/cursor`.
The same pack declares an exact optional peer
`@anthropic-ai/claude-agent-sdk@0.3.323`. npm 11.19.1 refuses to lock this
archive against Crew's previous `0.3.306`, so Crew depends on `0.3.323`.
`@ag-ui/claude-agent-sdk@0.0.8` still declares a peer of `0.3.306`. The lock
update warns and keeps the root dependency, `0.3.323`.

The observability archive stays
`birbcrew-switchboard-observability-0.0.0-dadfe09.tgz`, packed from
`dadfe09fb2f0090b46168309309ca01bb89b9a0e`. `src/observability` is unchanged
from that commit to this pin. Do not rebuild it for this pin.

The package declares an exact optional peer, `@ag-ui/core@1.0.4`. Crew installs
`@ag-ui/core` itself, so npm checks that peer against Crew's version. A change
that moves Crew's `@ag-ui/core` should move this pin in the same change.

## Check the bytes

```sh
shasum -a 256 vendor/switchboard/switchboard-562f0291fce6fbf07ac5df02b81574bc3a09ca7b.tgz
npm ci
node --test --test-name-pattern='^Switchboard' tests/fixtures/engines/artifacts.test.ts
```

The test reads the pin record and checks, together, the archive's SHA-256 and
SRI, the `file:` dependency in `package.json`, the lockfile's `resolved` and
`integrity`, and the installed package's name, version, license and notices.
It also checks that `createEventStream`, `createCursorRuntime` and
`opencodeHostAdapter` resolve. `npm ci` can install a cached copy under the
lock's integrity, so a replaced archive must also change the lock.

## Rebuild from source

Use an empty directory, Node 24.22.3 and npm 11.19.1. The source lockfile pins
TypeScript 7.0.2. Packs are not assumed identical across machines. The pin
records the archive this change commits.

```sh
git -C /path/to/switchboard archive 562f0291fce6fbf07ac5df02b81574bc3a09ca7b | tar -x -C /path/to/empty-directory
cd /path/to/empty-directory
npm ci
npm run build
npm pack --pack-destination /path/to/package-output
```

`npm run build` compiles the root project (including the OpenCode host
adapter), the Pi, Codex and Claude adapters, both host projects, and
`adapters/cursor`. Compare a rebuilt package with the recorded SHA-256 before
adopting it, and rename it to the commit-named filename.

To move the pin, in one change:

1. Add the new `switchboard-<revision>.tgz` and delete the old one; the service
   image copies every `*.tgz` in this directory.
2. Update every field of `switchboard.json`.
3. Point the dependency and the lock at it with npm 11.19.1:
   `npm install --package-lock-only --ignore-scripts @mattsp1290/switchboard@file:vendor/switchboard/switchboard-<revision>.tgz`.
4. Run the artifact test above.
