import asyncio
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError
from test_conversation_recency import isolated_postgres  # noqa: F401

from birbcrew import api, store
from birbcrew.config import settings
from birbcrew.domain import Conversation, ProjectContext


def context(project="alpha", revision="a" * 40):
    text = "Project source with a distinctive implementation detail."
    return {
        "schema_version": "birbcrew.project-context.v1",
        "project_id": project,
        "project_revision": revision,
        "project_name": "My project",
        "repositories": [
            {
                "repository_id": "1",
                "full_name": "owner/first",
                "url": "https://github.com/owner/first",
                "commit": "b" * 40,
            },
            {
                "repository_id": "2",
                "full_name": "owner/second",
                "url": "https://github.com/owner/second",
                "commit": "c" * 40,
            },
        ],
        "sources": [
            {
                "repository_id": "1",
                "commit": "b" * 40,
                "path": "README.md",
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "text": text,
            }
        ],
        "notes": {"project": project, "actor": "owner", "commit": revision, "notes": []},
    }


@pytest.mark.parametrize(
    "mutation",
    [
        "empty",
        "duplicate",
        "unknown_source",
        "changed_commit",
        "digest",
        "path",
        "notes",
        "note_path",
        "note_digest",
        "context_budget",
    ],
)
def test_context_rejects_expanded_or_unverifiable_scope(mutation):
    value = context()
    if mutation == "empty":
        value["repositories"] = []
    elif mutation == "duplicate":
        value["repositories"].append(value["repositories"][0])
    elif mutation == "unknown_source":
        value["sources"][0]["repository_id"] = "3"
    elif mutation == "changed_commit":
        value["sources"][0]["commit"] = "d" * 40
    elif mutation == "digest":
        value["sources"][0]["text"] += " changed"
    elif mutation == "path":
        value["sources"][0]["path"] = "../private"
    elif mutation == "notes":
        value["notes"]["project"] = "another-project"
    elif mutation == "context_budget":
        for index in range(3):
            text = "x" * 60000
            value["sources"].append(
                {
                    **value["sources"][0],
                    "path": f"large-{index}.md",
                    "text": text,
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            )
    else:
        body = "Scoped note"
        value["notes"]["notes"] = [
            {
                "key": "note",
                "path": "projects/alpha/../beta/private.md",
                "updated": {"owner": 1},
                "file_sha256": "a" * 64,
                "content_sha256": hashlib.sha256(body.encode()).hexdigest(),
                "body": body,
            }
        ]
        if mutation == "note_digest":
            value["notes"]["notes"][0]["path"] = "projects/alpha/memories/note.md"
            value["notes"]["notes"][0]["body"] = "Changed"
    with pytest.raises(ValidationError):
        ProjectContext.model_validate(value)


def test_context_digest_has_one_canonical_json_representation():
    value = context()
    parsed = ProjectContext.model_validate(value)
    expected = hashlib.sha256(
        json.dumps(
            parsed.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    assert parsed.digest == expected
    assert ProjectContext.model_validate_json(json.dumps(value, indent=4)).digest == expected
    assert parsed.repositories[0].repository_id == "1"


@pytest.fixture
def project_config(tmp_path, monkeypatch):
    config = tmp_path / "crew.json"
    config.write_text(
        json.dumps(
            {
                "database_url": "unused",
                "temporal_address": "unused",
                "task_queue": "fixture",
                "token_hashes": {"owner": hashlib.sha256(b"owner-token").hexdigest()},
                "context": {"project": "proof", "actor": "owner", "commit": "fixture", "notes": []},
                "evidence_dir": str(tmp_path),
                "mode": "project-test",
                "project_service_token_sha256": hashlib.sha256(b"service-token").hexdigest(),
            }
        )
    )
    monkeypatch.setenv("BIRBCREW_CONFIG", str(config))
    settings.cache_clear()
    yield
    settings.cache_clear()


def test_service_context_boundary_and_creation_retries(project_config, isolated_postgres):  # noqa: F811
    class Temporal:
        def __init__(self):
            self.starts = []

        async def start_workflow(self, *args, **kwargs):
            self.starts.append(kwargs)

        def get_workflow_handle(self, identity):
            class Handle:
                async def execute_update(self, name, value, **kwargs):
                    assert name == "cancel"
                    assert value == "owner"
                    return {"acknowledgement": "requested"}

            return Handle()

    async def exercise():
        await store.migrate()
        temporal = Temporal()
        api.app.state.temporal = temporal
        headers = {"Authorization": "Bearer owner-token"}
        cid = str(uuid4())
        body = {"id": cid, "context": context()}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api.app), base_url="http://fixture"
        ) as client:
            rejected = await client.post(
                "/internal/project-conversations", json=body, headers=headers
            )
            assert rejected.status_code == 403
            trusted = {**headers, "X-Birbforge-Project-Token": "service-token"}
            created = await client.post(
                "/internal/project-conversations", json=body, headers=trusted
            )
            assert created.status_code == 200, created.text
            assert created.json()["project_context"] == ProjectContext.model_validate(
                body["context"]
            ).model_dump(mode="json")
            assert created.json()["coworker"]["id"] == "birbcrew-project-planning"
            assert created.json()["coworker"]["tools"] == []
            settings().mode = "approved-goal"
            assert (
                await client.post("/conversations", json={"id": cid}, headers=headers)
            ).status_code == 409
            observed = await client.get(f"/conversations/{cid}", headers=headers)
            assert "mode" not in observed.json()
            cancelled = await client.post(f"/conversations/{cid}/cancel", headers=headers)
            assert cancelled.status_code == 202
            assert cancelled.json()["acknowledgement"] == "requested"

            assert (
                await client.post("/internal/project-conversations", json=body, headers=trusted)
            ).json() == created.json()
            changed = {**body, "context": context(revision="d" * 40)}
            assert (
                await client.post("/internal/project-conversations", json=changed, headers=trusted)
            ).status_code == 409
            untrusted = await client.post(
                f"/conversations/{cid}/inputs",
                headers=headers,
                json={"request_id": str(uuid4()), "text": "plan"},
            )
            assert untrusted.status_code == 403
            project_list = await client.get("/conversations?project_id=alpha", headers=headers)
            assert project_list.json() == [
                {"id": cid, "revision": 0, "project_id": "alpha", "project_revision": "a" * 40}
            ]
            assert (
                await client.get("/conversations?project_id=beta", headers=headers)
            ).json() == []
            stale = await client.post(
                f"/internal/project-conversations/{cid}/inputs",
                headers=trusted,
                json={"request_id": str(uuid4()), "text": "plan", "context_sha256": "0" * 64},
            )
            assert stale.status_code == 409
        assert all(item["task_queue"] == "fixture-projects" for item in temporal.starts)
        assert len(await store.conversations_for_owner("owner")) == 1
        assert not await store.operation_rows(cid)

    asyncio.run(exercise())


@pytest.mark.parametrize("turn_count,context_bytes", [(6, 0), (16, 128000)])
def test_six_turns_restart_resume_and_deduplication(
    project_config,
    isolated_postgres,  # noqa: F811
    turn_count,
    context_bytes,
    monkeypatch,
):
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from birbcrew.domain import ProjectPrompt, workflow_id
    from birbcrew.project_runtime import (
        agent,
        project_conversation_events,
        save_project_conversation,
        validate_project_provider,
    )
    from birbcrew.project_workflow import ProjectConversationWorkflow

    if context_bytes:

        async def bounded_response(messages, info):
            yield "s" * 2000

        monkeypatch.setattr(agent.model, "stream_function", bounded_response)

    async def finalized(cid, count):
        for _ in range(300):
            value = await store.snapshot(cid, "owner")
            if value["phase"] == "failed":
                raise AssertionError(value)
            if sum(item["outcome"] == "completed" for item in value["inputs"]) == count:
                return value
            await asyncio.sleep(0.05)
        raise AssertionError("project turn did not finalize")

    async def exercise():
        await store.migrate()
        source_context = context()
        if context_bytes:
            for index in range(2):
                text = "x" * (context_bytes // 2)
                source_context["sources"].append(
                    {
                        **source_context["sources"][0],
                        "path": f"context-{index}.md",
                        "text": text,
                        "sha256": hashlib.sha256(text.encode()).hexdigest(),
                    }
                )
        frozen = ProjectContext.model_validate(source_context)
        cid = str(uuid4())
        state = Conversation(
            id=cid, owner="owner", context=frozen.notes, kind="project", project_context=frozen
        )
        await store.create(state)
        async with await WorkflowEnvironment.start_local(
            plugins=[PydanticAIPlugin()],
            dev_server_existing_path=os.environ.get(
                "TEMPORAL_TEST_SERVER", "/opt/homebrew/bin/temporal"
            ),
            dev_server_log_level="error",
        ) as env:
            queue = "project-proof-" + str(uuid4())
            options = dict(
                task_queue=queue,
                workflows=[ProjectConversationWorkflow],
                activities=[
                    project_conversation_events,
                    save_project_conversation,
                    validate_project_provider,
                ],
            )
            prompts = [
                ProjectPrompt(
                    request_id=uuid4(),
                    text=f"Inspect source question {i}",
                    context_sha256=frozen.digest,
                )
                for i in range(turn_count)
            ]
            async with Worker(env.client, **options):
                handle = await env.client.start_workflow(
                    ProjectConversationWorkflow.run, state, id=workflow_id(cid), task_queue=queue
                )
                for index, prompt in enumerate(prompts[:3]):
                    accepted = await handle.execute_update("submit", prompt)
                    assert accepted["ordinal"] == index
                    await finalized(cid, index + 1)
            before = await store.snapshot(cid, "owner")
            async with Worker(env.client, **options):
                handle = env.client.get_workflow_handle(workflow_id(cid))
                repeated = await handle.execute_update("submit", prompts[0])
                assert repeated["ordinal"] == 0
                assert repeated["outcome"] == "completed"
                for index, prompt in enumerate(prompts[3:], 3):
                    await handle.execute_update("submit", prompt)
                    await finalized(cid, index + 1)
                value = await store.snapshot(cid, "owner")
                assert len(value["inputs"]) == turn_count
                assert len(value["attempts"]) == turn_count
                assert len(value["messages"]) == turn_count * 2
                assert value["messages"][:6] == before["messages"]
                assert value["project_context"] == frozen.model_dump(mode="json")
                assert all(not item.get("instructions") for item in value["native_messages"])
                history = await handle.fetch_history()
                history_bytes = len(history.to_json().encode())
                payloads = []

                def inspect_payloads(message):
                    if not hasattr(message, "DESCRIPTOR"):
                        return
                    if message.DESCRIPTOR.full_name == "temporal.api.common.v1.Payload":
                        payloads.append(len(message.data))
                    for field, child in message.ListFields():
                        if field.message_type:
                            if field.is_repeated:
                                for item in child.values() if hasattr(child, "values") else child:
                                    inspect_payloads(item)
                            else:
                                inspect_payloads(child)

                for event in history.events:
                    inspect_payloads(event)
                assert max(payloads) < 1048576
                assert history_bytes < 45000000
                evidence = os.environ.get("PROJECT_CHAT_REVIEW_EVIDENCE")
                if evidence and context_bytes:
                    from pathlib import Path

                    Path(evidence).write_text(
                        json.dumps(
                            {
                                "turns": turn_count,
                                "frozen_context_bytes": len(frozen.model_dump_json().encode()),
                                "maximum_temporal_payload_bytes": max(payloads),
                                "history_json_bytes": history_bytes,
                                "context_in_native_history": False,
                                "final_native_history_bytes": len(
                                    json.dumps(
                                        value["native_messages"],
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    ).encode()
                                ),
                                "kind": "real Temporal and PostgreSQL with injected provider",
                            },
                            indent=2,
                        )
                    )
                assert not await store.operation_rows(cid)
                assert value["context_sha256"] == frozen.digest
                from temporalio.client import WorkflowUpdateFailedError

                with pytest.raises(WorkflowUpdateFailedError):
                    await handle.execute_update(
                        "submit", prompts[0].model_copy(update={"text": "changed reuse"})
                    )
                if turn_count == 16:
                    with pytest.raises(WorkflowUpdateFailedError):
                        await handle.execute_update(
                            "submit", prompts[0].model_copy(update={"request_id": uuid4()})
                        )
                    assert (await handle.execute_update("submit", prompts[0]))[
                        "outcome"
                    ] == "completed"
                await handle.execute_update("cancel", "owner")
                assert await handle.result() == "cancelled"

    asyncio.run(exercise())


def test_interrupted_provider_turn_is_not_reissued(project_config, isolated_postgres, monkeypatch):  # noqa: F811
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio.service import RPCError
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from birbcrew.domain import ProjectPrompt, workflow_id
    from birbcrew.project_runtime import (
        agent,
        project_conversation_events,
        save_project_conversation,
        validate_project_provider,
    )
    from birbcrew.project_workflow import ProjectConversationWorkflow

    calls = []

    async def interrupted(messages, info):
        calls.append(1)
        yield "Provisional content before provider failure."
        raise RuntimeError("injected_provider_connection_lost")

    async def exercise():
        await store.migrate()
        frozen = ProjectContext.model_validate(context())
        cid = str(uuid4())
        state = Conversation(
            id=cid, owner="owner", context=frozen.notes, kind="project", project_context=frozen
        )
        await store.create(state)
        async with await WorkflowEnvironment.start_local(
            plugins=[PydanticAIPlugin()],
            dev_server_existing_path=os.environ.get(
                "TEMPORAL_TEST_SERVER", "/opt/homebrew/bin/temporal"
            ),
            dev_server_log_level="error",
        ) as env:
            queue = "project-failure-" + str(uuid4())
            monkeypatch.setattr(agent.model, "stream_function", interrupted)
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ProjectConversationWorkflow],
                activities=[
                    project_conversation_events,
                    save_project_conversation,
                    validate_project_provider,
                ],
            ):
                handle = await env.client.start_workflow(
                    ProjectConversationWorkflow.run,
                    state,
                    id=workflow_id(cid),
                    task_queue=queue,
                )
                prompt = ProjectPrompt(
                    request_id=uuid4(),
                    text="Inspect project code",
                    context_sha256=frozen.digest,
                )
                await handle.execute_update("submit", prompt)
                assert await asyncio.wait_for(handle.result(), 15) == "failed"
                with pytest.raises(RPCError):
                    await handle.execute_update("submit", prompt)
            value = await store.snapshot(cid, "owner")
            assert value["failure"] == "provider_turn_unconfirmed_no_replacement_dispatched"
            assert value["inputs"][0]["request_id"] == str(prompt.request_id)
            assert value["attempts"][0]["outcome"] == "unconfirmed"
            assert value["messages"] == []
            assert not await store.operation_rows(cid)
        assert calls == [1]

    asyncio.run(exercise())


def test_project_worker_selects_its_model_from_the_mode_alone(project_config, monkeypatch):
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.models.openai import OpenAIChatModel

    from birbcrew import project_runtime, provider
    from birbcrew.config import Settings

    document = json.loads(Path(os.environ["BIRBCREW_CONFIG"]).read_text())

    def configured(mode):
        value = Settings.model_validate(document | {"mode": mode})
        monkeypatch.setattr(project_runtime, "settings", lambda: value)

    def missing_key():
        raise ValueError("No literal OPENCODE_GO_API_KEY assignment in ~/.profile")

    # Live with no credential fails at startup and before every turn.
    # It never becomes the injected model.
    configured("project-live")
    monkeypatch.setattr(provider, "read_go_key", missing_key)
    with pytest.raises(ValueError, match="OPENCODE_GO_API_KEY"):
        project_runtime.make_agent()
    with pytest.raises(ValueError, match="OPENCODE_GO_API_KEY"):
        asyncio.run(project_runtime.validate_project_provider())
    # Live with the credential needs nothing else: there is no attestation path to configure.
    monkeypatch.setattr(provider, "read_go_key", lambda: "synthetic-not-a-credential")
    live = project_runtime.make_agent().model
    assert isinstance(live, OpenAIChatModel) and live.model_name == provider.MODEL
    asyncio.run(project_runtime.validate_project_provider())
    for mode in ("test", "live", "approved-goal"):
        configured(mode)
        with pytest.raises(ValueError, match="requires project-live or project-test"):
            project_runtime.make_agent()
    configured("project-test")
    monkeypatch.setattr(provider, "read_go_key", lambda: pytest.fail("test mode read a credential"))
    assert isinstance(project_runtime.make_agent().model, FunctionModel)
    asyncio.run(project_runtime.validate_project_provider())


def test_project_provider_sdk_does_not_retry_timeout(monkeypatch):
    from openai import APITimeoutError

    from birbcrew import provider

    calls = []

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("injected uncertain acknowledgement", request=request)

    monkeypatch.setattr(provider, "read_go_key", lambda: "synthetic-not-a-credential")

    async def exercise():
        model = provider.model()
        client = model._provider.client
        assert client.max_retries == 0
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(timeout))
        try:
            with pytest.raises(APITimeoutError):
                await client.chat.completions.create(
                    model="injected", messages=[{"role": "user", "content": "hello"}]
                )
        finally:
            await client.close()
        assert len(calls) == 1

    asyncio.run(exercise())


def test_provider_preflight_rejects_without_dispatch_and_allows_fresh_input(  # noqa: F811
    project_config,
    isolated_postgres,  # noqa: F811
):
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from birbcrew.domain import ProjectPrompt, workflow_id
    from birbcrew.project_runtime import project_conversation_events, save_project_conversation
    from birbcrew.project_workflow import ProjectConversationWorkflow

    validations = []

    @activity.defn(name="validate_project_provider")
    async def preflight():
        validations.append(1)
        if len(validations) <= 3:
            raise ValueError("injected_unreadable_provider_credential")

    async def exercise():
        await store.migrate()
        frozen = ProjectContext.model_validate(context())
        cid = str(uuid4())
        state = Conversation(
            id=cid, owner="owner", context=frozen.notes, kind="project", project_context=frozen
        )
        await store.create(state)
        async with await WorkflowEnvironment.start_local(
            plugins=[PydanticAIPlugin()],
            dev_server_existing_path=os.environ.get(
                "TEMPORAL_TEST_SERVER", "/opt/homebrew/bin/temporal"
            ),
            dev_server_log_level="error",
        ) as env:
            queue = "project-preflight-" + str(uuid4())
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ProjectConversationWorkflow],
                activities=[preflight, project_conversation_events, save_project_conversation],
            ):
                handle = await env.client.start_workflow(
                    ProjectConversationWorkflow.run, state, id=workflow_id(cid), task_queue=queue
                )
                prompt = ProjectPrompt(
                    request_id=uuid4(), text="First planning question", context_sha256=frozen.digest
                )
                rejected = []
                for index in range(3):
                    failed = prompt.model_copy(update={"request_id": uuid4()})
                    rejected.append(failed)
                    await handle.execute_update("submit", failed)
                    for _ in range(300):
                        value = await store.snapshot(cid, "owner")
                        if len(value["inputs"]) == index + 1 and (
                            value["inputs"][-1]["outcome"] == "failed"
                        ):
                            break
                        await asyncio.sleep(0.05)
                    assert value["phase"] == "idle"
                    assert value["failure"] == "provider_preflight_rejected_not_dispatched"
                    assert value["attempts"] == []
                assert (await handle.execute_update("submit", rejected[0]))["outcome"] == "failed"
                assert len(validations) == 3
                for index in range(16):
                    next_prompt = prompt.model_copy(update={"request_id": uuid4()})
                    await handle.execute_update("submit", next_prompt)
                    for _ in range(300):
                        value = await store.snapshot(cid, "owner")
                        if len(value["inputs"]) == index + 4 and (
                            value["inputs"][-1]["outcome"] == "completed"
                        ):
                            break
                        await asyncio.sleep(0.05)
                    assert value["phase"] == "idle"
                    assert value["failure"] is None
                    assert len(value["attempts"]) == index + 1
                assert len(validations) == 19
                assert (await handle.execute_update("submit", rejected[0]))["outcome"] == "failed"
                await handle.execute_update("cancel", "owner")
                await handle.result()

    asyncio.run(exercise())


def test_reconcile_queries_durable_receipt_when_project_projection_lags(  # noqa: F811
    project_config,
    isolated_postgres,  # noqa: F811
):
    from birbcrew.domain import AcceptedInput, ProjectPrompt

    prompt = ProjectPrompt(
        request_id=uuid4(), text="Accepted but not yet projected", context_sha256="0" * 64
    )
    receipt = AcceptedInput(
        request_id=str(prompt.request_id),
        digest=prompt.digest,
        text=prompt.text,
        ordinal=0,
        outcome="accepted",
    ).model_dump(mode="json")
    queries = []

    class Temporal:
        def get_workflow_handle(self, identity):
            class Handle:
                async def query(self, name, request_id, **kwargs):
                    queries.append((name, request_id))
                    return receipt if request_id == receipt["request_id"] else None

            return Handle()

    async def exercise():
        await store.migrate()
        frozen = ProjectContext.model_validate(context())
        state = Conversation(
            id=str(uuid4()),
            owner="owner",
            context=frozen.notes,
            kind="project",
            project_context=frozen,
        )
        await store.create(state)
        api.app.state.temporal = Temporal()
        body = prompt.model_copy(update={"context_sha256": frozen.digest})
        headers = {
            "Authorization": "Bearer owner-token",
            "X-Birbforge-Project-Token": "service-token",
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=api.app), base_url="http://fixture"
        ) as client:
            path = f"/internal/project-conversations/{state.id}/reconcile"
            assert (await store.snapshot(state.id, "owner"))["inputs"] == []
            response = await client.post(path, json=body.model_dump(mode="json"), headers=headers)
            assert response.status_code == 200
            assert response.json() == {"accepted": True, "input": receipt}
            changed = body.model_copy(update={"text": "Changed reuse"})
            assert (
                await client.post(path, json=changed.model_dump(mode="json"), headers=headers)
            ).status_code == 409
            unknown = body.model_copy(update={"request_id": uuid4()})
            assert (
                await client.post(path, json=unknown.model_dump(mode="json"), headers=headers)
            ).json() == {"accepted": False}
        assert queries[0] == ("accepted_input", str(prompt.request_id))
        assert (await store.snapshot(state.id, "owner"))["inputs"] == []

    asyncio.run(exercise())


@pytest.mark.parametrize("response_bytes", [15000, 150000])
def test_queued_unicode_inputs_recheck_headroom_before_inference(  # noqa: F811
    project_config,
    isolated_postgres,  # noqa: F811
    monkeypatch,
    response_bytes,
):
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from pydantic_ai.messages import (
        ModelMessagesTypeAdapter,
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from birbcrew.domain import MAX_PROJECT_NATIVE_BYTES, ProjectPrompt, workflow_id
    from birbcrew.project_runtime import (
        agent,
        project_conversation_events,
        save_project_conversation,
    )
    from birbcrew.project_workflow import ProjectConversationWorkflow, native_bytes

    calls = []
    entered = asyncio.Event()
    release = asyncio.Event()

    @activity.defn(name="validate_project_provider")
    async def preflight():
        entered.set()
        await release.wait()

    async def unicode_response(messages, info):
        calls.append(1)
        yield "答" * (response_bytes // 3)

    monkeypatch.setattr(agent.model, "stream_function", unicode_response)

    async def exercise():
        await store.migrate()
        frozen = ProjectContext.model_validate(context())
        cid = str(uuid4())
        seeded = (
            [
                ModelRequest(parts=[UserPromptPart("Earlier completed question")]),
                ModelResponse(parts=[TextPart("前" * 13000)]),
            ]
            if response_bytes == 15000
            else []
        )
        state = Conversation(
            id=cid,
            owner="owner",
            context=frozen.notes,
            kind="project",
            project_context=frozen,
            native_messages=ModelMessagesTypeAdapter.dump_python(seeded, mode="json"),
        )
        if seeded:
            assert native_bytes(state.native_messages) < 42000
            assert len(json.dumps(state.native_messages).encode()) > 78000
        await store.create(state)
        async with await WorkflowEnvironment.start_local(
            plugins=[PydanticAIPlugin()],
            dev_server_existing_path=os.environ.get(
                "TEMPORAL_TEST_SERVER", "/opt/homebrew/bin/temporal"
            ),
            dev_server_log_level="error",
        ) as env:
            queue = "unicode-headroom-" + str(uuid4())
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ProjectConversationWorkflow],
                activities=[preflight, project_conversation_events, save_project_conversation],
            ):
                handle = await env.client.start_workflow(
                    ProjectConversationWorkflow.run, state, id=workflow_id(cid), task_queue=queue
                )
                prompts = [
                    ProjectPrompt(request_id=uuid4(), text=text, context_sha256=frozen.digest)
                    for text in ["問" * 3000, "🪶" * 2000, "次" * 2500]
                ]
                await handle.execute_update("submit", prompts[0])
                await asyncio.wait_for(entered.wait(), 5)
                for prompt in prompts[1:]:
                    await handle.execute_update("submit", prompt)
                assert (await handle.query("accepted_input", str(prompts[1].request_id)))[
                    "outcome"
                ] == "accepted"
                release.set()
                for _ in range(400):
                    value = await store.snapshot(cid, "owner")
                    if len(value["inputs"]) == 3 and all(
                        item["outcome"] in {"completed", "failed"} for item in value["inputs"]
                    ):
                        break
                    await asyncio.sleep(0.05)
                assert calls == [1]
                assert value["inputs"][0]["outcome"] == "completed"
                assert [item["outcome"] for item in value["inputs"][1:]] == ["failed", "failed"]
                assert len(value["attempts"]) == 1
                assert value["attempts"][0]["outcome"] == "completed"
                assert native_bytes(value["native_messages"]) < MAX_PROJECT_NATIVE_BYTES
                if response_bytes == 15000:
                    assert (await handle.execute_update("submit", prompts[0]))[
                        "outcome"
                    ] == "completed"
                    assert value["phase"] == "idle"
                    assert value["failure"] == "project_history_headroom_exhausted_not_dispatched"
                    assert value["messages"][-1]["content"] == "答" * 5000
                    assert (await handle.execute_update("submit", prompts[1]))[
                        "outcome"
                    ] == "failed"
                    await handle.execute_update("cancel", "owner")
                    assert await handle.result() == "cancelled"
                else:
                    assert value["phase"] == "failed"
                    assert value["failure"] == "provider_response_confirmed_history_budget_exceeded"
                    assert "bounded preview" in value["messages"][-1]["content"]
                    assert "Full native response SHA-256" in value["messages"][-1]["content"]
                    assert "答" * 100 in value["messages"][-1]["content"]
                    assert await handle.result() == "failed"
                    headers = {
                        "Authorization": "Bearer owner-token",
                        "X-Birbforge-Project-Token": "service-token",
                    }
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=api.app), base_url="http://fixture"
                    ) as client:
                        retried = await client.post(
                            f"/internal/project-conversations/{cid}/inputs",
                            json=prompts[0].model_dump(mode="json"),
                            headers=headers,
                        )
                    assert retried.status_code == 200
                    assert retried.json()["outcome"] == "completed"
                assert calls == [1]

    asyncio.run(exercise())


@pytest.mark.parametrize("stage", ["preflight", "prepared"])
def test_cancellation_before_model_scheduling_is_not_an_uncertain_attempt(  # noqa: F811
    project_config,
    isolated_postgres,  # noqa: F811
    monkeypatch,
    stage,
):
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from birbcrew.domain import ProjectPrompt, workflow_id
    from birbcrew.project_runtime import agent, project_conversation_events
    from birbcrew.project_workflow import ProjectConversationWorkflow

    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def response(messages, info):
        calls.append(1)
        yield "This inference must not run."

    monkeypatch.setattr(agent.model, "stream_function", response)

    @activity.defn(name="validate_project_provider")
    async def preflight():
        if stage == "preflight":
            entered.set()
            await release.wait()

    @activity.defn(name="save_project_conversation")
    async def save(state: Conversation) -> Conversation:
        if stage == "prepared" and state.attempts and state.attempts[-1].outcome == "prepared":
            entered.set()
            await release.wait()
        return await store.save(state)

    async def exercise():
        await store.migrate()
        frozen = ProjectContext.model_validate(context())
        state = Conversation(
            id=str(uuid4()),
            owner="owner",
            context=frozen.notes,
            kind="project",
            project_context=frozen,
        )
        await store.create(state)
        async with await WorkflowEnvironment.start_local(
            plugins=[PydanticAIPlugin()],
            dev_server_existing_path=os.environ.get(
                "TEMPORAL_TEST_SERVER", "/opt/homebrew/bin/temporal"
            ),
            dev_server_log_level="error",
        ) as env:
            queue = "cancel-before-model-" + str(uuid4())
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[ProjectConversationWorkflow],
                activities=[preflight, project_conversation_events, save],
            ):
                handle = await env.client.start_workflow(
                    ProjectConversationWorkflow.run,
                    state,
                    id=workflow_id(state.id),
                    task_queue=queue,
                )
                await handle.execute_update(
                    "submit",
                    ProjectPrompt(
                        request_id=uuid4(),
                        text="Planning question",
                        context_sha256=frozen.digest,
                    ),
                )
                await asyncio.wait_for(entered.wait(), 5)
                assert (await handle.execute_update("cancel", "owner"))[
                    "acknowledgement"
                ] == "requested"
                release.set()
                assert await handle.result() == "cancelled"
                value = await store.snapshot(state.id, "owner")
                assert value["phase"] == "cancelled"
                assert value["inputs"][0]["outcome"] == "cancelled"
                assert calls == []
                assert [attempt["outcome"] for attempt in value["attempts"]] == (
                    [] if stage == "preflight" else ["not_dispatched"]
                )

    asyncio.run(exercise())
