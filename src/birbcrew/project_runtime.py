import asyncio
from contextlib import suppress
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5

from ag_ui.core import RunAgentInput
from pydantic_ai import Agent
from pydantic_ai.durable_exec.temporal import TemporalDurability, stream_agent_events
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.ui.ag_ui import AGUIAdapter
from temporalio import activity
from temporalio.common import RetryPolicy
from temporalio.workflow import ActivityCancellationType

from birbcrew import provider, store
from birbcrew.config import settings
from birbcrew.domain import Conversation, ProjectCoworker, Projection, RunDeps

DURABILITY = TemporalDurability[RunDeps](
    deps_type=RunDeps,
    event_stream_topic="project-agent-events",
    activity_config={
        "start_to_close_timeout": timedelta(seconds=180),
        "heartbeat_timeout": timedelta(seconds=30),
        "cancellation_type": ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        "retry_policy": RetryPolicy(maximum_attempts=1),
    },
    model_activity_config={
        "start_to_close_timeout": timedelta(seconds=120),
        "heartbeat_timeout": timedelta(seconds=30),
        "retry_policy": RetryPolicy(maximum_attempts=1),
    },
)


def fixture_text(messages):
    return "Injected project model response. " + " ".join(
        str(part.content) for part in messages[-1].parts if hasattr(part, "content")
    )


def fixture_response(messages, info):
    return ModelResponse(parts=[TextPart(fixture_text(messages))])


async def fixture_stream(messages, info):
    yield fixture_text(messages)


def make_agent():
    config = settings()
    if config.mode == "project-live":
        selected = provider.model()
    elif config.mode == "project-test":
        selected = FunctionModel(fixture_response, stream_function=fixture_stream)
    else:
        raise ValueError("Project worker requires project-live or project-test mode")
    return Agent(
        selected,
        name="birbcrew-project-planning-v1",
        deps_type=RunDeps,
        output_type=str,
        instructions=ProjectCoworker().instructions,
        capabilities=[DURABILITY],
    )


agent = make_agent()


@activity.defn
async def validate_project_provider() -> None:
    """Refuse a live turn before dispatch when the provider credential is no longer readable."""
    if settings().mode == "project-live":
        provider.read_go_key()


@activity.defn
async def save_project_conversation(state: Conversation) -> Conversation:
    return await store.save(state)


@activity.defn
async def project_conversation_events(spec: Projection) -> int:
    client = activity.client()
    handle = client.get_workflow_handle(spec.workflow_id)
    adapter = AGUIAdapter(
        agent,
        RunAgentInput(
            thread_id=spec.conversation_id,
            run_id=spec.run_id,
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
        ),
        include_usage=True,
    )
    ids = {}

    def stable_ids(event: dict) -> dict:
        for field in ("messageId", "parentMessageId", "entityId"):
            if event.get(field):
                old = event[field]
                if old not in ids:
                    ids[old] = str(uuid5(NAMESPACE_URL, f"{spec.run_id}/stream/{len(ids)}"))
                event[field] = ids[old]
        return event

    async def heartbeat():
        while True:
            activity.heartbeat()
            await asyncio.sleep(0.5)

    pulse = asyncio.create_task(heartbeat())
    try:
        async with stream_agent_events(
            client,
            handle,
            "project-agent-events",
            output_type=str,
            from_offset=spec.offset,
        ) as native:
            i = 0
            async for event in adapter.transform_stream(native):
                activity.heartbeat()
                payload = stable_ids(
                    event.model_dump(
                        mode="json", by_alias=True, exclude_none=True, exclude={"timestamp"}
                    )
                )
                await store.publish(spec.conversation_id, f"{spec.run_id}/{i}", payload)
                i += 1
            return native.offset + 1
    finally:
        pulse.cancel()
        with suppress(asyncio.CancelledError):
            await pulse
