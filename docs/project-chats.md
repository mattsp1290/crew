# Project conversation contract

Project chats use a tool-free Pydantic AI agent and the maintained OpenCode Go provider. The separate `ProjectConversationWorkflow` owns durable request ordering and finalized history. AG-UI carries observation events. The synthetic coworker and the approved documentation pilot keep their existing workflows.

A project context binds an ordered nonempty set of stable GitHub repository IDs, canonical names, exact commits, bounded source text and digests, and scoped Beans notes. The context digest uses sorted compact UTF-8 JSON. Source paths cannot escape their repository. Note paths must remain under the exact Beans project namespace. The server rejects conflicting conversation UUID reuse. Membership changes never rewrite an existing conversation.

## Trusted service API

The following routes require both the owner's existing bearer token and `X-Birbforge-Project-Token`. The configured `project_service_token_sha256` identifies the trusted Forge resolver. The browser and phone never receive that service token.

- `POST /internal/project-conversations` accepts `id` and `context`. `context` follows `ProjectContext` in `domain.py`. An unchanged retry returns the canonical conversation. Changed context with an existing UUID conflicts.
- `POST /internal/project-conversations/{id}/inputs` accepts `request_id`, `text`, and `context_sha256`. The digest must match the frozen context. Request UUID reuse with changed text conflicts.
- `GET /conversations?project_id=...` returns owner-scoped conversations for the frozen project identity.
- `POST /internal/project-conversations/{id}/reconcile` accepts the same strict project prompt. It observes the persisted receipt or queries the durable workflow when PostgreSQL projection lags. It submits no update and dispatches no inference. Changed text conflicts and unavailable observation returns 503.
- Existing conversation GET and AG-UI events routes expose the frozen context and its digest. Observation does not submit a provider turn.

Forge resolves the project through Beans and repository content through its configured GitHub connection before trusted creation. Forge checks current access before each new input. An unchanged already accepted input must reconcile before new access checks. Public conversation input and synthetic human-choice routes reject project conversations, so clients cannot bypass Forge's access gate.

Source content is captured once at the recorded commits. This release does not add arbitrary file tools or an index. New chats adopt current project membership. Existing chats retain their original bytes and provenance.

## Worker configuration

`python -m birbcrew.project_worker` registers only project conversation activities and their workflow. `project_task_queue` selects its queue. Without that setting, the queue is `task_queue` followed by `-projects`. The API can retain `approved-goal` mode while a separate project worker uses `project-live` mode.

`mode` is required. A configuration without it, or with an unknown value, fails to load. The project worker accepts only `project-live` and `project-test`. `project-live` needs the OpenCode Go key in `$HOME/.profile` and nothing else. The worker reads the key at startup and exits without it. Before every new turn it checks that the key is still readable and refuses the turn otherwise; a changed key takes effect after a restart. It never substitutes the injected model. Earlier releases also required `live_attestation`, a dated owner statement that expired after twelve hours. That setting was removed, and a configuration that still names it fails to load. Nothing now asserts the statement's claims of eligible coding use and disabled Extra Usage. The maintained provider checks its model list before a live acceptance run. Project calls identify `birbcrew-project-chat/0.1.0`, use a stable conversation session header, and permit up to 4096 output tokens. `project-test` uses a visibly injected deterministic model and proves no live-provider behavior.

## Recovery and limits

Project chats accept up to sixteen usable turns. Failed preflight or history-headroom rejections retain their request UUIDs without consuming that turn budget. Retained receipts are separately bounded to twenty identities, four nondispatched failures, and 64 KiB of total input text. Reaching a resource bound returns `new_chat_required`. Unchanged retries still reconcile at the bound. Temporal retains accepted UUIDs and finalized framework messages. This release does not implement continue-as-new.

Model activities have one attempt. An interrupted or failed provider call records `provider_turn_unconfirmed_no_replacement_dispatched` and retains the original conversation, request, and attempt IDs. No replacement provider turn starts automatically. Finalized history remains canonical. Provisional text from the failed turn does not become a finalized message. A provider may still be computing after its connection fails.

Cancellation acknowledges a request to stop the read-only call. The persisted `read_only_provider_cancellation_requested` label does not prove remote provider termination. The planning agent has no tools, shell, source-write capability, publication capability, or implementation dispatcher.

Chat-local implementation approval remains a Forge consumer of the separately owned Ready contract. This module does not create a second launcher or authorize execution from a chat message.

Frozen project context is bounded to 128 KiB of canonical JSON. Stored native history excludes repeated frozen instructions. New inputs require a new chat when existing native history exceeds 64 KiB, sixteen usable turns have been accepted, or usable user text would exceed 32 KiB in total. History sizes use compact UTF-8 JSON without ASCII escaping.

Before each turn, including an already queued turn, the workflow reserves 64 KiB for the 4096-token response and 4 KiB for its message envelope, in addition to the exact serialized prompt and current history. Insufficient headroom finalizes only that request as failed with `project_history_headroom_exhausted_not_dispatched`, records no provider attempt, and leaves the chat idle. A queued request cannot inherit the headroom observed before an earlier answer completed.

If a provider violates the reserved response envelope and exceeds the 128 KiB native-history ceiling, the workflow retains a bounded 16,000-byte Unicode-safe response preview and the full native response digest in canonical history. The input and attempt remain completed. The chat closes with `provider_response_confirmed_history_budget_exceeded`, not an unconfirmed-provider label. It does not reissue inference. A cancellation observed before model scheduling records no dispatch, or a prepared attempt as `not_dispatched`.

These intersecting limits bound payload growth. The sizing fixture records measured history and payload sizes for its exact inputs. It does not prove every theoretical combination of the configured maxima or remove Temporal's history warning threshold.

A provider credential preflight failure records `provider_preflight_rejected_not_dispatched`, finalizes that request as failed without a provider attempt, and leaves the conversation idle. The unchanged request remains reconciled. After the operator restores the key, a new explicit request UUID can proceed.

The context contract includes `unavailable_sources` entries with `repository_id`, `path`, and `reason`, and `unavailable_notes` entries with `key` and `reason`. Both default to empty arrays and participate in the context digest. They record evidence gaps without inventing source content.
