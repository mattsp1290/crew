# Switchboard package

Crew installs `@operatorworks/switchboard@0.0.0` from the commit-named archive
`switchboard-55e04a1d255ce4d5acf6302a900f57e0bb718b70.tgz`.
[The pin record](switchboard.json) identifies the source repository, merged
revision/tree, archive SHA-256, npm integrity and notices. No registry publication
or old-name compatibility alias is used.

The archive is the retained package built from merged Switchboard PR #84 with
Node 24.22.3 and npm 11.19.1. Its SHA-256 is
`b473a6eaa3235d37107ce572efc9c9f7a7a0cfaa8958495fa3d01fee86222eee`.
Rebuilds are not assumed to reproduce its bytes. It includes the fixed Cursor
text runtime and changes to shared Codex/Pi/Claude/OpenCode adapters; dependency
upgrades must run the affected consumer checks together.

## Cursor policy

Crew's production driver selects `createCursorTextRuntime` from
`@operatorworks/switchboard/cursor`, with the `cursor-text-v1` contract, SDK exactly
`1.4.2`, and service Node exactly `24.22.3`. The generic sandboxed
`createCursorRuntime` export remains available to other consumers.

The fixed text policy supplies empty tools, settings, MCP, custom callbacks and
agent registries, a fresh SDK `emptyFs()`, reported workspace `/`, disabled SDK
sandbox and disabled transport retries. Create/resume use the same launch
builder. Crew remains fresh-create-only and rejects continuation checkpoints;
the upstream resume export does not add a second Crew turn.

The physical execution workspace, HOME, temporary and Cursor transcript paths
belong to the private conversation root. Profile `cwd` is retained as validated
metadata. No old operator workspace is moved or deleted automatically. Trusted
profiles supplying their own `runtime` implement their own boundary and are
outside the production factory guarantee.

A credential-free bounded child probes the installed package/version and exports
before production Cursor profile registration writes any volume marker or SQL
row. It cannot create/resume an agent, run inference, or inherit credentials,
proxies, TLS paths, endpoint overrides or profile modules. The parent never
imports the SDK. This export probe is not semantic qualification or a worker
availability promise.

Candidate checks, observations and remaining deployment gates are described in
[the qualification guide](../../docs/cursor-restricted-text-qualification.md).
Model tool removal does not confine arbitrary SDK code at the OS level. Close,
completion and empty tools do not attest SDK helper/writer termination; preserve
`content_runtime_unconfirmed` and the trusted erasure drain/enrollment contract.

## Other consumers and peers

The gateway imports the root `createEventStream`; Codex uses `./host/codex` and
OpenCode uses `./host/opencode`. Workflow bundles must not import Switchboard's
Node-dependent root entry.

Crew's `.npmrc` uses `legacy-peer-deps=true`, so exact optional peers are not
automatically installed or enforced. Keep the direct `@cursor/sdk@1.4.2` and
`@bufbuild/protobuf@1.10.0` dependencies: SDK 1.4.2's Connect 1.x peer requires
protobuf 1.x at the root, while AG-UI's protobuf 2.x stays nested. Removing the
root protobuf dependency can make Cursor fail to import. Crew's AG-UI Claude
adapter still requires `@anthropic-ai/claude-agent-sdk@0.3.306`.

The separate observability archive remains
`birbcrew-switchboard-observability-0.0.0-dadfe09.tgz`, built from
`dadfe09fb2f0090b46168309309ca01bb89b9a0e`. It is not rebuilt by this pin change.

## Verify or rebuild

Use Linux, Node 24.22.3 and npm 11.19.1:

```sh
npm ci
npm run build
npm run typecheck
node --test --test-name-pattern='^Switchboard' tests/fixtures/engines/artifacts.test.ts
```

The artifact test compares archive bytes, pin, dependency, lock, installed
metadata/notices, adapter exports and SDK version. It also rejects the old package
key in the dependency and lock.

To rebuild, archive source revision `55e04a1d255ce4d5acf6302a900f57e0bb718b70`
into an empty directory, then run `npm ci`, `npm run build` and `npm pack` with
that toolchain. Record the resulting archive's own integrity and rename it to
`switchboard-<revision>.tgz`. To adopt different bytes, replace the main archive,
update every relevant pin field, migrate the dependency/lock together, audit the
consumed-to-candidate changes, and repeat qualification. Retain the separate
observability artifact.
