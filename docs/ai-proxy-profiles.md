# Operator-controlled AI proxy profiles

This is the supported **custom profile** path for the AI proxy request
`birbcrew-r-ooha`. It is independent of the built-in direct-provider and ChatGPT
subscription profiles that `providers.ts` exports. It does not read their
`BIRBCREW_LIVE_PROFILES` setting, use their auth files, or fall back to them.

## Exact protocol contract

| Engine | `protocol` | Local SDK route | Upstream requirement |
| --- | --- | --- | --- |
| Claude | `anthropic-messages` | `/v1/messages` or `/v1/messages?beta=true` | Anthropic Messages JSON/SSE, including tool use/results |
| Codex | `openai-responses` | `/v1/responses` | OpenAI Responses SSE, including function calls/results |
| Pi | `openai-chat-completions` | `/v1/chat/completions` | OpenAI Chat Completions SSE, including tool calls/results |

Claude's pinned beta Messages SDK adds the exact `?beta=true` suffix. The relay
accepts that suffix locally but still forwards to the exact configured upstream
endpoint, with `anthropic-beta` headers preserved. Other query strings and the
`count_tokens` route are not supported.

There is no universal format translation. Configure the **full upstream POST
endpoint**, including any proxy routing prefix. A proxy offering only Chat
Completions cannot serve this Codex profile. Each profile has one exact model ID;
requests for another model are rejected before credential resolution or network
forwarding. Engine/protocol mismatches fail at profile creation. Model availability
at a remote service cannot be inferred from a model listing: unsupported models
fail on generation and do not trigger fallback. Pi currently exposes a text-only,
non-reasoning model with 32,768 input context and 4,096 output token limits; choose
a proxy model compatible with those limits. This is not arbitrary model discovery.

## Trusted module example

Create a private TypeScript module accessible to the worker and its supervisor
processes. Keep it outside client-controlled uploads. The endpoint and model below
are examples, not a service to call:

```ts
import { createProxyProfile } from "./src/service/proxy-profiles.ts";
import { commandCredentialResolver } from "./src/service/proxy-credential.ts";

const credential = commandCredentialResolver({
  executable: "/opt/company/bin/resolve-ai-proxy-credential",
  args: ["--audience", "approved-ai-proxy"],
  // Only explicitly required environment is passed. No shell or ambient env.
  env: { HOME: "/var/lib/birbcrew-credential-owner" },
});
const configured = await createProxyProfile({
  engine: "claude",
  protocol: "anthropic-messages",
  accountId: "operator-proxy-account-v1", // non-secret, stable registration identity
  endpoint: "https://proxy.example.invalid/anthropic/v1/messages",
  model: "claude-sonnet-4-6",
  headers: { "x-application": "birbcrew" },
  resolveCredential: credential,
  protectedTool: "record_work_item", // omit for text-only members
});
export const profiles = new Map([["proxy-claude.v1", configured.profile]]);
export const close = configured.close;
```

Use `engine: "codex", protocol: "openai-responses"` or
`engine: "pi", protocol: "openai-chat-completions"` for the other engines, with
an appropriate model and endpoint. Make separate profiles/relay instances for
separate routes. Export a `close` that closes all instances when composing a map.
`humanTool: "choose_next_step"` is an alternative to `protectedTool`, not an
additional tool. Existing registered-tool approval rules are unchanged.

Run with the existing worker command:

```sh
BIRBCREW_DATABASE_URL=... BIRBCREW_STATE_DIR=/absolute/private/state \
  npm run members -- worker /absolute/private/proxy-profiles.ts
```

The fixed executable must return exactly one JSON object on stdout:

```json
{"headers":{"authorization":"Bearer <short-lived-secret>"},"expiresAt":1900000000000}
```

`expiresAt` is Unix epoch milliseconds. This example is a shape, not a credential.
The helper owns renewal; it must return a currently valid credential for every
invocation. It can use an operator-approved credential store. The resolver can
instead be an in-process async function accepting an `AbortSignal`. Never accept
an executable, args, endpoint, headers, model or credential from AG-UI input.
Helpers run without a shell, with fixed copied arguments, a minimal explicit
environment, a 10-second default deadline and 16 KiB output limit. Non-JSON output,
extra JSON fields, nonzero exit, expiry and cancellation fail generically; stdout,
stderr, arguments and exception details are not logged or propagated. Each helper
runs in its own process group. Deadline, cancellation and output overflow send
SIGTERM, escalate to SIGKILL after 100ms and wait for the direct child to be reaped.
A further 100ms drain window closes inherited pipes; group-local descendants are
terminated, with orphan reaping owned by the OS/subreaper. Trusted helpers must not
daemonize or escape their group. This is bounded lifecycle management, not a
sandbox for untrusted programs; no unrelated PIDs are scanned or signalled.

## Lifecycle and security boundary

Claude/Pi importing processes start a relay on a random IPv4 loopback port with a
new 256-bit local token. Codex acquires a separate relay/token for each invocation:
its host `AbortSignal` directly closes that invocation's upstream requests, even
when the native SDK has not yet disconnected its socket. The driver awaits lease
cleanup in `finally`; cancelling one turn cannot cancel another concurrent turn.
Profile shutdown closes all outstanding leases. The Claude and Codex SDKs receive only that
local token, never the upstream credential. The confined Pi worker receives neither: the
host makes each Pi model request through the relay and passes the reply to the worker. Each **actual forwarded HTTP request** invokes the resolver
and checks expiry immediately before fetch, including SDK-internal tool
continuations and any compaction requests using the same route. Nothing caches a
credential for a turn. On restart, the trusted module creates a new relay/token
and resolver; stable profile/account/model identity and native state are retained,
not credentials. `close()` aborts active requests and closes connections. The CLI
and supervisor already call the module's `close` during teardown; a killed process
loses its listener automatically.

The relay snapshots the destination and custom headers at startup, authenticates
local callers, validates the request's exact model, strips incoming credentials,
and sends only configured headers plus necessary protocol headers. Upstream TLS
is required except explicitly enabled HTTP **numeric loopback** fixtures/local
proxies (`allowHttpLoopback: true`). Redirects are never followed. Responses
outside successful JSON/SSE and upstream error bodies are replaced with generic
errors; arbitrary upstream headers are not forwarded. Successful HTTP status alone is
not trusted: JSON bodies and incremental SSE events are inspected for recognized
protocol error envelopes (`error`, `response.failed`, `response.incomplete` and
nested response error/status). Their diagnostics are replaced with a generic
failure, including an error arriving after earlier safe streamed content. Each
JSON body/SSE event is limited to 1MiB, not the entire stream. Malformed, oversized
or unterminated frames fail generically; valid text/tool events remain streamed.
Only SSE event/data fields are forwarded, not comments or unknown fields. Client disconnect and
shutdown abort upstream fetch. The default body limit is 16 MiB and request
deadline is five minutes. There is no direct-provider or subscription bypass.

The proxy and helper are trusted operator components: the relay cannot protect
against a malicious successful model response deliberately echoing credentials,
nor against another process that can read this process's memory. Do not log
credential helper output or raw request headers in an upstream proxy. Avoid secrets
in `accountId`, profile names, model IDs or endpoint paths, which are configuration,
not secret storage. The local token is ephemeral transport authentication, not an
upstream account credential. Use OS isolation and egress policy appropriate to
your deployment; this relay is not a replacement for a host network firewall.

## Offline validation and remaining live acceptance

On Linux with Landlock ABI 4 or newer, Node **24.22.3**, a C compiler and the checked-in package lock:

```sh
npm ci
npm run build
npm run test:proxy
npm test
```

`test:proxy` uses local scripted HTTP services only. It exercises the actual pinned
Claude Agent SDK, Codex SDK/CLI and Pi runtime, not a pretend Pi provider. It checks
streaming, a registered-tool round trip, fresh credentials after synthetic expiry,
profile recreation with saved checkpoints, cancellation, wrong route/model/token,
expired credentials, redirects, unavailable upstream and redacted helper errors.
No personal login, provider key or paid inference is needed. Test output records
assertions, not credentials or raw headers. It distinguishes native driver/profile
recreation from a complete Temporal/Postgres worker deployment restart.

Locked versions: Claude Agent SDK **0.3.306**, Anthropic SDK **0.113.0**, Codex SDK
and CLI **0.167.1**, Pi AI/Agent Core/Coding Agent **1.5.2**, AG-UI core **1.0.4**.
See `package-lock.json` and `vendor/ag-ui/manifest.json` for exact vendored adapter
integrities. This change is stacked on PR #28, source
`a7dd4197a0ffe83caa2a7f8fca9bb870de0490de`, not independent of that stack.

Before production use, explicitly authorize live inference for each chosen
proxy/model/account and then:

1. Start the worker with only proxy profiles. Spawn each engine and stream a text
   turn. Verify the intended model and required custom headers in **redacted**
   proxy-side counters, not raw credential logs.
2. Request a registered protected tool, approve it using the normal application
   flow, and verify the matching result returns on the original conversation.
3. Arrange short synthetic credential lifetimes in a test credential issuer. Let
   a request complete after expiry, then continue the tool/turn. Verify resolver
   invocations and successful new credential identities for every request.
4. Restart the actual worker/supervisor between turns without changing native
   state or global authentication files. Reconnect and continue the conversation;
   verify new relay/credential resolution and preserved tool correlation.
5. Cancel an active stream. Confirm upstream disconnect and no subsequent request.
   Separately force expiry, unavailable service, redirects and an invalid model.
   Each must fail visibly, without direct/subscription fallback.
6. Inspect application/Temporal history, native checkpoints, diagnostics and AG-UI
   events for synthetic credential canaries. Do not use real secrets as evidence.

Fixture success is not live-proxy acceptance. Real provider compatibility, actual
worker/container restart and deployment-specific credential issuance still need
that operator-controlled acceptance. Pi's current driver disables compaction; the
fixture does not claim to force Claude/Codex compaction, only to renew at the same
HTTP boundary those requests must use.

## Independent validation at the original proxy revision

The [validation handoff](https://github.com/mattsp1290/hub/blob/23537fb1d88018c2c35b485a55176e4e317ffedd/projects/birbcrew/handoffs/birbcrew-sq4k-ai-proxy-pr29-validation-two-corrections-and-verified.md)
records an independent Linux ARM64/Landlock ABI4 probe of `48910c2`: build and all
17 then-current proxy tests passed. Actual between-turn worker/supervisor process
replacement plus PostgreSQL and Temporal development-server restart passed for
all three engines. Duplicate completed requests caused zero new inference; new
recall requests used fresh credentials, exactly two requests per engine overall.
This was a temporary host probe, not a maintained portable test or worker-container
replacement test. It did not establish in-flight/tool-decision recovery, observer
reconnect, production Temporal persistence, forced compaction or live acceptance.

That probe also found two generic runtime defects: HTTP200 protocol error payloads
crossed the relay boundary, and a helper ignoring SIGTERM survived its deadline.
The current regression suite covers both corrections, including downstream canary
absence and helper process cleanup. Native journey tests additionally check SDK
callbacks/errors and retained native files for the injected diagnostic canary;
these checks are not a universal guarantee about arbitrary successful model text.
The independent broader consumer suite had one Claude timeout (nine passes, one
cancelled); no baseline cause was established. Subsequent [Linux CI](https://github.com/mattsp1290/crew/actions/runs/43085082834)
on `5eb15dc` passed the complete consumer suite (10/10, including Claude) and all
32 proxy qualification tests. This establishes that run's success, not a diagnosed
cause for the earlier timeout. The maintained scenario below supersedes that portability gap without expanding
its acceptance scope.

## Maintained service-restart fixture

Run `npm run test:proxy:restart` after `npm ci` and `npm run build` on Linux with
Landlock ABI4+, Node24.22.3, Docker and Temporal CLI **1.10.0** on PATH (or set
`TEMPORAL_CLI` to its absolute path). The `proxy-service-restart` CI job installs
and checksum-verifies that CLI and runs the same command with disposable services.

This committed scenario uses actual service CLI commands, the worker/supervisor,
PostgreSQL, Temporal development-server persistence and all three native engines
through `createProxyProfile`. It completes a remember turn, kills the worker and
Temporal process groups, restarts PostgreSQL while retaining data, rediscovers its
port, and restarts Temporal/workers with the same persistence/native state. It
then verifies duplicate readback with zero new upstream requests and a recall
with one fresh credential identity. Synthetic credentials are hashed for in-memory
comparison, not printed. Finally blocks stop owned processes and remove the test
container/private state on both success and failure.

The committed test turns the independent between-turn host probe into repeatable
qualification. It still does **not** claim application worker-container replacement,
in-flight/tool-decision recovery, observer reconnect, production Temporal
persistence, forced compaction or live proxy/model acceptance.
