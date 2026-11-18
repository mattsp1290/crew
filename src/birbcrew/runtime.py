import asyncio
import copy
from contextlib import suppress
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5

from ag_ui.core import RunAgentInput
from pydantic_ai import Agent, CallDeferred, DeferredToolRequests, RunContext
from pydantic_ai.durable_exec.temporal import TemporalDurability, stream_agent_events
from pydantic_ai.ui.ag_ui import AGUIAdapter
from temporalio import activity
from temporalio.common import RetryPolicy
from temporalio.workflow import ActivityCancellationType

from birbcrew import provider, store, test_model
from birbcrew.config import settings
from birbcrew.domain import Conversation, Coworker, Projection, RunDeps
from birbcrew.telemetry import observation

DURABILITY = TemporalDurability[RunDeps](
    deps_type=RunDeps,
    event_stream_topic="agent-events",
    activity_config={
        "start_to_close_timeout": timedelta(seconds=300),
        "heartbeat_timeout": timedelta(seconds=3),
        "cancellation_type": ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        "retry_policy": RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=3),
    },
    model_activity_config={
        "start_to_close_timeout": timedelta(seconds=120),
        "heartbeat_timeout": timedelta(seconds=30),
    },
)


def make_agent():
    config = settings()
    if config.mode == "live":
        selected_model = provider.model()
    elif config.mode == "test":
        selected_model = test_model.model()
    else:
        raise ValueError("Unsupported provider mode")
    allowed = "test" if config.mode == "test" else provider.MODEL
    if allowed not in Coworker().eligible_models:
        raise ValueError("Model is not eligible for this coworker definition")
    return Agent(
        selected_model,
        name="birbcrew-proof-v1",
        deps_type=RunDeps,
        output_type=[str, DeferredToolRequests],
        instructions=Coworker().instructions,
        capabilities=[DURABILITY],
    )


agent = make_agent()


async def prepare_operation(ctx, definition):
    definition = copy.deepcopy(definition)
    definition.parameters_json_schema["properties"]["operation_id"]["enum"] = [
        ctx.deps.operation_id
    ]
    return definition


@agent.tool(prepare=prepare_operation, sequential=True)
async def record_work_item(ctx: RunContext[RunDeps], operation_id: str) -> dict:
    """Record exactly one synthetic coding work item using the provided stable operation ID."""
    if operation_id != ctx.deps.operation_id:
        raise ValueError("Unexpected operation ID")
    with observation(
        "tool.effect",
        conversation_id=ctx.deps.conversation_id,
        request_id=ctx.deps.request_id,
        run_id=ctx.deps.run_id,
        operation_id=operation_id,
        workflow_id=activity.info().workflow_id,
    ):
        result, inserted = await store.record_effect(ctx.deps)
    if inserted and ctx.deps.interrupt_after_effect:
        with observation(
            "tool.committed_before_ack",
            conversation_id=ctx.deps.conversation_id,
            operation_id=operation_id,
            request_id=ctx.deps.request_id,
            run_id=ctx.deps.run_id,
            workflow_id=activity.info().workflow_id,
        ):
            while True:
                activity.heartbeat()
                await asyncio.sleep(0.2)
    if not inserted:
        with observation(
            "tool.reconciled",
            conversation_id=ctx.deps.conversation_id,
            request_id=ctx.deps.request_id,
            run_id=ctx.deps.run_id,
            operation_id=operation_id,
            workflow_id=activity.info().workflow_id,
        ):
            pass
    return result


@agent.tool(sequential=True)
async def choose_next_step(ctx: RunContext[RunDeps]) -> str:
    """Ask the installation owner to choose inspect or test for this synthetic coding task."""
    raise CallDeferred()


@activity.defn
async def save_conversation(state: Conversation) -> Conversation:
    with observation(
        "conversation.persist",
        conversation_id=state.id,
        workflow_id=activity.info().workflow_id,
        phase=state.phase.value,
    ):
        return await store.save(state)


@activity.defn
async def project_events(spec: Projection) -> int:
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
            "agent-events",
            output_type=str | DeferredToolRequests,
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
