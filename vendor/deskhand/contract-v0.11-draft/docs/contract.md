# deskhand contract

| Item | Value |
| --- | --- |
| Document version | `0.11-draft` |
| `contract_version` reported by `status` | `0.11-draft` |
| MCP protocol revision | `2026-07-28` |
| Schemas | `docs/schemas/` (JSON Schema Draft 2020-12) |
| Source requests | deskhand-r-nkjj, crew-r-yqso, birbhomes-r-5elb, birbhomes-r-ttg5 |

This document is what Crew's client and the deskhand implementation build
against. The "Shared contract" block of the source requests is authoritative.
Where this document departs from it, the departure is a numbered amendment in
[section 17](#17-changes-from-the-shared-contract).

Sections 2 to 9 define the wire surface. Sections 10 to 15 define behavior:
states, conditions, the operation outcome model, timing bounds, the allowance
file and clean stop. Statements about the MCP specification and about provider
image limits were checked against the published text on 2026-11-14.
[Section 18](#18-verified-against-the-specification-on-2026-11-14) lists the
sources, and the few points that the specification does not state. Platform
signals that the spike (deskhand-r-waw0) has still to choose are marked
"chosen by the spike".

The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Terms

- **Caller.** The MCP client. In v0 this is Crew's executor.
- **Principal.** The authenticated caller: the subject distinguished name of
  the client certificate. Its key is the RFC 4514 string of the certificate's
  DER-encoded subject, so two certificates with the same subject are the same
  principal. The bearer token must be valid on every request but
  is not part of the principal's identity. All of Crew shares one client
  certificate, so deskhand sees one principal per Mac and cannot tell Crew's
  internal callers apart. Separating them is Crew's job.
- **Holder.** A label (`holder_id`) that the caller assigns to whoever is
  driving the desktop. It is not a credential.
- **Handle.** A `frame_id`, an `operation_id` or the lease. Every handle is
  scoped to the pair (principal, `holder_id`).
- **Read tool.** `status`, `displays`, `screenshot`. A read changes nothing on
  the Mac and nothing inside deskhand except minting a frame.
- **Effect tool.** `pointer`, `keyboard`. They post input. A caller MUST treat
  any tool it does not know as an effect.
- **Lease tool.** `lease` ([section 5](#5-lease), amendment 4). It posts no
  input, but it changes who may. A caller classifies it as an effect. In this
  document "effect call" and "effects" still mean `pointer` and `keyboard`
  only.
- **Global points.** macOS global display coordinates: the origin is the
  top-left corner of the main display, x grows to the right, y grows downward,
  and the unit is the point. Coordinates on displays left of or above the main
  display are negative.
- **Frame pixels.** The pixel grid of one returned screenshot. `(0, 0)` is the
  top-left pixel.

## 2. Transport and authentication

### 2.1 Endpoint

- deskhand serves MCP `2026-07-28` over the streamable HTTP transport, without
  sessions. There is no `initialize` request and no session header. Every
  request stands alone. deskhand ignores an `Mcp-Session-Id` request header:
  it never refuses a request because of one, and it never mints or echoes
  one.
- The endpoint is `https://deskhand-<mac>.forge.svc:<port>/mcp`. The same Mac
  also answers as `deskhand-<mac>.forge.svc.cluster.local`. `<mac>` is
  `lunus-macbook-pro` or `m1max2021`. The port is deployment configuration
  (birbhomes-r-5elb) and is not fixed by this contract.
- The only HTTP method is `POST`. One request body carries one JSON-RPC
  message. Batches are not accepted.
- deskhand always answers with one `application/json` body. The transport
  lets a server choose JSON or an event stream for each request, and deskhand
  always chooses JSON. It never opens an event stream, sends no
  server-to-client requests and sends no notifications.
- HTTP/1.1 over TLS 1.3. deskhand offers neither HTTP/2 nor an earlier TLS
  version. It sends no CORS headers.
- deskhand listens on one configured LAN address and port. It never listens on
  loopback only and never on all interfaces. The transport says: "When running
  locally, servers SHOULD bind only to localhost (127.0.0.1) rather than all
  network interfaces (0.0.0.0)." deskhand does not run locally in that sense:
  every caller is on another machine. It binds one LAN address, never
  `0.0.0.0`, and the listener is protected by mutual TLS, the token and the
  host's packet filter.
- **The address can be missing.** When the Mac starts away from home, or
  leaves, the configured address does not exist and the bind fails
  (`EADDRNOTAVAIL`). deskhand does not exit. It tries the bind again at least
  every 5 s (`BIND_RETRY_MS`) and serves as soon as the address is back, with
  no manual step. Nothing else changes while it waits. No caller can reach
  it, so nothing on the wire reports the wait.
- Keep-alive connections are capped at 5 minutes. Once a connection is that
  old, deskhand closes it after the response in flight has been sent. It never
  cuts a call short to enforce the cap. A caller MUST be ready to reconnect
  between requests.
- Closing the connection before the response arrives cancels the call. An
  effect call that is executing is aborted, and one that has not been
  admitted yet is never admitted ([section 9.5](#95-order-of-refusals)). See
  [section 4.3](#43-operation_id).
- A Mac that is away, asleep with the lid closed or logged out answers
  nothing. A caller treats a refused or timed-out connection as
  "unavailable", not as an error from deskhand. A Mac whose LAN gate has
  closed is normally away as well. If it can still be reached, it answers
  with the state `gated` ([section 15.1](#151-gate-stop)).

### 2.2 Authentication

Both factors are required on every request.

1. **Mutual TLS.** The caller presents a client certificate. deskhand accepts
   it only when all of this holds:
   - it chains to the private CA, which is the only CA deskhand trusts, and
     it is in date;
   - its extended key usage includes `clientAuth`;
   - its subject equals the expected client subject that is configured for
     this Mac, compared as the RFC 4514 string of the DER-encoded subject.

   Anything else fails the TLS handshake, so the caller sees a TLS alert or a
   closed connection and no HTTP status. The same CA signs each Mac's server
   certificate, which is why chaining to the CA is not enough: a server
   certificate, or any other certificate from that CA, is refused.
2. **Bearer token.** `Authorization: Bearer <token>`, where the token is the
   per-Mac token. It is compared in constant time.

The caller MUST verify the server certificate against the same private CA and
MUST check that the name it connected to is one of the certificate's subject
alternative names. The endpoint is a fixed LAN address that another device
could hold while the Mac is away.

This is not "MCP authorization" in the specification's sense. deskhand serves
no authorization metadata and runs no OAuth flow.

### 2.3 Request headers

| Header | Rule | Failure |
| --- | --- | --- |
| `Host` | MUST equal `<name>:<service port>` for one of the two configured Service DNS names, compared case-insensitively. The bare name is also accepted when the service port is 443. An IP literal is never accepted. | `421` |
| `Origin` | MUST be absent. Any value is refused. | `403` |
| `Authorization` | `Bearer <token>`. | `401` |
| `Content-Type` | `application/json`, with or without `charset=utf-8`. | `415` |
| `Accept` | The caller MUST list both `application/json` and `text/event-stream`, as the transport requires. deskhand is lenient: it refuses only a header that is present and admits neither `application/json` nor `*/*`. | `406` |
| `MCP-Protocol-Version` | MUST be present and be a date of the form `YYYY-MM-DD`. | `400`, `-32020` |
| `MCP-Protocol-Version` | MUST be `2026-07-28`. | `400`, `-32022` |
| `Mcp-Method` | MUST be present and equal the body's `method`. | `400`, `-32020` |
| `Mcp-Name` | On `tools/call`, MUST be present and equal the body's `params.name`. Ignored on other methods. | `400`, `-32020` |
| `Mcp-Session-Id` | Ignored. Never echoed. | none |

The service port in `Host` is the port the caller dials on the cluster Service.
It can differ from the port deskhand listens on, so deskhand takes the accepted
`Host` values from configuration.

- **A missing or malformed required header is `-32020`.** That covers an
  absent `MCP-Protocol-Version`, one that is not a date, an absent
  `Mcp-Method` and an absent `Mcp-Name` on `tools/call`. `-32022` is only for
  a well-formed version that deskhand does not support.
- **Header values are compared exactly.** `Mcp-Method` and `Mcp-Name` are
  compared with the body byte for byte, so the comparison is case-sensitive.
  Header names are case-insensitive, as in HTTP.
- **Encoded values are decoded first.** A value that is not plain ASCII
  arrives as `=?base64?<base64 of the UTF-8 text>?=`. deskhand decodes that
  form before it compares. A `tools/call` for a tool with a non-ASCII name
  therefore gets `-32602` (unknown tool) and not `-32020`. A value in that
  form that does not decode is a malformed header (`-32020`).
- **The body repeats the protocol version.** Every request MUST carry
  `params._meta["io.modelcontextprotocol/protocolVersion"]`, a string, and it
  MUST equal the `MCP-Protocol-Version` header. A request without it, or with
  a value that is not a string, is refused with `400` and `-32602`. A value
  that differs from the header is refused with `400` and `-32020`.

### 2.4 Order of checks and HTTP status codes

deskhand applies these checks in order and stops at the first failure.

| # | Check | On failure |
| --- | --- | --- |
| 1 | TLS handshake with the expected client certificate ([section 2.2](#22-authentication)) | handshake fails, no HTTP response |
| 2 | Header block is at most 16,384 bytes | `431` |
| 3 | Path is `/mcp` | `404` |
| 4 | Method is `POST` | `405` with `Allow: POST` |
| 5 | `Host` is accepted | `421` |
| 6 | `Origin` is absent | `403` |
| 7 | Bearer token is present and valid | `401` with `WWW-Authenticate: Bearer realm="deskhand"` |
| 8 | `Content-Type` is `application/json` | `415` |
| 9 | Body is at most 65,536 bytes | `413` |
| 10 | `Accept` admits JSON | `406` |
| 11 | Body is strict JSON (see below) | `400`, JSON-RPC `-32700` |
| 12 | Body is one JSON-RPC 2.0 request object or notification object | `400`, JSON-RPC `-32600` |
| 13 | `MCP-Protocol-Version` is present and well formed | `400`, JSON-RPC `-32020` |
| 14 | `MCP-Protocol-Version` is `2026-07-28` | `400`, JSON-RPC `-32022` |
| 15 | The body is a notification (it has no `id`) | not a failure: answered `202` with no body, and no later check runs |
| 16 | `params._meta["io.modelcontextprotocol/protocolVersion"]` is present and is a string | `400`, JSON-RPC `-32602` |
| 17 | That value equals the `MCP-Protocol-Version` header | `400`, JSON-RPC `-32020` |
| 18 | `Mcp-Method` is present and equals `method`; on `tools/call`, `Mcp-Name` is present and equals `params.name` | `400`, JSON-RPC `-32020` |
| 19 | `method` is one of the three in [section 3](#3-mcp-methods) | `404`, JSON-RPC `-32601` |
| 20 | On `tools/call`, `params.name` is a known tool and `arguments`, if present, is an object | `200`, JSON-RPC `-32602` |

Responses to failures 2 to 10 have no meaningful body. A caller MUST decide on
the status code alone. `401` never says which part of the credential was wrong.

Once check 20 passes the HTTP status is always `200`, and every refusal from
that point on is an `isError` tool result ([section 9](#9-errors)).

**Notifications (check 15).** This revision of MCP defines no notification
that a client sends over HTTP. deskhand still accepts one: a body with a
`method` and no `id` that passed checks 1 to 14 is answered `202` with no body
and is otherwise ignored. A notification with a missing or unsupported
`MCP-Protocol-Version` header gets the `400` of check 13 or 14.

**Strict JSON (check 11).** deskhand refuses a body that an ordinary parser
would accept in more than one way, because Crew shows a person one reading and
deskhand must not act on another:

- A JSON object with two members of the same name is refused, at any depth.
- A string that is not valid Unicode is refused: an unpaired surrogate, written
  as a `\u` escape or as raw bytes, and invalid UTF-8.
- Where the fault lies decides the error. Inside `params.arguments` of a
  `tools/call` it is the tool error `invalid_argument`, reported with the
  other argument faults ([section 9.5](#95-order-of-refusals)) and before any
  schema check. Anywhere else in the body it is `400` with `-32700`.

RFC 8785, which the operation digest uses
([section 12.1](#121-records)), cannot canonicalize either kind of body, so
deskhand never has to.

### 2.5 Size limits

| Limit | Value | Why |
| --- | --- | --- |
| Request header block | 16,384 bytes | |
| Request body | 65,536 bytes | The largest valid call (1024 fully escaped code points of `keyboard` text plus 64 bundle identifiers) is under 32,000 bytes. |
| Encoded image (`MAX_IMAGE_BYTES`) | 3,750,000 bytes, before base64 | The provider limit counts the base64 text, and the strictest provider allows 5,000,000 characters. 3,750,000 bytes encode to exactly 4 × 3,750,000 / 3 = 5,000,000 characters. |
| Response body (`MAX_RESPONSE_BODY_BYTES`) | 5,400,000 bytes | 5,000,000 base64 characters, plus 400,000 bytes for the JSON envelope and the metadata, which appears twice and is a few kilobytes each time. |

deskhand never sends a response body over 5,400,000 bytes. A caller MUST accept
response bodies up to that size.

## 3. MCP methods

deskhand implements exactly `server/discover`, `tools/list` and `tools/call`.
`server/discover` and `tools/list` answer in every state, because they reveal
nothing about the desktop. Every other method gets `404` with `-32601`. The
specification requires `server/discover` of every server and `tools/list` of
every server with the `tools` capability. It has no `ping` in this revision.

Requests are JSON-RPC 2.0 objects whose `id` is a string or an integer. The
response echoes the `id`. deskhand keeps no `id` from one HTTP request to the
next and never compares them.

Every request carries `params`, because every request carries
`params._meta["io.modelcontextprotocol/protocolVersion"]`
([section 2.3](#23-request-headers)). deskhand reads that one member of
`params._meta` and ignores the rest, including
`io.modelcontextprotocol/clientInfo` and
`io.modelcontextprotocol/clientCapabilities`. It requires no client
capability, so it never answers `-32021`. `_meta` is not part of a tool's
arguments and is not part of the operation digest
([section 12.1](#121-records)).

Every successful result carries `resultType`. deskhand always sends
`"resultType": "complete"` and never `"input_required"`.

**Caching hints.** The specification requires `ttlMs` and `cacheScope` on the
results of `server/discover` and `tools/list`. deskhand sends `"ttlMs": 300000`
and `"cacheScope": "private"` on both. Five minutes is safe because neither
result changes while deskhand runs. `private` is the cautious value: the
answers are the same for every caller, but nothing is gained by letting a
proxy share them.

### 3.1 `server/discover`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }
  }
}
```

The result states that deskhand supports protocol revision `2026-07-28` only,
has the `tools` capability with `listChanged` false, and identifies itself as
`deskhand` with its build version. The server identity is inside the result's
`_meta`, under `io.modelcontextprotocol/serverInfo`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": { "listChanged": false } },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "deskhand",
        "version": "0.1.0"
      }
    },
    "ttlMs": 300000,
    "cacheScope": "private"
  }
}
```

deskhand sends no `instructions`. That member is optional guidance for a
model, and what a model should know about deskhand is in the tool descriptions
and in Crew's own prompts.

The contract version is not in this result. A caller reads it from
`status.contract_version`, which this contract controls.

### 3.2 `tools/list`

The result is
`{"resultType": "complete", "tools": [...], "ttlMs": 300000, "cacheScope": "private"}`
with the six tools in the order `status`, `displays`, `screenshot`, `pointer`,
`keyboard`, `lease`, in one page. There is no `nextCursor`, which means the
list is complete. The list never changes while deskhand runs.

Each tool entry has `name`, `title`, `description`, `inputSchema`,
`outputSchema` and `annotations`.

- `description` is the `description` of the tool's input schema file.
- `inputSchema` and `outputSchema` are the files under `docs/schemas/tools/`,
  made self-contained by this rule: copy every entry of `defs.json`'s `$defs`
  into the schema's own `$defs`, rewrite each `../defs.json#/$defs/NAME` to
  `#/$defs/NAME`, and remove `$id`. Names in a tool schema's own `$defs` never
  collide with names in `defs.json`.
- Input schemas are closed objects with no `oneOf`, `anyOf` or `allOf` at the
  top level, so they can be handed to a model provider unchanged. Unions are
  nested one level down, under `action`.
- `holder_id`, `operation_id` and every argument of `lease` are supplied by
  the caller's executor. They are never chosen by a model.
- Each output schema is `oneOf` the tool's success shape and the tool's error
  shape, so `structuredContent` conforms to `outputSchema` whether or not
  `isError` is set. The specification does not say whether `outputSchema`
  governs an error result; this layout is correct either way. The two shapes
  are disjoint: an error always has `code` and a success never does.
- A tool's error shape is the shared `tool_error` with `code` limited to the
  codes that tool can return ([section 9.3](#93-tool-error-codes)).
- JSON Schema 2020-12 is the specification's default dialect for both
  schemas.

| Tool | Title | Kind | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | Status | read | `true` | `false` | `true` | `false` |
| `displays` | List displays | read | `true` | `false` | `true` | `false` |
| `screenshot` | Take a screenshot | read | `true` | `false` | `false` | `true` |
| `pointer` | Pointer input | effect | `false` | `true` | `true` | `true` |
| `keyboard` | Keyboard input | effect | `false` | `true` | `true` | `true` |
| `lease` | Lease | lease | `false` | `false` | `false` | `false` |

All four annotations are set explicitly on every tool, because the
specification's defaults (`destructiveHint` and `openWorldHint` true) would
be wrong for most of them. Notes:

- `status` is read-only. It reports state and looks records up, and it
  changes nothing ([section 6.1](#61-status)).
- `screenshot` is not marked idempotent because each call mints a new frame and
  supersedes the previous one. It is open-world because the image shows
  whatever any app put on the screen, which the caller treats as untrusted.
- `pointer` and `keyboard` are idempotent because `operation_id` is a required
  argument: the same arguments are performed once.
- `lease` is not read-only: it changes who holds the lease, and a release
  aborts the effect that is executing under it. It is not marked idempotent
  because it has no `operation_id` and a repeated `acquire` moves the expiry.
  It never touches the desktop itself, so it is neither destructive nor
  open-world.
- The "Kind" column is this contract's classification. A caller keeps its own
  table and MUST NOT rely on the annotations. In that table `lease` is an
  effect, as any tool outside the shared contract's three reads is
  (amendment 4).

### 3.3 `tools/call`

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "pointer",
    "arguments": { "...": "..." },
    "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }
  }
}
```

`params.arguments` MAY be omitted for a tool with no required argument, and is
then `{}`.

Every result has the same four members:

```json
{
  "resultType": "complete",
  "content": [{ "type": "text", "text": "<JSON of structuredContent>" }],
  "structuredContent": { "...": "..." },
  "isError": false
}
```

- `structuredContent` is always present and conforms to the tool's output
  schema. A caller reads results from here.
- `isError` is always present. It is `true` exactly when `structuredContent`
  is a `tool_error`.
- `content` ends with exactly one text block whose text is a JSON serialization
  of `structuredContent`. It exists for clients that cannot read
  `structuredContent`. Its byte layout is not specified.
- A successful `screenshot` puts one image block before the text block:
  `{"type": "image", "data": "<base64>", "mimeType": "image/jpeg"}`. No other
  result carries an image.

Whole request and response messages for `server/discover` and `tools/call`,
and the JSON-RPC errors of [section 9.4](#94-json-rpc-errors), are in
`docs/schemas/examples/wire/`. Every request there carries
`params._meta["io.modelcontextprotocol/protocolVersion"]`. There is a
`tools/list` request but no response example, because the response is the six
schema pairs after the rule in [section 3.2](#32-toolslist).

## 4. Handles and scoping

deskhand keys every handle by (principal, `holder_id`). A handle presented
under a different principal or a different `holder_id` does not exist as far as
deskhand is concerned. Handles are not authentication: knowing one grants
nothing without the certificate and the token.

### 4.1 `holder_id`

- Assigned by the caller. 1 to 128 characters from `A-Z a-z 0-9 . _ : -`.
- It names the lease holder. `screenshot`, `pointer`, `keyboard` and `lease`
  require it. `status` takes it as an option.
- deskhand never returns a `holder_id` in any result. A caller learns whether
  the holder it named holds the lease, and nothing about any other holder
  ([section 5.4](#54-what-status-shows)).
- A Crew installation that is restored from a backup MUST choose a new
  `holder_id`, so that it cannot mistake an old lease for its own.

### 4.2 `frame_id`

- Minted by `screenshot`. Opaque. deskhand mints `frm_` followed by 22
  base64url characters (128 random bits). Callers accept any 1 to 64
  characters from `A-Z a-z 0-9 _ -`.
- One frame covers one display, or a region of one display.
- A frame belongs to the (principal, `holder_id`) that took it. Taking a
  screenshot does not require the lease.
- "Latest" is judged per (principal, `holder_id`, `display_id`). A screenshot
  taken under one `holder_id` never makes another holder's frame stale. The
  shared contract says "not the latest for that display"; the narrowing to
  one holder is clarification 1 in
  [section 17.5](#175-clarifications).
- Every effect call names a `frame_id`. deskhand refuses it with `stale_frame`
  under the rules in [section 8.3](#83-frame-staleness).
- Frames do not survive a restart or any change of state away from `ok`.

### 4.3 `operation_id`

- Supplied by the caller on every effect call. Crew sends its own call ID, so
  the two action logs can be joined. 1 to 128 characters from
  `A-Z a-z 0-9 . _ : -`.
- The record key is (principal, `holder_id`, `operation_id`).
- An operation record is created only when a call is **admitted**, which means
  it passed every check in [section 9.5](#95-order-of-refusals). A call that is
  refused before admission posts nothing and leaves no record, so the same
  `operation_id` can be sent again later and is then judged afresh.
- Admission is atomic. One effect call at a time is being admitted or is
  executing on a Mac, so two calls with the same `operation_id` can never both
  be admitted ([section 9.5](#95-order-of-refusals)).
- Lifecycle: `accepted` → `executing` → `completed`, `aborted` or `failed`. A
  restart turns `accepted` into `failed_before_execution` and `executing` into
  `aborted_by_restart`.
- Each record stores a keyed digest (HMAC-SHA-256,
  [section 12.1](#121-records)) of the canonical request: the JSON object
  `{"name": <tool name>, "arguments": <arguments as received>}` in RFC 8785
  canonical form. Defaults are not filled in first, so a caller that repeats a
  call MUST send the same arguments, not an equivalent spelling.
- `status` with an `operation` argument looks a record up without executing
  anything ([section 6.1](#61-status)). That is how a caller learns what
  became of a call whose response it lost
  ([section 12.5](#125-repeats-and-stored-results)).

What a call with an `operation_id` that already has a record returns:

| Record | Same digest | Different digest |
| --- | --- | --- |
| none yet: the first call is still being admitted | `operation_in_progress` | `operation_id_conflict` |
| `accepted` or `executing` | `operation_in_progress` | `operation_id_conflict` |
| `completed` | the stored success, with `replayed: true` | `operation_id_conflict` |
| `aborted` or `failed` | the stored error, with `replayed: true` and `current_state` | `operation_id_conflict` |
| `aborted_by_restart` | `interrupted`, `operation.status` `aborted_by_restart` | `operation_id_conflict` |
| `failed_before_execution` | `interrupted`, `operation.status` `failed_before_execution` | `operation_id_conflict` |

A replay never posts input. It is answered before any lease or frame check,
but only while the state is `ok`, and only when no other effect call is being
admitted or is executing: until that call is over a repeat gets `busy`.
`operation_in_progress` and `operation_id_conflict` carry `operation` (the
record's status and events posted so far) but never the stored result. For a
first call that is still being admitted they carry `operation` with `status`
`accepted` and `events_posted` 0, although no record exists yet. If that
first call is then refused, no record is kept.

While the state is not `ok`, the shared contract's rule holds for repeats too:
the call fails with the state's name. deskhand then adds `operation` when a
record exists for the `operation_id`, so the caller still learns whether input
went out, but it does not return the stored result until the state is `ok`
again.

Results and input:

- `completed`: every event of the action was posted.
- `aborted`: deskhand stopped part-way and released every key and button the
  operation had pressed. `operation.events_posted` says how many events went
  out. Input that was posted cannot be undone.
- `failed`: an internal fault after admission. `events_posted` is reported the
  same way.
- When the caller closes the connection mid-call, the operation is aborted and
  recorded with code `cancelled`. Repeating the `operation_id` returns it.
- A call whose connection closes before it is admitted is dropped. Nothing is
  posted and no record is kept.

Records are kept for a configured window and up to a configured number per
principal. The defaults are 24 hours and 10,000, and `status.limits` reports
the values in force (`operation_retention_ms`, `operation_max_records`). A
record inside the window is never evicted; at the cap a new `operation_id` is
refused with `operation_capacity`. A caller MUST NOT repeat an `operation_id`
after the window.

Persistence, write ordering, aborts and restart recovery are in
[section 12](#12-operation-outcome-model).

## 5. Lease

deskhand owns one lease per Mac. One holder drives the desktop at a time. The
lease is managed with a sixth tool, `lease` (amendment 4,
[section 17.4](#174-amendment-4-the-lease-tool)). Effect calls name the holder
with `holder_id` and never acquire or renew the lease themselves. `status`
never changes the lease.

Schemas: `tools/lease.input.json`, `tools/lease.output.json`.

### 5.1 Operations

`lease` arguments: `{"op": ..., "holder_id": ..., "ttl_ms": ...}`. `op` and
`holder_id` are required.

- `ttl_ms` is 5,000 to 120,000 and defaults to 30,000. A value outside the
  range is `invalid_argument`; deskhand does not clamp it.
- `ttl_ms` belongs to `acquire` and `renew`. On `release` it MUST be absent,
  and a `release` that carries it is `invalid_argument` with
  `details.argument` `/ttl_ms`. The input schema is flat
  ([section 3.2](#32-toolslist)) and cannot state this rule, so deskhand
  checks it.
- `lease` has no `operation_id` and keeps no operation record. Repeating a
  lease call is safe: each `op` leads to the same holder state when it is
  sent twice.

| `op` | When no live lease | When the caller holds it | When another holder holds it |
| --- | --- | --- | --- |
| `acquire` | `acquired`; expires `ttl_ms` from now | `renewed`; expiry reset to `ttl_ms` from now | `refused`, `lease_held_by_other` |
| `renew` | `refused`, `lease_expired` if the caller's own lease was the last one and it ran out; otherwise `refused`, `lease_not_held` | `renewed`; expiry reset to `ttl_ms` from now | `refused`, `lease_held_by_other` |
| `release` | `not_held` (a no-op, so a repeated release is safe) | `released` | `refused`, `lease_held_by_other` |

The result has two members:

| Member | Meaning |
| --- | --- |
| `lease_result` | `{op, outcome}`, plus `code` exactly when `outcome` is `refused`, plus `expires_in_ms` exactly when `code` is `lease_held_by_other`: how long the other holder's lease still runs if it is not renewed. |
| `lease` | The lease as the named holder sees it after the operation ([section 5.4](#54-what-status-shows)). `held_by_caller` is `true` after `acquired` and `renewed` and `false` after every other outcome. |

A refused lease operation does **not** make the call an error. The result has
`isError: false`, `lease_result.outcome` is `refused` and the reason is in
`lease_result.code`. A caller MUST read `lease_result`. The only tool errors
of `lease` are `invalid_argument` and `internal_error`.

The schema ties the values together: `acquire` ends as `acquired`, `renewed`
or `refused`; `renew` as `renewed` or `refused`; `release` as `released`,
`not_held` or `refused`, and the only code a `release` can be refused with is
`lease_held_by_other`.

`renew` never acquires. A caller that believes it holds a lease it has lost
finds out on its next renewal.

### 5.2 Allowed states

`lease` answers in every state. It is never refused with a tool error that
carries a state's name, which is part of amendment 4: the shared contract's
rule that every tool except `status` fails with the state's name does not
apply to it in that form.

| State | `acquire`, `renew` | `release` |
| --- | --- | --- |
| `gated`, `paused`, `disarmed` | `refused` with the state's name in `lease_result.code` | allowed |
| every other state, including `ok` | allowed | allowed |

`gated`, `paused` and `disarmed` drop the lease when they begin, so no lease
exists in those states. In the other non-`ok` states a lease can be held and
renewed, although every effect call is refused with the state's name.

### 5.3 How a lease ends

| Cause | What the former holder's next effect call gets |
| --- | --- |
| `ttl_ms` ran out with no renewal | `lease_expired` |
| `release` | `lease_not_held` |
| State became `gated`, `paused` or `disarmed` | the state's name while it lasts, then `lease_not_held` |
| deskhand restarted | `lease_not_held` |
| Another holder acquired afterwards | `lease_held_by_other` |

`lease_expired` describes the most recent lease only. It is returned while no
lease is live and the last lease that existed belonged to the named holder and
ended by running out. It has no time limit of its own; it stops as soon as
anyone acquires the lease or deskhand restarts. In every other case with no
live lease the code is `lease_not_held`.

Whenever the lease ends, an effect that is executing under it is aborted and
its held input is released. The aborted call returns the code in the table.

### 5.4 What `status` shows

`status` reports the lease only as seen from a holder that the call names.

| `status` call | `status.lease` |
| --- | --- |
| no `holder_id` argument | `null` |
| `holder_id` names the (principal, holder) that holds the live lease | `{held_by_caller: true, acquired_at, expires_at, expires_in_ms}` |
| `holder_id` names anyone else, or no lease is live | `{held_by_caller: false}` |

The `lease` member of a `lease` result has the same shape and is never
`null`, because that call always names a holder.

- No result carries a `holder_id`. deskhand never tells one caller the label
  of another. Crew shares one principal, and the label is the only thing
  that separates its internal callers. The schemas forbid a `holder_id`
  member in the lease view, in the `status` result and in the `lease`
  result.
- `{held_by_caller: false}` does not say whether the lease is free. A holder
  finds that out by calling `lease` with `acquire`, which answers
  `lease_held_by_other` and `expires_in_ms` when it is not.
- A caller SHOULD schedule renewal from `expires_in_ms` (for example at half
  of it), because its clock and the Mac's can differ.

Crew's executor owns the lease and is the only caller of `lease`. A `lease`
call is an effect in Crew's table, so it is never run as a read on a member's
behalf, and its arguments are never chosen by a model.

## 6. Tools

Arguments that do not match a tool's input schema are refused with
`invalid_argument`. Unknown arguments are refused, not ignored. Where a schema
says integer, a JSON number with a zero fraction such as `10.0` is an integer.
Strings with a restricted alphabet are checked over the whole string: a
trailing newline is a forbidden character, whatever the regex engine.

Success shapes are open: a later minor version may add members, and a caller
MUST ignore members it does not know. Enumerated values (`state`, `condition`,
error codes) only change with a new contract version.

### 6.1 `status`

Schemas: `tools/status.input.json`, `tools/status.output.json`.

`status` answers in every state and is never refused with a state's name. Its
only tool error is `invalid_argument` (and `internal_error`).

`status` is a pure read. It changes nothing, it never posts input, and it
does not touch the lease. Both arguments are optional:

| Argument | Rule |
| --- | --- |
| `holder_id` | Report the lease as seen from this holder ([section 5.4](#54-what-status-shows)). |
| `operation` | `{holder_id, operation_id}`, both required. Look up the operation record for (principal, `holder_id`, `operation_id`). Nothing is executed. |

The lookup answers in every state, is never held up by an executing effect,
does not need the lease and does not count toward the action ceiling. It
returns the record's `status` and `events_posted`, not the stored result. A
call with that key that is being admitted at that moment is reported as
`accepted` with 0 events.

`null` means "no record now": deskhand has no record for that key, and no
call with that key is inside the admission section at this moment. It says
nothing about a request that is still on its way to deskhand. A caller
treats `null` as final only when it has no request for that `operation_id`
still in transit ([section 12.5](#125-repeats-and-stored-results)).

| Member | Meaning |
| --- | --- |
| `contract_version` | `0.11-draft` for this document. |
| `mcp_protocol_version` | `2026-07-28`. |
| `server_version` | The deskhand build. |
| `mac` | This Mac's configured name. |
| `time` | deskhand's clock, for skew detection. |
| `started_at` | When this process started. A new value means every frame and the lease are gone. |
| `state` | The state with the highest precedence ([section 10](#10-states)). |
| `active_states` | Every state other than `ok` that holds now, in precedence order. Empty exactly when `state` is `ok`; otherwise its first item is `state`. The schema enforces both. |
| `conditions` | Active conditions that are not states ([section 11](#11-conditions-that-are-not-states)). |
| `armed_until` | When arming expires, or `null`. |
| `lease` | [Section 5.4](#54-what-status-shows). `null` exactly when the call named no `holder_id`. |
| `operation` | Present exactly when the call had an `operation` argument: `{status, events_posted}` of that record, or `null` when deskhand has no record for it now. No input has been posted for that `operation_id` so far, or its record has passed the retention window. When `null` is final is in [section 12.5](#125-repeats-and-stored-results). |
| `display_config_generation` | The current display configuration generation. |
| `limits` | The limits in force ([section 16](#16-constants)), including the configured ones. |

### 6.2 `displays`

Schemas: `tools/displays.input.json`, `tools/displays.output.json`. No
arguments.

Returns `display_config_generation` and one entry per active display:
`display_id`, `uuid`, `name`, `is_main`, `is_builtin`, `asleep`, `bounds`
(global points), `pixel_size` (native pixels) and `point_pixel_scale` (native
pixels per point). In a mirror set only the primary display is listed.

`display_id` is only meaningful within one `display_config_generation`. `uuid`
identifies the same physical display across reconfigurations.
`display_config_generation` increases every time the display arrangement, mode
or scale changes. It is strictly increasing within one deskhand run; callers
compare it for equality only.

### 6.3 `screenshot`

Schemas: `tools/screenshot.input.json`, `tools/screenshot.output.json`.

| Argument | Required | Default | Rule |
| --- | --- | --- | --- |
| `holder_id` | yes | | The frame is scoped to it. The lease is not required. |
| `display_id` | no | the main display | An ID that is not an active display is `invalid_argument`. |
| `region` | no | the whole display | Global points. Width and height at least 1. MUST lie entirely inside the display's bounds, otherwise `invalid_argument`. |
| `format` | no | `jpeg` | `jpeg` or `png`. |
| `max_long_edge` | no | 2576 | Integer, 256 to 2576. Anything else is `invalid_argument`. |

A region is aligned outward to whole native pixels and the result's
`capture_rect` reports what was captured. The pointer is never drawn into the
image; `pointer_position` reports where it was. Apps on the Mac's capture
exclusion list are absent from the image, and so are deskhand's own windows
([section 6.9](#69-app-policy)).

Result: the image block ([section 3.3](#33-toolscall)) and this metadata.

| Member | Meaning |
| --- | --- |
| `frame_id` | The handle for effect calls. |
| `sha256` | SHA-256, lowercase hex, of the encoded image bytes (the image block's `data` after base64 decoding). |
| `display_id`, `display_config_generation` | The display and the configuration it was captured under. |
| `capture_rect` | The captured rectangle in global points. The origin may be negative. |
| `source_pixel_size` | Size of `capture_rect` in native pixels. |
| `output_pixel_size` | Size of the returned image. This is the frame pixel space. Neither edge is over 2576. |
| `point_pixel_scale` | Native pixels per point. |
| `downscale` | The scale applied, in (0, 1]. |
| `format`, `mime_type`, `jpeg_quality`, `image_bytes` | The encoding. `jpeg_quality` is present for JPEG only. |
| `captured_at`, `max_age_ms` | The frame becomes `too_old` `max_age_ms` after `captured_at`. |
| `pointer_position` | Pointer location in frame pixels at capture, or `null` if outside. |
| `frontmost_app` | Bundle identifier, team identifier and name of the frontmost app at capture. When deskhand cannot determine a frontmost app, `bundle_id` and `team_id` are `null` and `name` is the empty string. |

Sizing and encoding are in [section 7](#7-screenshot-sizing-and-encoding).

### 6.4 `pointer`

Schemas: `tools/pointer.input.json`, `tools/pointer.output.json`.

Common arguments, all required: `holder_id`, `frame_id`, `operation_id`,
`action`. Optional: `permitted_apps`.

All coordinates are integers in the frame pixel space of `frame_id`
([section 8.2](#82-mapping-a-pointer-target)).

| `action.type` | Members | What deskhand posts |
| --- | --- | --- |
| `move` | `x`, `y` | Moves the pointer. Nothing is pressed. |
| `click` | `x`, `y`, `button` (`left`), `count` (1), `modifiers` (`[]`) | Moves, presses the modifiers, presses and releases `button` `count` times as one multi-click, releases the modifiers. `count` is 1, 2 or 3. |
| `drag` | `path`, `button` (`left`), `modifiers` (`[]`), `duration_ms` (500) | Moves to `path[0]`, presses the modifiers, presses `button`, moves through every later point in order, taking at least `duration_ms`, releases `button` at the last point, releases the modifiers. `path` has 2 to 32 points. `duration_ms` is 50 to 5000. |
| `scroll` | `x`, `y`, `dx` (0), `dy` (0), `modifiers` (`[]`) | Moves, presses the modifiers, scrolls, releases the modifiers. At least one of `dx`, `dy` is non-zero. Each is -10,000 to 10,000. |

Defaults are in parentheses. `button` is `left`, `right` or `middle`.
`modifiers` is a set drawn from `control`, `option`, `shift`, `command`.

- **Scroll direction.** Positive `dy` reveals content further down. Positive
  `dx` reveals content further right. This does not depend on the Mac's
  "natural scrolling" setting. Deltas are in frame pixels and are converted to
  points with the frame's ratio. The contract fixes the direction; how far an
  app actually scrolls is up to the app.
- **Press and hold.** A `drag` whose two points are equal holds the button at
  that point for `duration_ms`.
- **`duration_ms` is a minimum.** It is the least time from button down to
  button up. deskhand moves the pointer at most 8 frame pixels per event and
  checks the window under each point before it moves there
  ([section 6.9](#69-app-policy)), so a long path takes as long as those
  checks need. The bounds of [section 13](#13-timing-bounds) hold for the
  whole drag, however long it takes.
- **No input is held between calls.** There is no separate press or release
  action in v0. See [section 6.6](#66-held-input).

### 6.5 `keyboard`

Schemas: `tools/keyboard.input.json`, `tools/keyboard.output.json`.

Common arguments are the same as for `pointer`. `frame_id` names the frame the
caller was looking at when it decided to type.

| `action.type` | Members | What deskhand posts |
| --- | --- | --- |
| `type` | `text` | Types the text as Unicode input. The keyboard layout does not matter and no shortcut is triggered. |
| `press` | `key`, `modifiers` (`[]`), `hold_ms` (0) | Presses the modifiers, presses `key`, waits `hold_ms`, releases `key`, releases the modifiers. With modifiers this is a chord. `hold_ms` is 0 to 5000. Key repeat is not synthesized. |

- `text` is 1 to 1024 Unicode code points. It MUST NOT contain a C0 or C1
  control character (U+0000 to U+001F, U+007F to U+009F), U+2028 or U+2029.
  Newline and tab are therefore refused with `invalid_argument`; send them as
  `press` with `return` or `tab`, so an approval card can show them.
- `key` is one of the names in `defs.json#/$defs/key`: `a` to `z`, `0` to `9`,
  the punctuation keys ``- = [ ] \ ; ' , . / ` ``, `return`, `tab`, `space`,
  `delete` (backspace), `forward_delete`, `escape`, `up`, `down`, `left`,
  `right`, `home`, `end`, `page_up`, `page_down`, and `f1` to `f12`.
- A character key names the key that produces that character, unshifted, in
  the active keyboard layout. If the layout has no such key the call is
  `invalid_argument`. A shifted character is the base key plus `shift`.
- Every `press` is checked against the Mac's denied global shortcut list: a
  key or a chord, so a bare key such as `f11` can be denied too. A match is
  refused with `denied_shortcut` ([section 6.9](#69-app-policy)).
- Modifier-only presses and chords of several non-modifier keys are not in v0.

### 6.6 Held input

Inside one action, deskhand holds exactly this input:

| Action | Held | Released |
| --- | --- | --- |
| `pointer` `move`; `keyboard` `type` | nothing beyond each event pair | |
| `pointer` `click`, `scroll` | the modifiers | after the last click or scroll event |
| `pointer` `drag` | the modifiers and the button, for at least `duration_ms` | at the last point |
| `keyboard` `press` | the modifiers and the key, for `hold_ms` | after `hold_ms` |

Modifiers are pressed in the order `control`, `option`, `shift`, `command` and
released in the reverse order, whatever order the array lists them in.

An operation never reaches a final state with input still down. On an abort
deskhand releases what the operation pressed before it answers. The one
exception is a release that cannot be posted yet; deskhand then reports the
`cleanup_pending` condition and refuses effects until it has released
([section 12](#12-operation-outcome-model)).

### 6.7 Effect results

`pointer` and `keyboard` share one success shape,
`defs.json#/$defs/effect_result`:

| Member | Meaning |
| --- | --- |
| `operation_id`, `frame_id` | Echoed. |
| `status` | Always `completed`. |
| `events_posted` | Number of input events posted. |
| `replayed` | `true` when this is the stored result of an earlier call. |
| `measured` | Facts deskhand measured at the last look, the app-policy check immediately before the first event ([section 12.3](#123-write-ordering)). |
| `completed_at` | When the last event was posted. |

`measured` holds `frontmost_app`, `target_app`, `window_title`, `global_point`
and `measured_at`, and `drag_end` for a `drag`.

| Member | `pointer` | `keyboard` |
| --- | --- | --- |
| `frontmost_app` | The frontmost app. | The frontmost app. |
| `target_app` | The app that owns the topmost window under the first target point. | The app that owns keyboard focus. |
| `window_title` | The title of that window. | The title of the focused window of the app that owns keyboard focus. |
| `global_point` | Where the first target point mapped. | `null`. |
| `drag_end` | `drag` only: `target_app`, `window_title` and `global_point` for the last point of `path`. | absent. |

- On a success `frontmost_app`, `target_app` and `drag_end.target_app`
  always carry a `bundle_id`, and for `pointer` `global_point` is never
  `null`. The schemas enforce this. A call for which deskhand could not
  measure them is refused ([section 6.9](#69-app-policy)).
- `window_title` is `null` when the window has no title, on every
  `denied_app`, and whenever the app is on the Mac's capture exclusion list.
  A title that the frame hides is never sent on the wire. The same rules
  cover `drag_end.window_title`.
- `drag_end` is present whenever `measured` is present for a `drag`, with one
  exception: a `denied_app` never has it, because `measured` then describes
  only the check that failed. The schema enforces the exception.
- Titles are cut to 512 Unicode scalar values. That is what the schema's
  `maxLength` counts; a cut by grapheme clusters could exceed it.

deskhand runs the app-policy check three times or more: before admission
(step 14 of [section 9.5](#95-order-of-refusals)), at the last look
immediately before the first event, and before every later event
([section 12.3](#123-write-ordering)). Which of them `measured` comes from
depends on the result:

| Result | `measured` is taken at |
| --- | --- |
| A success, and every error of an admitted call other than `denied_app` and `interrupted` | The last look. It shows what was true when the first event went out, or was about to. The last look takes these facts even when it fails for another cause. |
| `log_unavailable` | Step 14. The call was refused before admission and never reached the last look. |
| `denied_app`, before or after admission | The check that failed. `target_app` is the app that caused the refusal and `global_point` is the point that was being checked. |

`measured` is therefore present on `denied_app`, on `log_unavailable`, and on
the result of every admitted call, success or error, including a replay of
it. The one exception is `interrupted`: that result is built from the record
after a restart and has no `measured`. No other response has it.

### 6.8 `permitted_apps`

An effect call MAY carry `permitted_apps`, a list of 1 to 64 distinct bundle
identifiers (each 1 to 255 characters from `A-Z a-z 0-9 . _ -`, compared
exactly). When present, every app that the app-policy check measures
([section 6.9](#69-app-policy)) MUST have its bundle identifier on this list,
as well as being allowed by the Mac's own policy. Otherwise the call is
refused with `denied_app` and `details.denied_by` is `permitted_apps`. The
list can only narrow the Mac's policy. It lets a Crew session say "only these
apps" and have deskhand enforce it against what it measures at the moment of
the effect.

### 6.9 App policy

The app policy keeps an agent away from sensitive apps. It is not a sandbox.
It is deny-by-default: an app is allowed only if the Mac's configuration
allows it. Every refusal under this section is `denied_app` with
`details.denied_by` `policy`, unless it says otherwise.

**Identity.** An app is identified by the pair (bundle identifier,
code-signing team identifier), read from the running process's code
signature. An allowlist entry names both, and both must match.

- Software that Apple signs as part of macOS has no team identifier. Its
  `team_id` is `null` on the wire, and an allowlist entry must say that it
  means Apple's own signature. The spike confirms how deskhand reads this.
- An app is never allowed when it has no bundle identifier, when it is
  unsigned or ad-hoc signed, when its signature is not valid, or when its
  team does not match the entry.
- deskhand's own bundle is never allowed, whatever the configuration says:
  not as the frontmost app, not as the owner of a window and not as the
  owner of keyboard focus.

**What is checked.**

| Tool | Apps that must be allowed |
| --- | --- |
| `pointer` and `keyboard` | The frontmost app. |
| `pointer` `move`, `click`, `scroll` | The app that owns the topmost window under the target. |
| `pointer` `drag` | The app that owns the topmost window under every sampled point of the path (see "Drag" below). |
| `keyboard` | The app that owns keyboard focus. A panel of another process can take keystrokes while the frontmost app stays the same (a launcher, a notification's reply field). The signal is the accessibility focused application, confirmed by the spike. |

**Uncertainty refuses.** If any check is uncertain, deskhand refuses. Each of
these is `denied_app` with `details.denied_by` `policy`:

- the frontmost app cannot be determined, or its identity cannot be read;
- no window is found under a checked point, or the owner of the topmost one
  cannot be determined. The menu bar, the Dock and the desktop are windows of
  system processes, and those processes are denied unless they are
  allowlisted;
- the owner of keyboard focus cannot be read.

`measured` then reports what deskhand has. An app it could not determine is
`{"bundle_id": null, "team_id": null, "name": ""}`.

**The menu bar is a spike item.** An allowlist entry names a bundle
identifier, so a process that has none can never be allowlisted. If the
process that owns the menu bar window has none on the installed macOS, a
click on an allowed app's own menu titles is always `denied_app`. That fails
closed, so it is not a safety problem, but it would put menu titles out of
reach of `pointer`. The spike (deskhand-r-waw0) records which process owns
the menu bar, the Dock and the desktop, and whether each has a bundle
identifier. If the menu bar's owner has none, v1.0 either says that menu
titles are out of reach in v0 or defines the owner of a menu-bar point as
the frontmost app. Until then the rule above stands.

The other checks fail closed in the same way. A target patch that cannot be
captured again is `stale_frame` with reason `pixels_changed`
([section 8.4](#84-target-patch-check)). An idle signal that cannot be read,
or that cannot be told apart from deskhand's own events, counts as
`user_active` ([section 13.2](#132-the-person-at-the-mac)).

**deskhand's own windows.** deskhand's menu bar item, its menus, its arming
window and its indicator belong to deskhand's bundle, which is always denied.

- They are left out of every frame and out of every patch comparison, like
  an app on the capture exclusion list.
- The indicator ignores pointer events and is skipped when deskhand looks for
  the topmost window under a point. Every other deskhand window under a point
  refuses the call.
- Arming cannot be done by posted input
  ([section 10.4](#104-gated-paused-and-disarmed)).

**Drag.** A drag is checked along its whole path, not only at its ends.

- Before admission (step 14 of [section 9.5](#95-order-of-refusals)) deskhand
  samples every segment of `path` at steps of at most 8 frame pixels
  (`DRAG_POLICY_SAMPLE_PX`), including every point of `path`, and checks the
  owner of the topmost window under each sample.
- During the drag it never moves the pointer more than 8 frame pixels in one
  event. Before each move it checks the frontmost app and the owner of the
  topmost window under the point it is about to move to. If that check
  fails, the pointer does not move there: the drag is aborted with
  `denied_app` while the pointer is still over an allowed window.
- These checks take time, so `duration_ms` is a minimum
  ([section 6.4](#64-pointer)). A long path takes longer.
- The window that carries the drag image follows the pointer and is not the
  drop target, so the check under the next point looks through it. How
  deskhand recognizes that window is chosen by the spike. A window that it
  cannot recognize as a drag image is treated like any other window, so the
  check still fails closed.
- The release that ends a drag, completed or aborted, is posted where the
  pointer is. A release never moves the pointer.
- On `denied_app`, `details.point_index` names the point of `path` that the
  pointer was at or was heading for: 0 for the first point, otherwise the
  index of the point that ends the segment being checked. For `move`,
  `click` and `scroll` it is 0. It is absent when the refusal did not come
  from a point: the frontmost app, or keyboard focus.

**Denied global shortcuts.** A `keyboard` `press` is refused with
`denied_shortcut` when its key and modifiers are on the Mac's denied shortcut
list. The list is configured per Mac. Its default is:

| Shortcut | What it would do |
| --- | --- |
| `command+space`, `control+space` | Spotlight, input source switching. |
| `command+tab` | Switch app. |
| `option+command+escape` | Force Quit. |
| `control+up`, `control+down`, `control+left`, `control+right` | Mission Control and switching Spaces. |
| `shift+command+3`, `shift+command+4`, `shift+command+5` | Screenshots and screen recording. |
| `control+f1` to `control+f8` | Keyboard access and moving keyboard focus: `control+f2` to the menu bar, `control+f3` to the Dock, `control+f8` to the status menus. |
| `f11` | Show Desktop. |
| `command+f5`, `option+command+8` | VoiceOver, zoom. |
| `control+command+q`, `shift+command+q` | Lock the screen, log out. |

- The rule covers a key or a chord. An entry with no modifier, such as `f11`,
  denies the bare key.
- **Supersets are denied too.** A press whose key equals an entry's key and
  whose modifiers include all of that entry's modifiers is denied. So
  `shift+command+tab` and `control+shift+command+4` are denied by the
  entries above, and `f11` is denied with any modifiers. This fails closed:
  it can refuse a harmless chord, and it cannot let a listed one through.
- The focus-moving entries matter because they move keyboard focus to the
  menu bar, the Dock or a status menu, where deskhand's own menu is, without
  changing the frontmost app.
- `details.shortcut` names the press as it was sent
  ([section 9.2](#92-the-tool_error-shape)).

**What a refusal costs.** A call that is refused with `denied_app` or
`denied_shortcut` before admission counts toward the action ceiling
([section 9.5](#95-order-of-refusals)), so the policy cannot be probed
without limit.

## 7. Screenshot sizing and encoding

Constants: `MAX_LONG_EDGE` = 2576, `MIN_LONG_EDGE` = 256,
`MAX_VISUAL_TOKENS` = 4784, `MAX_PIXELS` = 3,588,000, `MAX_IMAGE_BYTES` =
3,750,000, JPEG quality steps 85, 75, 65, 60.

**The provider's cap.** A model provider accepts an image whose long edge is
at most 2576 px and which costs at most `MAX_VISUAL_TOKENS` = 4784 visual
tokens. The figure "about 3.75 megapixels" that goes with it is an
approximation of that token cap, not a pixel cap. An image over the cap in a
tool result is rejected, not shrunk. deskhand enforces the token cap through
a pixel cap that is safe under both ways of counting tokens:

```text
MAX_PIXELS = MAX_VISUAL_TOKENS * 750 = 4784 * 750 = 3,588,000

by area:     tokens = w * h / 750
             w * h <= 3,588,000  gives  tokens <= 4784

by patches:  tokens = ceil(w / 28) * ceil(h / 28)
                    <= (w / 28 + 1) * (h / 28 + 1)
                    =  (w * h + 28 * (w + h) + 784) / 784
             with w * h <= 3,588,000 and both edges <= 2576, w + h is
             largest at 2576 + 3,588,000 / 2576 = 3968.9, so
             tokens <= (3,588,000 + 28 * 3968.9 + 784) / 784 = 4719.3
```

So every size that passes the rule below costs at most 4784 tokens, whatever
its aspect ratio. Over all sizes the rule can produce, the largest patch
count is 4704 (1541 × 2328).

**Size.** Let `w` and `h` be the source pixel size, `L` the requested
`max_long_edge` (2576 if omitted), and all arithmetic IEEE 754 double:

```text
scale = min(1, L / max(w, h), sqrt(MAX_PIXELS / (w * h)))
out_w = max(1, floor(w * scale))
out_h = max(1, floor(h * scale))
while out_w * out_h > MAX_PIXELS or max(out_w, out_h) > L:
    decrement the longer of out_w, out_h by 1   (out_w on a tie)
```

The loop only guards against floating-point rounding. `downscale` reports
`scale`. deskhand never upscales and never returns an image that breaks either
limit.

| Source | `max_long_edge` | Output | Pixels | Tokens by area | Tokens by patches |
| --- | --- | --- | --- | --- | --- |
| 3456 × 2234 | 2576 | 2355 × 1522 | 3,584,310 | 4779.1 | 85 × 55 = 4675 |
| 3024 × 1964 | 2576 | 2350 × 1526 | 3,586,100 | 4781.5 | 84 × 55 = 4620 |
| 5120 × 2880 | 2576 | 2525 × 1420 | 3,585,500 | 4780.7 | 91 × 51 = 4641 |
| 2560 × 1440 | 2576 | 2525 × 1420 | 3,585,500 | 4780.7 | 91 × 51 = 4641 |
| 3456 × 2234 | 1568 | 1568 × 1013 | 1,588,384 | 2117.8 | 56 × 37 = 2072 |

The first two rows are the built-in panels of the two Macs. A 2560 × 1440
display is now scaled slightly (by 0.9866), because its native 3,686,400
pixels are over the cap.

**Encoding.**

- `jpeg` (the default): encode at quality 85. If the result is over
  `MAX_IMAGE_BYTES`, encode again at 75, then 65, then 60, and return the first
  that fits. If quality 60 is still too large, refuse with `image_too_large`.
- `png`: encode once. If the result is over `MAX_IMAGE_BYTES`, refuse with
  `image_too_large`. deskhand does not switch format on its own.
- `image_too_large` mints no frame. Its `details` carry `image_bytes` and
  `max_image_bytes`. The caller retries with `jpeg` or a smaller
  `max_long_edge`.
- `MAX_IMAGE_BYTES` counts the encoded bytes before base64. Providers count
  the base64 text, and the strictest limit among them is 5 MB of it.
  3,750,000 bytes become exactly 5,000,000 base64 characters, so an image
  that deskhand returns fits every provider.
- Pixels are 8-bit sRGB with no alpha.

## 8. Coordinates and frame staleness

### 8.1 Coordinate spaces

Positions on the wire are in one of two spaces:

- **Global points:** `displays[].bounds`, the `region` argument,
  `capture_rect` and `measured.global_point`.
- **Frame pixels:** everything inside a `pointer` `action` (`x`, `y`, `path`,
  `dx`, `dy`) and `pointer_position`.

Sizes named `pixel_size` are counts of pixels, not positions:
`displays[].pixel_size` and `source_pixel_size` count native display pixels,
and `output_pixel_size` counts frame pixels.

### 8.2 Mapping a pointer target

For a target `(x, y)` in a frame with `capture_rect` `R` and
`output_pixel_size` `(W, H)`:

```text
global_x = R.x + (x + 0.5) * R.width  / W
global_y = R.y + (y + 0.5) * R.height / H
```

The target is the centre of the named pixel. The result is then clamped to the
bounds of the frame's display.

A target is in the frame when `0 <= x < W` and `0 <= y < H`. If any point of an
action is outside, the whole call is refused with `out_of_frame` before
anything is posted; `details.point_index` names the first such point (0 for
`move`, `click` and `scroll`). Integers outside -65,536 to 65,535 and
non-integers are `invalid_argument` instead.

Example: frame 2355 × 1522 of `capture_rect` `{0, 0, 1728, 1117}`. Target
`(1204, 778)` maps to global point `(883.811, 571.343)`.

### 8.3 Frame staleness

An effect call is refused with `stale_frame` when any of these holds. The
checks run in this order and `details.reason` names the first that fails.

| `reason` | Applies to | Condition |
| --- | --- | --- |
| `unknown` | both | deskhand has no such frame for this (principal, `holder_id`). It was never minted, or it was dropped by a restart or by a change of state away from `ok`. |
| `display_changed` | both | The current `display_config_generation` differs from the frame's. |
| `not_latest` | both | A newer frame exists for the same (principal, `holder_id`, `display_id`). |
| `too_old` | both | More than `max_age_ms` has passed since `captured_at`. |
| `frontmost_changed` | `keyboard` | The frontmost app is not the one recorded in the frame's `frontmost_app`. |
| `pixels_changed` | `pointer` | The target patch changed ([section 8.4](#84-target-patch-check)). |

Whatever the reason, the remedy is a new screenshot. A caller MUST NOT branch
on `reason`; deskhand MAY answer `unknown` for a frame it has discarded even if
a more specific reason once applied.

`max_age_ms` is `FRAME_MAX_AGE_MS`, configured per Mac between 5,000 and
600,000 with a default of 60,000. Each `screenshot` result and
`status.limits.frame_max_age_ms` report the value in force.

### 8.4 Target-patch check

Constants: `PATCH_SIZE` = 64 frame pixels, `PATCH_CHANNEL_TOLERANCE` = 16,
`PATCH_MAX_CHANGED_FRACTION` = 0.02, `PATCH_CHECK_MAX_AGE_MS` = 250.

deskhand keeps each live frame's output pixels (as captured, before encoding).
At step 13 of [section 9.5](#95-order-of-refusals) a `pointer` call checks
one patch for `move`, `click` and `scroll` (around the target) and two for
`drag` (around the first and the last point of `path`). Both are checked
before the button goes down, because the drag itself changes the screen.

- **The check must be fresh.** The first event is posted at most
  `PATCH_CHECK_MAX_AGE_MS` (250 ms) after the capture that the patch check
  used. Admission and two durable writes lie between the two
  ([section 12.3](#123-write-ordering)). If they take longer, deskhand posts
  nothing and ends the call with `stale_frame`, reason `pixels_changed`,
  `details.point_index` 0 and `operation.events_posted` 0.
- **A capture that fails is a changed patch.** If deskhand cannot capture the
  rectangle again, the call is refused with `stale_frame`, reason
  `pixels_changed`.
- **deskhand's own windows are left out** of the frame and of the new capture
  alike, so its indicator never makes a patch differ.

For a point `(x, y)` in a frame with `capture_rect` `R` and size `(W, H)`:

1. The patch is the pixel range `[x0, x1) × [y0, y1)` with
   `x0 = max(0, x - 32)`, `x1 = min(W, x + 32)`, `y0 = max(0, y - 32)`,
   `y1 = min(H, y + 32)`. It holds at most 64 × 64 pixels.
2. The patch covers this rectangle in global points:
   origin `(R.x + x0 * R.width / W, R.y + y0 * R.height / H)`, size
   `((x1 - x0) * R.width / W, (y1 - y0) * R.height / H)`.
3. deskhand captures at least that rectangle again, with the same app
   exclusions and no pointer, and scales it exactly as it scaled the frame, so
   that the new pixels line up with the frame's pixel grid. Capturing the
   whole `capture_rect` again and cutting the patch out of it is always
   correct.
4. A pixel has changed when any of its red, green or blue values differs from
   the frame's by more than 16 (on the 0 to 255 scale).
5. The patch has changed when the number of changed pixels is greater than
   0.02 times the number of pixels in the patch. The call is then refused with
   `stale_frame`, reason `pixels_changed`.

`details.point_index` names the point whose patch changed: 0 for `move`,
`click` and `scroll`; for `drag`, 0 if the first point's patch changed,
otherwise the index of the last point (`path` length minus 1). The first point
is checked first.

This check happens entirely inside deskhand, so two implementations need not
produce the same pixels. What the contract fixes is the region, the two
thresholds, and that both sets of pixels come from the same capture and
scaling path. An unchanged screen MUST yield no changed patch.

Why these values:

- 64 pixels is about 46 points on a Retina display at the default scale: one
  control and its surroundings. It catches a button that moved or a menu that
  opened, and ignores animation elsewhere on the screen.
- A tolerance of 16 absorbs resampling noise and translucency shimmer between
  two captures of an unchanged screen.
- 2% of a full patch is 82 pixels. A blinking text cursor changes a few dozen
  at most, so it does not make a text field stale; a control that changes
  state does.

## 9. Errors

### 9.1 Two kinds of error

- **Tool errors.** deskhand understood the request and refused or failed it.
  HTTP `200`, a normal JSON-RPC result, `isError: true`, and
  `structuredContent` is a `tool_error`. Every refusal a model should read and
  react to is of this kind, including every state, a stale frame and an
  invalid argument.
- **JSON-RPC errors.** The request was not a valid MCP call to an existing
  tool: transport, header, version and protocol faults, unknown methods and
  unknown tools. These have a numeric code ([section 9.4](#94-json-rpc-errors)).

### 9.2 The `tool_error` shape

Schema: `defs.json#/$defs/tool_error`.

| Member | Presence | Meaning |
| --- | --- | --- |
| `code` | always | One of the codes in [section 9.3](#93-tool-error-codes). |
| `message` | always | For people and models. Not stable. Never parse it. |
| `state` | always | The highest-precedence state when the error was produced. On a replay it is the state stored with the result, not the state now. |
| `operation_id` | effect tools, when it parsed | Echoed. |
| `operation` | effect tools, when a record exists for this `operation_id` | `{status, events_posted}`. Its presence means a call with this `operation_id` was admitted and input may have been posted. Its absence means nothing was ever posted for it. One exception: on `operation_in_progress` and `operation_id_conflict` it can describe a first call that is still being admitted (`accepted`, 0 events). |
| `replayed` | exactly on the result of an admitted call | `false` when the result is first returned, `true` when it is the stored result returned to a repeat. |
| `current_state` | exactly when `replayed` is `true` | The highest-precedence state when this response was produced. `state` says what held when the earlier call ended, and `current_state` says what holds now ([section 12.5](#125-repeats-and-stored-results)). |
| `retry_after_ms` | `rate_limited` | The earliest useful retry. |
| `measured` | `denied_app`, `log_unavailable`, and errors of admitted calls other than `interrupted` | [Section 6.7](#67-effect-results). |
| `details` | per code | See the table below. |

For the codes below, `details` and the listed members are always present. The
schema enforces this. Other codes have no `details`.

| Code | `details` members |
| --- | --- |
| `invalid_argument` | `argument` |
| `stale_frame` | `reason`; also `point_index` when the reason is `pixels_changed` |
| `out_of_frame` | `point_index`, `output_pixel_size` |
| `image_too_large` | `image_bytes`, `max_image_bytes` |
| `user_active` | `idle_ms`: milliseconds since the person's last input; 0 when deskhand could not read it |
| `denied_app` | `denied_by`: `policy` or `permitted_apps`; also `point_index` when a pointer target caused the refusal |
| `denied_shortcut` | `shortcut` |
| `lease_held_by_other` | `expires_in_ms` |

The schema also enforces these rules:

- A code that is not in the table never has `details`.
- When `code` is the name of a state, `state` is that same state. This holds
  on a replay too, because a replay keeps the stored `state`: a replayed
  `secure_input` abort has `state` `secure_input`, and the state now is in
  `current_state`.
- `current_state` is present exactly when `replayed` is `true`.
- `operation_in_progress`, `operation_id_conflict`, `interrupted` and
  `cancelled` always carry `operation_id` and `operation`. `interrupted` and
  `cancelled` always have `replayed` `true`.
- On `denied_app`, `measured.window_title` is `null` and `measured.drag_end`
  is absent.
- Each tool's output schema accepts only the codes that
  [section 9.3](#93-tool-error-codes) lists for that tool.

- `argument` is a JSON Pointer (RFC 6901) into `arguments`. It names the
  offending value, or the object that lacks a required member or has an
  unknown one. It is best effort: when deskhand cannot be more exact (for
  example an `action` that matches no shape) it names an enclosing object, at
  worst the whole of `arguments` with the empty pointer `""`. `message` says
  what is wrong.
- `shortcut` is the modifiers in the order `control`, `option`, `shift`,
  `command`, then the key, joined by `+`: for example `command+space` or
  `control+shift+a`.

### 9.3 Tool error codes

"Tools" says which tools can return the code; "effects" means `pointer` and
`keyboard`, and each tool's output schema accepts only its own codes.
"Posted" says whether the call that gets this code can itself have posted
input: *no* means never; *maybe* means that on an effect tool the code is
also used to end an admitted call part-way.

| Code | Tools | Posted | Meaning | What the caller does |
| --- | --- | --- | --- | --- |
| `gated` | all but `status` and `lease` | maybe | The LAN-gate allowance is missing, invalid or expired (amendment 2). | Wait for the Mac to be on the LAN. |
| `paused` | all but `status` and `lease` | maybe | The kill switch was used. | A person must arm deskhand again. |
| `disarmed` | all but `status` and `lease` | maybe | Not armed, or arming ran out. | A person must arm deskhand. |
| `not_console` | all but `status` and `lease` | maybe | deskhand's session does not own the console. | Wait. |
| `locked` | all but `status` and `lease` | maybe | The screen is locked. deskhand never unlocks. | Wait. |
| `display_asleep` | all but `status` and `lease` | maybe | The display is asleep. | Wait. |
| `permission_missing` | all but `status` and `lease` | maybe | A macOS permission is not granted. | A person must grant it. |
| `permission_stale` | all but `status` and `lease` | maybe | A permission needs to be confirmed again, or capture returns blank frames. | A person must confirm it. |
| `secure_input` | all but `status` and `lease` | maybe | Secure input is on (a password field has focus). | Wait. |
| `stale_frame` | effects | no | The frame can no longer be trusted ([section 8.3](#83-frame-staleness)). It can also end an admitted `pointer` call before its first event ([section 8.4](#84-target-patch-check)); `operation` is then present with 0 events. | Take a new screenshot. |
| `out_of_frame` | `pointer` | no | A target is outside the frame. | Fix the target. |
| `user_active` | effects | maybe | The person at the Mac used the keyboard or pointer within the last 3 s, or during the call, or deskhand could not tell. | Back off, then take a new screenshot. |
| `denied_app` | effects | maybe | The frontmost app, the app under a target or the app with keyboard focus is not allowed, or deskhand could not determine it ([section 6.9](#69-app-policy)). | Do not retry unchanged. |
| `denied_shortcut` | `keyboard` | no | The key or chord is a denied global shortcut. | Do not retry. |
| `rate_limited` | effects | no | The Mac's action ceiling for the last 60 s is reached ([section 9.5](#95-order-of-refusals)). | Retry after `retry_after_ms`. |
| `busy` | effects | no | Another effect call is being admitted or is executing. deskhand does not queue. | Retry shortly. |
| `lease_not_held` | effects | maybe | The named holder does not hold the lease. | Acquire the lease. |
| `lease_held_by_other` | effects | no | Another holder holds the lease. | Wait for it. |
| `lease_expired` | effects | maybe | The named holder's lease ran out. | Acquire again. |
| `invalid_argument` | all | no | Arguments break the schema or a rule in this document. | Fix the call. |
| `image_too_large` | `screenshot` | no | The encoded image is over 3,750,000 bytes. | Ask for `jpeg` or a smaller `max_long_edge`. |
| `operation_in_progress` | effects | no | An earlier call with the same `operation_id` is still being admitted or is executing. | Wait, then look the operation up with `status`, or repeat the call to get its result. |
| `operation_id_conflict` | effects | no | The `operation_id` was used before with different arguments. | A caller bug. Do not retry. |
| `operation_capacity` | effects | no | The principal's operation records inside the retention window are at the cap (10,000 in 24 h by default). | Wait. |
| `log_unavailable` | effects | no | The action log could not record the intent, so nothing was posted. | An operator must look. |
| `cleanup_pending` | effects | no | Input from an earlier operation still has to be released. | Wait. |
| `cancelled` | effects | no | The caller closed the connection during an earlier call with this `operation_id`. Seen only on a replay. | Treat as an aborted operation; see `operation`. |
| `interrupted` | effects | no | deskhand restarted during an earlier call with this `operation_id`. Seen only on a replay. | See `operation.status`. |
| `internal_error` | all | maybe | A fault inside deskhand. | Report it. Do not assume nothing was posted unless `operation` is absent. |

How to read `operation` on any error:

- `operation` describes the record for this `operation_id`, whichever call
  created it. If it is absent, no input was ever posted for this
  `operation_id`.
- If it is present, `operation.events_posted` events went out for this
  `operation_id`. Unless `operation.status` is `accepted` or `executing`, the
  operation is over and what it pressed has been released (or
  `cleanup_pending` is reported).
- Those events were posted by **this** call only when `replayed` is `false`.
  When `replayed` is `true` or absent (for example `operation_in_progress`,
  `operation_id_conflict`, or a state's name returned to a repeat) they were
  posted by the earlier call and this call posted nothing.

Lease refusals inside the `lease_result.code` of a `lease` result use the
same names but are not tool errors ([section 5.1](#51-operations)).

### 9.4 JSON-RPC errors

| Code | HTTP | When |
| --- | --- | --- |
| `-32700` Parse error | `400` | The body is not JSON, or it is not strict JSON outside `params.arguments`: a duplicate member name or a string that is not valid Unicode ([section 2.4](#24-order-of-checks-and-http-status-codes)). `id` is `null`. |
| `-32600` Invalid Request | `400` | Not a JSON-RPC 2.0 request or notification object, or a batch. |
| `-32601` Method not found | `404` | Any method other than `server/discover`, `tools/list`, `tools/call`. |
| `-32602` Invalid params | `400` | `params._meta["io.modelcontextprotocol/protocolVersion"]` is missing or is not a string. |
| `-32602` Invalid params | `200` | `tools/call` names a tool that does not exist (`"Unknown tool: <name>"`), or `arguments` is present and is not an object. |
| `-32603` Internal error | `200` | A fault before the tool was reached. |
| `-32020` Header mismatch | `400` | A required header is missing or malformed: `MCP-Protocol-Version`, `Mcp-Method`, or `Mcp-Name` on `tools/call`. Or `Mcp-Method` or `Mcp-Name` differs from the body, or the body's protocol version differs from the header. A `tools/call` whose `params.name` is missing or not a string lands here, because `Mcp-Name` cannot match it. |
| `-32022` Unsupported protocol version | `400` | `MCP-Protocol-Version` is well formed and is not `2026-07-28`. |

`error.data` MAY be `{"detail": "...", "header": "..."}`. It is for
diagnosis and is not stable.

The specification fixes `400` for `-32020`, `-32021` and `-32022`, `404` with
`-32601` for an unknown method, `400` with `-32602` for a missing required
`_meta` member, and `-32602` with the message `Unknown tool: <name>` for an
unknown tool. The HTTP status of the other rows is this contract's choice.
deskhand never sends `-32021` (it requires no client capability), and never
sends `-32002` or `-32042`, which this revision forbids.

An argument that has the wrong type or breaks a tool's input schema is **not**
`-32602`. It is the tool error `invalid_argument`, so the model can read it and
correct the call.

### 9.5 Order of refusals

When several refusals apply, deskhand returns the first in this order. The
state comes first for every tool except `status` and `lease`. The shared
contract requires that for every tool except `status`, and amendment 4 adds
`lease` to the exception.

`status` and `lease`: `invalid_argument` only. A lease operation that is
refused is not an error ([section 5.1](#51-operations)).

`displays` and `screenshot`:

1. The state's name, unless the state is `ok`.
2. `invalid_argument`.
3. `screenshot`: `image_too_large`.

`pointer` and `keyboard`:

1. The state's name, unless the state is `ok`.
2. `invalid_argument`. A duplicate member name or invalid Unicode inside
   `arguments` is found here, before the schema is applied
   ([section 2.4](#24-order-of-checks-and-http-status-codes)).
3. The admission section. If another effect call holds it:
   `operation_in_progress` or `operation_id_conflict` when that call has the
   same (principal, `holder_id`, `operation_id`), otherwise `busy`.
4. The operation record, if one exists for (principal, `holder_id`,
   `operation_id`): `operation_id_conflict` or a replay
   ([section 4.3](#43-operation_id)).
5. `cleanup_pending`.
6. `lease_held_by_other`, `lease_expired`, `lease_not_held`.
7. `rate_limited`.
8. `operation_capacity`.
9. `stale_frame` for every reason except `pixels_changed`.
10. `out_of_frame`.
11. `user_active`.
12. `denied_shortcut`.
13. `stale_frame` with reason `pixels_changed`.
14. `denied_app`. `measured` is taken at this step.
15. `log_unavailable`.

While the record file or the held-input ledger cannot be read or written,
every effect call that reaches step 4 fails there with `internal_error`
([section 12.3](#123-write-ordering)).

**The admission section.** Each Mac has one admission section, and one effect
call at a time is inside it. This is the single serial executor: deskhand
never queues an effect and never runs two.

- A call enters at step 3, by an atomic test-and-set. Nothing can come
  between the test and the claim.
- It stays inside through steps 4 to 15, the creation of its record, its
  execution and its final record write
  ([section 12.3](#123-write-ordering)). A call that is refused at steps 4
  to 15 leaves the section when it is refused.
- A call that arrives while the section is held does not wait. It gets
  `operation_in_progress` when the holder of the section has the same
  (principal, `holder_id`, `operation_id`) and the same digest,
  `operation_id_conflict` when it has the same key and a different digest,
  and `busy` in every other case. This holds across principals and holders.
- So the record lookup of step 4 and the creation of the record are never
  separated by another call's admission. A repeated `operation_id` is
  performed once, however close together the two calls arrive.
- A call whose connection is closed is never admitted. deskhand looks at the
  caller's connection when the call enters the section at step 3, and again
  immediately before it creates the record
  ([section 12.3](#123-write-ordering)). If the caller has closed it, the
  call leaves the section, posts nothing and leaves no record. Nobody is
  left to answer.
- `lease`, `status`, `displays` and `screenshot` do not enter the section and
  are never answered `busy`.

An error from step 1, 2, 3 or 4 carries `operation` whenever `holder_id` and
`operation_id` are well formed and a record exists for them. At step 3 it
also describes a call that is still being admitted
([section 4.3](#43-operation_id)). From step 5 on no record exists, so there
is no `operation`.

A call that passes all fifteen, and whose connection is still open, is
admitted: its record is created and execution starts. After that only an
abort or a fault can end it early, with the code of whatever caused it: a
state's name, `user_active`, `denied_app` (the app check is repeated before
every event, including the first), `stale_frame` (the patch check was too
old when the first event was due), `lease_expired` or `lease_not_held` (the
lease ended), `cancelled` (the caller hung up, so only a later repeat sees
it) or `internal_error`.

**The action ceiling.** Each Mac has one counter, across all principals and
all holders. Releasing the lease or changing `holder_id` does not reset it.

- It counts, over a sliding window of the last 60 s, every admitted call and
  every call that was refused before admission with `denied_app` or
  `denied_shortcut`. No other refusal counts, and a replay does not count.
- A call that reaches step 7 while the count is `ACTIONS_PER_MINUTE` or more
  is refused with `rate_limited`.
- `retry_after_ms` is the time until the oldest counted entry leaves the
  window: its time plus 60,000 ms, minus now.

## 10. States

Each blocking state is a fact about the Mac that either holds or does not.
Several can hold at once. deskhand's state is the one that holds with the
highest precedence, or `ok` when none holds. The names and their precedence,
highest first:

| Precedence | State | Holds while | Detected by | Drops the lease |
| --- | --- | --- | --- | --- |
| 1 | `gated` | The LAN-gate allowance is missing, invalid, not yet valid or expired. | The allowance file ([section 14](#14-allowance-file-format)). | yes |
| 2 | `paused` | The kill switch was used and nobody has armed deskhand since. | deskhand's own kill switch: the menu bar item or the global hot key. | yes |
| 3 | `disarmed` | deskhand is not armed. It starts this way, and returns to it when arming runs out, when a person disarms it, when the kill switch is used and, by default, when `gated` begins ([section 10.4](#104-gated-paused-and-disarmed)). | deskhand's own arming timer. | yes |
| 4 | `not_console` | deskhand's login session does not own the console: another account is in front, or the console shows the login window. | Platform console-ownership signal. For the login window: platform login-window signal, chosen by the spike. | no |
| 5 | `locked` | The screen of deskhand's session is locked. | Platform lock signal, chosen by the spike. | no |
| 6 | `display_asleep` | Any active display is asleep. | Platform display-sleep signal. | no |
| 7 | `permission_missing` | A macOS permission that deskhand needs to capture the screen or to post input is not granted. | Platform permission checks. The spike records which input permissions the installed macOS has. | no |
| 8 | `permission_stale` | A permission is granted on record but does not work: macOS wants screen-capture consent confirmed again, or capture returns blank frames. | Platform capture-health signal, chosen by the spike. | no |
| 9 | `secure_input` | Secure input is on. Normally a password field has focus. | Platform secure-input signal. | no |
| 10 | `ok` | None of the above holds. | | |

`status.state` is the active state with the highest precedence, and
`status.active_states` lists all of them. Every tool except `status` and
`lease` fails with the name of `status.state` unless it is `ok`. What `lease`
does in each state is in [section 5.2](#52-allowed-states).

`gated` is amendment 2 and is pending approval
([section 17](#17-changes-from-the-shared-contract)).

### 10.1 Detection

- This contract fixes what each state means. The macOS signal behind a state
  is an implementation matter. Where the table says "chosen by the spike",
  the spike (deskhand-r-waw0) picks the signal and records it in
  `docs/spike-results.md`. The other platform signals are the ones the
  project plan names, and the spike confirms them. Changing a signal does not
  change this contract.
- **Fail closed.** When a signal cannot be read, or its answer is uncertain,
  the state it feeds holds. An uncertain lock signal means `locked`. An
  uncertain capture check means `permission_stale`.
- `gated`, `paused` and `disarmed` need no platform signal. They come from
  the allowance file, the kill switch and the arming timer. `disarmed`
  begins at `status.armed_until` by deskhand's clock.
- deskhand starts `disarmed`. Neither arming nor `paused` is kept across a
  restart.
- The login window has no state of its own. It is reported as `not_console`
  together with the `login_window` condition
  ([section 11.4](#114-login_window)).
- No call can end a blocking state. A person at the Mac ends `paused` and
  `disarmed`, the LAN gate ends `gated`, and the Mac ends the rest. deskhand
  never unlocks a session.

### 10.2 What a blocking state refuses

| Request | While the state is not `ok` |
| --- | --- |
| `server/discover`, `tools/list` | Answered as usual. |
| `status` | Answered. It reports the state, and its operation lookup works as usual. |
| `lease` | Answered. `acquire` and `renew` are refused in `lease_result` while the state is `gated`, `paused` or `disarmed` ([section 5.2](#52-allowed-states)). `release` is always allowed. |
| `displays`, `screenshot` | Refused with the state's name. |
| `pointer`, `keyboard` | Refused with the state's name, before any other check ([section 9.5](#95-order-of-refusals)). Nothing is posted. |

### 10.3 Leaving `ok`

When the state changes from `ok` to any other state, deskhand does all of
this, whatever the new state is:

1. **It stops the calls in flight.** An executing effect is aborted with the
   new state's name ([section 12.4](#124-aborts)). A `displays` or
   `screenshot` call that has not answered yet is refused with the new
   state's name. A screenshot that was captured but not returned is
   discarded and mints no frame.
2. **It releases held input.** Every key and button the aborted effect
   pressed is released, if cleanup is authorized
   ([section 12.8](#128-cleanup-authorization)). If it is not, the releases
   wait and the `cleanup_pending` condition is reported.
3. **It invalidates every frame**, of every holder. An effect call that
   names one later gets `stale_frame` with reason `unknown`.

Operation records are kept. Input that was already posted stays posted.
How quickly this happens is in [section 13](#13-timing-bounds).

### 10.4 `gated`, `paused` and `disarmed`

These three also drop the lease, at the moment they begin and whatever state
deskhand was in before. No lease exists while any of them holds, and
`acquire` and `renew` are refused. What the former holder sees afterwards is
in [section 5.3](#53-how-a-lease-ends).

The other blocking states leave the lease alone. Its holder can keep
renewing it through a locked screen or a sleeping display, and it runs out
as usual if the holder does not.

**The kill switch.** Using it does three things at once: `paused` begins,
arming ends, and everything in [section 10.3](#103-leaving-ok) happens.
Because arming ends, `disarmed` holds as well: `status.active_states` then
lists both `paused` and `disarmed`, and `status.armed_until` is `null`.
`paused` ends only when a person at the Mac arms deskhand again, which ends
`disarmed` too. There is no way to resume without arming.

**Arming.** A person arms deskhand from the menu bar for a duration they
choose. `disarmed` begins again at `status.armed_until`, or sooner if the
person disarms it.

**Only a person arms.** Arming, extending the arming period and leaving
`paused` are acts of the person at the Mac. deskhand does not accept any of
them:

- from an input event that deskhand posted itself;
- while an operation is executing;
- within `USER_ACTIVITY_LOOKBACK_MS` (3 s) of the last event that deskhand
  posted.

Together with the rule that deskhand's own bundle is always a denied app
([section 6.9](#69-app-policy)), this keeps an agent from extending its own
arming. Disarming and the kill switch are never restricted in this way.

**`gated` ends arming.** By default, arming ends when `gated` begins:
`disarmed` then holds as well, `status.active_states` lists `gated` and
`disarmed`, and `status.armed_until` is `null`. When the allowance returns,
the state is `disarmed` until a person arms deskhand again. A Mac that left
the LAN has probably left with its owner, and it should not start driving
again by itself when it comes home.

This is the per-Mac setting `gated_ends_arming`, which is `true` by default.
Where it is `false`, `gated` and arming are independent: if the allowance
returns before arming runs out, the state can be `ok` again with nobody at
the Mac. The default is a decision for the owner to confirm
(Appendix A, item 27).

### 10.5 Returning to `ok`

Nothing is restored when the state becomes `ok` again.

- Every frame taken earlier is gone. The caller takes a new screenshot.
- If the lease was dropped, the caller acquires it again. If it was not, it
  is still held, unless it ran out in the meantime.
- A repeated `operation_id` returns its stored result again
  ([section 4.3](#43-operation_id)).
- Held input whose release had to wait is released first. Until it is,
  effect calls get `cleanup_pending`.

## 11. Conditions that are not states

A condition is a fact that `status` reports in `conditions`, beside the
state. A condition never changes `status.state`, never drops the lease and
never invalidates a frame. No condition refuses a read tool.

| Condition | Set while | Effect on calls |
| --- | --- | --- |
| `credentials_warning` | A replacement credential was rejected. | None on tool calls. |
| `cleanup_pending` | Input that deskhand pressed has still to be released. | Every effect call is refused with `cleanup_pending`. |
| `log_unavailable` | deskhand's last attempt to write to the action log failed. | An effect call whose intent entry cannot be written is refused with `log_unavailable`. |
| `login_window` | The console shows the login window. | None of its own: the state is `not_console`. It also blocks releases. |
| `user_active` | The person at the Mac used the keyboard or pointer within the last 3 s. | Effect calls are refused with `user_active`, and an executing effect is aborted with it. |

These five names are the only ones that can appear. Each appears at most
once, and the order carries no meaning. `cleanup_pending`, `log_unavailable`
and `user_active` are also error codes; as conditions they are advance
notice. A caller MAY read them to skip a call that would be refused. It MUST
still handle the error, because a condition can change between `status` and
the next call.

### 11.1 `credentials_warning`

deskhand reloads its server certificate, private key and bearer token when
their files change and when it receives `SIGHUP`. Before a new certificate
and key replace the old pair, all of this must be true:

- the key matches the certificate;
- the certificate chains to the private CA and is in date;
- its subject alternative names include every configured Service DNS name.

**Set** when a reload is rejected. deskhand keeps serving with the previous
pair and logs the reason, never the credential. **Cleared** by the next
reload that succeeds.

**Effect on calls:** none. It tells an operator that a rotation did not take
effect: the certificate in use is the old one, and it will run out.

A token file that is missing, unreadable or malformed after a change also
sets the condition, but the old token is not kept. No token is valid until
the file is fixed, and every request gets `401`
([section 2.4](#24-order-of-checks-and-http-status-codes)). The condition can
then only be seen on the Mac.

What a caller sees across a rotation that succeeds:

- New connections get the new certificate. Existing connections run until
  they close, which is at most 5 minutes later
  ([section 2.1](#21-endpoint)).
- The token is checked on every request. A replaced token stops working at
  once, unless the Mac is configured with an overlap window in which the
  previous token is also accepted. The default window is 0.
- The principal is the subject of the client certificate, compared as the
  RFC 4514 string of its DER encoding ([section 1](#1-terms)). Replacing the
  token, or rotating either certificate while the client's subject stays the
  same, keeps the lease, the frames and the operation records.
- A client certificate with a different subject is refused at the handshake
  until the Mac's expected client subject is changed to match
  ([section 2.2](#22-authentication)). After that change it is a different
  principal and sees none of them.

### 11.2 `cleanup_pending`

**Set** when deskhand owes a release it has not posted: the held-input
ledger ([section 12.7](#127-held-input-ledger)) has at least one entry and no
operation is executing. That happens when the releases of an abort had to
wait, when deskhand starts with entries left by the previous run, and when
posting a release failed. **Cleared** when the ledger is empty.

**Effect on calls:** every effect call is refused with `cleanup_pending`
(step 5 of [section 9.5](#95-order-of-refusals)). Read tools and lease
operations are not affected.

deskhand tries again on every change of state and at least once a second. No
call is needed to make it try. It posts the releases as soon as cleanup is
authorized ([section 12.8](#128-cleanup-authorization)).

Cleanup waits only while the screen is locked, the session is off the
console or secure input is on, and each of those is a state. So a caller
usually gets that state's name first. It sees the code `cleanup_pending`
only in the short time between the state ending and the releases going out,
or when a release keeps failing. `status.conditions` shows the condition in
every state.

### 11.3 `log_unavailable`

**Set** when deskhand's most recent attempt to reach the writer of the
action log failed: the connection was lost or refused, or an entry was not
committed. deskhand checks the writer when it starts and whenever the
connection drops, and keeps retrying on its own. **Cleared** when an attempt
succeeds.

**Effect on calls:** the condition itself refuses nothing. Every effect call
tries to commit its intent entry as the last step before admission (step 15
of [section 9.5](#95-order-of-refusals)). It is refused with
`log_unavailable` exactly when that fails, and then nothing is posted. Read
tools are not refused.

If the outcome entry cannot be written after an effect ran, the input is
already out. The call returns its true result, the condition is set, and the
operation record still holds the outcome. The action log then shows an
intent with no outcome.

### 11.4 `login_window`

**Set** while the console shows the login window, for example after someone
chose "Login Window" from the fast user switching menu. **Cleared** when it
no longer does.

The login window always means the state `not_console`, because deskhand's
session does not own the console then. If the console-ownership signal and
the login-window signal disagree, deskhand reports `not_console` anyway. A
Mac where nobody is logged in runs no deskhand and answers nothing
([section 2.1](#21-endpoint)).

**Effect on calls:** none of its own. Every tool except `status` and `lease`
is already refused with `not_console`, or with a state of higher precedence. The
condition tells the caller why, without an eleventh state. It also blocks
releases ([section 12.8](#128-cleanup-authorization)): deskhand posts no
input of any kind at the login window.

### 11.5 `user_active`

**Set** while the person at the Mac produced keyboard or pointer input less
than `USER_ACTIVITY_LOOKBACK_MS` ago ([section 16](#16-constants)).
**Cleared** once that long has passed with no such input. Input that
deskhand posted does not count. `status` evaluates the condition when it is
called. When deskhand cannot read the idle signal, or cannot tell the
person's input from its own, the condition is set
([section 13.2](#132-the-person-at-the-mac)).

**Effect on calls:**

- An effect call that would start executing while it is set is refused with
  `user_active` (step 11 of [section 9.5](#95-order-of-refusals)). Nothing
  is posted.
- An executing effect is aborted with `user_active` when the person uses
  the keyboard or pointer
  ([section 13.2](#132-the-person-at-the-mac)).
- Read tools are not refused. The lease is kept and frames stay valid. The
  person has probably changed the screen, so the caller SHOULD back off and
  then take a new screenshot.

`details.idle_ms` on the error is the time since the person's last input.

`user_active` is not a state because a person at the Mac does not make it
unusable: reads still work, nothing is dropped, and the refusal ends by
itself.

## 12. Operation outcome model

Every admitted effect call has one operation record. The record is what
makes a repeated `operation_id` safe, and what tells a caller after any
failure whether input reached the Mac. The wire-visible rules are in
[section 4.3](#43-operation_id) and [section 6.6](#66-held-input). This
section adds storage, write ordering, aborts and recovery.

**Input that has already been posted cannot be undone.** deskhand can stop,
and it can release what it is holding down. It cannot take back a click, a
typed character or a drop, and it does not try: it posts no compensating
input. Nothing in this section changes that.

### 12.1 Records

- The key is (principal, `holder_id`, `operation_id`).
- A record holds its status, `events_posted`, the request digest, the time
  of admission and, once the operation is over, the result that was
  returned.
- **Payload binding.** The digest is HMAC-SHA-256 over the bytes of the
  canonical request, keyed with a per-install key. The canonical request for
  the operation digest is RFC 8785 over `{name, arguments}` as received: the
  tool name plus its arguments, and no transport metadata (no header, no
  JSON-RPC `id`, no `_meta`). A repeated `operation_id` with a different
  digest gets `operation_id_conflict` and never executes. The digest is not
  returned on the wire.
- **The key.** deskhand generates 32 random bytes at first start and keeps
  them in a file that only its user can read or write. The key never leaves
  the Mac. A plain hash of short typed text could be guessed from the record
  file; a keyed one cannot. If the key file is lost, deskhand generates a
  new key and every stored digest stops matching, so a repeat of an old
  `operation_id` gets `operation_id_conflict`. That is the safe direction:
  nothing is executed twice.
- Arguments that RFC 8785 cannot canonicalize never reach this point. A
  duplicate member name or invalid Unicode is `invalid_argument`
  ([section 2.4](#24-order-of-checks-and-http-status-codes)).
- Records are kept in a file on the Mac that only deskhand's user can read
  or write. They survive a restart and a credential rotation
  ([section 11.1](#111-credentials_warning)).

### 12.2 Lifecycle

```text
accepted -> executing -> completed | aborted | failed
```

| Status | Meaning | Input posted |
| --- | --- | --- |
| `accepted` | The call was admitted. Nothing has been posted. | none |
| `executing` | deskhand is posting the action's events. | possibly some |
| `completed` | Every event of the action was posted, and everything it pressed was released. | all of it |
| `aborted` | deskhand stopped part-way for one of the causes in [section 12.4](#124-aborts). | `events_posted` events |
| `failed` | A fault inside deskhand ended the operation. | `events_posted` events |
| `failed_before_execution` | deskhand stopped or crashed while the record was `accepted`. | none |
| `aborted_by_restart` | deskhand stopped or crashed while the record was `executing`. | at least `events_posted` events |

`accepted` and `executing` are the only statuses that change. The other five
are final, and a final record is never rewritten.

`events_posted` counts synthetic input events: one pointer move, one button
press, one button release, one scroll, one key press or one key release each
count as one. Releases that deskhand posts to clean up after an abort are
not counted. This contract does not fix how many events an action takes (a
drag posts as many moves as it needs), so the count shows how far an action
got only roughly. Zero means that no input reached the Mac, except on
`aborted_by_restart`, where the count is a lower bound.

### 12.3 Write ordering

An effect call goes through these steps in this order.

1. Checks 1 to 14 of [section 9.5](#95-order-of-refusals) pass. From check 3
   on, the call holds the Mac's admission section.
2. The intent entry is committed to the action log (check 15). If it cannot
   be committed, the call is refused with `log_unavailable`, nothing is
   posted and no record exists.
3. deskhand looks at the caller's connection. If the caller has closed it,
   the call ends here: nothing is posted and no record is created. The
   action log gets a refusal entry with the outcome `cancelled`
   ([section 12.10](#1210-action-log-entries)), so the intent entry of step
   2 does not stand alone. Otherwise the record is created as `accepted`,
   and the call is now admitted.
4. The record is written as `executing` and flushed to stable storage
   (`fsync`). This happens before the first event is posted.
5. **The last look.** Immediately before the first event, with nothing
   between the check and the post, deskhand checks again:
   - the state is `ok`;
   - the deadline has not passed ([section 13.1](#131-the-deadline));
   - the person at the Mac is not active;
   - the app policy holds: the frontmost app, the app under the target for
     `pointer`, the owner of keyboard focus for `keyboard`
     ([section 6.9](#69-app-policy));
   - for `pointer`, the capture that the patch check used is at most
     `PATCH_CHECK_MAX_AGE_MS` (250 ms) old
     ([section 8.4](#84-target-patch-check));
   - the named holder still holds the lease;
   - the caller's connection is still open.

   If any of these fails, the operation is aborted with the code of the
   cause and `events_posted` 0. Nothing was posted. A closed connection is
   `cancelled`.
6. The events are posted. Before every event deskhand repeats the state,
   deadline, activity, app-policy, lease and connection checks of step 5
   ([section 12.4](#124-aborts)). For every event, the first included, the
   order is fixed:
   1. For a key-down or button-down event, the held-input ledger entry is
      written and flushed ([section 12.7](#127-held-input-ledger)).
   2. The checks run.
   3. The event is posted.

   Nothing lies between the checks and the post: no ledger write and no
   `fsync`. If the checks fail, the event is not posted, and the ledger
   entry that was written for it is cleared without a release. After each
   key-up or button-up event the matching entry is cleared and flushed.
7. When the action is over, or after an abort and its releases, the final
   status, `events_posted` and the result are written and flushed. The call
   then leaves the admission section.
8. The outcome entry is written to the action log.
9. The response is sent.

Steps 2 to 4 take time: a round trip to the log writer and two durable
writes. Step 5 exists because the checks of step 1 are that old by then. An
app that came to the front in between, or a person who touched the keyboard,
is seen at step 5 and gets no event.

deskhand never posts an event it could not first record. If a record or
ledger write fails, the event that the write was guarding is not posted, and
the operation ends as `failed` with `internal_error`. While the record file
or the ledger cannot be read or written, every effect call fails with
`internal_error` at step 4 of [section 9.5](#95-order-of-refusals) and
nothing is posted.

Because step 7 comes before step 9, a result that the caller received is the
result a later repeat returns.

### 12.4 Aborts

An executing operation ends early for one of these causes. The executor
looks for the first seven before every event, including the first, and
while it waits ([section 13](#13-timing-bounds)). The fourth applies to the
first event only.

| Cause | Code | `operation.status` |
| --- | --- | --- |
| The state left `ok`: kill switch, allowance gone, arming ran out, lock, console switch, display sleep, lost permission, secure input | the new state's name | `aborted` |
| The person at the Mac used the keyboard or pointer, or deskhand can no longer tell | `user_active` | `aborted` |
| The frontmost app, the app under the next point, or the owner of keyboard focus is not allowed or cannot be determined | `denied_app` | `aborted` |
| The patch check was more than 250 ms old when the first event was due (`pointer` only) | `stale_frame`, reason `pixels_changed` | `aborted`, 0 events |
| The lease ran out | `lease_expired` | `aborted` |
| The holder released the lease | `lease_not_held` | `aborted` |
| The caller closed the connection | `cancelled`, seen on a repeat | `aborted` |
| A fault inside deskhand | `internal_error` | `failed` |
| deskhand stopped or crashed | `interrupted`, seen on a repeat | `aborted_by_restart` |

When deskhand notices several causes at the same check, the code follows the
order of [section 9.5](#95-order-of-refusals), so a state's name comes
first.

On an abort deskhand does this, in order:

1. It stops. No further event of the action is posted.
2. It releases every key and button that the operation pressed and has not
   yet released, in the reverse of the order it pressed them, if cleanup is
   authorized ([section 12.8](#128-cleanup-authorization)). If it is not,
   the releases wait in the ledger and `cleanup_pending` is set.
3. It records `aborted` with the count of events posted, durably.
4. It writes the outcome to the action log.
5. It answers with the code of the cause.

What an abort leaves behind is whatever was posted before it. An aborted
`type` leaves the characters already typed. An aborted `click` may have
clicked. An aborted `drag` ends when its button is released, which drops
whatever was being dragged at the place the pointer had reached. The caller
takes a new screenshot to see where things stand.

**Where a release lands.** A button release is posted at the pointer's
current location. A release never moves the pointer: not the release that
ends an abort, not a deferred release and not a release after a restart
([section 12.8](#128-cleanup-authorization)). Because a drag checks the
window under each point before it moves there
([section 6.9](#69-app-policy)), the pointer of a drag that deskhand aborts
for `denied_app` is still over an allowed window, and that is where the drop
lands. A deferred release lands wherever the pointer is when cleanup runs.
deskhand cannot choose that place, and the app policy does not block a
release.

### 12.5 Repeats and stored results

The table in [section 4.3](#43-operation_id) says what a repeated
`operation_id` returns. Behind it:

- When an operation ends, deskhand stores the `structuredContent` it is
  about to return in the record, before it sends the response.
- A repeat with the same digest gets that stored result with `replayed` set
  to `true`. On a stored error, `code`, `state`, `operation`, `measured` and
  `details` are as stored. `state` is therefore the state that held when the
  earlier call ended, not the state now: a replayed `secure_input` abort
  still has `state` `secure_input`. `message` may be worded differently.
- A replayed error also gains `current_state`, the state at the moment of
  the replay. A stored result is only returned while the state is `ok`,
  because step 1 of [section 9.5](#95-order-of-refusals) comes before step
  4, so in this version `current_state` is always `ok`. A caller reads the
  member and does not assume its value.
- `interrupted` has no stored result. deskhand builds it from the record
  when the repeat arrives, so its `state` and its `current_state` are both
  the state at that moment.
- A stored success has no `state` and gains no `current_state`. `replayed`
  `true` is its only difference.
- A replay posts nothing, measures nothing, needs neither the lease nor a
  live frame, and does not count toward the action ceiling.
- While the first call is still being admitted, or is `accepted` or
  `executing`, a repeat gets `operation_in_progress` at once. It does not
  wait for the first call.
- While a different effect call holds the admission section, a repeat gets
  `busy` ([section 9.5](#95-order-of-refusals)).

**A lost response.** A caller that sent an effect call and got no response
does not know whether the call was admitted. It SHOULD ask with the
read-only lookup, `status` with `operation: {holder_id, operation_id}`
([section 6.1](#61-status)), and SHOULD NOT repeat the call to find out.

| Lookup result | Meaning |
| --- | --- |
| `operation` is `null` | No record now, and no call with this key is being admitted at this moment. No input has been posted for it so far. Whether that is final depends on the caller's own request: see "When `null` is final" below. |
| `status` `accepted` or `executing` | It is still being admitted or is running. Look again. A call that is still being admitted can yet be refused, and the next lookup is then `null`. |
| any final status | It is over. `events_posted` says how much went out. |

The lookup never executes anything, so it is safe in the one case where a
repeat is not: the first call was refused before admission (`busy`,
`rate_limited`, `stale_frame`) or was lost on the way. A repeat of that call
would be admitted as a new call and would post its input later, in a
different context. crew-r-yqso forbids exactly that: "never retried".

**When `null` is final.** The lookup cannot see a request that is still on
its way: one that the network is holding up, or one that deskhand has read
and has not yet brought to step 3 of
[section 9.5](#95-order-of-refusals). Such a request has no record, and it
can still be admitted after a lookup has answered `null`. So `null` by
itself means "no record now". A caller MUST NOT record "nothing was posted"
while a request of its own for that `operation_id` may still be in transit.

`null` is final once one of these is true of the caller's request for that
`operation_id`. Nothing will then be posted for it unless the caller sends
the call again.

- **The request completed.** The caller received its response.
- **Its connection is closed.** Closing the connection cancels the call
  ([section 2.1](#21-endpoint)), and deskhand never admits a call whose
  connection is closed. It looks at the connection when the call enters the
  admission section, again before it creates the record, and before every
  event ([section 12.3](#123-write-ordering)). So the caller closes the
  connection that carried the call first, and then looks the call up on
  another connection.
- **Its frame is no longer the latest.** After it sent the call and before
  the lookup, the caller received a new screenshot of the same display
  under the same `holder_id`. The lost call names the older frame, so step
  9 refuses it with `stale_frame` whenever it arrives
  ([section 8.3](#83-frame-staleness)).

"Closed" means that the close has reached the Mac: the caller shut the
connection down and the Mac acknowledged it, or the Mac closed it. The
lookup travels on another connection and can overtake a close that is still
in flight. While the path is stalled and the close is unacknowledged, the
request can still be admitted, and `null` is not yet final. A caller in
that position records the outcome as uncertain and looks again later.

Repeating the call stays allowed, and it is the only way to get the stored
result itself. Inside the retention window a repeat of an admitted call
returns the stored result and posts nothing. A caller that repeats MUST be
ready for the call to execute, which is what happens when no record exists.

### 12.6 Retention and capacity

- A record is kept for `OPERATION_RETENTION_MS` from its admission. The
  default is 24 hours. After that deskhand deletes it, and the same
  `operation_id` would be treated as new. That is why a caller MUST NOT
  repeat an `operation_id` after the window.
- A record inside the window is never evicted, whatever its status.
- A principal can have at most `OPERATION_MAX_RECORDS` records inside the
  window, counted across all of its `holder_id` values. The default is
  10,000. At the cap, a call with a new `operation_id` is refused with
  `operation_capacity` and posts nothing. A repeat of an existing
  `operation_id` is still answered. The refusal ends when the oldest record
  leaves the window.
- Both values are configured per Mac and reported in `status.limits`.

At the default ceiling of 60 actions a minute, a caller that never pauses
reaches the default cap after about 2 hours 47 minutes.

### 12.7 Held-input ledger

deskhand keeps a durable ledger of every key and button that might be down
because of it. The ledger, not the count of events, decides what is
released.

1. Before posting a key-down or button-down event, deskhand writes a
   "possibly held" entry for that key or button and flushes it to stable
   storage.
2. After posting the matching up event, it clears the entry and flushes
   again.
3. A crash between the write and the post, or between the post and the
   clear, leaves the entry in place. Recovery then releases something that
   may not be down. That is the safe direction: an extra key-up or button-up
   does no harm.
4. Each operation tracks the keys and buttons it pressed. On an abort it
   releases only those.
5. Cleanup after a restart runs from the ledger. It posts only the key-up
   and button-up events that match the entries, and nothing else.
6. A crash during cleanup leaves the remaining entries for the next start.

An entry is cleared only after its release has been posted. The one
exception is an entry whose down event was never posted, because the checks
that follow the write failed ([section 12.3](#123-write-ordering)): nothing
is down, so it is cleared without a release. If posting a release fails,
the entry stays and deskhand tries again. While an entry
remains and no operation is executing, the `cleanup_pending` condition is
set ([section 11.2](#112-cleanup_pending)).

### 12.8 Cleanup authorization

Every release needs authorization. That covers the releases that end an
ordinary abort and the releases of restart cleanup alike. A release is
authorized only when **none** of these blocking conditions holds:

- the screen is locked (`locked`);
- deskhand's session does not own the console (`not_console`);
- the console shows the login window (`login_window`);
- secure input is on (`secure_input`).

Each one is judged on its own. The state that `status` reports is not
enough: if the state is `paused` and the screen is also locked, releases
wait, although `paused` has the higher precedence.

Releases **are** allowed while `gated`, `paused` or `disarmed`, because a
release removes input and does not add any. `display_asleep`, the permission
states, the app policy and `user_active` do not block a release either.

- If an abort is caused by the screen locking, by a console switch or by
  secure input turning on, its releases are deferred, not posted. The
  operation is still recorded `aborted` and the call still answers with the
  state's name. The entries stay in the ledger.
- Until cleanup can run, deskhand logs `cleanup_pending`, reports the
  condition and refuses every effect call.
- When the last blocking condition ends, deskhand posts the deferred
  releases before it admits any effect.

deskhand never unlocks a session and never posts at the login window, not
even a release. Whether synthetic input that is still held outlives the
process that posted it is a spike item. This contract assumes it can, which
is why the ledger is durable.

A release is a key-up or a button-up and nothing else. A button-up is posted
at the pointer's current location and never moves the pointer
([section 12.4](#124-aborts)).

### 12.9 Restart

When deskhand starts, before it answers any call:

1. Every `accepted` record becomes `failed_before_execution`. Nothing was
   posted for it.
2. Every `executing` record becomes `aborted_by_restart`. Events may have
   been posted. `events_posted` is the last count that reached the disk and
   is a lower bound.
3. All frames are gone and the lease is gone. `status.started_at` has a new
   value.
4. deskhand is `disarmed` ([section 10.1](#101-detection)).
5. If the ledger has entries, `cleanup_pending` is set. deskhand releases
   them as soon as cleanup is authorized
   ([section 12.8](#128-cleanup-authorization)). That can be at once, and it
   can be much later.

Steps 1 and 2 are written durably. A repeat of such an `operation_id` gets
`interrupted` with the record's status ([section 4.3](#43-operation_id)). A
caller treats `aborted_by_restart` as "input may have reached the Mac, and
deskhand cannot say how much".

Operation records, the retention window and the count per principal carry
over unchanged. The action ceiling's counter is kept in memory and starts
empty.

### 12.10 Action log entries

The action log is append-only and cannot be edited by the session user. Its
writer is a separate root process, and deskhand reaches it over a local
connection ([section 11.3](#113-log_unavailable)). There are three kinds of
entry.

| Kind | Written | If it cannot be written |
| --- | --- | --- |
| intent | Before admission (step 2 of [section 12.3](#123-write-ordering)). | The call is refused with `log_unavailable`. |
| outcome | After the final record write (step 8). | The call still returns its true result, and the `log_unavailable` condition is set. |
| refusal | When an effect call is refused before admission, for any code. | Nothing changes for the call. It is best effort. |

Every entry has these fields:

| Field | Content |
| --- | --- |
| time | deskhand's clock, UTC. |
| kind | intent, outcome or refusal. |
| caller node address | The source address of the connection. |
| principal | The client certificate's subject. |
| `holder_id`, `operation_id` | As sent. |
| tool, action | The tool name and `action.type`. |
| `frame_id`, frame digest | The frame the call named, and its `sha256` when deskhand still has the frame. |
| frontmost app | `bundle_id`, `team_id` and name as measured; on an outcome also the target app. |
| outcome | On an outcome or a refusal: `completed` or the error code, `operation.status` and `events_posted`. |

- Typed text is logged as its length only.
- No entry holds image bytes, a window title, a token or any part of a
  credential.
- A refusal entry lets an operator see what was tried against the app policy
  (`denied_app`, `denied_shortcut`) even though no operation record exists.
  It does not fail closed: a refusal posts nothing, so nothing is lost if the
  entry is.
- The encoding of an entry, the file's location and its rotation are
  implementation matters and are not part of this contract.

## 13. Timing bounds

The constants are in [section 16](#16-constants). This section says what
each bound is measured from, and what deskhand has done by the end of it.

| Event | Bound | By then deskhand has |
| --- | --- | --- |
| The allowance, the lease or the arming period ends | `DEADLINE_BOUND_MS` (1 s) after the end time | cancelled the executing effect, released its held input and dropped the lease |
| The allowance file is removed, or replaced by one that is not valid | `DEADLINE_BOUND_MS` (1 s) after the change | the same |
| The person at the Mac uses the keyboard or pointer during an effect | `USER_ACTIVITY_ABORT_MS` (250 ms) after their input | stopped posting and released what the operation held |

In this section "released" means released if cleanup is authorized
([section 12.8](#128-cleanup-authorization)). If it is not, deskhand has
stopped posting within the bound and the releases wait.

### 13.1 The deadline

While an effect executes, and while a lease is held, deskhand works to one
deadline:

```text
deadline = min(allowance expires_at, lease expiry, arming expiry)
```

- **When it is checked.** Before every posted event, at every activity poll
  while an operation waits with input held (the duration of a drag, the
  hold of a key), and by a timer while no operation is executing.
- **Expiry.** All three end times are known in advance. Within
  `DEADLINE_BOUND_MS` of the deadline, deskhand has cancelled the executing
  operation, released its held input and dropped the lease.
- **Revocation.** If the allowance file is removed or replaced, deskhand
  notices within 1 s, through a file watch plus a poll
  ([section 14.4](#144-reading-and-revocation)). If no valid allowance is
  left, deskhand has cancelled, released and dropped the lease within
  `DEADLINE_BOUND_MS` of the change. A replacement that is valid only moves
  the deadline.
- **Moving the deadline.** The lease is renewed through `lease`, which an
  executing effect does not hold up, so a renewal moves the deadline while
  an effect runs. A person cannot extend arming while an operation executes
  ([section 10.4](#104-gated-paused-and-disarmed)), so the arming expiry does
  not move during an effect.
- **No look-ahead.** deskhand does not refuse a call because it could not
  finish before the deadline. It admits the call and aborts it at the
  deadline. A caller SHOULD renew the lease before an action that comes
  close to what is left of it.

| What ended | State afterwards | Code on the aborted call | Lease |
| --- | --- | --- | --- |
| Allowance | `gated` | `gated` | dropped |
| Arming period | `disarmed` | `disarmed` | dropped |
| Lease | unchanged | `lease_expired` | ended |

### 13.2 The person at the Mac

- **Before execution.** An effect call is refused with `user_active` when
  the person's last input is less than `USER_ACTIVITY_LOOKBACK_MS` old
  ([section 16](#16-constants)).
- **During execution.** deskhand reads the platform's hardware-input idle
  signal every `USER_ACTIVITY_POLL_MS` (100 ms), including while it waits
  with input held. Its own posted events do not count. How it tells them
  from the person's is chosen by the spike.
- **Uncertainty counts as activity.** If the idle signal cannot be read, or
  deskhand cannot separate its own events from the person's, the person
  counts as active: the call is refused, or the executing effect is aborted,
  with `user_active`. `details.idle_ms` is then 0.
- **The bound.** Within `USER_ACTIVITY_ABORT_MS` (250 ms) of the person's
  input, deskhand has posted the operation's last event and released what
  the operation held. Up to 100 ms of that is the wait for the next poll.
  The rest is for stopping and releasing.
- Events can still be posted in the gap before the poll that notices. The
  bound limits that gap. It does not close it.
- The call returns `user_active` with `operation.status` `aborted` and
  `details.idle_ms`.

### 13.3 Other changes of state

The executor reads the state at the same moments as the deadline: before
every posted event, and at every activity poll while it waits. So once
deskhand knows that the state is not `ok`, it posts no further event of the
operation, and an operation that is waiting stops within one poll interval
(100 ms). The kill switch is known to deskhand at once.

How long macOS takes to report a lock, a console switch, a sleeping display
or secure input is not bounded by this contract. The spike measures it.

## 14. Allowance file format

The LAN gate on each Mac (birbhomes-r-ttg5) publishes a short-lived
allowance file while the Mac is on the home LAN. deskhand only reads it.
Without a valid allowance the state is `gated` (amendment 2). birbhomes owns
the publisher. This section is deskhand's side of that interface, and
`docs/schemas/allowance.json` is the schema of the file's contents.

### 14.1 The file

- The path is deskhand configuration, supplied per Mac by birbhomes.
- deskhand opens the directory that holds the file with
  `O_NOFOLLOW | O_DIRECTORY`, and then opens the file inside it with `openat`
  and `O_NOFOLLOW`. Neither the directory nor the file can be a symbolic
  link, and the file it reads is the one in the directory it checked. It
  then checks what it opened, not the paths:
  - the directory is owned by root and is not writable by group or by
    others;
  - the file is a regular file;
  - the file is owned by root;
  - the file is not writable by group or by others.
- deskhand's user must be able to read it. birbhomes publishes it
  world-readable.
- birbhomes guarantees that it publishes atomically: it writes the new file
  beside the old one and renames it into place. deskhand therefore never
  sees a half-written file, and treats a file that does not parse as
  invalid, not as a reason to wait.

### 14.2 Contents

One JSON object in UTF-8 with exactly these four members:

```json
{
  "version": 1,
  "mac": "lunus-macbook-pro",
  "not_before": "2026-11-14T15:00:00Z",
  "expires_at": "2026-11-14T15:02:00Z"
}
```

| Member | Rule |
| --- | --- |
| `version` | The integer `1`. Any other value is invalid. |
| `mac` | This Mac's configured name, the same string as `status.mac`: 1 to 63 characters from `a-z 0-9 -`. Compared exactly. An allowance for another Mac is invalid. |
| `not_before` | A timestamp. The allowance is not valid before it. |
| `expires_at` | A timestamp later than `not_before`. The allowance is not valid at or after it. |

- Timestamps are UTC RFC 3339 in the same form as on the wire:
  `YYYY-MM-DDTHH:MM:SS`, an optional fraction of up to 9 digits, and a
  literal `Z`. An offset such as `+00:00` is invalid, although it also means
  UTC.
- A timestamp that is not a real UTC instant makes the file invalid: month
  13, day 32, 30 February, hour 24, minute or second 60. deskhand never
  normalizes such a value into a later time. A leap second (`:60`) is
  refused as well.
- An unknown member makes the file invalid. A change to the format gets a
  new `version`.
- How long an allowance lasts is birbhomes' choice, and deskhand sets no
  minimum or maximum. A short one bounds how long deskhand keeps serving
  after the publisher stops.

The schema checks the shape, and its timestamp pattern refuses every
impossible value except 29 February in a year that is not a leap year. A
validator MUST also assert the `date-time` format, which catches that case.
That `mac` names this Mac and that `expires_at` is later than `not_before`
are checked by deskhand.

### 14.3 When the allowance is valid

At time `now` on deskhand's clock, the allowance is valid when all of this
holds:

1. The file checks of [section 14.1](#141-the-file) pass.
2. The contents conform to [section 14.2](#142-contents).
3. `mac` equals this Mac's configured name.
4. `not_before` minus `ALLOWANCE_SKEW_TOLERANCE_MS` is not later than `now`.
5. `now` is earlier than `expires_at`.

In every other case the state is `gated`: the file is missing or cannot be
read, a check fails, the allowance is not yet valid, or it has expired. The
wire does not say which. deskhand logs the reason on the Mac.

The publisher and deskhand read the same clock, so the tolerance only
matters when that clock is stepped. It is configured per Mac and is 0 by
default. It applies to `not_before` only: `expires_at` is never extended.

### 14.4 Reading and revocation

- deskhand consults the allowance on every tool call, `status` included. It
  may answer from a copy of the file's contents that is at most 1 s old
  (`ALLOWANCE_CACHE_MAX_MS`).
- The copy holds the contents, not the verdict. `expires_at` is compared
  with the clock every time, so the cache never delays an expiry.
- deskhand also watches the file and reads it again on a period short
  enough to keep the bound of [section 13.1](#131-the-deadline), and never
  longer than 1 s. This runs whether or not calls arrive.
- **Revocation** is removing the file, or replacing it with one that is not
  valid now. deskhand notices within 1 s and is then `gated`.
- A replacement that is valid takes effect when it is read. The deadline
  moves to its `expires_at`, whether that is earlier or later.

### 14.5 Becoming and leaving `gated`

- **Becoming `gated`** aborts the operation in flight with `gated`, releases
  its held input if cleanup is authorized, invalidates every frame and drops
  the lease ([section 10.3](#103-leaving-ok),
  [section 10.4](#104-gated-paused-and-disarmed)).
- **Becoming `gated`** also ends arming, unless the Mac is configured with
  `gated_ends_arming` `false`
  ([section 10.4](#104-gated-paused-and-disarmed)).
- **Leaving `gated`** needs a valid allowance and nothing else. deskhand
  finds it at the next read, within 1 s of publication. Nothing is restored
  ([section 10.5](#105-returning-to-ok)). By default the state is then
  `disarmed`, and a person arms deskhand again.

## 15. Clean stop

deskhand-r-nkjj asks for a way for the host's LAN gate to stop deskhand and
leaves the mechanism to birbhomes. birbhomes-r-ttg5 rules out the obvious
one: the gate's root adapter must not terminate processes of the personal
user. So deskhand can be stopped in two ways, and the LAN gate uses the
first.

### 15.1 Gate stop

The LAN gate stops deskhand by withdrawing the allowance. It removes the
file to stop at once, or stops publishing and lets the allowance expire.
deskhand then:

1. Aborts the executing effect with `gated` ([section 12.4](#124-aborts)),
   and refuses read calls in flight with `gated`.
2. Releases the input that the effect held, if cleanup is authorized
   ([section 12.8](#128-cleanup-authorization)).
3. Drops the lease, invalidates every frame and, by default, ends arming
   ([section 10.4](#104-gated-paused-and-disarmed)).
4. Writes the outcome of the aborted operation to the action log, and logs
   the change of state.
5. Keeps running in the state `gated`. `status` is answered and reports
   `gated`. `displays`, `screenshot`, `pointer` and `keyboard` are refused
   with `gated`, and `lease` refuses `acquire` and `renew` with it.

Steps 1 to 3 are done within `DEADLINE_BOUND_MS` of the removal or of
`expires_at` ([section 13.1](#131-the-deadline)).

deskhand does not exit on a gate stop. Away from home its LAN address is
unreachable anyway, and the packet filter on the Mac keeps other devices
out. If the address itself is gone, deskhand keeps trying to bind it
([section 2.1](#21-endpoint)). Because the process stays up, deskhand
answers again as soon as a valid allowance is published, with no restart.
By default it is then `disarmed` and a person arms it, which is the one
manual step that birbhomes-r-ttg5 allows
([section 10.4](#104-gated-paused-and-disarmed)).

### 15.2 Process stop

The process itself is stopped with `SIGTERM`. launchd sends it when the
LaunchAgent is unloaded: at logout, on uninstall and on upgrade. The LAN
gate does not use this path. On `SIGTERM` deskhand:

1. Stops accepting connections and reads no further request from the
   connections it has.
2. Aborts the executing effect. It stops posting and releases the input the
   effect held, if cleanup is authorized. If it is not, the entries stay in
   the ledger and the next start reports `cleanup_pending`.
3. Records the outcome durably. The aborted operation ends as
   `aborted_by_restart` with the true count of events posted. An admitted
   call that had not started executing ends as `failed_before_execution`.
4. Writes the outcome to the action log and logs the stop.
5. Lets read calls in flight finish, closes every connection and exits.

Steps 1 to 4 are done within `DEADLINE_BOUND_MS` of the signal.

An effect call that was in flight gets no response: the caller sees the
connection close and treats the outcome as unknown. Once deskhand is back,
a repeat of the `operation_id` returns `interrupted` with the record's
status and count ([section 4.3](#43-operation_id)).

If deskhand is killed instead (`SIGKILL`, a crash, loss of power), none of
this runs, and the next start recovers from the record file and the ledger
([section 12.9](#129-restart)). To a caller the two look the same. The
difference is that after a clean stop `events_posted` is exact, and nothing
is left held unless cleanup was not authorized.

After either kind of process stop deskhand starts `disarmed`, with no lease
and no frames. `SIGHUP` does not stop deskhand; it reloads the credentials
([section 11.1](#111-credentials_warning)).

## 16. Constants

Contract constants are fixed by this document. Configured values are set per
Mac and, unless the table says otherwise, reported by `status.limits`.

| Name | Value | Kind |
| --- | --- | --- |
| `MAX_LONG_EDGE` | 2576 px | contract (amendment 1) |
| `MIN_LONG_EDGE` | 256 px | contract |
| `MAX_VISUAL_TOKENS` | 4784 | provider cap (amendment 1) |
| `MAX_PIXELS` | 3,588,000 (= 4784 × 750) | contract (amendment 1) |
| `MAX_IMAGE_BYTES` | 3,750,000 bytes before base64 (5,000,000 base64 characters) | contract |
| `JPEG_QUALITY_STEPS` | 85, 75, 65, 60 | contract |
| `PATCH_SIZE` | 64 frame pixels | contract |
| `PATCH_CHANNEL_TOLERANCE` | 16 of 255 | contract |
| `PATCH_MAX_CHANGED_FRACTION` | 0.02 | contract |
| `PATCH_CHECK_MAX_AGE_MS` | 250 | contract |
| `DRAG_POLICY_SAMPLE_PX` | 8 frame pixels | contract |
| `FRAME_MAX_AGE_MS` | default 60,000; 5,000 to 600,000 | configured |
| `USER_ACTIVITY_LOOKBACK_MS` | 3,000 | contract |
| `USER_ACTIVITY_POLL_MS` | 100 | contract |
| `USER_ACTIVITY_ABORT_MS` | 250 | contract |
| `DEADLINE_BOUND_MS` | 1,000 | contract |
| `ALLOWANCE_CACHE_MAX_MS` | 1,000 | contract |
| `ALLOWANCE_SKEW_TOLERANCE_MS` | default 0; 0 to 60,000 | configured; not reported by `status` |
| `LEASE_TTL_MS` | default 30,000; 5,000 to 120,000 | contract; chosen per call |
| `ACTIONS_PER_MINUTE` | default 60; one counter per Mac over a sliding 60 s window | configured |
| `GATED_ENDS_ARMING` (`gated_ends_arming`) | default true | configured; not reported by `status` |
| `DISCOVERY_TTL_MS` | 300,000 (`ttlMs` of `server/discover` and `tools/list`) | contract |
| `BIND_RETRY_MS` | at most 5,000 | contract |
| `KEYBOARD_MAX_TEXT_LENGTH` | 1024 code points | contract |
| `KEY_HOLD_MAX_MS`, `DRAG_DURATION_MAX_MS` | 5,000 | contract |
| `DRAG_MAX_POINTS` | 32 | contract |
| `SCROLL_MAX_DELTA` | 10,000 frame pixels | contract |
| `OPERATION_RETENTION_MS` | default 86,400,000 (24 h) | configured |
| `OPERATION_MAX_RECORDS` | default 10,000 per principal | configured |
| `MAX_REQUEST_BODY_BYTES` | 65,536 | contract |
| `MAX_REQUEST_HEADER_BYTES` | 16,384 | contract |
| `MAX_RESPONSE_BODY_BYTES` | 5,400,000 | contract |
| `CONNECTION_MAX_AGE` | 5 min | contract |

- **`USER_ACTIVITY_LOOKBACK_MS`.** An effect call is refused with `user_active`
  when the person at the Mac produced keyboard or pointer input less than
  3,000 ms before the call would start executing. Input that deskhand posted
  itself does not count. Three seconds covers the pauses inside ordinary
  typing and mousing, and is short enough that an idle Mac is usable at once.
- **`USER_ACTIVITY_ABORT_MS`.** While an effect executes, deskhand checks for
  the person's input every 100 ms. Within 250 ms of such input it has stopped
  posting and released what the operation held, and the call returns
  `user_active` with `operation.status` `aborted`.
- **`DEADLINE_BOUND_MS`.** Within 1 s of the allowance, the lease or the arming
  period ending or being revoked, deskhand has cancelled the executing
  operation, released its held input and dropped the lease.

What each bound is measured from is in [section 13](#13-timing-bounds). The
two allowance values are used in
[section 14](#14-allowance-file-format).

## 17. Changes from the shared contract

The "Shared contract" block is the same text in deskhand-r-nkjj, crew-r-yqso
and birbhomes-r-5elb. That block and the rest of each request are
authoritative. This document departs from the request text in four places,
and each departure is a numbered amendment. Points where it only makes the
request text more exact are listed as clarifications in
[section 17.5](#175-clarifications).

- An amendment is **approved** when the owner has left a note on every
  affected request: deskhand-r-nkjj, crew-r-yqso, birbhomes-r-5elb and
  birbhomes-r-ttg5. deskhand, crew, birbhomes and forge share one owner.
- Until an amendment is approved, deskhand follows the request text.
- `docs/contract.md` v1.0 is not published until all four are approved.
- This draft describes the contract with all four applied, so that Crew can
  build against it now. If the owner rejects one, the sections named below
  change before v1.0.

| # | Amendment | Status |
| --- | --- | --- |
| 1 | Screenshot limits | Approved by the owner on 2026-11-12 with the figure 3,750,000 pixels. The figure is now 3,588,000: owner re-confirmation needed. |
| 2 | `gated` state | Pending: deskhand-nxas. |
| 3 | No node-IP allowlist inside deskhand | Pending: deskhand-nxas, and the owner's decision in deskhand-fxz0. |
| 4 | The `lease` tool | Pending: deskhand-nxas. |

### 17.1 Amendment 1: screenshot limits

- **Text it changes.** deskhand-r-nkjj, "Required behaviour", Screenshot:
  "downscaled by default to at most 1568 px on the long edge."
- **The change.** By default a screenshot is downscaled to a long edge of at
  most 2576 px and to at most 3,588,000 pixels. A caller may ask for a
  smaller long edge, down to 256 px. deskhand never returns an image over
  either limit ([section 7](#7-screenshot-sizing-and-encoding)).
- **Rationale.** Callers use current models only. Those accept images up to
  2576 px on the long edge and 4784 visual tokens, and their providers
  reject a larger image instead of shrinking it. A 1568 px default throws
  away detail that the model could use to place a click.
- **The figure changed after approval.** The owner approved this amendment
  with a pixel limit of 3,750,000. That number is the providers' "about 3.75
  megapixels", which turned out to approximate the cap of 4784 visual
  tokens and not to be a limit itself. At 3,750,000 pixels the default
  screenshot of both Macs' built-in panels (2408 × 1556 and 2402 × 1560)
  costs more than 4784 tokens and would be rejected. The limit is therefore
  3,588,000 pixels (4784 × 750), which is stricter than the approved figure
  and serves the same intent: the largest image a current model accepts.
- **Status.** Approved by the owner on 2026-11-12 with the figure 3,750,000.
  **Owner re-confirmation needed** for 3,588,000. The 2576 px long edge is
  unchanged.

| Request | What changes for it |
| --- | --- |
| deskhand-r-nkjj | The Screenshot item of "Required behaviour" reads 2576 px and 3,588,000 pixels in place of 1568 px. |
| crew-r-yqso | "Images": Crew sizes its per-request image cap, and what it keeps out of checkpoints, for images of up to 2576 px and 3,750,000 bytes, which is 5,000,000 characters of base64. A whole response is at most 5,400,000 bytes. |
| birbhomes-r-5elb | Nothing. |
| birbhomes-r-ttg5 | Nothing. |

### 17.2 Amendment 2: the `gated` state

- **Text it changes.** The shared contract, "States": "`ok`, `locked`,
  `display_asleep`, `not_console`, `disarmed`, `paused`,
  `permission_missing`, `permission_stale`, `secure_input`." It also gives a
  name to the refusal in birbhomes-r-ttg5: "have deskhand refuse calls when
  it is absent or expired."
- **The change.** A tenth state, `gated`, holds while the LAN-gate allowance
  is missing, invalid, not yet valid or expired
  ([section 14](#14-allowance-file-format)). It has the highest precedence,
  it is reported by `status` and used as an error code like every other
  state, and it drops the lease ([section 10](#10-states)). The rule that
  every tool except `status` fails with the state's name covers it, as
  amended by amendment 4, which makes `lease` a second exception.
- **Rationale.** birbhomes-r-ttg5 already requires the refusal, and none of
  the nine states describes it. Reusing one would mislead: `disarmed` tells
  a person to arm deskhand, which would not help. Answering nothing would
  hide `status`, so a caller could not tell a Mac whose gate is closed from
  one that is broken. A name of its own lets Crew report that the Mac's LAN
  gate is closed, and wait. It ranks first because it is the outermost
  gate, and nothing a person does at the Mac ends it.
- **Status.** Pending approval, tracked by deskhand-nxas. The refusal itself
  is request text and is built either way. What waits for approval is the
  name, its precedence and that it drops the lease.

| Request | What changes for it |
| --- | --- |
| deskhand-r-nkjj | The "States" list of the shared contract gains `gated`: ten values in place of nine. |
| crew-r-yqso | The same list. Under "Availability", `gated` is one more tool error that the model can read, alongside away, locked, disarmed and paused. |
| birbhomes-r-5elb | The same list. Nothing in the network path changes. |
| birbhomes-r-ttg5 | The refusal "when it is absent or expired" is the state `gated`, and the allowance has the format of [section 14](#14-allowance-file-format). The acceptance item "stops serving within the gate's expiry" is met by `gated`: deskhand keeps answering `status` and `lease`, refuses `acquire` and `renew` inside the `lease` result, and refuses every other tool ([section 15.1](#151-gate-stop)). |

### 17.3 Amendment 3: no node-IP allowlist inside deskhand

- **Text it changes.** birbhomes-r-ttg5, "What to do": "Supply the per-Mac
  configuration: listen address, allowlist of node addresses, app policy,
  credential file paths."
- **The change.** deskhand's configuration has no allowlist of node
  addresses, and deskhand does not filter by source address. The pf anchor
  of birbhomes-r-5elb is the only source filter. deskhand still binds one
  LAN address and still requires both credentials on every request
  ([section 2](#2-transport-and-authentication)).
- **Rationale.** The shared contract already says where access is decided:
  "A source filter can only name nodes. The credential is the access
  control." The pf anchor admits the port from the node addresses only,
  before a connection reaches deskhand. A second list inside deskhand would
  repeat it, would have to be changed in step with it whenever a node is
  added or readdressed, and would look like an outage when the two differ.
  It would keep out nothing that the anchor lets in.
- **Status.** Pending. It needs the owner's decision in deskhand-fxz0
  (whether deskhand keeps a node-IP allowlist) and then the approval notes
  tracked by deskhand-nxas. The project plan's default answer is no
  allowlist. If the owner decides to keep one, this amendment is withdrawn:
  deskhand then takes the list from its per-Mac configuration and refuses
  connections from any other source address. Nothing on the wire changes
  for a caller on a listed node.

| Request | What changes for it |
| --- | --- |
| deskhand-r-nkjj | No text changes. "Caller identity" in the shared contract stays as it is, and this amendment settles that deskhand itself runs no source filter. |
| crew-r-yqso | Nothing. A caller on a node that the pf anchor admits sees no difference. |
| birbhomes-r-5elb | The pf anchor (item 4 of "What to do") is the only source filter, so its list of node addresses is the only one to maintain. |
| birbhomes-r-ttg5 | "allowlist of node addresses" leaves the per-Mac configuration that birbhomes supplies to deskhand. |

### 17.4 Amendment 4: the `lease` tool

- **Text it changes.** The shared contract, "Tools": "`status`, `displays`,
  `screenshot` (reads); `pointer`, `keyboard` (effects)." And "States":
  "Every tool except `status` fails with the state's name unless the state
  is `ok`."
- **The change.** A sixth tool, `lease`, acquires, renews and releases the
  lease ([section 5](#5-lease)). `status` no longer takes a `lease` argument
  and is a pure read. `status` reports the lease only as seen from a
  `holder_id` that the call names, as `held_by_caller` and an expiry, and no
  result ever carries a `holder_id`. `lease` answers in every state: it
  refuses `acquire` and `renew` in `gated`, `paused` and `disarmed` inside
  its result, not as a tool error with the state's name, and it always
  allows `release`.
- **Rationale.** Earlier drafts carried lease operations on `status`, so that
  five tools were enough. But the shared contract calls `status` a read, and
  crew-r-yqso runs reads without a card. A read that can take the lease
  away, and by releasing it abort an executing effect, is not a read. A
  separate tool is an effect under the shared contract's own rule ("treats
  any unknown tool as an effect"), so Crew gates it without a special case.
  `status` also used to show the holder label to the whole principal, and
  that label is the only thing that separates Crew's internal callers.
- **Status.** Pending approval, tracked by deskhand-nxas. If the owner
  rejects it, lease operations go back to an optional `lease` argument of
  `status`, as in 0.9-draft, and sections 3.2, 5, 6.1 and 9.5 change back.
  The shared contract names no lease operation, so one of the two forms is
  needed either way.

| Request | What changes for it |
| --- | --- |
| deskhand-r-nkjj | The "Tools" list of the shared contract gains `lease`: six tools in place of five. The state rule reads "every tool except `status` and `lease`". |
| crew-r-yqso | The same list. "Classification" is unchanged: `lease` is not one of the three reads, so it is an effect by Crew's unknown-tool rule. "Lease": Crew's executor acquires and renews with `lease`, never with `status`. |
| birbhomes-r-5elb | The same list. Nothing in the network path changes. |
| birbhomes-r-ttg5 | Nothing. |

### 17.5 Clarifications

These make the request text more exact without departing from it. They need
no approval note, and they are listed so that nobody finds them by surprise.

1. **"The latest frame" is per holder.** The shared contract refuses an
   effect when "the frame is not the latest for that display". This document
   judges "latest" per (principal, `holder_id`, `display_id`)
   ([section 4.2](#42-frame_id), reason `not_latest` in
   [section 8.3](#83-frame-staleness)). A screenshot taken under one
   `holder_id` does not make another holder's frame stale. Only the lease
   holder can post input, so only its frames matter for an effect.
2. **A lost acknowledgement is looked up, not retried.** crew-r-yqso says
   that a click or keystroke whose acknowledgement was lost "is recorded as
   uncertain and never retried". `status` with `operation` lets Crew resolve
   the uncertainty without sending the call again
   ([section 12.5](#125-repeats-and-stored-results)). Crew closes the
   connection of the lost call before it asks. Until that close has reached
   the Mac, a `null` answer is "no record now" and the outcome stays
   uncertain.

## 18. Verified against the specification on 2026-11-14

The statements this document makes about MCP `2026-07-28` and about provider
image limits were read from the published text on 2026-11-14. Earlier drafts
marked them **(Q1)** to **(Q16)** as open; the markers are gone, and the
answers are below.

Sources. MCP pages are under
`https://modelcontextprotocol.io/specification/2026-07-28/`, and provider
pages under `https://platform.claude.com/docs/en/`.

| Source | Page |
| --- | --- |
| S1 | `changelog` |
| S3 | `basic/transports/streamable-http` |
| S4 | `server/tools` |
| S5 | `server/discover` |
| S7 | `schema` |
| S8 | `basic/index` |
| S9 | `server/utilities/pagination` |
| S10 | `computer-use-tool` (provider) |
| S11 | `build-with-claude/vision` (provider) |
| S12 | `server/utilities/caching` |

| Was | Verified fact | Source | Where it is used |
| --- | --- | --- | --- |
| Q1 | `params._meta["io.modelcontextprotocol/protocolVersion"]` is a required string on every request and must match the `MCP-Protocol-Version` header, else `400`. | S7 | 2.3, 2.4, 3 |
| Q2 | `resultType` is `"complete"` or `"input_required"` (or an extension string). | S7, S8 | 3 |
| Q3 | `server/discover` takes only `_meta`. Its result has `supportedVersions`, `capabilities`, `_meta["io.modelcontextprotocol/serverInfo"]`, optional `instructions`, `ttlMs` and `cacheScope`. | S5, S7 | 3.1 |
| Q4 | `-32022` is an unsupported protocol version. `-32020` is a header mismatch, or a required header that is missing or malformed. `-32021` is a missing required client capability. A server must not send `-32002` or `-32042`. | S7, S8 | 2.3, 9.4 |
| Q5 | A missing `MCP-Protocol-Version`, `Mcp-Method` or required `Mcp-Name` is `400` with `-32020`. `Mcp-Name` is required on `tools/call`. Non-ASCII header values are sent as `=?base64?...?=`. Header names are case-insensitive and values case-sensitive. | S3 | 2.3 |
| Q6 | A client must list both `application/json` and `text/event-stream` in `Accept`. The server chooses JSON or a stream for each request, so a server that only answers JSON conforms. | S3 | 2.1, 2.3 |
| Q7 | An accepted notification is answered `202` with no body. This revision defines no notification from client to server over HTTP. A sessionless server ignores `Mcp-Session-Id`. | S1, S3 | 2.1, 2.4 |
| Q9 | `-32020`, `-32021` and `-32022` are `400`. An unknown method is `404` with `-32601`. A missing required `_meta` member is `400` with `-32602`. A bad `Origin` is `403`. | S3, S7, S8 | 2.4, 9.4 |
| Q10 | `title` is optional. The annotation defaults are `readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true. An image block is `{type: "image", data, mimeType}`. | S7 | 3.2, 3.3 |
| Q11 | `nextCursor` is optional, and its absence means the end of the list. JSON Schema 2020-12 is the default dialect of `inputSchema` and `outputSchema`. | S4, S9 | 3.2 |
| Q12 | The long edge limit is 2576 px. "About 3.75 megapixels" approximates a cap of 4784 visual tokens and is not a pixel cap. An image over the limit in a tool result is rejected, not downscaled. | S10 | 7, 17.1 |
| Q13 | The image size limit counts the base64 text: 10 MB on the Claude API and 5 MB on Bedrock. | S11 | 2.5, 7 |
| Q14 | A call to an unknown tool is JSON-RPC `-32602` with the message `Unknown tool: <name>`. | S4 | 2.4, 9.4 |
| Q15 | `server/discover` is mandatory. `tools/list` is mandatory with the `tools` capability. `ping` was removed in this revision. | S1, S4, S5 | 3 |
| Q16 | "Servers MUST validate the Origin header on all incoming connections to prevent DNS rebinding attacks." "When running locally, servers SHOULD bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)." | S3 | 2.1, 2.3 |
| new | Results of `server/discover` and `tools/list` must carry the caching hints `ttlMs` (an integer of at least 0) and `cacheScope` (`"public"` or `"private"`). | S12 | 3 |

**Still open.** The specification does not state these points, so this
document makes a choice and says so. None of them blocks an implementation.

- **Whether `outputSchema` governs an error result (was Q8).** Not stated.
  Each output schema here includes the tool's error shape, so
  `structuredContent` conforms either way
  ([section 3.2](#32-toolslist)).
- **`Mcp-Name` on methods that name nothing (part of Q5).** Not stated.
  deskhand ignores the header on `server/discover` and `tools/list`.
- **The HTTP status of `-32700`, `-32600`, `-32603` and of `-32602` for an
  unknown tool (part of Q9).** Not stated. This contract answers `400`,
  `400`, `200` and `200` ([section 9.4](#94-json-rpc-errors)).
- **How a provider counts visual tokens (part of Q12).** The provider
  documentation gives the cap, not one formula that this document can rely
  on. `MAX_PIXELS` is chosen to stay under the cap whether tokens are
  counted by area or by 28 px patches
  ([section 7](#7-screenshot-sizing-and-encoding)). Before v1.0 a default
  screenshot from each Mac must be shown to be accepted by each engine.

## 19. Schema index

All files are JSON Schema Draft 2020-12 under `docs/schemas/`. `$id` values
(`https://deskhand.invalid/schemas/...`) are identifiers, not locations.

Every string with a restricted alphabet has an anchored `pattern` and also a
`not` `pattern` over its forbidden characters. The second one matters in regex
engines where `$` also matches before a final newline (Python's `re`, and ICU,
which Foundation's `NSRegularExpression` uses): there the anchored pattern
alone would accept a trailing newline.

| File | Contents |
| --- | --- |
| `defs.json` | Shared definitions: `state`, `condition`, `error_code`, `holder_id`, `operation_id`, `frame_id`, `rect`, `point`, `frame_point`, `key`, `modifiers`, `app_ref`, `measured`, `lease_view`, `operation_view`, `effect_result`, `tool_error` and others. |
| `tools/<tool>.input.json` | The `arguments` of each of the six tools: `status`, `displays`, `screenshot`, `pointer`, `keyboard`, `lease`. |
| `tools/<tool>.output.json` | The `structuredContent` of each tool: its success shape, or `tool_error` limited to the codes that tool can return. |
| `allowance.json` | The contents of the LAN-gate allowance file ([section 14](#14-allowance-file-format)). Self-contained, and not served by `tools/list`. |
| `wire/jsonrpc-request.json`, `wire/jsonrpc-notification.json` | A request and a notification as a caller sends them ([section 2.3](#23-request-headers), [section 3](#3-mcp-methods)). |
| `wire/jsonrpc-response.json`, `wire/jsonrpc-error.json` | The envelope of a successful response, and a JSON-RPC error with the codes of [section 9.4](#94-json-rpc-errors). |
| `wire/server-discover-result.json`, `wire/tools-list-result.json`, `wire/tools-call-result.json` | The `result` of each method ([section 3](#3-mcp-methods)). None of the `wire/` files is served by `tools/list`. |
| `examples/<tool>.<input\|output>.<name>.json` | Instances that validate against the schema named by the first two parts. |
| `examples/invalid/<tool>.<input\|output>.<name>.json` | Instances that MUST be rejected by that schema. |
| `examples/allowance.<name>.json`, `examples/invalid/allowance.<name>.json` | Instances that validate against `allowance.json`, and instances that it MUST reject. |
| `examples/invalid/<wire schema>.<name>.json` | Instances that the `wire/` schema of that name MUST reject, for example `jsonrpc-request.empty-params.json`. |
| `examples/wire/*.json` | Whole JSON-RPC messages. Every request carries `params._meta["io.modelcontextprotocol/protocolVersion"]`. In `tools-call.<tool>.<name>.<request\|response>.json`, `params.arguments` and `result.structuredContent` validate against the tool's schemas. |

Four rules of this document are checked by deskhand and cannot be stated in
a schema: `ttl_ms` is absent on a `lease` `release` (input schemas stay
flat), an image has at most 3,588,000 pixels (a schema cannot multiply),
`measured.drag_end` is present for a `drag` (an output schema does not see
the action), and a timestamp of 29 February falls in a leap year (the
`date-time` format, which a validator MUST assert, catches it).

## Appendix A. Decisions made in this draft

The plan did not settle these. They are listed so the owner and Crew can
object before v1.0. Items 1 to 24 come from the wire surface (0.1-draft),
items 25 to 46 from the behavior sections (0.9-draft), items 47 to 66 from
the foundation review (0.10-draft) and items 67 to 73 from its re-review
(0.11-draft). Items 1, 11, 12, 27 and 46 were changed by the review, and
items 37, 46, 50 and 53 by the re-review.

1. Lease operations are a sixth tool, `lease` (amendment 4). `status` is a
   pure read with no `lease` argument. A refused lease operation is reported
   in `lease_result`, not as a tool error. (Until 0.9-draft they rode on
   `status`.)
2. Lease operations are refused only in `gated`, `paused` and `disarmed`;
   `release` is allowed in every state; `renew` never acquires.
3. Lease lifetime is chosen per call, 5 to 120 s, default 30 s.
4. `screenshot` requires `holder_id` but not the lease; "latest frame" is
   judged per (principal, `holder_id`, `display_id`).
5. A call refused before admission leaves no operation record.
6. The canonical request for the operation digest is RFC 8785 over
   `{name, arguments}` as received.
7. Four codes the plan does not name: `denied_shortcut` (for refusals from the
   plan's denied global shortcut list), `cancelled`, `interrupted` and
   `internal_error`.
8. `permitted_apps`, an optional caller-side narrowing of the app policy.
9. `keyboard` is stale when the frontmost app differs from the frame's
   (`frontmost_changed`).
10. Patch constants 64 px, 16 of 255, 2%; `drag` checks its first and last
    point.
11. `USER_ACTIVITY_LOOKBACK_MS` 3,000; `FRAME_MAX_AGE_MS` default 60,000;
    `ACTIONS_PER_MINUTE` default 60, counting admitted calls and the
    refusals of item 55.
12. `MAX_IMAGE_BYTES` is 3,750,000 (decimal) measured before base64, which
    is 5,000,000 base64 characters; request body 65,536 bytes; response body
    5,400,000 bytes.
13. Endpoint path `/mcp`; TLS 1.3 and HTTP/1.1 only; JSON responses only; `421`
    for a wrong `Host`; `Host` carries the Service port.
14. No input held between calls: no press or release actions; press-and-hold
    is a two-point `drag`; `hold_ms` on `keyboard` `press`.
15. Key names are characters in the active layout, not physical positions.
16. Scroll deltas are frame pixels with a fixed direction convention.
17. The pointer is not drawn into frames; `pointer_position` reports it.
18. `region` is in global points and must lie inside one display.
19. `keyboard` text limit 1024 code points; C1 controls, U+2028 and U+2029 are
    refused along with newline and tab.
20. Tool annotation values, and the order of refusals in section 9.5 after
    its first step.
21. A repeated `operation_id` gets the state's name, with `operation` but
    without the stored result, while the state is not `ok`. This keeps the
    shared contract's rule that every tool except `status` fails with the
    state's name. Returning stored results in every state would serve Crew's
    lost-acknowledgement case better, but it needs an amendment.
22. The members of `details` and which codes always carry them; the best-effort
    rule for `details.argument`.
23. `lease_expired` describes the most recent lease only and has no time limit.
24. Operation retention and the record cap are reported in `status.limits`.
25. `display_asleep` holds while any active display is asleep. A successful
    `displays` result therefore always has `asleep` `false` in v0.
26. deskhand starts `disarmed`. Neither arming nor `paused` survives a
    restart, and `paused` ends only by arming.
27. `gated` ends arming by default. The per-Mac setting `gated_ends_arming`
    (default `true`) turns that off. **For the owner to confirm:** 0.9-draft
    said the opposite, and the review argued that a laptop that left the LAN
    should not resume driving by itself when it comes home.
28. Leaving `ok` also stops read calls in flight: a screenshot that was not
    yet returned is discarded.
29. An unreadable or uncertain signal makes its state hold. This widens the
    plan's rule for the lock signal to every state.
30. The login window always gives the state `not_console`, also when the two
    platform signals disagree.
31. A rejected token file is not treated like a rejected certificate: the old
    token is not kept, and every request gets `401` until the file is fixed.
32. The `log_unavailable` condition refuses nothing by itself. A call is
    refused only when its own intent entry fails. A failed outcome entry does
    not change the result of the call.
33. deskhand retries pending cleanup on every change of state and at least
    once a second.
34. The order of `status.conditions` carries no meaning.
35. `events_posted` counts single synthetic events and leaves out cleanup
    releases. The number of events per action is not fixed.
36. The intent entry is logged before the record is created, and the final
    record, with the stored result, is durable before the response is sent.
37. On a replayed error, `state` is the state stored with the result, and
    `current_state` is the state at the time of the replay. (Until
    0.10-draft `state` was the state at the replay, which broke the rule
    that a state's code carries that state.)
38. The retention window runs from admission. The record cap counts a
    principal's records across all of its `holder_id` values.
39. A failed record or ledger write stops the event it was guarding, and the
    operation ends as `failed` with `internal_error`.
40. The state and the deadline are also checked at every 100 ms activity poll
    while an operation waits. Without that the bounds could not hold during a
    5 s key hold.
41. No look-ahead: a call that cannot finish before the deadline is admitted
    and then aborted at the deadline.
42. Allowance contents: `version` is the integer 1; unknown members are
    invalid; timestamps need a literal `Z`; `mac` is 1 to 63 characters from
    `a-z 0-9 -`; deskhand sets no limit on the lifetime.
43. `ALLOWANCE_SKEW_TOLERANCE_MS` is 0 by default, at most 60,000, and
    applies to `not_before` only.
44. The 1 s revocation bound covers noticing and acting together, so the
    backstop poll runs more often than the plan's "1 s poll".
45. Clean stop has two forms. The LAN gate withdraws the allowance and
    deskhand keeps running as `gated`. `SIGTERM` ends the process within 1 s,
    records the operation in flight as `aborted_by_restart` with an exact
    count, and sends that call no response.
46. `contract_version` follows the document version and is `0.11-draft`. The
    `status` output schema fixes it as a constant.
47. `status` reports the lease only as `held_by_caller` plus its times, and
    only for a `holder_id` that the call names. No result carries a
    `holder_id`, and `{held_by_caller: false}` does not say whether the
    lease is free.
48. The `lease` result is `{lease_result, lease}`. A refused `acquire` with
    `lease_held_by_other` carries the other lease's `expires_in_ms`. `lease`
    has no `operation_id`, answers in every state and has only
    `invalid_argument` and `internal_error` as tool errors.
49. `ttl_ms` on a `release` is `invalid_argument`. The flat input schema
    cannot state it.
50. `status` with `operation` is a read-only record lookup. It reports a
    call that is being admitted as `accepted` with 0 events, and returns
    `status` and `events_posted` but not the stored result. `null` means
    "no record now" and is final only under item 68.
51. One admission section per Mac, entered by an atomic test-and-set and
    held until the final record write. A call that finds it held gets
    `operation_in_progress`, `operation_id_conflict` or `busy` at once,
    before the record lookup, so a replay can get `busy` while another
    effect runs.
52. `operation_in_progress` and `operation_id_conflict` carry `operation`
    as `accepted` with 0 events for a first call that is still being
    admitted.
53. The last look: state, deadline, activity, app policy, the lease and the
    caller's connection are checked again immediately before the first
    event, and a patch check older than `PATCH_CHECK_MAX_AGE_MS` (250 ms)
    ends the call with `stale_frame` and 0 events.
54. App identity is (bundle identifier, team identifier). Apple's own
    software has no team identifier and needs an allowlist entry that says
    so. An unidentifiable app, a point with no window and an unreadable
    keyboard focus are `denied_app`. deskhand's own bundle is always denied.
55. `denied_app` and `denied_shortcut` refusals before admission count
    toward the action ceiling. The ceiling is one counter per Mac over a
    sliding 60 s window.
56. `keyboard` checks the owner of keyboard focus and reports it as
    `measured.target_app`, which was `null` for `keyboard` until 0.9-draft.
57. `measured.window_title` is `null` on every `denied_app` and for every
    app on the capture exclusion list.
58. A drag is checked along its whole path at steps of 8 frame pixels,
    checks the next point before each move, and reports its last point in
    `measured.drag_end`. `denied_app` carries `details.point_index` when a
    point caused it.
59. The default denied shortcut list of [section 6.9](#69-app-policy), the
    superset rule, and that a bare key can be denied.
60. Arming, extending arming and leaving `paused` are not accepted from
    posted input, while an operation executes, or within 3 s of deskhand's
    last posted event.
61. The client certificate needs the `clientAuth` extended key usage and
    the subject configured for the Mac. The principal's key is the RFC 4514
    string of the DER-encoded subject.
62. The operation digest is HMAC-SHA-256 with a per-install key. A lost key
    turns repeats of old operations into `operation_id_conflict`.
63. Duplicate member names and invalid Unicode are refused: `-32700`
    outside `params.arguments`, `invalid_argument` inside.
64. deskhand retries a failed bind at least every 5 s and does not exit.
65. Action log entries: the fields of
    [section 12.10](#1210-action-log-entries), with `principal`,
    `holder_id`, kind and action added to the list in deskhand-r-nkjj. A
    refused effect call is logged once, best effort.
66. `server/discover` and `tools/list` send `ttlMs` 300,000 and `cacheScope`
    `private`. `server/discover` sends no `instructions`. A notification is
    answered `202` only after the version header checks. A timestamp that is
    not a real UTC instant, including a leap second, is invalid.
67. A replayed error carries `current_state`. No other result has it. In
    this version it is always `ok`, because a stored result is only returned
    in `ok`.
68. deskhand never admits a call whose connection is closed, and it checks
    the connection at the last look and before every event. A lookup's
    `null` is final once the caller's own request has completed, once its
    connection is closed and the close has reached the Mac, or once a newer
    screenshot has made its frame stale. The third way is this document's
    addition; it follows from the `not_latest` rule.
69. `duration_ms` of a drag is a minimum. How deskhand looks through the
    drag-image window is a spike item.
70. `measured` on a success, and on an error of an admitted call, is taken
    at the last look. `log_unavailable` reports step 14 and `denied_app`
    reports the check that failed. `drag_end` is absent on `denied_app` and
    present on every other `measured` of a drag, and its app is identified
    on a success.
71. For every event the order is ledger write, checks, post. A ledger entry
    whose down event was never posted is cleared without a release.
72. The schemas forbid a `holder_id` member in the lease view, the `status`
    result and the `lease` result.
73. Whether `pointer` can reach the menu bar depends on which process owns
    it, which the spike records.
