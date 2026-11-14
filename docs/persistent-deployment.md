# Run the TypeScript member service persistently

This guide covers the container image for the TypeScript gateway and worker,
their configuration, storage, database role and kernel requirements. It is a
packaging contract, not production authentication: the gateway still
authenticates each request with an operator-configured bearer token digest and
binds only to `127.0.0.1`. A consumer such as Forge reaches it from another
container in the same pod.

Statements marked **verified** were exercised for this change on a linux/arm64
Docker 29.2.1 host (Ubuntu 24.04 VM, kernel 6.8.0) with disposable PostgreSQL 17.6,
Temporal CLI 1.10.0's development server and synthetic credentials. Statements
marked **unverified** have not been run against a Kubernetes cluster or a real
provider account.

## Build the image

`packaging/service.Dockerfile` has no default base image. Pass a digest-pinned
Node 24.22.3 Debian bookworm image; the build stops for a tag without a digest,
another Node version or another Debian release.

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f packaging/service.Dockerfile \
  --build-arg NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 \
  -t REGISTRY/crew-service:COMMIT --push .
```

The digest above is the `node:24.22.3-bookworm-slim` index resolved on
2026-11-14. Use BuildKit: the build context is limited by
`packaging/service.Dockerfile.dockerignore` to the lockfiles, vendored packages,
the shared client's build inputs, `scripts/build-native`, `native/member-launch.c`
and `src/service`. Each platform installs the locked development dependencies,
compiles the shared client, then runs `npm prune --omit=dev`. The runtime image
includes the client's compiled files and license at the local dependency's link
target. Pi confinement grants read access to only that client's compiled `dist`
directory and package manifest, so npm's local dependency link works without
exposing the client source or granting writes to package files.
The runtime image omits TypeScript and the client's source files. The builder compiles
the native launcher against the same bookworm glibc into
`/app/.proof/bin/member-launch`, the path the source resolves.
The image runs as `10001:10001` under `tini` and contains no
credentials. The `Service image` workflow rebuilds it for amd64 on relevant pull
requests and runs it read-only with the flags below. **Verified** on the previous Node 22.23.3 base: the command above without `--push` built both
platforms, arm64 natively and amd64 under QEMU. The amd64 image completed the Pi
fixture path below under emulation; Codex was exercised on arm64 only. On the
Node 24.22.3 base only that workflow's amd64 build and smoke run are verified.

## Processes

Both commands run from `/app`. Every process applies the `birbcrew_ts`
migrations at startup (see [Database role](#database-role)).

| Process | Command | Notes |
| --- | --- | --- |
| Gateway | `node src/service/gateway.ts /etc/crew/gateway.json` | JSON `{ "port": 8080, "tokenHashes": { "<sha256 hex>": "<owner id>" } }` as in the [gateway guide](member-gateway.md). Listens on `127.0.0.1:<port>` and prints `{"url": ...}`. Also runs the [scheduled-routine](scheduled-routines.md) and [outbound webhook](webhooks.md) dispatchers. |
| Worker | `node src/service/cli.ts worker src/service/providers.ts` | Registers the profiles named by `BIRBCREW_LIVE_PROFILES`. Stops at startup without it. |

Every gateway fires scheduled routines from a PostgreSQL leased queue, beside its
cancellation outbox; there is no separate scheduler process and no Temporal
Schedule. Several gateway replicas on one database are safe: claims skip rows
another replica has locked and each window has a primary key, so a window fires at
most once. Give every replica the same `tokenHashes`. A replica that does not know a
routine's owner records that owner's windows as skipped `owner_unavailable`, which
counts toward disabling the routine after ten failures. A restarted replica fires no
window from the 5 minutes before it started, but another running replica does; with
one replica, a restart skips any window in those 5 minutes. A routine fires only
while at least one gateway runs, so stopping every gateway pauses routines and their
missed windows are skipped, not replayed. Routine firings use the gateway's clock;
keep replicas' clocks synchronised.

Gateways also send [outbound webhooks](webhooks.md): once an owner registers an
endpoint, every gateway replica connects out to it. Give gateways egress to DNS (the
servers in the container's `/etc/resolv.conf`, queried directly; the hosts file is
not read) and to the HTTPS hosts and ports owners register, which may be any public
address and port. Crew refuses private, loopback and metadata addresses itself, but
an egress policy (a Kubernetes `NetworkPolicy` or a firewall) is the place to narrow
it further, for example to an allow-list of receivers. Webhook requests ignore
`HTTP_PROXY`, `HTTPS_PROXY` and `NODE_USE_ENV_PROXY`, so an installation whose only
way out is a proxy cannot deliver them. Add a private certificate authority with
`NODE_EXTRA_CA_CERTS`. Workers never send webhooks. An endpoint in the `slack` or
`ntfy` [format](webhooks.md#formats) posts to that service's host, such as
`hooks.slack.com` or an ntfy server, so an allow-list has to include it. Each
endpoint's signing secret, and its URL, which for those formats is itself a
credential, are stored as plain text in the application database, so protect
database access and backups as
[outbound webhooks](webhooks.md#the-secret-and-where-it-is-kept) explains.

Run one container per process with the hardening below. `tini` is the image
entrypoint and reaps orphaned SDK descendants, so do not add Docker's `--init`.
In Kubernetes pass the command as `args:`; setting `command:` replaces `tini`.

**Verified** with these flags for the gateway, the fixture worker and the members CLI:

```sh
--read-only --cap-drop ALL --security-opt no-new-privileges \
--tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 \
--mount type=volume,src=crew-state,dst=/var/lib/birbcrew/native
```

## Configuration

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `BIRBCREW_DATABASE_URL` | both | none | PostgreSQL connection string for the Crew database. TLS settings belong in the URL, for example `?sslmode=verify-full&sslrootcert=/etc/crew/postgres/ca.pem`. |
| `BIRBCREW_TEMPORAL_ADDRESS` | both | `127.0.0.1:7233` | Temporal frontend `host:port`. |
| `BIRBCREW_TEMPORAL_NAMESPACE` | both | `default` | Existing Temporal namespace. A worker exits with status 1 if it is missing; the gateway does not check it at startup. |
| `BIRBCREW_TEMPORAL_TLS_CA_PATH` | both | unset | Absolute path to the PEM CA that signs the Temporal frontend certificate. |
| `BIRBCREW_TEMPORAL_TLS_CERTIFICATE_PATH` | both | unset | Absolute path to the PEM client certificate. |
| `BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH` | both | unset | Absolute path to the PEM client private key. |
| `BIRBCREW_TEMPORAL_TLS_SERVER_NAME` | both | unset | Name checked against the frontend certificate and sent as SNI. |
| `BIRBCREW_STATE_DIR` | worker | `/var/lib/birbcrew/native` | Native state directory. Keep the image default. |
| `HOME` | both | `/tmp` | Writable home for SDK caches. |
| `BIRBCREW_WORKER_HEARTBEAT_FILE` | worker | unset | Absolute path the worker touches every 5 seconds from the start of its Temporal workers until shutdown begins. See [Health](#health). |
| `BIRBCREW_USAGE_PRICES_PATH` | worker, and a backend that runs `runTrustedRequest` | unset | Absolute path to the operator's JSON price table, USD per million tokens per model. Read once at worker start; a malformed file stops the worker. Unset, no cost is estimated. See [estimated cost](usage-metering.md#estimated-cost). |
| `BIRBCREW_WEBHOOK_ALLOW_INSECURE_TARGETS` | gateway | unset | `1` lets webhooks use plain `http` and loopback or private addresses, for local testing only. Any other value leaves it off. See [outbound webhooks](webhooks.md#network-safety). |
| `BIRBCREW_LIVE_PROFILES` | worker | unset, required | JSON naming the live account of each engine this worker serves. See [Provider accounts](#provider-accounts). |
| `OPENCODE_GO_API_KEY` | worker | unset | Required when `BIRBCREW_LIVE_PROFILES` has a `pi` entry. |
| `BIRBCREW_CODEX_AUTH_HOME` | worker | unset | Codex sign-in directory for a `chatgpt-subscription` entry. |

Temporal TLS is all or nothing: set all four TLS variables, or none for the
previous plaintext connection. A partial set, a relative path or an unreadable
file stops the process before it connects. The error names only the variables
(and the file error code), never their values or file contents. The
gateway, the worker, the CLI and the Codex live-call signal sent from SDK child
processes all use these settings. Certificate and key files are read when a
connection opens; restart the gateway and worker after rotating them.

**Verified:** the gateway, the worker, its SDK child processes and the members
CLI reached Temporal only through an nginx mTLS terminator
(`ssl_verify_client on`) in front of the development server, used a non-default
namespace, and completed Pi and Codex fixture turns through `/v1` and a CLI
turn. Every accepted session presented the configured SNI and client
certificate, and no member workflow appeared in `default`. A gateway without
TLS settings or with a wrong server name exited with status 1, as did a worker
with a missing namespace. `npm run test:temporal:tls` repeats this in CI with a
separate Node TLS terminator, which also refuses a handshake without a client
certificate; it needs Docker, OpenSSL, Node 24.22.3 and the pinned Temporal CLI
1.10.0. **Unverified:** a real Temporal 1.32
frontend with server-side mTLS, its authorizer or claim mapper, and certificate
rotation.

`BIRBCREW_DATABASE_URL` reaches node-postgres 8.23.1 unchanged in every process,
including SDK child processes. **Verified:** with PostgreSQL accepting only
`hostssl` TCP connections, `sslmode=verify-full&sslrootcert=<CA path>` worked for
the gateway, worker and CLI, and a plaintext connection was refused.

## Storage

| Path | Mount | Requirements |
| --- | --- | --- |
| `/var/lib/birbcrew/native` | Persistent volume, worker only | Writable by uid 10001. The worker creates `.birbcrew-volume` identity files, at the root for Claude and under `codex/` for Codex. Those profiles are registered to that identity, so a replacement worker must mount the same volume. Pi context lives in PostgreSQL. |
| `/tmp` | tmpfs | Writable, exec allowed, mode `1777`. |
| `BIRBCREW_CODEX_AUTH_HOME` | Codex sign-in, worker only | Read-only is enough. `auth.json` must be readable by uid 10001. The worker never writes this directory, so the Codex CLI that owns the login stays its only writer. |
| `/etc/crew/...` | Read-only secrets | Gateway configuration and Temporal TLS files, readable by uid 10001. |

Keep the state directory at the same absolute path for the life of the
installation. Codex records absolute session paths and the worker validates
them; [quiesced recovery](coordinated-recovery.md) restores the tree at the same
logical path. **Verified:** a replacement worker container with the same volume
recalled an earlier Pi conversation, and a Codex fixture turn wrote its session
to this volume.

`/tmp` needs exec and the sticky bit because the Temporal worker bundles its
workflow code at startup with `@swc/core`, which unpacks its native addon under
`$HOME/.cache` and refuses a parent directory that other users can replace.
**Verified:** with `/tmp` mode `0777` or `noexec` the worker cannot start;
`1777` with exec works. In Kubernetes use `emptyDir: {medium: Memory}`, which
is a tmpfs with mode `1777`; a disk-backed `emptyDir` is `0777` and is expected
to fail (**unverified** on a cluster).

## Database role

Each gateway, worker and CLI process calls `MemberStore.migrate()` at startup
with the `BIRBCREW_DATABASE_URL` role. That role runs the `birbcrew_ts`
migrations, under an advisory lock, and owns the schema it creates. Give Crew
its own database and role, separate from Temporal persistence.

The role needs `CONNECT`, `CREATE` and `TEMPORARY` on the database:

```sql
CREATE ROLE crew_service LOGIN PASSWORD '...';
CREATE DATABASE crew;
REVOKE ALL ON DATABASE crew FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crew TO crew_service;
```

**Verified** with PostgreSQL 17.6 and a role without superuser, `CREATEDB` or
`CREATEROLE`: the first start created `birbcrew_ts` owned by `crew_service`.
With only `CONNECT` and `CREATE`, the first start failed with
`permission denied to create temporary tables` and created nothing (migration
006 uses `pg_temp` functions); after `GRANT TEMPORARY` it applied every
migration. `CREATE SCHEMA IF NOT EXISTS` checks database `CREATE` even after
the schema exists, so a role with only `CONNECT` cannot start. The current code
therefore cannot run with separate migration and runtime roles.

## Upgrades

Stop every gateway, worker and CLI process of the previous release, including
scheduled CLI jobs, before the first process of the new release starts. That
first process applies the new migrations, and a previous-release process does not
know about them. After migration 21, for example, it keeps committing spawns,
admissions and decisions without the audit rows the new release writes, and
nothing marks the gap (see [the audit trail](audit-trail.md#retention-upgrade-and-recovery)).
Rolling back has the same effect for as long as the earlier release runs.

Migration 25 (scheduled routines) takes its locks on `members`,
`request_admissions` and `audit_events` without queueing: it retries for up to 60 s
while other sessions hold them, then fails with `55P03` and the process exits
without applying anything. Restart it once the other sessions are done (see
[scheduled routines](scheduled-routines.md#upgrade-and-recovery)). Migration 26
(member memory) does the same for `members`, `conversations` and `audit_events`.
From version 24 both run in one transaction, and 26 retries while holding 25's
locks, so admissions and audited writes wait meanwhile; an open of the previous
release still in flight makes it fail after the 60 s (see
[member memory](memories.md#upgrade)). Migration 27 (conversation handoff) does the
same for all four tables. It also raises the internal turn bound from 16 KiB to 64 KiB
for a handoff's first request, which a previous-release worker refuses, and a
previous-release gateway or worker ignores handoff seals, so stopping the previous
release first is required for it; rolling back past it is unsupported (see
[conversation handoff](handoffs.md#upgrade)). Migration 28 (approval expiry) does the
same for `deferred_calls`, `request_admissions`, `routines`, `routine_firings` and
`audit_events`, retrying while it holds 27's locks when both run in one transaction. A
previous-release workflow worker never expires a card that has a deadline, while the
database refuses a decision past it, so stopping the previous release first is required
for it too; rolling back once a request with a deadline was accepted is unsupported (see
[approval expiry](approval-expiry.md#upgrade-in-flight-workflows-and-recovery)).
Migration 29 (member instructions) does the same for `members` and `audit_events`.
After 27 in one transaction it already holds both; from version 27 it retries for
`members` while holding 28's locks, and a spawn of the previous release still in flight
makes it fail after the 60 s (see [member instructions](member-instructions.md#upgrade)).
Migration 30 (audit filters) builds three indexes under `SHARE` on `audit_events`,
taken the same way; after 27, 28 or 29 in one transaction it already holds that
table. Audited writes wait for a time that grows with the audit table, and from
version 29 a long autovacuum of that table can also make it fail after the 60 s
(see [audit filters](audit-filters.md#upgrade-and-recovery)).
Migration 31 (usage metering) takes `members` and `native_launches` in
`SHARE ROW EXCLUSIVE` and `audit_events` and `routine_firings` in `ACCESS EXCLUSIVE`, with
`NOWAIT` and retries like 25 to 30; after 27 to 30 in one transaction it retries while
holding their locks, and a running native turn never delays it (see
[usage metering](usage-metering.md#upgrade-and-recovery)). Migration 32 (outbound
webhooks) takes `audit_events` alone in `ACCESS EXCLUSIVE` the same way; after 31 in
one transaction it already holds it (see [outbound webhooks](webhooks.md#upgrade)).
Migration 33 (instruction packs) takes `members` in `SHARE ROW EXCLUSIVE` and
`audit_events` in `ACCESS EXCLUSIVE` the same way; from version 31 it retries for
`members` while holding 32's lock, and a spawn of the previous release still in flight
makes it fail after the 60 s (see [instruction packs](instruction-packs.md#upgrade)).
From the release that adds migration 31 on, every gateway, worker and CLI process
refuses to start with
`Migration N would apply after migration M` when it would apply a migration numbered 27
or above below one the database already has, because applying the older one would
silently narrow constraints the newer one widened.
Nothing was applied, and the previous release still starts: keep running it. The usual
cause is a release that numbered a migration below one an earlier release already
shipped; report it and deploy a release that renumbers that migration. Do not delete the
`schema_versions` row. Only a database that ran an unreleased or branch build needs
restoring from a backup taken before that build, or rebuilding.

A Kubernetes Deployment's default `RollingUpdate` strategy starts new pods while
old ones still run, which is exactly what this forbids. Scale every Deployment
that runs a Crew process to zero, wait for its pods to terminate and suspend
CronJobs that run the CLI before you roll out the new image. `strategy: {type:
Recreate}` stops old pods before new ones start only within one Deployment, so it
is enough on its own only when one Deployment runs every Crew process
(**unverified** on a cluster).

## Provider accounts

Claude is not covered here. The worker loads profiles from
`src/service/providers.ts` as described in [member profiles](member-profiles.md).

Set `BIRBCREW_LIVE_PROFILES` to one JSON object with an entry for each engine
this worker serves. The worker stops at startup when the variable is unset or
invalid, or when a configured engine's API key is missing. The Codex sign-in is
read on every turn instead, and a turn fails without a current sign-in for the
configured account. The setting itself needs no file or volume and does not
expire. The value names accounts, so supply it from a Secret.

```json
{"pi": {"provider": "opencode-go", "account": "ACCOUNT LABEL"},
 "codex": {"provider": "chatgpt-subscription", "account_id": "CHATGPT_ACCOUNT_ID", "model": "gpt-5.4"}}
```

- **Pi (OpenCode Go):** add the `pi` entry and set `OPENCODE_GO_API_KEY` to the
  key. Profiles: `pi-go-glm-5.3-flash.v1`, `.approval.v1`, `.next-step.v1` and
  `.crew.v1`.
- **Codex (ChatGPT subscription):** add the `codex` entry with provider
  `chatgpt-subscription` and set `BIRBCREW_CODEX_AUTH_HOME` to an absolute
  directory holding a Codex CLI ChatGPT login in `auth.json`. Each turn copies
  that file without its refresh token into a private directory under `/tmp`,
  starts the bundled `codex app-server` there and reads the current access token.
  The copy is removed after the read. A worker killed during the read leaves its
  copy behind, and a later read removes copies older than five minutes. Refresh
  requests from that app-server go to a closed loopback port, so the worker never
  rotates the login. It never writes the sign-in directory either, which can be
  mounted read-only. The turn stops
  unless the token is current and belongs to `account_id`. Without `BIRBCREW_CODEX_AUTH_HOME` the
  worker falls back to `CODEX_HOME`, then `$HOME/.codex`, which is the tmpfs
  `/tmp/.codex` in this image, so set it explicitly. Keep the login current with the Codex
  CLI against the same directory. How that refresh runs in the cluster is
  **unverified**.

A failed member turn writes one JSON line per cause to the worker's stderr, each
with `"level":"warn"`, `conversationId` and `requestId`. A Codex sign-in problem
gives `codex_signin_unavailable`. Its `reason` is one of `login-file`, `scratch`,
`start`, `exited`, `timeout`, `protocol`, `signed-out`, `token`, `expired` or
`account`. An `expired` line carries `expiredAt`. A `codex app-server` that
stopped adds `exitCode` or `signal` and the end of its stderr. The turn runner
then logs `native_turn_failed` and the supervisor `native_turn_unconfirmed`, with
the error class and message. A runner that died without a reply is named with
its exit code or signal. `codex_signin_copy_left` means a sign-in copy could not
be removed. Token-shaped text in these lines is replaced with `[redacted]`. The
message a member sees does not carry the cause.

Releases before this setting read dated attestation files through
`BIRBCREW_PI_ATTESTATION` and `BIRBCREW_CODEX_ATTESTATION`. Those variables are
no longer read. To upgrade, set `account` to the file's `account_path`, copy
`account_id` and `model`, and remove the variables, the files and their volume.
A different `account` or `account_id` stops the worker with `Profile registered
for another account`. [Member profiles](member-profiles.md#what-replaced-provider-attestations)
lists what each field became.

## Kernel

Every member engine runs through the native launcher (`native/member-launch.c`).
Codex needs Linux Landlock ABI 4 or newer, and Claude and Pi need ABI 3; with
less, the launcher exits with status 126 and the turn fails, with no unconfined
fallback. See [native confinement](verification.md#native-confinement). Landlock ABI 4 shipped in
Linux 6.7; the node must also list `landlock` in `/sys/kernel/security/lsm`, and
the container seccomp profile must allow the `landlock_*` syscalls.

**Verified:** on kernel 6.8.0 with `landlock` enabled, Docker's default seccomp
profile, `--cap-drop ALL` and `no-new-privileges`, the Codex fixture approval
turn ran through the launcher. **Unverified:** the k3s node's LSM list and
containerd's `RuntimeDefault` seccomp profile.

## Health

The gateway listens on loopback only, so kubelet `httpGet` and `tcpSocket`
probes, which target the pod IP, cannot reach it. Use exec probes, which run
inside the container's network namespace. **Verified:** a gateway that cannot
open its Temporal connection and a worker whose namespace is missing exit with
status 1, so the restart policy handles those failed starts.

### Gateway

The gateway has no unauthenticated route. A request without a valid bearer
token gets `401` before the gateway parses the URL, reads the body or touches
PostgreSQL or Temporal. That `401` is the liveness signal. The probe fetches
`/v1/capabilities` with no token and passes only on `401`. Replace `8080` with
the configured port:

```yaml
startupProbe:
  periodSeconds: 10
  failureThreshold: 30
  timeoutSeconds: 5
  exec:
    command: ["node", "-e", "fetch('http://127.0.0.1:8080/v1/capabilities', { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"]
livenessProbe:
  periodSeconds: 10
  failureThreshold: 3
  timeoutSeconds: 5
  exec:
    command: ["node", "-e", "fetch('http://127.0.0.1:8080/v1/capabilities', { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"]
```

- A pass proves that the listener accepts connections and the event loop
  answers. It says nothing about PostgreSQL or Temporal.
- The same command is the startup probe. The gateway connects to Temporal and
  applies migrations before it starts listening, so the probe fails until
  startup has finished. A migration can wait 60 s for locks (see
  [Upgrades](#upgrades)), so the startup budget is long.
- The fetch gives up after 3 seconds, so a gateway that accepts the connection
  but never answers fails. Starting Node takes a few hundred milliseconds on a
  small CPU limit, so the kubelet timeout is longer than the fetch timeout.
- Each probe run starts a Node process. Its peak memory was about 55 MiB in a
  test, and it counts against the container's memory limit.
- A false restart is not free. It drops every open event stream and in-flight
  request. With one gateway, every routine window that falls due from the old
  process stopping until the new one is listening is skipped, not run late (see
  [scheduled routines](scheduled-routines.md#the-dispatcher)). Keep the failure
  threshold conservative.
- `GET /v1/health` is a readiness check for a consumer that holds a token. Do
  not use it for liveness. A PostgreSQL or Temporal outage would fail it on
  every gateway at once, restart them all and fix nothing.

### Worker

Set `BIRBCREW_WORKER_HEARTBEAT_FILE` to an absolute path, for example
`/tmp/crew-worker.heartbeat`. The worker refuses to start if the path is
relative or its directory is not writable. It touches the file when it starts
its Temporal workers, then every 5 seconds until shutdown begins. A touch
creates the file if needed and never truncates it. If a touch fails, the worker
logs `Cannot update BIRBCREW_WORKER_HEARTBEAT_FILE` once and keeps running.

A recent modification time proves that:

- the worker's main event loop is running;
- the worker started its Temporal workers;
- shutdown has not begun.

It does not prove that the workers can reach Temporal or are polling. The SDK
marks a worker `RUNNING` as soon as `run()` is called, before its first poll.
The file also does not detect an activity or the SDK supervisor child that
hangs without blocking the event loop. A supervisor that exits does stop the
worker.

Startup runs migrations, connects to Temporal and bundles workflow code before
the first touch, so give it a startup probe:

```yaml
startupProbe:
  periodSeconds: 10
  failureThreshold: 30
  exec:
    command: ["sh", "-c", "test $(( $(date +%s) - $(stat -c %Y /tmp/crew-worker.heartbeat) )) -lt 30"]
livenessProbe:
  periodSeconds: 10
  exec:
    command: ["sh", "-c", "test $(( $(date +%s) - $(stat -c %Y /tmp/crew-worker.heartbeat) )) -lt 30"]
```

The probe checks only the file's age. A file left on the same volume by a
previous container passes it until that file is 30 seconds old. In Kubernetes,
an `emptyDir` such as `/tmp` keeps the file when the container restarts. After
a quick crash the startup probe can pass on the old file. If startup then takes
longer than the liveness probe allows, the worker is restarted again
(**unverified** on a cluster).

**Verified** in a `node:22.23.3-bookworm` container on linux/arm64 (Docker
29.2.1, kernel 6.8.0) with PostgreSQL 17.11 and the Temporal CLI 1.10.0
development server, not in the hardened image:

- The gateway probe exited 1 before the gateway listened and 0 once it had
  printed its URL. It exited 1 after 3 seconds while the gateway was stopped
  with `SIGSTOP`, 0 after `SIGCONT`, and 1 once the gateway had exited.
  `GET /healthz` without a token got `401`.
- A heartbeat path in a missing directory, or a relative one, stopped the
  worker with status 1.
- The worker probe passed while the worker ran, failed after 35 seconds of
  `SIGSTOP` and passed again 6 seconds after `SIGCONT`. Content already in the
  file was kept.
- With the Temporal server stopped for 60 seconds, the worker kept running and
  its heartbeat stayed fresh, so the probe kept passing.
- `npm run test:temporal:tls` runs the gateway probe command against a real
  gateway and checks that the worker's heartbeat advances.

**Unverified:** these probes have not been run under kubelet.
