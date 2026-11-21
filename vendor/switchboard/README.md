# Switchboard package

Crew installs the private ESM package `@mattsp1290/switchboard@0.0.0` from a
commit-named tarball. Its version never changes, so the filename and
[the pin record](switchboard.json) carry its identity: the source repository,
revision and tree, the license, the archive's SHA-256 and its npm integrity.
No registry publication is claimed.

The tarball was built from Switchboard `main` at
`1c0b20fdcd07e08b851011add04649aba6ac3c3d`
([operatorworks/switchboard](https://github.com/operatorworks/switchboard), formerly
`mattsp1290/switchboard`; the package name is unchanged) on Darwin arm64 with
Node 24.22.3 and npm 11.19.1. It was not copied from an AgentUI pin. That revision
contains both the Codex host work Crew main pinned at `fa521d1` and the Cursor and
OpenCode adapters this branch pinned at `562f029`.

The gateway uses the root entry's `createEventStream` for observer fan-out
(see [the gateway guide](../../docs/member-gateway.md)). The Codex member
driver uses `./host/codex`, the Cursor text member `./cursor`, and the OpenCode
text member `./host/opencode`. Workflow code must not import Switchboard: the
root entry loads `node:fs` and other built-ins that the Temporal workflow
bundle refuses.

The pack declares exact optional peers, including
`@anthropic-ai/claude-agent-sdk@0.3.323` and `@cursor/sdk@1.4.2`. Crew's
`.npmrc` sets `legacy-peer-deps=true`, so npm does not install or enforce those
peers: Crew keeps `@anthropic-ai/claude-agent-sdk@0.3.306`, the exact version the
vendored `@ag-ui/claude-agent-sdk@0.0.8` requires, and depends on
`@cursor/sdk@1.4.2` directly because it imports `@mattsp1290/switchboard/cursor`.

Crew also depends on `@bufbuild/protobuf@1.10.0` directly, though it imports it
nowhere. `@cursor/sdk@1.4.2` pins that version and uses `@connectrpc/connect@1.7.0`,
which reaches it only as a peer. With `legacy-peer-deps`, npm ignores that peer
when it places packages: it hoists `@connectrpc/connect` next to the
`@bufbuild/protobuf@2` that `@ag-ui/proto` needs, and `./cursor` then fails to load
(`does not provide an export named 'protoBase64'`). The root dependency keeps 1.x at
the top level and nests 2.x under `@ag-ui/proto`. Remove it only together with a
`@cursor/sdk` that no longer needs protobuf 1.x.

The observability archive stays
`birbcrew-switchboard-observability-0.0.0-dadfe09.tgz`, packed from
`dadfe09fb2f0090b46168309309ca01bb89b9a0e`. Since that commit,
`src/observability` only gained the opt-in `admitObservedToolNames` option. Crew
does not import `./observability` from this pack and does not use that option, so
the extraction is not rebuilt for this pin.

The package declares an exact optional peer, `@ag-ui/core@1.0.4`. Crew installs
`@ag-ui/core` itself, so npm checks that peer against Crew's version. A change
that moves Crew's `@ag-ui/core` should move this pin in the same change.

## Check the bytes

```sh
shasum -a 256 vendor/switchboard/switchboard-1c0b20fdcd07e08b851011add04649aba6ac3c3d.tgz
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
git -C /path/to/switchboard archive 1c0b20fdcd07e08b851011add04649aba6ac3c3d | tar -x -C /path/to/empty-directory
cd /path/to/empty-directory
npm ci
npm run build
npm pack --pack-destination /path/to/package-output
```

`npm run build` compiles the root project (including the OpenCode host
adapter), the Pi, Codex and Claude adapters, both host projects, and
`adapters/cursor`. Compare a rebuilt package with the recorded SHA-256 before
adopting it, and rename it to the commit-named filename. A rebuild on another
machine is not claimed to reproduce these bytes.

To move the pin, in one change:

1. Add the new `switchboard-<revision>.tgz` and delete the old one; the service
   image copies every `*.tgz` in this directory.
2. Update every field of `switchboard.json`.
3. Point the dependency and the lock at it with npm 11.19.1:
   `npm install --package-lock-only --ignore-scripts @mattsp1290/switchboard@file:vendor/switchboard/switchboard-<revision>.tgz`.
4. Run the artifact test above.
