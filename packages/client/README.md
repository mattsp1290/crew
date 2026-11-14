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

Methods cover capabilities, health, member listing and creation, conversation opening and snapshot projection, submission, request status, cancellation and approval decisions. `decide` requires the member, request, invocation and approval identities supplied by the observation state. The domain snapshot exposes cursor, conversationId, memberId, engine, profile and phase. Official AG-UI observation owns message and tool interpretation.

The same observer instance can reconnect to receive a fresh snapshot. Each run sends empty observation input.

Install exact optional peers `@ag-ui/client@1.0.4` and `@ag-ui/core@1.0.4` to use observation.

```ts
import { createCrewObserver } from "@birbcrew/client/agui";
const observer = createCrewObserver({ baseUrl, token, conversationId });
await observer.runAgent();
// observer.abortRun() only disconnects observation.
```

`@birbcrew/client/openapi.json` is exported as OpenAPI 3.1 for the core integration endpoints, including bearer authentication, errors and SSE. It is not the complete Crew API. Its `x-excluded-routes` enumerates audit, routine, memory, instruction-pack, webhook, usage, grant, instructions, handoff, conversation listing and legacy submission/cancellation routes outside this release. JSON snapshot message and tool fields are opaque JSON; use official AG-UI to interpret them. Runtime UTF-8 byte and control-character restrictions appear in schema extension annotations.

The client requires Node 22 or newer, or a browser with fetch, Web Streams, TextEncoder, and String.prototype.isWellFormed.

The server and client import the same public contract schemas. After `npm ci` or editing client sources, run `npm run build:client` before starting the server. Builds clear old outputs. From the repository root, run `npm run openapi` to generate the document and `npm run check:openapi` to check freshness directly against source. `npm run verify:client` packs the artifact and tests clean Node 22.23.3 and 24.22.3 consumers, browser types and bundling. Set `CREW_NODE22` and `CREW_NODE24` to those binaries. Full native service qualification remains `npm run test:api:service`, after `scripts/build-native` and the existing service prerequisites.
