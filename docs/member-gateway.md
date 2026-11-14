# Observe a durable Claude, Codex or Pi conversation

Start the worker and its registered fixture or approved account profile as described in the [member profile guide](member-profiles.md). The gateway uses the same PostgreSQL database and Temporal endpoint as that worker.

Create a local gateway configuration with an unused port and a mapping from SHA-256 bearer-token digests to owner IDs. Use high-entropy tokens. For example, this script writes an ephemeral token and configuration to owner-readable files in your current directory. Run it in a private directory outside the repository.

```sh
node --input-type=module <<'JS'
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const token = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(token).digest("hex");
writeFileSync("owner.token", token, { mode: 0o600, flag: "wx" });
writeFileSync("gateway.json", JSON.stringify({ port: 0, tokenHashes: { [digest]: "local" } }), { mode: 0o600, flag: "wx" });
JS
npm --prefix /path/to/birbcrew run --silent gateway -- /absolute/path/to/gateway.json
```

The gateway prints its loopback URL. Send the token as an `Authorization: Bearer <token>` header on every request. No route is served without it. A request without a valid token gets `401 {"error":"authentication_required"}` before the gateway touches PostgreSQL or Temporal. That `401` is the supported liveness signal; see [Health](persistent-deployment.md#health). All command bodies use JSON. Run the npm command from the repository with the path to the generated gateway configuration.

| Method and path | Body or response |
| --- | --- |
| POST /members | Send a new `requestId` (UUID), `engine` (`claude`, `codex` or `pi`) and a registered `profile`. Returns the member identity. Reuse the same body for retries. |
| POST /conversations | Send `memberId` and a new `conversationId` (UUID). Returns the initial public snapshot. |
| GET /conversations/{id} | Returns `messages`, `state` and the committed `cursor`. State includes the member, engine, profile, phase, pending approvals and any pending questions. |
| POST /conversations/{id}/inputs | Send a new `requestId` and `text`. A 202 response acknowledges the input. Retry ambiguous acknowledgements with the same ID and text. |
| POST /conversations/{id}/human | Copy `memberId`, `requestId`, `invocationId`, `approvalId` and `version` from the pending card. Set `choice` to a value in its `choices` array. Cards in `state.pendingApprovals` accept `approve` or `deny`, and a card with a `standingChoices` array also accepts `allow_conversation` or `allow_always` (see [standing grants](standing-grants.md)). Cards in `state.pendingQuestions` accept `inspect` or `test`. The response reports the recorded choice. |
| POST /conversations/{id}/cancel | Send the active `requestId`. The command acknowledges cancellation. Both observers receive the terminal state after native cleanup, then `RUN_FINISHED` with `outcome: {"type":"cancelled"}`, or `RUN_ERROR` if the native stop is not confirmed. |
| POST /conversations/{id}/events | Attach a read-only AG-UI observer using the route's conversation ID as its thread ID. |

The versioned contract also serves `GET /v1/health` (PostgreSQL and Temporal readiness, `503` when either is unavailable) and `GET /v1/members` and `GET /v1/conversations` (the token owner's members and conversations, keyset-paginated). They have no unversioned form and use the same bearer token. See [the integration API](integration-api-v1.md#health-and-listing) for their response shapes and parameters.

Each fresh observer receives a committed message and state snapshot, followed by frames after its cursor. Each protected call has a public ID used for the tool call, result and decision card. The stream stays open at ordinary input completion and while a decision is pending. It emits `RUN_FINISHED` when the conversation ends. When the input that uses its last turn completes, the event has no `outcome`, which AG-UI reads as success. When a cancelled request's native work has ended, it carries `outcome: {"type":"cancelled"}`, which the official client reports as a cancelled run. A new conversation has 128 turns; one created before [bounded conversations](bounded-conversations.md) keeps four. A failed native turn, or a cancellation whose native stop is not confirmed, emits `RUN_ERROR`. Disconnecting an observer releases its connection while the workflow continues.

To attach the official client, construct an empty client each time. Input submission and human decisions use their separate HTTP routes.

```js
import { HttpAgent } from "@ag-ui/client";
const agent = new HttpAgent({
  url: baseUrl + "/conversations/" + conversationId + "/events",
  threadId: conversationId,
  headers: { Authorization: "Bearer " + token },
});
await agent.runAgent({}, {
  onMessagesChanged({ messages }) { console.log(messages); },
});
```

An explicit `?after=<cursor>` must match the current snapshot. A stale value returns HTTP 410 before streaming. A live observer that falls more than 256 frames behind receives `RUN_ERROR` with `CURSOR_EXPIRED`. In either case a fresh observer without `after` receives the latest snapshot. Conversations whose turns predate the public event ledger report HTTP 409 `history_unavailable`; their old prompt digests cannot reconstruct their public messages.

The fixture suite exercises two official observers during a protected approval and an ordinary next-step question on each engine, gateway restart, argument redaction, cursor expiry and terminal message equality. During native generation observers receive assistant text as it arrives. A newly attached observer receives the open step and its accumulated text before the next delta. A failed attempt closes the open message and restores the committed history.

Pi and Claude also report when they start receiving arguments for a protected work item. Observers first see the public argument prefix `{"operation_id":`. A client joining at that point receives the same tool opener and prefix. When the native arguments contain the expected operation ID, both clients receive its value while the call remains open. The confirmed native proposal closes the arguments and enables the decision. The public tool ID stays the same through the result. If the worker dies before confirmation, the observer receives the closing tool frame and the committed message history.

Codex publishes one balanced text message for each completed native assistant item. On a tool-enabled turn it holds the preamble until its native call identifies itself or the turn finishes without a proposal. If an item ends with a possible prefix of a known native call ID, publication waits for the next item or turn completion. Every item containing part of a matched ID displays `[tool call]`. A later turn can introduce a new ID that happens to match prose in an already completed turn. Observers have already received that prose by then.

A live MCP proposal has an `expiresAt` deadline. Disconnecting an observer leaves the call open for another owner client to resolve. If the deadline expires or the worker dies, both observers receive the interruption and the card closes. A late decision returns HTTP 409.

Inspect `state.liveOperations` for the effect and its native delivery status. For an interrupted call with zero effect, open a new conversation under the same member, submit a new request and approve its new call. For a committed effect, use the existing receipt. If execution is uncertain, wait for reconciliation. Native delivery stays unknown until Codex confirms the result on that call.

A call that a [standing grant](standing-grants.md) approved has no card. Observers
receive its tool-call frames, a state snapshot whose `grantedCalls` entry names the
grant, and then its result. The phase stays `running`. Revoking a grant through
`POST /v1/members/{memberId}/grants/{grantId}/revoke` affects later calls only.

Pi crew profiles publish each delegation with a public tool-call ID. A child’s
`SUBAGENT_STARTED` carries that ID in `parentToolCallId`. Its text, protected
tool calls and results carry the same `subagentRunId` until it finishes.
Connecting during a sibling’s approval restores open child scopes and any
partial text before further deltas arrive. Cancelling the parent closes active
children and publishes a cancelled result for pending work items.
