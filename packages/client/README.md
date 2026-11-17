# Crew HTTP client

`@birbcrew/client` supplies portable domain commands for a configured Crew service. It uses standard fetch and Zod. The root import has no Node, database, Temporal, native engine, Switchboard or AG-UI dependency.

```ts
import { CrewClient, CrewUnknownOutcomeError } from "@birbcrew/client";
const crew = new CrewClient({ baseUrl: "https://crew.example", token });
const members = await crew.listMembers({ limit: 50 });
const snapshot = await crew.conversation({ conversationId });
const command = { conversationId, requestId, text };
try {
  const receipt = await crew.submit(command);
  if (receipt.status === "completed") console.log(receipt.result.text);
} catch (error) {
  if (!(error instanceof CrewUnknownOutcomeError)) throw error;
  // Persist the command identity and exact text before dispatch. The host decides when to reconcile.
  const receipt = await crew.requestStatus({ conversationId, requestId });
}
```

Every method makes one HTTP attempt. There is no polling, retry, provisioning or implicit submission. UUIDs normalize to lowercase like the server. Prompt text is preserved exactly, including whitespace and Unicode normalization. A signal already aborted sends nothing. An abort after dispatch does not undo the command. Redirects are refused so credentials and commands cannot be forwarded to another route.

`CrewUnknownOutcomeError.command` retains the original normalized command identity after a lost connection, in-flight abort, ambiguous server error, oversized response or invalid successful response. Its cause is a bounded public failure without raw transport details, request bodies or credentials. A 404 status lookup does not establish that a previously dispatched request can never arrive. Recovery and any deliberate same-identity resubmission belong to the host.

`CrewTransportError` identifies read transport failures. In-flight read aborts reject with the signal reason. Invalid arguments always reject the returned promise.

`CrewHttpError` exposes HTTP status and a bounded public error code. `CrewProtocolError` reports malformed successful reads. Responses are limited to 8 MiB, error bodies to 16 KiB. Unknown safe error identifiers are retained; malformed identifiers are not reflected into error messages. `health()` returns the readiness report for both HTTP 200 and the documented HTTP 503 dependency failure.

`RequestReceipt` has the same observed response type at the root and `/contract` entry points. `ServerRequestReceipt` and `serverRequestReceiptSchema` enforce the server's accepted initiator kinds. Observed initiators accept additive fields and future kinds advertised by capabilities; known routine and handoff ids remain UUIDs. Observed initiators do not authorize work.

Receipt status, cancellation delivery, native termination and effects are independent facts. Only `completed` requires `result.text`. Historical noncompleted receipts may carry a result. `uncertain` is a server receipt state, distinct from an unknown HTTP command outcome.

Member creation accepts optional instructions and ordered instruction-pack UUIDs, matching the server's eight-pack limit and duplicate rejection. Member creation and listing retain the attached pack IDs.

Methods cover capabilities, health, member listing and creation, conversation opening and snapshot projection, handoff creation and reading, submission, request status, cancellation, approval decisions and decision records, standing-grant listing and revocation. `decide` requires the member, request, invocation and approval identities supplied by the observation state. The domain snapshot exposes cursor, conversationId, memberId, engine, profile and phase. Official AG-UI observation owns message and tool interpretation.

The same observer instance can reconnect to receive a fresh snapshot. Each run sends empty observation input.

Install exact optional peers `@ag-ui/client@1.0.4` and `@ag-ui/core@1.0.4` to use observation.

```ts
import { createCrewObserver } from "@birbcrew/client/agui";
const observer = createCrewObserver({ baseUrl, token, conversationId });
await observer.runAgent();
// observer.abortRun() only disconnects observation.
```

`@birbcrew/client/openapi.json` is exported as OpenAPI 3.1 for the core integration endpoints, including bearer authentication, errors and SSE. It is not the complete Crew API. Its `x-excluded-routes` enumerates audit, routine, memory, instruction-pack, webhook, usage, instructions, conversation listing and legacy submission/cancellation routes outside this release. JSON snapshot message and tool fields are opaque JSON; use official AG-UI to interpret them. Runtime UTF-8 byte and control-character restrictions appear in schema extension annotations.

The client requires Node 22 or newer, or a browser with fetch, Web Streams, TextEncoder, and String.prototype.isWellFormed.

The server and client import the same public contract schemas. After `npm ci` or editing client sources, run `npm run build:client` before starting the server. Builds clear old outputs. From the repository root, run `npm run openapi` to generate the document and `npm run check:openapi` to check freshness directly against source. `npm run verify:client` packs the artifact and tests clean Node 22.23.3 and 24.22.3 consumers, browser types and bundling. Set `CREW_NODE22` and `CREW_NODE24` to those binaries. Full native service qualification remains `npm run test:api:service`, after `scripts/build-native` and the existing service prerequisites.

`approvalDetail({ conversationId, memberId, requestId, invocationId, approvalId, version })` reads the complete immutable `record_work_item` proposal for the authenticated owner. Use it only when capabilities advertise `approvalDetails.version === 1` and include `record_work_item` in `tools`. An absent capability or unknown version means this feature is unsupported. This capability is independent of standing grants.

The response includes the exact proposed `arguments`, policy version and every requested identity. The client validates the entire identity and requires `arguments.operation_id === requestId`. The optional note preserves whitespace, Unicode and the difference between absent and empty, with a 4096-byte UTF-8 limit, no NUL and no unpaired surrogates. The response excludes native call IDs and credentials. Passive observation, events and audit previews retain their redaction.

The documented GET route is `/v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}` with required `memberId`, `invocationId` and integer `version` query parameters. Unknown or repeated parameters are rejected. Foreign owners, mismatched identities and unsupported tools return the same bounded `not_found` response. All responses use `Cache-Control: no-store`.

Details remain readable after settlement. Reading them does not assert that a proposal is pending or actionable, reserve an approval, extend a deadline, create a grant or execute a tool. The existing decision endpoint remains the authority for whether a choice can execute.

`decide` accepts an optional `decisionId`, a UUID the application saves before it sends the decision. Send it only when the `/contract` export `decisionReceiptsCapabilityV1Schema.safeParse(capabilities.decisionReceipts).success`; an older Crew rejects the field with `400 invalid_input`, and an absent capability or unknown version leaves decisions unnamed. The client requires the reply to echo the same `approvalId`, the exact `choice` and the same `decisionId` (none when none was sent); any other reply is an unknown outcome. `CrewUnknownOutcomeError.command` for a decision is `{ kind: "decision", conversationId, requestId, approvalId, decisionId? }`. Crew lowercases the id, so the echo and `command.decisionId` are lowercase. Repeating the same `decisionId` and choice returns the recorded decision without a second effect. `409 decision_conflict` is definitive: the card records another `decisionId`, another choice or a standing grant's approval, and this decision never applied. `409 decision_unverifiable` is not definitive: the card records the same choice with no id, an owner decision Crew cannot attribute, so it may be this operation's own earlier unnamed send; nothing new applied. Never add a `decisionId` to an operation that was ever sent without one. `409 conflict` and `409 unknown_approval` say nothing about a recorded decision. Check `capabilities.decisionReceipts.tools` before naming a decision on a card.

`decisionRecord({ conversationId, memberId, requestId, invocationId, approvalId, version })` reads `GET /v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}/decision` with the same query, identity checks, `not_found` and `no-store` rules as `approvalDetail`, for `record_work_item` and `choose_next_step` cards. The result is a union on `state`: `decided` with `decisionId` (`null` for an unnamed decision), the exact `choice`, `recordedAt` and `effect` (`none`, or `work_item` with its `receiptId`); `auto_approved` with `grantId`; `closed` with `reason` `expired` or `cancelled`; and `undecided`. Only a matching `decided` record acknowledges an unknown named decision. Another id, `auto_approved` and `closed` mean it never applied. `undecided`, a `null` id and `404` leave it unknown, and an explicit retry with the same `decisionId` is safe.

`listGrants({ memberId }, options?)` reads every active grant for the authenticated owner's member, plus at most twenty inactive rows. The result is `{ apiVersion: "1", memberId, active, inactive }`. There is no pagination or active-result truncation. The client checks member identity, unique grant IDs, scope, conversation, choice and status consistency. Invalid responses and transport failures reject instead of returning empty permission lists.

`revokeGrant({ memberId, grantId }, options?)` posts `{}` to `/v1/members/{memberId}/grants/{grantId}/revoke` and returns `{ apiVersion: "1", grant }`. The client requires the exact requested member and grant IDs and a revoked status. Revocation affects later proposals only. Calls already approved remain approved. Repeated revocation returns the revoked grant, including an existing `recovery_restore` revocation reason.

Both methods accept the existing optional abort signal. An unknown revoke outcome preserves `{ kind: "grant_revocation", memberId, grantId }` in `CrewUnknownOutcomeError.command`. A later list can show current permission state, but it cannot acknowledge the earlier command. The client never retries automatically.

`capabilities().standingGrants` is optional. The `/contract` export `standingGrantsCapabilityV1Schema.safeParse(metadata)` identifies supported version 1 metadata, including choices, tools, policy version, initiator kinds, list history limit and revocation behavior. Absent metadata or an unknown version leaves standing grants unavailable to callers. Unknown-version metadata remains opaque and does not prevent ordinary chat. Callers still check that the desired tool, choice and initiator are advertised. This client increment adds no automatic standing choice or permission UI.

`createHandoff({ conversationId, requestId, memberId }, options?)` creates a fresh successor for the owner's source conversation and target member. The target may be the source's member. The application supplies and saves all three IDs before dispatch, bound to the original service, authenticated owner and chat segment. The client allocates no IDs, selects no member and replays no interrupted owner prompt. These examples use application-owned `intents` storage and UI functions.

```ts
import { CrewUnknownOutcomeError, type CreateHandoff } from "@birbcrew/client";

const intent: CreateHandoff = { conversationId, requestId, memberId };
await intents.save(intent);
try {
	const created = await crew.createHandoff(intent, { signal });
	await intents.recordCommitted(created);
	showSuccessor(created.target.conversationId);
} catch (error) {
	if (!(error instanceof CrewUnknownOutcomeError) || error.command.kind !== "handoff") throw error;
	await intents.recordUnknown(error.command);
	showNeedsReconciliation();
}
```

The result retains `apiVersion: "1"` and the committed handoff record. `firstRequestAdmitted` reports whether an admission record exists for the reserved target request. An admission may be rejected. An admitted request may fail or become uncertain. Read its receipt to learn execution status. Repeating the exact POST can drive delivery while that request remains unadmitted. After admission, repeating the POST sends no new target request.

The handoff POST classifies exactly `409 update_rejected` as `CrewUnknownOutcomeError`, in addition to the ordinary command uncertainty cases. Its cause remains `CrewHttpError` with that status and code. Ordinary refusals such as `409 busy`, `409 conflict` and `409 handed_off` remain `CrewHttpError`. The frozen handoff error identity contains `{ kind: "handoff", conversationId, requestId, memberId }`, with lowercase UUIDs.

On a separate reconciliation action, compare the outgoing record with every saved caller-known identity. A different outgoing command identifies another successor, not acknowledgement of this command. An incoming-only read or GET 404 leaves the earlier unknown POST unresolved. The POST may still commit after that read.

```ts
import { CrewHttpError, type HandoffCommandIdentity } from "@birbcrew/client";

const command: HandoffCommandIdentity = await intents.loadUnknown();
try {
	const chain = await crew.handoff({ conversationId: command.conversationId });
	const outgoing = chain.outgoing;
	if (outgoing !== null
		&& outgoing.source.conversationId === command.conversationId
		&& outgoing.requestId === command.requestId
		&& outgoing.target.memberId === command.memberId) {
		await intents.recordReconciled(outgoing);
	} else if (outgoing !== null) {
		showOtherSuccessor(outgoing);
	} else {
		showStillUnknown();
	}
} catch (error) {
	if (!(error instanceof CrewHttpError) || error.status !== 404) throw error;
	showStillUnknown();
}

async function retrySavedHandoff(saved: HandoffCommandIdentity) {
	return crew.createHandoff({
		conversationId: saved.conversationId,
		requestId: saved.requestId,
		memberId: saved.memberId,
	});
}
```

Handoff inputs are strict. Reconstruct the three fields for an explicit retry because the error identity's `kind` is not an accepted input field. Preserve the same identity throughout reconciliation and retry. The client makes one HTTP attempt for each invocation and performs no capability preflight or automatic retry.

`handoff({ conversationId }, options?)` returns `{ apiVersion: "1", conversationId, incoming, outgoing }`. At least one record is present on a successful read. Nested records omit `apiVersion`. The client checks the requested envelope identity, incoming target and outgoing source, as well as each record's bounds and distinct source and target conversations. Neither method returns transcript text.

```ts
const chain = await crew.handoff({ conversationId }, { signal });
renderBoundaries(chain.incoming, chain.outgoing);
const edge = chain.outgoing ?? chain.incoming;
if (edge !== null && edge.firstRequestAdmitted) {
	const receipt = await crew.requestStatus({
		conversationId: edge.target.conversationId,
		requestId: edge.firstRequestId,
	});
	renderReservedRequest(receipt);
}
```

The handoff command's `requestId` and the reserved target's `firstRequestId` identify separate roles. The server chooses the reserved ID. `CreateHandoff`, `HandoffRecord`, `CreateHandoffResponse`, `ConversationHandoff`, `HandoffsCapability` and `HandoffsCapabilityV1` are schema-derived exports at the root and `/contract` entry points. `HandoffCommandIdentity` is exported at the root. The `/contract` entry point also exports the shared schemas.

`capabilities().handoffs` is optional. Use `/contract`'s `handoffsCapabilityV1Schema.safeParse(metadata)` to recognize supported version 1 routes, delivery and transcript limits. Absent metadata or an unknown positive version leaves handoffs unsupported for feature discovery. Unknown versions remain opaque metadata. Malformed advertised version 1 metadata fails validation. Capability discovery is an explicit application call.
