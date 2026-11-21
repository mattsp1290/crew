# Verify the local conversation proof

Use Linux with Docker access, Git, curl, sha256sum, ripgrep, uv, and `bn` 0.3.0.
The setup uses pinned PostgreSQL and Node container images. It downloads Temporal
CLI 1.10.0 and verifies its published checksum. Python 3.13.12 and Python packages
are pinned. The JavaScript lockfile pins the AG-UI clients.

1. Run `scripts/setup` from the repository.
2. Run `scripts/verify`.
3. Read `report.json` in the printed temporary evidence directory.

For the historical Python journey, use `scripts/verify` or
`scripts/verify-legacy --mode test`. Its report and private temporary files
belong to that run. To reproduce the historical hosted proof, invoke
`scripts/verify-legacy --mode live` explicitly, with the owner's approval to
make paid model calls.

### TypeScript fixture verification

Run `scripts/setup --mode fixture` on Linux with Docker, Git, curl,
sha256sum, a C compiler and Linux development headers. Pi needs
Landlock ABI 3 or newer, and Claude and Codex need ABI 4. Install Beans (`bn`) for the project-note
cases. Setup installs the pinned Node and Temporal executables, both npm
lockfiles, and the native launcher. The member fixture path requires no Python
interpreter. Offline replay also needs Linux user and network namespaces.

Run `scripts/verify --mode fixture` for the combined matrix, or add
`--engine pi`, `--engine claude`, or `--engine codex` for one member SDK.
`scripts/verify-members` and `npm run test:integration` use the same Node
entrypoint. Each run starts disposable PostgreSQL and Temporal on loopback,
checks two distinct conversations per member before and after cold replacement,
and cleans up its processes, containers, and native transcripts. Two separate
`clients/observe.mjs` processes use the client lockfile. One watches throughout
the conversation and the other attaches to a pending call. The verifier compares
both saved `.messages.json` files with the complete ordered PostgreSQL and HTTP
snapshots after the owner approves the call. Engine-specific
tests cover native calls, approvals, isolation, cancellation and observers.
The combined run also exercises simultaneous cancellation and offline replay.

Set `BIRBCREW_FIXTURE_EVIDENCE` to an output file outside the checkout for the
redacted JSON report. Use separate files for fixture and replay evidence. It records selected engines, passed stages, pinned package
integrities, launcher checksum, source fingerprint, and result. Release evidence
requires a clean checkout or a verified `git archive`. For an independently
attested source copy set both `BIRBCREW_SOURCE_REVISION` and
`BIRBCREW_SOURCE_SHA256` to the revision and source fingerprint established
from the original checkout.

### Native confinement

Every engine's native process starts through the member launcher,
`.proof/bin/member-launch`, built from `native/member-launch.c`. It applies a
Landlock filesystem ruleset and a seccomp filter, sets `no_new_privs` and a
parent-death signal, and closes inherited descriptors from 3 up (from one past
the worker channel for Pi and the Claude worker), before it runs the engine. Every engine may read
a fixed list of runtime files: the dynamic loader cache, DNS and TLS
configuration, `/dev/null`, `/dev/urandom` and a few `/proc` and `/sys` entries
that runtimes read at startup. The seccomp filter
refuses `setsid` and `setpgid`, so a native process cannot leave the process
group that its host kills, and on x86-64 it refuses x32 system call numbers,
which would otherwise bypass the filter.

- **Claude** runs `src/service/claude-worker.ts` under the launcher. The worker
  may read and execute Node, the checkout's `package.json`, `node_modules`,
  `src/service`, the compiled client under `packages/client/dist`, and
  `.proof/bin/member-launch`. It may write only its conversation directory. It
  may start a process, and the Claude CLI is started again through this
  launcher, which confines that CLI's filesystem to the conversation directory
  and does not handle network either. The worker may also read `/proc`, because
  a `/proc/self` rule names only the process that opened it and the nested
  launcher has a new pid. Landlock's ptrace scope still hides another process's
  environ, mem and cmdline. `setsid` and
  `setpgid` stay denied, so the worker cannot leave the process group its host
  kills. The launcher keeps the Node IPC socket and refuses to start unless
  that descriptor is a socket. The worker's network is not restricted: the
  vendored `@ag-ui/claude-agent-sdk` binds an ephemeral loopback MCP port after
  the ruleset is sealed, so a TCP allow rule cannot name it. Network rules move
  to C2b. Handled network access without that allow rule would deny every TCP
  connect, including the model request.
- **Codex** runs the Codex app-server through Switchboard's host adapter. The
  launcher leaves its private `CODEX_HOME` writable, its workspace readable, and
  grants private sqlite and log directories outside that home. TCP connects only
  to the provider port.
- **Pi** runs the Pi SDK in a Node worker, `src/service/pi-worker.ts`. The
  worker gets no credentials and no network. Its only channel is descriptor 3,
  a socket pair to its host carrying newline-delimited JSON.

In addition to the runtime files above, the Pi worker may use only these:

| Allowance | Reason |
| --- | --- |
| Read and execute the Node binary and anything under `/usr/lib`, `/usr/lib64` and `/lib64` | Node and its dynamic loader start the worker. Executing a file only replaces the worker, which cannot start another process. |
| Read `package.json`, `node_modules` and `src/service` in the checkout | The worker loads the Pi SDK and Crew's Pi session code. It cannot read the rest of the checkout, such as `tests`, `docs` or a local `.env`. Keep profile modules and secrets out of these directories. |
| Read, write, create and remove in one private directory | The Pi session needs a scratch working directory. It is the worker's `HOME`, `TMPDIR` and working directory, the host creates a new one for each invocation, and removes it after the worker exits, even when the worker left a directory it cannot list or a tree deeper than `PATH_MAX`. |
| Keep descriptor 3 | Model requests, text, tool calls and the result cross it. The launcher refuses to start a Pi worker unless descriptor 3 is a socket, and closes every other inherited descriptor; 0 to 2 are `/dev/null`. |

For Pi the seccomp filter also refuses:

- `socket`, `socketpair` and `io_uring_setup`, so the worker cannot open any
  socket, TCP, UDP or Unix;
- `fork`, `vfork` and `clone` without `CLONE_THREAD`, so it cannot start a
  process, and `clone3`, so that threads use `clone`;
- `prctl(PR_SET_PDEATHSIG)`, so it cannot undo its death signal;
- `kill` and `tgkill` to any process but itself, and `tkill`,
  `pidfd_send_signal`, `rt_sigqueueinfo` and `rt_tgsigqueueinfo`;
- `prlimit64`, `sched_setaffinity`, `sched_setattr`, `sched_setparam`,
  `sched_setscheduler`, `setpriority` and `ioprio_set` on any process but
  itself, since a lowered limit or priority also reaches another process of the
  same user;
- `fcntl(F_SETOWN)`, `fcntl(F_SETOWN_EX)`, `ioctl(FIOSETOWN)` and
  `ioctl(SIOCSPGRP)`, which would make the kernel signal another process;
- `shmget`, `msgget`, `semget` and `mq_open`, whose objects outlive the worker;
- `chmod`, `fchmodat`, `fchmodat2`, `utime`, `utimes`, `futimesat`,
  `utimensat`, `setxattr`, `lsetxattr`, `removexattr`, `lremovexattr`,
  `setxattrat`, `removexattrat` and `file_setattr`, because Landlock does not
  mediate file metadata: without them the worker could change the mode of any
  file its user owns, such as the native state volume;
- `ptrace`.

Landlock also does not mediate `stat`, `access`, `chdir` or `flock`, so the
worker can still learn whether a path exists and read its metadata. `chown` and
the descriptor-based `fchmod`, `fchown` and `fsetxattr` stay allowed: they need
ownership or a descriptor the worker can open, which outside its private
directory it has only on files its user owns and Landlock lets it read. Run the
service, as the service image does, as a user that does not own the checkout
and has no capabilities: the policy assumes both, and the launcher does not
drop privileges itself.

The worker's environment holds only `HOME` and `TMPDIR`: no database URL and no
provider key. The host does not trust the worker:

- **Model requests.** The host makes each model request for the worker with the
  operator's own model, provider, credentials, proxy relay and request
  identity, with provider retries off. Of the worker's request options it takes
  only the session ID, transport and bounded timeouts; it ignores any model,
  key, headers, identity or environment. A member segment may make one model
  request and a trusted application turn 17, one for each of at most 16 tool
  calls and one for the reply, never two at once.
- **Text and previews.** The host publishes the reply text and the argument
  previews itself, from the events it relays, and fails the turn past 65,536
  bytes of text; the worker reports neither.
- **Trusted tools.** The host runs each trusted application tool only for a
  call that the model sent through it, in a reply that neither failed nor hit
  its token limit, as the agent requires, with the model's arguments coerced
  against the tool's schema as the agent does. A failed dispatch fails the
  turn, as it did in process. The worker still builds the model's context, so a
  call "the model sent" is one the worker led the model to send.
- **The channel.** The host reads the worker's frames with a limit of 16 Mi
  characters, fails the turn if the worker leaves 64 MiB unread, and stops
  acting on frames after the first failure.
- **Member results.** The host checks the worker's result before it returns
  it. A member segment's checkpoint must keep the thread, the session and every
  earlier turn, and add only this request's turn or pending call. That turn
  must hold this request's prompt, the reply or tool calls exactly as the model
  sent them through the host, and system entries that the SDK itself writes:
  the instructions, the project context, the worker's own working directory,
  and the declarations of the segment's tools. A resumed turn's tool results
  must be the ones the host builds from the owner's decision or the children's
  outcomes. The committed text must equal the model's reply and the published
  text. A proposal must name the segment's tool and its request. Delegated
  child profiles come from the `@birbcrew/pi-subagents` role table on the
  host, not from the worker.
- **Trusted results.** A trusted turn's reply must equal the text the model
  sent, and its checkpoint must extend the prior one by this request's prompt,
  the replies the model sent, the results the host delivered, and the SDK's
  own system entries.
- **Usage.** The host records a member segment's usage from the replies it
  relayed, not from the worker.
- **Profile hooks.** A Pi profile's `prepare` runs on the host. Its extension
  may register only the `before_provider_headers`, `before_provider_request`,
  `after_provider_response` and `provider_stream_event` hooks; any other
  extension call fails the turn, and so does an error from a hook, which the Pi
  SDK would only report.
- **Process groups.** In the member lane the worker stays in the supervised
  runner's process group, so the supervisor's stop and reaping cover it; in the
  trusted lane it gets its own group, which the host kills when the worker
  exits.

Pi needs Landlock ABI 3 or newer, and Claude and Codex need ABI 4. On a kernel
without Landlock, with an older ABI, or where the container's seccomp profile
blocks the `landlock_*` system calls, the launcher exits with status 126 before
the engine starts, and the turn fails. No engine falls back to running
unconfined. Landlock below ABI 6 cannot scope signals, so a Claude or Codex
process can still signal other processes of the same user.

`tests/fixtures/engines/pi/confinement.test.ts` proves the Pi policy. It starts
a process with the launcher invocation of a Pi worker, running `node -e` probe
code instead of the worker entry. The probe gets `EACCES` when it reads a file
outside its allowed set: a sibling owner's file, a test file in the same
checkout, and its host's `/proc/<pid>/environ`. It gets `EPERM` when it
connects to a listening loopback port, which received no connection, when it
starts a process, when it signals its host, and when it changes the mode or
times of a file its user owns. It can still read Crew's code and write its
private directory. The same test runs a real Pi turn and checks
that its worker has `no_new_privs`, one more seccomp filter than the test
process, and only `HOME` and `TMPDIR` in its environment, and that the launcher
refuses a Pi worker started without descriptor 3.
`tests/fixtures/engines/claude/confinement.test.ts` proves the Claude worker
policy. A probe may read the worker and its dependencies and write its private
directory. It gets `EACCES` when it reads or writes a sibling file, reads a
test file, reads or appends the docs tree, reads client source, reads its
host's environment, writes `src/service`, `node_modules`, or the compiled
client, or executes a script it just wrote in the conversation directory.
A detached child keeps the worker's session id, which is how the probe shows
`setsid` was denied: libuv ignores the `EPERM`. A nested launcher process cannot read the sibling
file or the worker source: that second ruleset confines the CLI to the
conversation directory and does not handle network either. A loopback TCP
connect from the worker still succeeds, because network confinement waits for
C2b with the ephemeral MCP port. The same test runs a fixture turn and checks
that the worker has `no_new_privs`, one more seccomp filter than the test
process, that each CLI child has one more seccomp filter than the worker, and
a command of Node plus `claude-worker.ts`. The launcher flags and a host
sentinel are absent from its environment. The launcher refuses a Claude worker
whose channel is not a socket.
`tests/fixtures/engines/claude/durable.test.ts` proves a direct CLI launch
gets `EACCES` on a sibling owner's file.
`tests/fixtures/engines/codex/native.test.ts` proves the Codex filesystem
policy.

### Live member verification

The opt-in member entrypoint is `scripts/verify --mode live --engine ENGINE
--approval /absolute/private/proof.json`. Each run needs its own single-use
owner approval, and each provider its own account and credential. Fixture results apply only to the controlled
local providers. See the [account and profile guide](member-profiles.md).

## Run the Python subscription journey

This journey makes paid model calls. Run it only with the owner's approval.
Overage billing is a provider console setting that no code here reads. Keep
Extra Usage off there, and do not enable paid fallback.

The proof reads the literal `OPENCODE_GO_API_KEY` assignment from `~/.profile`.
It never prints that value or sources the profile. Use the owner's supported
credential flow to provision it. Do not put a credential in this repository.

Run `scripts/verify-legacy --mode live`. The credential is the only account
input. Before the first model call the proof asks the provider for its model
list with that key and stops on any answer but 200 or when `glm-5.3-flash` is
not listed. Earlier releases also required `--attestation`, a dated owner
statement that expired after twelve hours. That option was removed, and nothing
replaces it.

The journey uses the same conversation runtime with the compatible OpenAI
provider and `glm-5.3-flash`. The request identifies Birbcrew and supplies a
stable conversation session header. It performs only the synthetic coding
journey. The credential preflight and returned model identity appear in the
report, which states that billing was not checked. This live journey is opt-in
for routine runs and required for milestone acceptance.

## Inspect the evidence

The report records package and service versions, workflow IDs, process
termination points, fixture results, finalized messages, scoped note provenance,
and gate results. Client JSONL files contain AG-UI events. Worker logs and local
telemetry files correlate conversation, workflow, request, and operation IDs.
The raw Temporal histories stay in the disposable evidence directory.

Treat missing, failed, or inconclusive gates as unresolved. Source review cannot
replace a live integration run. Human review of authentication and permissions
is required before merge, even when all automated proof checks pass.

### TypeScript history replay and traces

Run `node tests/proof/replay-traces.mts` from the checkout against disposable
PostgreSQL and Temporal instances using `BIRBCREW_DATABASE_URL` and
`BIRBCREW_TEMPORAL_ADDRESS`. The probe uses local Claude, Codex and Pi providers and
requires Linux `unshare --user --net`. It replaces the worker while a Claude and a Pi call await approval. It settles a Codex call on its live connection before the restart. It completes all three conversations and the Pi child, then exports four private histories into a temporary directory. It replays them with
Temporal’s TypeScript Worker in a separate process with no network interfaces,
checks that the provider request log and receipt ledger are unchanged, and
removes the histories when it exits. To retain the redacted report with span
correlations, history hashes, package integrity values and source revision, set
`BIRBCREW_REPLAY_EVIDENCE` to an output file outside the checkout.

Set `BIRBCREW_TRACE_FILE` on a member worker to write local OpenTelemetry
spans to a private JSONL file. Model invocations, workflow segments, native
restores and tool settlement carry the conversation, request, engine and
Temporal run IDs. A Pi child also carries its child ID. Completed spans from
the same conversation and request share a trace ID across processes and worker
replacements. Each actual native driver call also emits one Switchboard
`invoke_agent <engine>` span beneath `model.invoke`. Its provider is `openai`
for Codex, `anthropic` for Claude, or the configured Pi model provider.
Provider identifiers must match `[a-z][a-z0-9._-]{0,63}`. Unsafe identifiers
suppress that observation. The agent records UUID run, request, and conversation
correlation, the engine, provider, and terminal outcome. Returned complete,
pending, and delegated results mean a successful invocation. A thrown native
error records `error` with `unknown-error`, without its message.

Agent observations contain no prompts, replies, model names, tool arguments,
native handles, or usage. Crew cannot observe individual provider requests or
tool executions inside a native SDK. Aggregate segment usage stays on the
existing operational `model.invoke` span. JSONL includes both span types.

Set `BIRBCREW_OTLP_TRACES_ENDPOINT` to also send the same spans over OTLP/HTTP
JSON to a collector. Without that variable, Crew selects
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`.
Signal-specific endpoints are complete URLs. For the generic endpoint, Crew
appends `/v1/traces` after its base path. Only the highest-priority nonempty
variable is validated and used. Give a full traces URL, such as
`https://collector.example/v1/traces`. It must use `https`, except that plain
`http` is allowed to `127.0.0.1`, such as `http://127.0.0.1:4318/v1/traces`,
and to any other host when `BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true` is also set
(see the Datadog Agent recipe below). IPv6 literal hosts such as `[::1]` are
rejected because the exporter cannot connect to them. It must have a path and must not embed a
user name, password, query string or fragment; the exporter sends only the
path, so a query string would otherwise be dropped. Either sink, both or
neither may be set. Spans come from the member worker and its native turn
runners, but every process that loads the store also reads the setting: the
gateway, every `members` command, the worker, the supervisor host and the turn
runners. Each of them fails at startup when the value breaks these rules, so
a malformed value stops the whole service, not only tracing. The error names
the selected variable and does not repeat the value. Network export preserves
the file's trace IDs, span IDs, parent relationships, and attributes.
Prompts, replies, tool arguments and credentials are never span data.
Spans are batched in a bounded queue and
dropped when the queue is full or the collector fails; export never fails a
turn. It can slow one, though: the host confirms a native turn only after its
runner exits, and the runner first waits up to 250 milliseconds to flush its
spans. A slow, stalled or unreachable collector therefore adds up to a quarter
second to every native turn, and spans not flushed in time are dropped. The
worker waits up to one second to flush when it stops. An export still in
flight can then keep it up longer: about two seconds when the collector
accepts the connection and stays silent, but until the operating system gives
up on the connection attempt, about two minutes on Linux, when nothing answers
the collector's address, and for as long as a collector keeps trickling an
answer. The orchestrator's stop timeout ends it in those cases. The exporter also
honours the standard `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_EXPORTER_OTLP_TRACES_HEADERS`, certificate, client key and compression
variables. The generic `OTEL_EXPORTER_OTLP_*` forms apply to every OTLP
exporter, so a header or certificate set for another service on the same host
is sent to this collector too. Prefer the `OTEL_EXPORTER_OTLP_TRACES_*` forms
and keep the generic ones unset for Crew. The exporter sends JSON only:
`OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` is ignored, gRPC is not used, and the
endpoint variables select the destination without changing this protocol.
The Python worker writes only the JSONL file. Configure one destination in
Crew. A collector can forward spans to multiple backends.

The resource carries `service.name` and any attributes from
`OTEL_RESOURCE_ATTRIBUTES`. Both variables are read only when
any OTLP endpoint is selected; no host, process or container
attributes are detected. The service name is `OTEL_SERVICE_NAME` when set and
not empty, otherwise `service.name` from `OTEL_RESOURCE_ATTRIBUTES`, otherwise
`birbcrew`. `OTEL_RESOURCE_ATTRIBUTES` follows the OpenTelemetry format:
comma-separated `key=value` entries such as
`deployment.environment.name=production,service.version=1.2.3`. Whitespace
around the whole value, such as the final newline of a YAML block, is ignored,
as are spaces and tabs around keys, values and commas. Empty entries are
skipped. Each key is a W3C Baggage token (letters, digits and
``!#$%&'*+-.^_`|~``) of at most 255 characters and appears once. Keys that
plain JavaScript objects inherit, such as `constructor`, `toString` or
`__proto__`, are refused because the OpenTelemetry SDK would drop them. Each
value is not empty and uses printable ASCII other than space, `"`, `,`, `;`
and `\`; percent-encode anything else, such as `%20` for a space or `%2C` for
a comma. Decoded, a value must be valid UTF-8, not only whitespace, and at
most 255 characters, counted as Unicode code points. It must not contain
control characters, invisible formatting characters, or line or paragraph
separators (Unicode categories Cc, Cf, Zl and Zp). At most 32 entries and 4096
characters are accepted. `OTEL_SERVICE_NAME` follows the same length and
character limits as a decoded value, after surrounding whitespace is removed.
Unlike the OpenTelemetry SDK, which drops malformed input silently, Crew
refuses to start when either variable breaks these rules, so a typo cannot
quietly remove the environment or version. The error names the variable and,
for an attribute, the entry's position among the comma-separated parts
(counting from 1, empty parts included), never its content.

When an export fails, the process writes one line to standard error, such as
`birbcrew: OTLP trace export failed (ECONNREFUSED) and its spans were dropped;
the next warning comes at least 5 minutes later`. The reason in parentheses is
one of these:

- an HTTP status, such as `HTTP 404`;
- `HTTP 429, 502, 503 or 504`, when retries on one of those statuses ran out;
- a fixed Node or OpenSSL error code, such as `ENOTFOUND`, `EPROTO` or
  `DEPTH_ZERO_SELF_SIGNED_CERT`;
- `timeout`, when no answer came within two seconds, including a connection
  attempt that is never answered;
- `unknown error`.

The line never contains the endpoint, a header, the collector's status text or
response body, or span data. Each process writes at most one such line every
five minutes and counts the failures it held back in the next one. A failed
write, such as to a closed pipe, is ignored. Native turn runners discard
standard error, so the line comes from the worker. Crew registers no
OpenTelemetry diagnostic logger.

#### Datadog Agent

To send spans to a Datadog Agent's OTLP receiver inside a Kubernetes cluster,
set these on the worker container. Its supervisor host and turn runners inherit
them. The gateway also reads them but emits no spans.

```sh
BIRBCREW_OTLP_TRACES_ENDPOINT=http://datadog-agent.default.svc:4318/v1/traces
BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true
OTEL_SERVICE_NAME=crew-worker
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.version=1.2.3
```

The Agent must run APM with its OTLP HTTP receiver listening beyond
loopback, for example `DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318`.
The receiver speaks plain HTTP, so an `https` endpoint fails every export with
`EPROTO`. Whenever an OTLP endpoint is selected,
`BIRBCREW_OTLP_TRACES_ALLOW_HTTP` must be `true` or `false`, in any case, or
empty, which means `false`; any other value stops startup. The opt-in changes
only whether the connection is encrypted, not where spans may go: an `https`
endpoint may already name any host. When the endpoint is plain `http` to a
host other than `127.0.0.1`, Crew refuses to start if
`OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_TRACES_HEADERS` holds
anything other than whitespace, because those headers usually hold
credentials. Everything else in each request is readable on the network: the
host and path, the resource attributes (service name, environment, version and
anything else in `OTEL_RESOURCE_ATTRIBUTES`), and every span's name, timing,
status, `engine`, and conversation, request, workflow run and child IDs. Use
the opt-in only where the path to the Agent stays inside the cluster network.
The exporter reads the collector's response without a size limit, as it does
over `https`, so whoever can answer in the collector's place can grow the
process's memory; without encryption that includes anyone able to intercept
or impersonate the Agent's Service inside the cluster.

The Agent maps `service.name` to the Datadog service,
`deployment.environment.name` to `env` and `service.version` to `version`.
The operational span name (`workflow.segment`, `model.invoke`, `tool.settle`,
or `native.restore`) becomes the Datadog resource name. Operational spans have
the operation name `Internal` because Crew sets no `operation.name` attribute.
An Agent started with
`DD_OTLP_CONFIG_TRACES_SPAN_NAME_AS_RESOURCE_NAME=true` uses the span name as
the operation name too, but that setting applies to every service sending OTLP
to that Agent.

To enable Datadog LLM Observability conversion on that destination, set
`BIRBCREW_DATADOG_LLMOBS=true`. The flag accepts exactly `true` or `false`,
defaults to `false`, and requires an endpoint when enabled. Keep both
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` unset.
Crew rejects inherited collector headers in this mode. Configure forwarding
credentials and LLM Observability in the Datadog Agent.

The resource receives boolean `dd_llmobs_enabled=true`. The network exporter
adds `_dd.ml_obs.metadata` with only the validated Switchboard outcome, run
ID, and request ID. This conversion leaves JSONL spans unchanged. HTTP
acceptance alone does not prove that Datadog converted a span into an LLM
Observability agent. Qualify the configured Agent and query its converted
spans before relying on backend visibility. With both local backends running,
run this synthetic host qualification from Crew.

```sh
LOTEL_BIN=/path/to/lotel \
LOTEL_ENDPOINT=http://127.0.0.1:4318/v1/traces \
DATADOG_OTLP_ENDPOINT=http://127.0.0.1:14318/v1/traces \
npm run verify:observability
```

The probe forwards Crew's exported JSON through a local bridge, queries both
backends by original span IDs, and saves
`.proof/genai-observability/backends.json`. It verifies host observations and
backend conversion. It does not exercise native provider requests.
Set `DD_SITE` for a Datadog site other than the default `us3.datadoghq.com`.
See [the qualification snapshot](observability-validation.json) for recorded results.

Datadog treats these agent spans as LLM roots because the operational parents
are not GenAI operations. Its LLM trace ID differs from the original OTel
trace ID. Datadog preserves that OTel ID as `apm_trace_id` and the
`otel.trace_id` tag, and preserves the span ID in decimal form. The APM trace
retains the workflow parent relationship. Its indexed view can contain only a
subset of the emitted spans. The probe reports how many agent parents it can
independently query in APM. Use those identifiers and the
Switchboard metadata to correlate the two Datadog views.

#### Refresh the Switchboard observability package

Crew pins an immutable observability-only archive under `vendor/switchboard`.
It retains upstream JavaScript and declarations byte for byte, its original
instrumentation scope, the MIT license, and source and extracted SHA-256 hashes.
Crew uses Node 24.22.3. Its existing Switchboard core package and native SDK
pins remain separate because the latest full package requires different native
SDK peers. The extracted entry depends only on the shared OpenTelemetry API.
The immutable archive's README records its earlier Node 22 compatibility check.
Current Crew validation uses Node 24.22.3.

From a clean Switchboard checkout with its dependencies installed, use Node
24.22.3 to run `node scripts/vendor-switchboard-observability.mjs ../switchboard`
from Crew. The script builds upstream, checks runtime imports, and packs the
observability entry plus its type-only core contract. It refuses to replace an
archive with different bytes at the same revision. Install the new archive
with `npm install --save-exact ./vendor/switchboard/<archive>.tgz`, then run
`npm run build` and `npm run test:telemetry` on Node 24.22.3. Commit the archive
and lockfile together. `npm run test:telemetry` runs the installed entry in
fresh Node processes against a real HTTP JSON collector and the JSONL exporter.
It checks correlation, parent relationships, preserved native results and
errors, bounded observation failures, metadata privacy, and endpoint selection.
