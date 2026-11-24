# Cursor restricted-text candidate audit

Crew has **not adopted or qualified** Switchboard's `cursor-text-v1` policy.
The production Cursor driver still uses the existing sandboxed factory and vendor
pin. Request `crew-r-8ial` remains open. Do not advertise restricted-container
support from the offline checks below.

The candidate is merged Switchboard
`55e04a1d255ce4d5acf6302a900f57e0bb718b70`, SDK `1.4.2`.
[The identity record](../tests/fixtures/cursor-candidate/candidate.json) identifies
the archive bytes. Obtain that exact archive from the implementation plan's
retained upstream verification artifacts; rebuilding is not assumed to reproduce
it. A different archive requires a fresh source review and lock update.

## Run the offline candidate audit

Use Docker and Node 24.22.3. Supply a digest-pinned Node 24.22.3 Debian bookworm
image and a new absolute evidence directory outside the repository:

```sh
node scripts/qualify-cursor-restricted-text.mjs --help
node scripts/qualify-cursor-restricted-text.mjs \
  --candidate /absolute/operatorworks-switchboard-0.0.0.tgz \
  --node-image node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 \
  --out /absolute/new-evidence-directory
```

Exit **2** means offline assertions passed and required live gates remain
pending. Exit 1 means a check failed; inspect the saved phase logs. Help exits 0.
There is no flag that promotes these results to deployment qualification.

The command builds a disposable candidate image with the separate locked
dependency fixture. It does not update Crew's dependency files. The container
receives no credentials or host mounts, runs as UID/GID 10001 with a read-only
root, dropped capabilities, NoNewPrivs, Docker's seccomp policy, private temporary
storage and no network. It checks the real `unshare -Ur true` denial; a missing
utility fails. This diagnostic image is separate from the production service
image and does not qualify that image.

The audit exercises the candidate's actual create/resume/send mapping through
its internal SDK seam, real SDK export/version checks, real invalid-tool
validation, and the real empty virtual filesystem. The host canary observer and
an isolated writable virtual tree serve as positive controls. The policy's
empty tree rejects writes. Resume here uses a synthetic handle, not a saved
provider session; Crew's planned integration remains fresh-create-only.

`evidence.json` records assertion names, pending gates, architecture, Node,
process identity, namespace denial, mount inventory, image identity, archive
identity and audit-source hashes. The lockfile and build/run logs accompany it.
The command removes its temporary build context and image tag; Docker may retain
build cache. Evidence contains synthetic data only.

## Gates that still block adoption

1. Force forbidden executor requests and inspect actual serialized provider
   requests. SDK 1.4.2 sends `tools: []` as an empty allowed-tools header; option
   assertions and absence of emitted tool events cannot prove enforcement.
2. Run synthetic Grok `grok-4.7` under the required container controls, checking
   the effective model, ambient configuration, canaries, host paths, helpers,
   destinations, analytics and close. The live SDK credential must come from a
   private operator-supplied source, never from mounted user configuration.
3. Supply a controlled externally reachable synthetic network canary with hit
   logs and a deliberate positive control. A local proxy cannot establish that
   provider-side network tools are disabled. Provisioning that endpoint is outside
   this audit command.

Only after these candidate gates pass can the production pin and package namespace
move together and Crew select `createCursorTextRuntime`. Registration probing,
private physical workspace mapping, installed-runtime tests and the remaining
Integration API, replay, recovery, privacy and erasure tests then follow the plan.
Live API acceptance must separately use the unmodified production image with
approximately 13 KiB and exactly 65,536-byte inputs.

Record ARM64 and amd64 results independently. Never infer complete SDK writer
inventory or erasure from no tools, completion or close. Preserve
`content_runtime_unconfirmed` and the existing trusted drain/enrollment procedure
in [persistent deployment](persistent-deployment.md).

The ordinary launcher checks need no Docker or inference:

```sh
node --test tests/proof/cursor-candidate-launcher.test.mjs
```
