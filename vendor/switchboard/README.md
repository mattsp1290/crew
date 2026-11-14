# Switchboard package

Crew installs the private ESM package `@mattsp1290/switchboard@0.0.0` from a
commit-named tarball. Its version never changes, so the filename and
[the pin record](switchboard.json) carry its identity: the source repository,
revision and tree, the license, the archive's SHA-256 and its npm integrity.
No registry publication is claimed.

The gateway uses only the root entry's `createEventStream`, for the observer
fan-out (see [the gateway guide](../../docs/member-gateway.md)). Nothing imports
the `./agui` entry. Workflow code must not import Switchboard: the root entry
loads `node:fs` and other built-ins that the Temporal workflow bundle refuses.

The package declares an exact optional peer, `@ag-ui/core@1.0.4`. Crew installs
`@ag-ui/core` itself, so npm checks that peer against Crew's version. A change
that moves Crew's `@ag-ui/core` should move this pin in the same change.

## One artifact for both consumers

These are the bytes AgentUI committed at
`vendor/switchboard-58c7922d8fade3617cc86fedcf41677f897025ef.tgz` in revision
`a9483be31cc301d7d9cb4d403a922098814cadb4`. They were copied, not rebuilt. The
SHA-256 equals AgentUI's pin record, the SRI equals AgentUI's lockfile entry, and
the Git blob is `6502dcc824653950e51330411bd5397211d07421` in both repositories.
AgentUI's record lists the Linux arm64 qualification run with Node 24.22.3 and
npm 11.19.1 that produced it.

`src/core/events.ts` is byte-identical between the pinned revision and
Switchboard `main` at `c3dd104`, the newest commit checked when this pin was taken:

```sh
git -C /path/to/switchboard diff 58c7922d8fade3617cc86fedcf41677f897025ef c3dd104 -- src/core/events.ts
```

## Check the bytes

```sh
shasum -a 256 vendor/switchboard/switchboard-58c7922d8fade3617cc86fedcf41677f897025ef.tgz
npm ci
node --test --test-name-pattern='^Switchboard' tests/fixtures/engines/artifacts.test.ts
```

The test reads the pin record and checks, together, the archive's SHA-256 and
SRI, the `file:` dependency in `package.json`, the lockfile's `resolved` and
`integrity`, and the installed package's name, version, license and notices.
`npm ci` can install a cached copy under the lock's integrity, so a replaced
archive must also change the lock.

## Rebuild from source

Use an empty directory, Node 24.22.3 and npm 11.19.1. The source lockfile pins
TypeScript 7.0.2.

```sh
git -C /path/to/switchboard archive 58c7922d8fade3617cc86fedcf41677f897025ef | tar -x -C /path/to/empty-directory
cd /path/to/empty-directory
npm ci
npm run build
npm pack --pack-destination /path/to/package-output
```

AgentUI found two packs of one build byte-identical, which does not establish
identical output across machines. Compare a rebuilt package with the recorded
SHA-256 before adopting it, and rename it to the commit-named filename.

To move the pin, in one change:

1. Add the new `switchboard-<revision>.tgz` and delete the old one; the service
   image copies every `*.tgz` in this directory.
2. Update every field of `switchboard.json`.
3. Point the dependency and the lock at it with npm 11.19.1:
   `npm install --package-lock-only --ignore-scripts @mattsp1290/switchboard@file:vendor/switchboard/switchboard-<revision>.tgz`.
4. Run the artifact test above.
