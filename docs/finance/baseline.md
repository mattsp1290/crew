# Conversation baseline for the finance importer

The finance integration starts at birbcrew commit
`88b219c18adeb352d2f291f099ede990a3190a58`. On Linux, run
`scripts/finance-baseline` with the [upstream proof prerequisites](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/docs/verification.md).
The script checks out the pin in a private temporary directory, runs
`scripts/setup`, then runs `scripts/verify --mode test`. It prints the
evidence directory and removes its temporary source checkout on exit.
The behavior below describes that pinned revision.

## Verified runtime

The deterministic run on 2026-11-13 passed seven boundary tests and all eleven
test-model gates. It recovered from a worker interruption after a committed tool effect,
recovered a pending human request after restart, and replayed three Temporal
histories offline. The live subscription gate is separate. This run used
synthetic coding work items.

| Component | Observed version |
| --- | --- |
| Python, Pydantic AI, Pydantic | 3.13.12, 2.66.0, 2.14.3 |
| AG-UI Python, Node, AG-UI JS client | 1.0.0, v22.23.3, 1.0.4 |
| Temporal Python SDK, CLI, server | 1.35.0, 1.10.0, 1.32.2 |
| PostgreSQL, psycopg | 17.6, 3.3.8 |
| FastAPI, Uvicorn | 0.162.0, 0.54.0 |
| Beans | v0.3.0-33-g4a3c61c |

## Input and decision ownership

[The HTTP gateway](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/src/birbcrew/api.py) checks the bearer identity against
the owner of the conversation before sending a Temporal Update. Creating a
conversation starts one workflow with ID `birbcrew-{conversation_id}`.
[ConversationWorkflow](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/src/birbcrew/workflow.py) owns three durable Updates.

- `submit` accepts four distinct request IDs per conversation, with ordinals
  0 through 3. Replaying the same ID and SHA-256 of the UTF-8 text returns the
  accepted input. A changed digest returns HTTP 409 with
  `request_payload_conflict`. A fifth distinct ID returns HTTP 409 with
  `proof_input_limit`. Finishing a turn does not free a slot.
- `resolve` checks the request ID, expected responder and decision version.
  It accepts an identical repeat and rejects a changed choice.
- `cancel` acknowledges an owner's cancellation and interrupts active work.
  Closing an observer connection leaves the workflow running.

The [worker](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/src/birbcrew/worker.py) registers the workflow and its
`save_conversation` and `project_events` activities.
[The agent and tools](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/src/birbcrew/runtime.py) currently perform a
synthetic write and request a human choice. A finance integration needs a
continuation that preserves accepted input IDs, ordinals and pending decisions
to support a fifth exchange.

## Resume after disconnect

`GET /conversations/{cid}` returns the authoritative snapshot. Its integer
`cursor` is the PostgreSQL `snapshot_cursor`.
[The store](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/src/birbcrew/store.py) advances this value in the same
transaction that saves the revision and appends finalized messages and state.
Publishing provisional events increments the event cursor independently.

Pass the finalized cursor as `after` on `POST /conversations/{cid}/events`.
The gateway sends the initial messages and state snapshot, then streams events
in order with an SSE `id`. A streamed state snapshot carries its finalized
cursor. An interim text or tool event ID tracks live delivery only.
A cursor unequal to the current finalized cursor or outside retention at
connection time returns HTTP 410. A cursor that falls outside retention during
observation ends the stream with `RUN_ERROR` code `CURSOR_EXPIRED`. For either
case, replace local state with a fresh snapshot and reopen the observer using
its cursor. Reconnecting requires no input submission.

## Where the proof keeps message content

`ConversationWorkflow.segment` serializes Pydantic AI's `result.all_messages()`
into `native_messages`. The workflow passes the full conversation to
`save_conversation` and receives it back, so Temporal records content in activity
payloads. PostgreSQL stores both `native_messages` and the AG-UI projection
in `conversations.snapshot`. The owner snapshot endpoint returns this object.
The event table stores projected payloads, including messages snapshots.
The workflow's coding tool also stores its input and result in `operations`.

The private evidence directory contains `temporal.db`, exported
`*-history.json`, the final snapshot in `report.json`, and projected messages
in the client JSONL and message files. [The replayer](https://github.com/mattsp1290/crew/blob/88b219c18adeb352d2f291f099ede990a3190a58/src/birbcrew/replay.py)
loads each exported history and runs the pinned workflow with the Pydantic AI
plugin. The directory also holds disposable credentials in `clients.json`,
`config.json` and `postgres.env`. Keep the whole directory outside Git. The
finance implementation must replace content-bearing runtime payloads with
references before a private credit report enters this path.
