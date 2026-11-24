# Qualify Cursor restricted-text workers

Crew selects Switchboard's `cursor-text-v1` factory and exact vendored artifact.
The [recorded Linux ARM64 journey](qualification/cursor-text-v1-linux-arm64.json)
passed against the production service image. amd64 remains unqualified.
Request `crew-r-8ial` remains open pending authorized merged delivery and the
consumer's independent acceptance. Offline checks alone do not establish
restricted-container support.

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
`environment_mismatch` and `contract_mismatch` identify rejected container
configuration and rejected audit output without printing their values.

The command builds a disposable candidate image with the separate locked
dependency fixture. It does not update Crew's dependency files. The container
receives no credentials or host mounts, runs as UID/GID 10001 with a read-only
root, dropped capabilities, NoNewPrivs, Docker's seccomp policy, private temporary
storage and no network. Docker proxy defaults are explicitly overridden for both
build and execution. The configured container environment is checked before
startup, and its potentially sensitive values are excluded from saved logs.
The command sets the entrypoint explicitly and validates the offline assertion
contract before retaining passing evidence.
It checks the real `unshare -Ur true` denial; a missing
utility fails. This diagnostic image is separate from the production service
image and does not qualify that image.

The audit exercises the candidate's actual create/resume/send mapping through
its internal SDK seam, real SDK export/version checks, real invalid-tool
validation, and the real empty virtual filesystem. The host canary observer and
an isolated writable virtual tree serve as positive controls. The policy's
empty tree rejects writes. Resume here uses a synthetic handle, not a saved
provider session; Crew remains fresh-create-only.

`evidence.json` records assertion names, pending gates, architecture, Node,
process identity, namespace denial, mount inventory, image identity, archive
identity and audit-source hashes. The lockfile and build/run logs accompany it.
The command removes its temporary build context, container and image tag, including
after SIGINT/SIGTERM. It saves partial subprocess output and records cleanup in
`cleanup.json`; cleanup failure prevents a passing exit. Docker may retain build
cache. Evidence contains synthetic data only.

## Candidate live audit requirements

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

The candidate live audit precedes adoption of the production pin and package
namespace. Crew selects `createCursorTextRuntime`, probes registration support
and maps the physical workspace privately. The separate service audit below
exercises Integration API acceptance, replay, recovery and erasure with the
unmodified production image. Candidate-only evidence cannot substitute for it.

Record ARM64 and amd64 results independently. Never infer complete SDK writer
inventory or erasure from no tools, completion or close. Preserve
`content_runtime_unconfirmed` and the existing trusted drain/enrollment procedure
in [persistent deployment](persistent-deployment.md).

The ordinary launcher checks need no Docker or inference:

```sh
node --test tests/proof/cursor-candidate-launcher.test.mjs
```

## Start a synthetic network observer

The standard-library Python observer binds only to loopback and serves fixed
synthetic JSON on two unpredictable paths. It never serves files, accepts
credentials, or records request headers or contents:

```sh
python3 scripts/cursor-canary.py --out /absolute/new-canary-directory
```

Read `ready.json` for the selected port, the `positive` and `negative` routes,
and their expected synthetic response values. `counts.json` and `hits.jsonl`
record requests to either route, including encoded paths, trailing slashes,
descendants, HEAD and unsupported methods. Other paths increment `unmatched`.
Query contents are excluded. Stop the process with SIGINT or SIGTERM.
The evidence directory remains private for inspection.

For provider-side observations, forward only this loopback listener through a
temporary public HTTPS tunnel. A tailnet-only address does not test provider
access. Check the public positive route deliberately, record its baseline count,
then prove a separately tool-enabled SDK fixture can reach it. Give the restricted
runtime the negative route and compare counters before and after. Do not request
the negative route yourself during that test. Stop both the tunnel and observer
after qualification. Both the negative and unmatched counters must stay at their
baselines. A model refusal or a zero counter without a successful
tool-enabled positive control is incomplete evidence.

The observer alone does not force SDK tool execution, prove all network tools are
disabled, or qualify the production image. The forced-executor gate remains
separate. Its local request/cleanup contract can be tested without inference:

```sh
python3 tests/proof/cursor_canary_test.py
```

## Run the live service audit

Use a disposable Linux Docker installation and the public observer above. Build
the production image and the separate test tools:

```sh
docker build -f packaging/service.Dockerfile \
  --build-arg NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 \
  -t crew-cursor-service .
docker build -f tests/proof/cursor-qualification.Dockerfile -t crew-cursor-tools .
docker image inspect --format '{{.Id}}' crew-cursor-service crew-cursor-tools
python3 scripts/qualify-cursor-service.py --help
```

Supply the two exact local image IDs. Prepare a private JSON credential file
containing only `apiKey`. Redirect that file to stdin, then remove the temporary
credential file after the audit:

```sh
python3 scripts/qualify-cursor-service.py \
  --image sha256:PRODUCTION_IMAGE_ID \
  --tools-image sha256:TOOLS_IMAGE_ID \
  --proof /absolute/crew/tests/proof/cursor-restricted-text.mts \
  --out /absolute/new-service-evidence \
  --negative-url https://controlled-observer.example/unpredictable-negative-route \
  --key-stdin < /absolute/private/cursor-credential.json
```

The launcher provisions a private Docker network, PostgreSQL 17, pinned Temporal
CLI 1.10.0 and private volumes. Only the production engine worker receives the
Cursor credential. Gateway and model worker use the unmodified production image
as UID/GID 10001 with a read-only root, dropped capabilities and NoNewPrivs.
The worker has only its private state volume and temporary space. The audit
requires an actual `/usr/bin/unshare -Ur true` EPERM result from that same image.
The launcher compares every service source file in the production and tools
images before inference. Every fixture overrides Docker's default proxy settings.

The API client checks synthetic JSON extraction at 13,312 and 65,536 bytes,
immutable advertised limits, pre-launch size refusals, replay launch counts,
conflicts and cross-owner refusal. A credential-free workflow coordinator stays
available while all Cursor engine pollers are stopped. The original accepted
request completes once after engine restart. A separately interrupted launch
must remain uncertain without another launch. The client uses receipt reads
to observe uncertainty and never resubmits the uncertain input.

Completed real SDK turns must still refuse erasure with
`content_runtime_unconfirmed`. A separate trusted operator container owns the
Docker socket only during enrollment. Its quiesce hook stops and awaits all
fixture senders, coordinator, engine workers and private PID namespaces, then
stops and restarts the persistent Temporal service to fence pending RPCs. It
uses the normal `erasure-inventory` CLI. Replacement workers erase the enrolled
synthetic conversations while retaining their original receipt metadata. The
audit seeds a private marker in each drained conversation root, then verifies
that each root disappears from the enrolled volume after DELETE succeeds.
This fixture has one enrolled state volume and no historical clones.

`evidence.json` identifies images, source hashes, architecture, hardening,
namespace denial, checks and cleanup. Exit 0 requires passing checks and
cleanup. `supported` remains false because the launcher alone cannot reconcile
external observer counters or qualify another architecture. Check the public
canary counters independently after the run and retain the successful
tool-enabled positive control. Neither the tools image nor its Docker socket
belongs in a deployed model worker.

The launcher failure and cancellation checks need no Docker or inference:

```sh
python3 tests/proof/cursor_service_launcher_test.py
```
