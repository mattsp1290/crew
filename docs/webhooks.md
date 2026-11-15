# Outbound webhooks

A pending approval card, a finished request and a settled routine firing used to
reach only a client that polled or held an AG-UI stream open. Routines run with
nobody watching, so their outcomes went unseen. Migration 32 lets an owner
register webhook endpoints. Crew calls an endpoint when one of the events it
selected happens, with a small signed body that names what happened. The
receiver fetches the details with the owner's own token. Since migration 34 an
endpoint can ask for a short readable message instead. A chat or push service's
incoming-webhook URL accepts it and shows it to a person, so no service of the
owner's own is needed in between (see [formats](#formats)).

## What an endpoint receives

Each endpoint selects one or more kinds. `webhookKinds` in
`src/service/webhooks.ts` is the registry. Every kind is derived from one
committed [audit event](audit-trail.md), so Crew sends nothing for a change that
rolled back.

| Kind | Audit event | Sent when | Fields besides the common ones |
| --- | --- | --- | --- |
| `approval.pending` | `approval.requested` | a work-item card or a next-step question became pending: a member proposed a call that no standing grant approved | `conversationId`, `requestId`, `approvalId`, `toolName` |
| `request.finished` | `request.finished` | a request reached `completed`, `failed`, `cancelled` or `uncertain` | `conversationId`, `requestId`, `status` |
| `routine.firing_settled` | `routine.firing_settled` | a routine window was skipped, or its firing succeeded or failed | `routineId`, `scheduledFor`, `status` (`succeeded`, `failed` or `skipped`) |
| `routine.disabled` | `routine.disabled` with reason `consecutive_failures` | Crew disabled a routine after its tenth failure in a row. An owner's own disable is not sent | `routineId`, `status` (`consecutive_failures`) |

Every body also has `webhookId`, `eventId` (the audit event ID, a decimal
string), `kind`, `occurredAt` (the database time of the change, with
microseconds) and `memberId`. This is what an endpoint in the default `crew` format
receives; the other formats send a message made from it. For example:

```json
{"kind": "request.finished", "status": "completed", "eventId": "1234",
 "memberId": "UUID", "requestId": "UUID", "webhookId": "UUID",
 "occurredAt": "2026-11-12T08:15:30.123456Z", "conversationId": "UUID"}
```

Key order is not significant. A body is at most 1 KiB. The `status` of a
`request.finished` or `routine.firing_settled` body takes the values its audit
event allows, and a value that event gains later is sent as it is, so accept a
`status` you do not know and fetch the details.

**A body carries identifiers, the kind, the time and a status only.** It never
carries prompt text, reply text, a work-item note, tool arguments, member memory
text, the owner ID, a token or a secret. A strict schema for each kind refuses
any other field before the body is stored. To learn more, the receiver calls Crew
with the owner's bearer token: the request receipt
(`GET /v1/conversations/{conversationId}/requests/{requestId}`), the conversation
snapshot, whose `pendingApprovals` or `pendingQuestions` holds the card, or the
routine's firings (`GET /v1/routines/{routineId}/firings`).

## Formats

An endpoint chooses its format when it is created and keeps it: like the URL and
the kinds, a different format is a different endpoint. `webhookFormats` in
`src/service/webhooks.ts` is the registry, so a format is one entry there. The
column's CHECK bounds only the shape of a name, so a later release can add a format
without a migration. A gateway whose registry lacks an endpoint's format, because
a later release added it, leaves that endpoint's deliveries `pending` and
unattempted, as it does for an owner outside its token map. They are all due once
a gateway that knows the format runs again, so a channel then gets the backlog at
once, up to 100 messages per pass.

| Format | `Content-Type` | Body | Signed | Made for |
| --- | --- | --- | --- | --- |
| `crew` (the default) | `application/json` | the body above | yes | a receiver the owner runs |
| `slack` | `application/json` | `{"text": "..."}` | no | Slack incoming webhooks, Mattermost incoming webhooks, and Discord's Slack-compatible path (`.../api/webhooks/{id}/{token}/slack`) |
| `ntfy` | `text/plain; charset=utf-8` | the lines below, with the title in a `Title` header | no | an ntfy topic URL |

`slack` and `ntfy` send one fixed template per kind: a title, the kind's own
lines, and three lines every message ends with: `Member`, `Event` (the `eventId`)
and `Occurred at` (`occurredAt`).

| Kind | Title | The kind's own lines |
| --- | --- | --- |
| `approval.pending` | `Crew: approval pending` | `Tool`, `Conversation`, `Request`, `Approval` |
| `request.finished` | `Crew: request <status>` | `Conversation`, `Request` |
| `routine.firing_settled` | `Crew: routine firing <status>` | `Routine`, `Scheduled for` |
| `routine.disabled` | `Crew: routine disabled` | `Routine`, `Reason` (`consecutive_failures`) |

`slack` puts the title on the first line of `text` and each value in backticks, so
Slack, Mattermost and Discord show it as code. `ntfy` sends the lines as they are.
For one `request.finished`:

```text
slack: {"text":"Crew: request completed\nConversation: `UUID`\nRequest: `UUID`\nMember: `UUID`\nEvent: `1234`\nOccurred at: `2026-11-12T08:15:30.123456Z`"}

ntfy:  Title: Crew: request completed

       Conversation: UUID
       Request: UUID
       Member: UUID
       Event: 1234
       Occurred at: 2026-11-12T08:15:30.123456Z
```

**A `slack` or `ntfy` message carries what the `crew` body carries, and nothing
else.** Crew builds it when it sends each attempt, from the stored body. The kind's
strict schema must accept that body again first. A body the schema refuses, which
only direct SQL could store, is never sent; its attempt fails as `network`. A
`crew` delivery sends the stored body as it is, which that schema accepted before
it was stored. So no format carries prompt or reply text, a work-item note, tool
arguments, member memory or instructions, a handoff transcript, the owner ID, a
token or a secret. Every value is a UUID, a decimal event ID, a timestamp, a
status or a tool name from a closed list, so none can hold markup or a mention that
the service would act on. A message leaves out the `webhookId`. Every attempt of
one delivery sends the same bytes. Delivery is at least once, so a channel can
show one event twice; the `Event` line tells a person it is the same event.

The trust boundary moves, though. A `crew` body goes to a receiver the owner runs.
A `slack` or `ntfy` message goes to a third-party service, which keeps it under its
own terms, and to everyone who can read the channel or topic. They see the member,
conversation, request, approval and routine IDs, the event ID, the tool name, the
status and the times. Crew cannot recall a message it has sent.

The format changes only the body and headers of each attempt. Every format sends
`User-Agent: Crew-Webhooks/1`. The audit source, the fan-out, the outbox row and
the body it stores, the target checks before every attempt, the timeouts, the
4 KiB response read, the retries and the disabling of an endpoint after ten
deliveries given up in a row are the same for every format.

### Signing

Crew signs only `crew` deliveries. A `slack` or `ntfy` request has no
`Crew-Webhook-*` header. No chat or push service checks Crew's signature. The
headers would only hand the service the endpoint ID, a timestamp and a signature,
and would suggest an authentication that nobody performs. A message in a channel
or on a topic is not authenticated by Crew: anyone who has the URL can post one
that looks the same. A receiver that has to know a request came from Crew uses
`crew`. The create response still returns a secret for every format, so it has one
shape. Crew stores the secret of a `slack` or `ntfy` endpoint as plain text, like
any other, and never uses it.

### The URL is a credential

An incoming-webhook URL is the only thing that lets a sender post.
[Slack](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
states that the URL "contains a secret".
[Mattermost](https://docs.mattermost.com/developers/integrate/webhooks/incoming)
says "Treat this endpoint as a secret".
[Discord](https://docs.discord.com/developers/resources/webhook)'s URL holds the
webhook's token. On an [ntfy](https://docs.ntfy.sh/publish/) server without access
control, anyone who knows a topic can both publish to it and subscribe to it, so
the topic name is what keeps the messages private. Crew sends no `Authorization`
header, so a server with access control has to take its token from the URL; ntfy
reads one from an `auth` query parameter.

Crew stores, returns and audits every endpoint's URL the same way, whatever its
format, so these formats add no new place where a URL appears:

- It is stored as plain text in `birbcrew_ts.webhook_endpoints`, beside the
  secret, and erased with it when the endpoint is deleted. Copies remain in earlier
  backups and in dead tuples until vacuum, as for the secret.
- The create, read and list routes return it in full, to the owner's token only.
  Anyone who holds that token can read it; another owner gets `404 not_found`.
- The audit trail and its CSV export hold the host and port, never the path or the
  query. Delivery rows hold no URL. Crew prints no URL, an error never names one,
  and `target_refused` gives no reason.
- The recovery manifest counts rows; the `application-postgres` artifact of a
  recovery generation holds every URL, as it holds every secret.

A leaked `slack` or `ntfy` URL does more harm than a leaked `crew` path. A `crew`
receiver checks the signature, so its path alone cannot forge an event. A `slack`
or `ntfy` URL is the only thing a sender needs, and on an open ntfy topic it also
lets anyone read the messages. Unlike the secret, which only the create response
returns, the URL is in every read. If one leaks, revoke it at the service, delete
the endpoint, and create one with the new URL.

### What the service does with a message

This is not a Slack, Mattermost, Discord or ntfy integration. Crew holds no
account, app token or OAuth grant for any of them, and calls none of their APIs.
The incoming-webhook URL, which can only post, is the one secret it keeps. Crew
posts only to the URL the owner registered, and the service shows the message to
whoever the owner set it up for. [The first-milestone brief](first-milestone.md)
left sending to Slack out of that milestone. A `slack` endpoint does post to Slack,
but only to a URL the owner supplies. Crew sends no email, SMS or push of its own.

- What the service does next is the service's and the owner's choice. ntfy reads
  options from the URL's query as well as from headers. On a server that has email
  enabled, an `email` parameter in a topic URL makes ntfy forward each message by
  email. `Title` is the only ntfy option header Crew sends.
- A message names a card but cannot decide one: a person still uses a client with
  the owner's token. There are no buttons and no replies.
- Crew does not read `Retry-After`. A service that answers `429` gets the attempt
  retried on Crew's own schedule, so a burst larger than a service's rate limit can
  be given up after ten attempts, and ten given up in a row disable the endpoint.
  Each endpoint's due deliveries go one after another, without a pause.
- A hook the service has revoked or archived answers with a `4xx` status: an
  ordinary failed attempt.

## Signature

Each `crew` request carries:

| Header | Value |
| --- | --- |
| `Crew-Webhook-Id` | the endpoint's `webhookId` |
| `Crew-Webhook-Event` | the `eventId` |
| `Crew-Webhook-Timestamp` | Unix seconds when this attempt was sent |
| `Crew-Webhook-Signature` | `v1=` and the hex HMAC-SHA256 of `<timestamp>.<body>` |
| `Content-Type` | `application/json` |
| `User-Agent` | `Crew-Webhooks/1` |

The HMAC key is the UTF-8 bytes of the endpoint's secret, exactly as the create
response returned it. `Crew-Webhook-Id` names the endpoint, not the message: every
delivery to one endpoint carries the same value. A receiver:

1. reads the raw body bytes before parsing them;
2. refuses a timestamp more than five minutes from its own clock, which rejects a
   replayed old request;
3. computes the signature over the timestamp header, a `.`, and the raw body, and
   compares it with the header in constant time;
4. takes `webhookId` and `eventId` from the signed body as the event's identity.
   Crew may send one event more than once (see [delivery](#delivery)), each time
   with a new timestamp and signature: retries span about three hours, a gateway
   crash can resend later, and a handler slower than Crew's 10-second timeout sees
   the retry while it still runs. Record the identity **in the same transaction
   as the effect** (or make the effect unique on the identity), so a crash between
   them can neither lose the event nor act twice. Answer an identity already
   recorded with `2xx` and do nothing, so Crew stops retrying it. If handling
   fails, record nothing and answer with an error, so the retry is handled. Keep
   identities for at least 24 hours. A receiver that cannot finish in a few
   seconds should record the identity and a job in one transaction, answer `2xx`,
   and do the work afterwards.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// The event's identity when the request is genuine and fresh; null when it must be refused.
function verify(secret, headers, rawBody, now = Date.now() / 1000) {
  const timestamp = headers["crew-webhook-timestamp"] ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300) return null;
  const expected = Buffer.from("v1=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  const given = Buffer.from(headers["crew-webhook-signature"] ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const { webhookId, eventId } = JSON.parse(rawBody);
  return `${webhookId}/${eventId}`;
}

// const key = verify(...);                      null: answer 401
// BEGIN;
//   INSERT INTO handled (key) VALUES (key) ON CONFLICT DO NOTHING;   no row inserted: COMMIT, answer 200
//   ...the effect, or a job row for it...
// COMMIT;                                        answer 200; on any failure ROLLBACK and answer 500
```

## The secret and where it is kept

Crew generates each endpoint's secret: 32 random bytes, encoded as 43 base64url
characters. The `201` response to the create that inserted the endpoint is the
only place it appears. A replayed create, the read and list routes, the audit
trail, the recovery manifest and Crew's own output never contain it. Store it
when you create the endpoint; if the response is lost, delete the endpoint and
create another.

Crew stores the secret as plain text in `birbcrew_ts.webhook_endpoints`. The
gateway keeps bearer tokens only as SHA-256 digests, because it only compares
them; an HMAC key has to be read back to sign, so a digest cannot replace it, and
Crew has no vault (see row 20 of [the feature comparison](feature-comparison.md)).
The limits that follow from this:

- Anyone who can read the application database, or the `application-postgres`
  artifact of a [recovery generation](coordinated-recovery.md), can read every
  secret and sign requests that receivers accept. Protect backups as the
  recovery guide already asks.
- Anyone with the signing key can sign arbitrary bodies. Crew's payload schema
  does not constrain a forged request. Its consequences depend on what the
  receiver validates and does. Fetching authoritative state from Crew with a
  separately held bearer token can reduce those consequences; a valid signature
  alone does not prove that Crew sent the request after its key leaked.
- There is no rotation in place. Create a new endpoint, move the receiver to its
  secret, then delete the old one. Deleting an endpoint erases its secret and URL
  from the row; copies remain in earlier backups and in PostgreSQL's dead tuples
  until vacuum.

Encrypting the column with an operator key was not chosen: every gateway and every
restore target would need that key, a lost key would silently break every
endpoint, and the gateway process would still hold it. A vault is a separate
feature.

## Routes

All routes need the bearer token. The owner comes only from it; another owner's
endpoint is `404 not_found`. Bodies and query parameters are strict: an unknown or
repeated field fails `400 invalid_input`.

| Route | Purpose |
| --- | --- |
| `POST /v1/webhooks` | Create `{ "requestId", "url", "kinds" }`, optionally with `"format"`; `201` with the endpoint and its `secret` |
| `GET /v1/webhooks?after=&limit=` | The owner's endpoints in every state, including deleted ones, ordered by `webhookId`; `{ apiVersion, webhooks, nextAfter, hasMore }` |
| `GET /v1/webhooks/{webhookId}` | One endpoint, including a deleted one |
| `POST /v1/webhooks/{webhookId}/enable` | Body `{}`; `200` with the endpoint |
| `POST /v1/webhooks/{webhookId}/disable` | Body `{}`; `200` with the endpoint |
| `DELETE /v1/webhooks/{webhookId}` | Tombstone: erases the URL and secret, cancels undelivered rows; `200` with the endpoint |
| `GET /v1/webhooks/{webhookId}/deliveries?before=&limit=` | Delivery rows, newest event first; `{ apiVersion, deliveries, nextBefore, hasMore }` |

```json
{
  "apiVersion": "1", "webhookId": "UUID", "url": "https://hooks.example.com/crew",
  "host": "hooks.example.com", "kinds": ["approval.pending", "request.finished"],
  "format": "crew", "state": "enabled", "disabledReason": null, "consecutiveFailures": 0,
  "createdAt": "2026-11-12T08:03:12.421Z", "secret": "43 base64url characters, create only"
}
```

`kinds` is one to four distinct kinds and is returned sorted. `format` is `crew`,
`slack` or `ntfy`, and `crew` when the create leaves it out; any other value fails
`400 invalid_input`. Every read returns it, including a tombstone's, and an endpoint
created before migration 34 reads as `crew`. `url` is
normalized (lowercase host, default port dropped) and is `null` once the endpoint
is deleted; `host` stays. `requestId` makes a create idempotent: the same owner
sending the same `requestId`, URL, kinds and format gets the endpoint back without
its secret. A different URL, kinds or format with that `requestId` fails
`409 conflict` (a replay that leaves the format out names `crew`), and a
replay of a deleted endpoint fails `409 webhook_deleted`. A target that the
[network rules](#network-safety) refuse, or whose name does not resolve within 5
seconds, fails `400 target_refused`, with no reason, so the route does not tell a
caller which names resolve to private addresses. A create or enable past the limit
fails `409 webhook_limit`; enabling or disabling a deleted endpoint fails
`409 webhook_deleted`. Repeating the current state changes nothing and returns the
endpoint.

A delivery is `{ eventId, kind, state, reason, attempts, nextAttemptAt,
lastAttemptAt, lastOutcome, lastStatusCode, createdAt, settledAt }`. Pass
`nextBefore` as the next `before`. `limit` is 1 to 100 on both lists, default 100.

| Endpoint state | Meaning |
| --- | --- |
| `enabled` | Receives events that occur from the moment it was last enabled |
| `disabled` | `disabledReason` is `owner`, `consecutive_failures` or `recovery_restore`. Receives nothing; events that occur meanwhile are never sent |
| `deleted` | A tombstone that keeps its ID, host, kinds and deliveries |

| Delivery state | Meaning |
| --- | --- |
| `pending` | Waiting for its next attempt at `nextAttemptAt` |
| `delivering` | A gateway holds a 60-second lease and is sending it |
| `delivered` | The endpoint answered `2xx` |
| `failed` | `reason: attempts_exhausted`: ten attempts failed |
| `cancelled` | `reason` is `endpoint_disabled`, `endpoint_deleted` or `recovery_restore` |

`lastOutcome` is `delivered`, `http_status` (any other status, including a
redirect; `lastStatusCode` has it), `timeout`, `network`, `address_refused` (the
name now resolves to a refused address), `url_refused` (the URL no longer passes,
for example after the operator turned insecure targets off) or `interrupted` (the
gateway holding the last attempt stopped before recording it).

## Delivery

The source of truth is the audit trail, written in the same transaction as each
change. No feature writes a second notification row, and no audited transaction
reads or writes a webhook table, so a slow, dead or locked webhook path never
delays or fails the change that caused an event.

Every gateway runs a `WebhookDispatcher` beside the routine dispatcher, on its own
unreferenced 1-second interval that the gateway clears when it closes. Each pass:

1. Reads the recovery phase. A held or restored installation ends the pass with
   nothing read or written. With no enabled endpoint, nothing that has occurred can
   be sent (an endpoint receives only events from when it is enabled), so at most
   once a minute the pass moves the cursor to the audit horizon, if it can read one
   without waiting, and ends.
2. **Fans out.** It reads the audit horizon the way `GET /v1/audit` does, so no
   transaction that commits late is skipped, and takes the cursor row
   (`webhook_cursor`) with `FOR UPDATE SKIP LOCKED`: one gateway fans out at a
   time. It reads, per owner with an enabled endpoint, up to 256 audit rows of the
   four source types after the cursor, records one `pending` delivery for each
   enabled endpoint of that owner that selected the kind and was enabled when the
   event occurred, and moves the cursor. A delivery is unique on
   `(webhook_id, event_id)`. Up to eight batches run per pass. Creating or
   enabling an endpoint holds the cursor in share mode until it commits and reads
   its enable time after taking it, so that time falls after any fan-out in
   progress, and a fan-out never passes an event that occurred once an endpoint
   was enabled. A fan-out shares each endpoint row it delivers to, so a disable
   either waits and then cancels what the fan-out inserted, or commits first and
   the fan-out skips the endpoint.
3. **Claims and sends.** It claims, with `FOR UPDATE SKIP LOCKED` and a 60-second
   lease, one due delivery for each enabled endpoint it is not already sending to,
   of owners in its token map, up to 32 endpoints. It does not wait for them. Each
   endpoint's due deliveries then go one after another, up to 100 before the next
   pass takes over, so a slow endpoint holds up only its own deliveries.

The attempt count rises when a delivery is claimed, so an attempt counts even if
its gateway dies mid-request. A failed attempt waits 30 seconds, doubling each
time, at most an hour: the tenth and last attempt comes about three hours after
the first, and then the delivery `failed`. A `2xx` answer resets the endpoint's
count of deliveries given up in a row; the tenth in a row disables the endpoint
with reason `consecutive_failures`, in the transaction that records it, and
cancels its undelivered rows. Only the gateway holding the lease records an
attempt.

Delivery is at least once and unordered. A gateway that stops, or loses its
database connection, between sending and recording an attempt leaves the lease to
expire, and any gateway sends that event again; the abandoned attempt still
counts. If that was the tenth attempt, the delivery fails with `lastOutcome:
interrupted` instead of being sent an eleventh time. Deliveries to one endpoint run one
at a time per gateway, so with several gateways an endpoint can receive several at
once. Sort by `eventId` if order matters; compare event IDs as 64-bit integers.

A gateway delivers only for owners in its token map, as the routine dispatcher
fires only for them. An owner removed from every gateway's map keeps their rows
`pending`, unattempted. Give every gateway the same map.

## Handoffs, approval expiry and usage budgets

These features add no kind. What each of their outcomes sends follows from the
audit rows above:

| Outcome | Audit rows | Sent |
| --- | --- | --- |
| A Claude or Pi card reaches its [approval deadline](approval-expiry.md) | `approval.expired`, then the request's `request.finished` | `approval.pending` was sent when the card became pending. Nothing is sent at the expiry. The turn goes on to its reply with a cancelled result, so `request.finished` follows with the status the request ends with, normally `completed` |
| An owner cancels or decides a card | `request.cancellation_requested` or `approval.decided`, then `request.finished` | `request.finished` only |
| A request is refused for its member's [usage budget](usage-metering.md) | `usage.request_refused` | Nothing: the request has no admission and never finishes. The submit itself answered `409 usage_limit` or `409 usage_limit_closed` |
| A routine firing fails with `usage_limit` or `approval_expired` | `routine.firing_settled` with that reason | `routine.firing_settled` with status `failed`; the tenth failure in a row also sends `routine.disabled` |
| A [conversation handoff](handoffs.md) commits | `conversation.handed_off`, the target's `conversation.opened` | Nothing |
| A handoff is refused for its target's budget | None: the handoff writes nothing | Nothing |
| The handoff's reserved first request finishes | `request.finished` on the target, with the handoff as initiator | `request.finished` with the target's `memberId`, `conversationId` and the reserved `requestId` |
| A member is spawned with [instructions](member-instructions.md) | `member.instructions_set` | Nothing |
| An [instruction pack](instruction-packs.md) is created or deleted, or a member is spawned with packs | `instruction_pack.created`, `instruction_pack.deleted`, `member.instruction_packs_attached` | Nothing |

No kind says that a card stopped being pending, whether by a decision, a cancel or
an expiry; the request's `request.finished` follows each. Its body does not say
which: a finish after an expiry looks like a finish after an owner's cancel. The
request receipt's `expiredApproval` tells them apart. A routine firing's body
carries its status, not its reason; `GET /v1/routines/{routineId}/firings` has the
reason. No body names an initiator, so a handoff's first request looks like any
other request of the target; its receipt and audit rows name the handoff. No body
carries a handoff transcript, member instructions or memory text.

The handoff transaction, the expiry that the conversation workflow's timer
settles, request admission, including a budget refusal, and a routine firing's
settlement write their audit rows and nothing to a webhook table, so a stalled
delivery path never delays or fails them; the dispatcher reads their rows after
they commit.

## Network safety

A webhook is a request from inside the installation to an address an owner
chose. `src/service/webhook-target.ts` is the one module that decides where Crew
may connect and makes the request. It checks a target when it is created and
again before every attempt, whatever the endpoint's format:

- `https` only. A URL with a user name, password or fragment is refused, as is a
  host that is not a plain DNS name or an IP literal. URLs are at most 2048 bytes.
- The host is resolved by querying the configured DNS servers for A and AAAA
  records (the hosts file is not read, and the lookup does not occupy one of
  Node's few worker threads, so a name whose servers never answer cannot starve the
  gateway), and every address it resolves to must be allowed: one refused address
  refuses the name. Refused always: unspecified, link-local
  (`169.254.0.0/16` and `fe80::/10`, which hold the cloud metadata services),
  the other metadata addresses `src/service/webhook-target.ts` lists
  (`100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`, `fd20:ce::254`),
  multicast, broadcast, reserved, documentation and benchmark ranges, and IPv6
  forms that embed an IPv4 address (mapped, NAT64, 6to4, Teredo). IPv6 outside
  `2000::/3` is refused. Refused by default: loopback, RFC 1918, shared address
  space (`100.64.0.0/10`) and unique local IPv6 (`fc00::/7`). A metadata address
  that a provider puts inside a private range and that is not on the list is
  refused only by default. Every spelling of an IP literal that the URL parser
  normalizes, such as `0x7f000001`, is checked as the address it becomes.
- Any port is allowed. An endpoint can be any public host and port, so a service
  that trusts requests from the gateway's egress address because of where they
  come from should not.
- The connection goes only to the addresses that check accepted: the resolution is
  passed to the socket, so DNS cannot answer differently between the check and the
  connection. TLS still verifies the certificate against the host name.
- No redirect is followed: a `3xx` is a failed attempt. No cookie, no
  `Authorization` header and no Crew credential is sent. The request has a
  5-second connect (and TLS handshake) timeout and a 10-second total timeout. The
  status settles the attempt as soon as the headers arrive, and Crew closes the
  connection once 4 KiB of the body have arrived. The response body is never
  stored.

`BIRBCREW_WEBHOOK_ALLOW_INSECURE_TARGETS=1` on the gateway allows plain `http` and
loopback and private addresses. It is off unless set to exactly `1`, including in
deployed installations; there is no production-mode restriction. This setting
permits public HTTP receivers as well as private HTTPS receivers, and is not
limited to Tailscale or NetBird peers. A private network used to reach Crew does
not protect an outbound public HTTP connection. Enable it only when the operator
accepts both HTTP and private-address destinations. It never allows link-local,
the listed metadata addresses or the other special addresses.
`capabilities.webhooks.schemes` reports only `https`, the
default, and `insecureTargets` says the setting exists and is off by default; neither
reports whether this gateway has it on. Names are resolved through DNS only, so
`localhost` and other hosts-file names may not resolve: test with an IP literal
such as `http://127.0.0.1:8080/`.
Turning it off later refuses the endpoints it let in at their next attempt, with
`url_refused` or `address_refused`.

Each request uses its own connection with no proxy: `HTTP_PROXY`, `HTTPS_PROXY`
and `NODE_USE_ENV_PROXY` do not apply to it (checked on Node 24.22.3). TLS trusts
Node's bundled certificate authorities, plus any the operator adds through
`NODE_EXTRA_CA_CERTS`, and presents no client certificate.

## Audit

| Type | Actor | Recorded when | One row per | Payload |
| --- | --- | --- | --- | --- |
| `approval.requested` | system | `proposeLocked` inserts a call no standing grant approved: a pending card or question | `approvalId` | `approvalId`, `invocationId`, `toolName`, `argumentDigest` |
| `webhook.created` | owner | an endpoint is created | endpoint + revision | `webhookId`, `revision` (1), `host`, `kinds`, `format` |
| `webhook.enabled` | owner | enable | endpoint + revision | `webhookId`, `revision`, `host` |
| `webhook.disabled` | owner, or system for `consecutive_failures` and `recovery_restore` | disable, the tenth delivery given up in a row, or a restore resuming | endpoint + revision | `webhookId`, `revision`, `host`, `reason` |
| `webhook.deleted` | owner | delete | endpoint + revision | `webhookId`, `revision`, `host` |

`host` is the URL's host and port. The trail never holds the path, the query or the
secret: a URL path can itself be a credential, and for a `slack` or `ntfy` endpoint
it always is. A `webhook.created` row written before migration 34 has no `format`;
that endpoint is `crew`. Endpoints belong to the owner, not
to a member, so `webhook.*` rows, like the [`instruction_pack.*`](instruction-packs.md#audit)
rows, have a `null` `memberId`, and their CSV cell is empty. A [`memberId` filter](audit-filters.md) never
matches them; select them with `eventType`. Deliveries are not audited; their rows
are the record.

## Recovery

The three tables carry the `recovery_write_barrier` trigger, so a held
installation refuses every endpoint change and delivery write, and capture counts
them. The dispatcher also stops at a hold by itself; an attempt already in flight
may still reach its receiver.

When a restored installation resumes, in the transaction that activates it, Crew:

- disables every enabled endpoint with reason `recovery_restore`, auditing each
  `webhook.disabled` with the system as actor;
- cancels every `pending` or `delivering` row with reason `recovery_restore`;
- moves the cursor past every restored audit event.

The restore can bring back an endpoint the owner deleted after the recovery point,
perhaps because its secret leaked, with its URL and secret. And an undelivered row
at the recovery point may have reached its receiver on the timeline the restore
discarded; sending it again, or sending events the restored timeline has already
passed, would tell a receiver that something happened twice, or happened when it
no longer had. So nothing from before the restore is sent. The owner reviews each
endpoint and enables it again; it then receives events that occur from then on. A
held source that resumes without a restore keeps its endpoints and their pending
rows. This follows what [standing grants](standing-grants.md#recovery) and
[member memory](memories.md#recovery) do: a restore never brings back authority to
act that the owner may have withdrawn.

Like the routine dispatcher, the webhook dispatcher runs only in gateways, which
[coordinated recovery](coordinated-recovery.md#scheduled-routines-are-consumer-ingress)
treats as consumer ingress.

## Upgrade

Migration 32 creates the three tables and changes only `audit_events` among
existing tables: it drops `NOT NULL` from `member_id`, adds
`audit_events_member_check` (only the `webhook.*` types may leave it null) and
replaces `audit_events_type_check` with every clause of migration 31's, unchanged,
plus clauses for the five new types, both `NOT VALID`, and builds two empty partial
unique indexes. Dropping `NOT NULL` is a catalog change; no row is rewritten or
checked. Until `migrate()` commits it holds, on existing tables only:

| Table | Modes (observed in `pg_locks` on PostgreSQL 17) | Why |
| --- | --- | --- |
| `audit_events` | `ACCESS EXCLUSIVE`, `ACCESS SHARE`, `SHARE` | the column and CHECKs, the cursor's starting point, and the two index builds |

It takes the lock with `LOCK ... NOWAIT` and retries every 20 to 100 ms, as
migrations 25 to 31 do, so it never waits in a lock queue where every audited write
would queue behind it; applied after 31 in one transaction, it already holds the
lock. A running native turn's admission transaction holds nothing on
`audit_events`, so the migration does not wait for it. After 60 s without the lock
it fails with `55P03`, applies nothing, and the process exits. The cursor starts at
the newest audit event, so no event from before the upgrade is ever sent.

Recreate any development database that ran this feature's earlier
`030-webhooks.sql`, before it was renumbered, or restore a backup taken before that
build; no release shipped that file. One that ran this feature without all of 27
to 29 from main records version 30 without them, and `migrate()` refuses it with
`Migration N would apply after migration 30` for the lowest missing N. One that had
27 to 29 from main records version 30, which `migrate()` takes for the audit
filters, and migration 32 then fails because `webhook_endpoints` already exists.
Either way nothing is applied.

Two changes reach existing clients. `GET /v1/audit` gains five event types, and
`memberId` is `null` on the `webhook.*` rows; a consumer that requires a member on
every row must accept `null` for those types. And every pending card or question
now also appends `approval.requested`. Processes of an earlier release write no
such row, so stop them before the first upgraded process starts, as for every
migration (see [persistent deployment](persistent-deployment.md#upgrades)).

Migration 34 adds `webhook_endpoints.format`, `NOT NULL` with the constant default
`crew`. Its CHECK takes a name that is a lowercase letter followed by up to 31
lowercase letters, digits or underscores. The migration also replaces 032's guard
function with one that keeps the format from changing, and changes no other
table. The default is a constant, so no row is rewritten. Until `migrate()`
commits, the only application table it holds is `webhook_endpoints`, in
`ACCESS EXCLUSIVE` (observed in `pg_locks` on PostgreSQL 17); it holds nothing on
`audit_events`. No transaction that audits a request, card or routine touches a
webhook table, so none waits for it. Only the webhook routes, the dispatcher and a
restore do, and with the earlier release's processes stopped, none of them runs
before `migrate()` commits.

The migration was numbered 35 in review and took 34, the next number after 33, when it
was restacked onto `main`. `migrate()` refuses to apply a migration numbered below one
already applied, so a database that ran this branch under number 35 must be recreated.

Three changes reach existing clients. Every route that returns an endpoint returns
its `format`, `webhook.created` rows gain `format`, and `capabilities.webhooks` gains
`formats`, `defaultFormat` and `signature.formats`. An earlier release run against
the upgraded database ignores the column and sends the `crew` body to every
endpoint, including `slack` and `ntfy` ones. Slack refuses it for lack of `text`, and
ntfy shows the JSON as the message, which still holds only IDs. Disable such
endpoints before you run an earlier release.

## Limits

| Limit | Value |
| --- | --- |
| Enabled endpoints per owner | 10, enforced by a trigger under a per-owner lock, as routines are |
| URL | 2048 bytes |
| Kinds per endpoint | 1 to 4 |
| Formats | `crew`, `slack`, `ntfy`; one per endpoint, fixed at creation |
| Stored body | 1 KiB; a `slack` or `ntfy` message made from it is shorter (about 350 bytes at most) |
| Attempts per delivery | 10, over about three hours |
| Deliveries given up in a row before the endpoint is disabled | 10 |
| Lease | 60 s |
| DNS, connect and total timeouts | 5 s, 5 s, 10 s |
| Response body read before the connection closes | 4 KiB |
| Endpoints one gateway sends to at once | 32 |

## Not covered

- Other audit types are not deliverable: spawns, opens, admissions, decisions,
  grants, routine lifecycle changes by the owner, memory and webhook changes,
  approval expiries, handoffs, member instructions, instruction packs, budget changes
  and budget refusals (see [what they send](#handoffs-approval-expiry-and-usage-budgets)).
  Adding a kind means adding it to `webhookKinds` and to the two CHECKs in a
  migration.
- Inbound webhooks that start a request (row 24 of the comparison).
- Delivery to anything but an HTTPS endpoint. Crew sends no email or SMS and runs
  no push service or chat app of its own; a `slack` or `ntfy` endpoint posts to a
  URL the owner supplies, and that service does the rest.
- A message template an owner writes, another layout (Microsoft Teams cards,
  Google Chat, Gotify, Pushover), ntfy priority, tags or click actions, Slack
  blocks or buttons, and deciding a card from a chat.
- Honoring `Retry-After`, and pacing deliveries to a service's rate limit.
- Secret rotation in place, custom headers, a certificate authority for one
  endpoint, client certificates and egress through a proxy.
- Ordering, a manual redelivery route, and retention of delivery rows, which grow
  with events times endpoints, as routine firings do.
- A card can be gone before its `approval.pending` delivery arrives: a Codex card
  after its live-call deadline (at most 170 s), and a Claude or Pi card after its
  approval deadline (at least 60 s), while retries span about three hours. A Claude turn
  recovered to a pending decision is not finished, so no `request.finished` is
  sent for it until reconciliation closes recovery.
- An event that occurs while an endpoint is disabled is never sent to it, even
  after the endpoint is enabled again.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases.

```sh
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:webhooks
npm run test:audit
```

`webhook-target.test.ts` needs no database. It checks the address rules for every
listed range under both settings, URL refusals including credentials, fragments
and every loopback spelling, that one refused DNS answer refuses the name and an
unanswered lookup times out, and, against local servers, that a request connects
only to the pinned address (a name only the test resolver knows), sends no
cookie or credential, follows no redirect, ends at its connect and total timeouts
and closes a response after a few KiB.

`webhooks.test.ts` runs each scenario in its own database with a local HTTP
receiver in the test process and a settable clock. It checks:

- strict, idempotent, owner-scoped routes; the secret in the first create response
  only; `target_refused` before anything is written; the limit of ten, also under
  15 concurrent creates; one endpoint and one secret for a concurrent duplicate;
  tombstones that erase URL and secret; and the audit rows, with the host and
  without the path or secret, in JSON and CSV;
- each kind delivered once to each endpoint that selected it, through the real
  proposal and commit paths, with the exact body, a signature the test verifies
  independently, and no prompt, reply, note or secret; nothing for an event before
  the endpoint existed or for an owner's own routine disable;
- a card that expires: `approval.pending`, then `request.finished` with status
  `completed` and no expiry mark, nothing for `approval.expired`, and the expiry
  settling while every webhook table is locked;
- a handoff: nothing for the handoff, and the reserved request's finish sent for
  the target with its member, conversation and request and no initiator, the
  handoff and the reserved request's admission committing while every webhook
  table is locked; neither path's bodies or headers carry the prompt, reply, note,
  transcript, member instructions, memory text or secret;
- a request refused for its budget, refused while every webhook table is locked,
  sending nothing, and a routine's two refused firings sent as failed, then its
  switch-off; every firing status and reason the dispatcher names delivered;
- a non-`2xx` answer retried on the backoff schedule until it gives up after ten
  attempts, and a later success resetting the count;
- ten deliveries given up in a row disabling the endpoint, with a system
  `webhook.disabled` row, cancelling the rest and sending nothing while disabled;
- a hanging endpoint timing out without holding up the pass or another endpoint,
  this gateway starting no second attempt for it meanwhile, and audited changes
  committing while every webhook table is locked;
- two dispatchers delivering 72 events to four endpoints once each;
- a fan-out waiting for an audit writer whose lower ID commits after a higher one,
  then delivering both;
- an attempt abandoned by a stopped dispatcher, untouched until its lease ends,
  then sent again; the stale holder's own settle, run late, changing neither the
  row nor the failure count; and a lost tenth attempt failing as `interrupted`
  without a send;
- an audit row that does not fit its kind skipped without holding up later
  events;
- 300 events, more than one fan-out batch, delivered in full, at most 100 per
  endpoint per pass, with the cursor ending at the horizon;
- the cursor moving to the end of the trail, at most once a minute, while no
  endpoint is enabled, but not while an enable holds the cursor (and without
  waiting for it), nor once an endpoint is enabled;
- the gateway's own loop delivering for the owners it serves, and sending and
  fanning out nothing once it closes;
- owner isolation, and owners outside a gateway's token map;
- a name that now resolves to a metadata address, alone or beside an allowed one,
  refused at delivery, and an `http` endpoint refused once insecure targets are off;
- the restore case: capture counting the three tables, nothing written or sent
  while held, a source that resumes keeping its endpoints, and a restored
  installation (the database accepting its own capture as a restore, as
  `recovery.test.ts` does without `pg_dump`) disabling them, cancelling the pending
  row, moving the cursor and sending only later events after an enable;
- each format, with a card and a finished request through the real proposal and
  commit paths and the two routine rows appended as the routine dispatcher does:
  the exact bytes and headers of every kind; the `crew` body unchanged byte for byte, in PostgreSQL's
  key order, and equal to the stored row; the same outbox row for every format; a
  signature on `crew` only; and no prompt, reply, note, memory or instruction text
  or secret in any body or header;
- a readable message refused for any body its kind's strict schema refuses, such a
  body never sent while a well-formed one to the same endpoint is, and an endpoint
  whose format the gateway does not know left unattempted;
- a `slack` endpoint made through the routes and delivered by the gateway's own
  loop to a local stub that follows Slack's documented answers (refusing a body that
  is not JSON as `invalid_payload` is the stub's own rule); the stub answering `ok`
  to it, `no_text` to a `crew` endpoint at the same hook, `invalid_payload` to an
  `ntfy` one, and `no_service` to a revoked hook, each refusal an ordinary failed
  attempt; the
  format in every read, its replay rules, and the hook's path absent from the
  trail, its CSV and the delivery rows;
- the backoff schedule for each format, every attempt sending the same bytes;
- the tombstone, history and cursor triggers, and the audit member CHECK;
- migration 32 on a version-31 database: every constraint and trigger it finds
  kept, and its type CHECK keeping every clause of 031's, as PostgreSQL stores
  them, unchanged and in order; its locks, no rewrite, `NOT VALID` CHECKs,
  the cursor at the newest event, that it retries instead of queueing behind an
  audited writer, and that it completes while a native turn holds its admission;
- migration 34 on a database without it: an existing endpoint read as `crew`,
  every other constraint, trigger, function, index and column kept, the guard
  changed only by the format, the format refused as a change, no rewrite, and
  `webhook_endpoints` the only table it locks.

Not claimed: no test posts to a real Slack, Mattermost, Discord or ntfy service.
The stub follows Slack's documented answers, and the other shapes rest on each
service's documentation. No test sends over TLS, so certificate verification and the
`secureConnect` path are exercised only by the connect-timeout test, which never
completes a handshake. No test queries real DNS: the resolver is replaced, so the
c-ares lookup and its timeouts are not exercised. No test races a create, enable
or disable against a fan-out in progress; the lock order that makes them safe is
argued above, not shown. The service proofs do not run a webhook.
