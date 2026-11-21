# Switchboard package

Crew installs the private ESM package `@mattsp1290/switchboard@0.0.0` from a
commit-named tarball. Its version never changes, so the filename and
[the pin record](switchboard.json) carry its identity: the source repository,
revision and tree, the license, the archive's SHA-256 and its npm integrity.
No registry publication is claimed.

The tarball was built from Switchboard `main` at
`fa521d1e4a0cac365bcec25d53685bc46acba1e9` on Darwin arm64 with Node 24.22.3
and npm 11.19.1. It was not copied from an AgentUI pin.

The gateway uses the root entry's `createEventStream` for observer fan-out
(see [the gateway guide](../../docs/member-gateway.md)). The Codex member
driver uses `./host/codex`. Workflow code must not import Switchboard: the
root entry loads `node:fs` and other built-ins that the Temporal workflow
bundle refuses.

The package declares an exact optional peer, `@ag-ui/core@1.0.4`. Crew installs
`@ag-ui/core` itself, so npm checks that peer against Crew's version. A change
that moves Crew's `@ag-ui/core` should move this pin in the same change.

## Check the bytes

```sh
shasum -a 256 vendor/switchboard/switchboard-fa521d1e4a0cac365bcec25d53685bc46acba1e9.tgz
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
git -C /path/to/switchboard archive fa521d1e4a0cac365bcec25d53685bc46acba1e9 | tar -x -C /path/to/empty-directory
cd /path/to/empty-directory
npm ci
npm run build
npm pack --pack-destination /path/to/package-output
```

Compare a rebuilt package with the recorded SHA-256 before adopting it, and
rename it to the commit-named filename. A rebuild on another machine is not
claimed to reproduce these bytes.

To move the pin, in one change:

1. Add the new `switchboard-<revision>.tgz` and delete the old one; the service
   image copies every `*.tgz` in this directory.
2. Update every field of `switchboard.json`.
3. Point the dependency and the lock at it with npm 11.19.1:
   `npm install --package-lock-only --ignore-scripts @mattsp1290/switchboard@file:vendor/switchboard/switchboard-<revision>.tgz`.
4. Run the artifact test above.
