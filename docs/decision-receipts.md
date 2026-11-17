# Decision receipts

A decision on a card used to carry no identity of its own. A caller whose reply to
`POST /v1/conversations/{conversationId}/human` was lost, or that crashed after Crew
accepted the decision, could not learn whether its decision applied: repeating the
same choice returned it again whoever had made it, and nothing could be read back.
Migration 39 lets a caller name its decision, and adds a read that reports exactly
what Crew recorded for a card.

## Naming a decision

`decide` accepts an optional `decisionId`, a UUID the caller chooses and saves before
it sends the decision:

```json
{ "requestId": "…", "memberId": "…", "invocationId": "…", "approvalId": "…", "version": 1,
  "choice": "approve", "decisionId": "…" }
```

The card records the id with the choice, and the reply echoes it:
`{ "approvalId": "…", "decision": "approve", "decisionId": "…" }`. Crew compares and
echoes UUIDs in lowercase, so compare the echo case-insensitively. The id is scoped to
its card: the same UUID on another card names another decision.

| Already on the card | Request | Result |
| --- | --- | --- |
| nothing | any | The decision commits with its id, if any. |
| id X, choice C | `decisionId` X, choice C | `200` with C and X. No second audit row, grant or effect. |
| id X or no id, choice C | any `decisionId`, another choice | `409 decision_conflict` |
| id X, choice C | another `decisionId`, choice C | `409 decision_conflict` |
| standing grant approval | any `decisionId` | `409 decision_conflict` |
| no id, choice C (an owner's decision) | any `decisionId`, choice C | `409 decision_unverifiable` |
| any, choice C | no `decisionId`, choice C | `200` with C, as before. |
| any, choice C | no `decisionId`, another choice | `409 conflict`, as before. |

`decision_conflict` is definitive: the card records a different decision (another
`decisionId`, another choice, or a standing grant's approval), so this named decision
never applied and never will.

`decision_unverifiable` is not definitive. The card records an owner's decision with the
same choice but no id, made before the caller named decisions or by a caller that did
not. Crew cannot tell whether that was this caller's own earlier unnamed send, so it
neither claims the decision for this id nor refuses it as another decision. Nothing new
was applied by this request. The caller should treat its operation as the unnamed
decision's outcome only if it knows it sent that choice without an id; otherwise it
stays unknown. To avoid the case, never add a `decisionId` to an operation that was
ever sent without one.

Every other refusal keeps its meaning, including `409 conflict` for a closed, expired or
cancelled card, a wrong version or digest and a standing choice the call cannot use,
and `409 unknown_approval` for a card the gateway cannot find; neither is a statement
about a recorded decision. A request without `decisionId` behaves exactly as it did
before migration 39. A decision made without an id is never claimed by a later named
one.

## Reading a decision back

`GET /v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}/decision?memberId&invocationId&version`
takes the same identity, query and refusal rules as the
[approval detail](../packages/client/README.md) read: the owner's card only, every
identity field exact, unknown or repeated parameters `400`, and any mismatch the same
`404 not_found`. It covers `record_work_item` and `choose_next_step` cards. Responses
use `Cache-Control: no-store`. The read takes no lock and changes nothing.

The response carries the card identity, `apiVersion: "1"`, `version: 1` and
`toolName`, and one of four states:

| `state` | Fields | Meaning |
| --- | --- | --- |
| `decided` | `decisionId` (UUID or `null`), `choice`, `recordedAt`, `effect` | An owner decision is recorded. `choice` is exact, including `allow_conversation` and `allow_always`. `decisionId` is `null` for a decision made without one. `recordedAt` is the `approval.decided` audit time, `null` only for a decision older than the audit trail. `effect` is `{ "kind": "work_item", "receiptId" }` once the approved work item is committed, else `{ "kind": "none" }`. |
| `auto_approved` | `grantId`, `recordedAt` | A standing grant approved the call when it was proposed. No card was shown, so no decision can apply. `recordedAt` is the `approval.auto_approved` audit time and is never `null`: the grant and that row commit together, so a card without it is damaged and its read fails with `503 retry_same_request`. |
| `closed` | `reason` (`expired` or `cancelled`), `closedAt` | No decision is recorded and none can ever commit: the card expired (`closedAt` is its expiry) or its request was cancelled (`closedAt` is `null`). |
| `undecided` | none | No decision is recorded yet. This is not a claim that the card still accepts one: a decision sent earlier may still commit. |

A Codex live card past its own callback deadline, or a card whose request ended
without a decision, reads `undecided`; only an expiry or a cancellation is reported as
closed.

## Reconciling

A caller that saved its `decisionId` and lost the reply reads the record:

- `decided` with its own id and choice: the decision applied.
- `decided` with another id, or `auto_approved` or `closed`: its decision never
  applied and never will.
- `decided` with `decisionId: null`: it cannot tell whether the decision was its own
  send from before it named decisions. This is the state in which `decide` answers
  `decision_unverifiable` for the same choice.
- `undecided`, `404` or a transport failure: still unknown. Sending the same decision
  again with the same id is safe, because a replay cannot apply a second time.

`capabilities().decisionReceipts` advertises the contract:

```json
{ "version": 1, "field": "decisionId",
  "route": "/v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}/decision",
  "tools": ["record_work_item", "choose_next_step"], "replay": "same-decision-id-and-choice",
  "conflictCode": "decision_conflict", "unverifiableCode": "decision_unverifiable" }
```

A Crew without it rejects `decisionId` with `400 invalid_input`, so send one only when
version 1 is advertised. Every field of version 1 is an exact literal except `tools`; any
change to one is a new version, because a client that cannot parse version 1 rejects
the whole capabilities response.

## Storage and rollout

Migration 39 adds a nullable `decision_id` column to `deferred_calls` and a `NOT VALID`
check that only an owner-decided card carries one. It takes `ACCESS EXCLUSIVE` on
`deferred_calls` with `NOWAIT`, retried for up to 60 seconds, and neither rewrites nor
scans the table. There is no index: a receipt is always read through its card, and a
unique index across cards would tell one owner whether another owner used a UUID.
The audit payload of `approval.decided` is unchanged.

The decision travels to the worker inside the conversation workflow's `decide` update.
A worker older than this release fails to parse a decision that carries `decisionId`,
so the decision is refused with nothing committed, typically as `409 update_rejected`
after the activity's retries. Deploy the worker
before the gateway, or both together. The workflow code is unchanged, so recorded
histories replay as before.
