# AG-UI adapter archives

[The manifest](manifest.json) records the Git revision, package path, license,
archive digest, and notices for each local npm dependency. The Pi archive is the
maintainer's published preview. Its LICENSE and PROVENANCE.md credit the donor.
The consumer pins Pi agent-core, pi-ai, and pi-coding-agent to 1.5.2.

Claude uses the fork build of adapter 0.0.8. The SDK is 0.3.306 and ships
Claude Code 2.1.306. The root uses Zod 4.4.3 to satisfy the SDK's peer range.
Pi's adapter resolves its own copy of Zod 3.25.76. The independent HTTP client
and both adapters use AG-UI client and core 1.0.4.

## Rebuild the Claude archive

Use a clean checkout of the manifest's Claude revision, Node 24.22.3, and
pnpm 10.33.4. The adapter's upstream tests also use the A2UI middleware.

```sh
pnpm --filter '@ag-ui/claude-agent-sdk...' --filter '@ag-ui/a2ui-middleware...' install --frozen-lockfile --ignore-scripts
pnpm -r --filter '@ag-ui/claude-agent-sdk...' --filter '@ag-ui/a2ui-middleware...' run build
cd integrations/claude-agent-sdk/typescript
pnpm run typecheck
pnpm test
pnpm pack
```

The packed filename is `ag-ui-claude-agent-sdk-0.0.8.tgz`. Crew vendors
it as `claude-agent-sdk-0.0.8.tgz`. The localhost provider used in the
consumer test has its own [source record and notice](../../tests/fixtures/engines/claude/PROVENANCE.md).
