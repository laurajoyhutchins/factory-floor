from __future__ import annotations

import asyncio
import signal
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from factory_floor_contracts.failure_descriptor_schema import (
    Category,
    FailureDescriptor,
)
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import (
    ProposedResult,
    ProposedResult2,
)
from factory_floor_contracts.resource_usage_schema import ResourceUsage
from factory_floor_contracts.staged_artifact_schema import StagedArtifact
from factory_floor_contracts.worker.capability_request_schema import (
    WorkerCapabilityRequest,
)
from factory_floor_contracts.worker.claim_response_schema import WorkerClaimResponse2

from .artifacts import stage_bytes, stage_json
from .client import PROTOCOL_VERSION, WorkerClient, WorkerSdkError, redact

Logger = Callable[[str, dict[str, Any]], None]
Sleep = Callable[[float], Awaitable[None]]


class WorkerComponent(Protocol):
    async def run(
        self, envelope: InvocationEnvelope, context: "WorkerContext"
    ) -> ProposedResult: ...


@dataclass
class WorkerContext:
    client: WorkerClient
    cancellation: asyncio.Event = field(default_factory=asyncio.Event)
    lease_lost: asyncio.Event = field(default_factory=asyncio.Event)
    staged: list[StagedArtifact] = field(default_factory=list)

    async def heartbeat(self, envelope: InvocationEnvelope):
        return await self.client.heartbeat(envelope)

    async def observe_cancellation(self, envelope: InvocationEnvelope):
        return await self.client.cancellation(envelope)

    async def stage_json(
        self,
        envelope: InvocationEnvelope,
        port_name: str,
        value: Any,
        *,
        schema_id: str,
        schema_digest: str,
        metadata: dict[str, Any] | None = None,
    ) -> StagedArtifact:
        artifact = await stage_json(
            self.client,
            envelope,
            port_name,
            value,
            schema_id=schema_id,
            schema_digest=schema_digest,
            metadata=metadata,
        )
        self.staged.append(artifact)
        return artifact

    async def stage_bytes(
        self,
        envelope: InvocationEnvelope,
        port_name: str,
        data: bytes | Any,
        media_type: str,
        *,
        schema_id: str,
        schema_digest: str,
        metadata: dict[str, Any] | None = None,
    ) -> StagedArtifact:
        artifact = await stage_bytes(
            self.client,
            envelope,
            port_name,
            data,
            media_type,
            schema_id=schema_id,
            schema_digest=schema_digest,
            metadata=metadata,
        )
        self.staged.append(artifact)
        return artifact

    async def invoke_capability(
        self,
        envelope: InvocationEnvelope,
        handle: str,
        input_value: dict[str, Any],
        *,
        retry_safe: bool = False,
    ):
        request = WorkerCapabilityRequest(
            protocolVersion=PROTOCOL_VERSION,
            executionId=envelope.executionId,
            attemptId=envelope.attemptId,
            leaseToken=envelope.leaseToken,
            lifecycleEpoch=envelope.lifecycleEpoch,
            handle=handle,
            input=input_value,
        )
        return await self.client.invoke_capability(
            envelope, request, retry_safe=retry_safe
        )


class WorkerRunner:
    def __init__(
        self,
        client: WorkerClient,
        components: dict[str, WorkerComponent],
        *,
        concurrency: int = 1,
        idle_sleep_ms: int = 250,
        sleep: Sleep = asyncio.sleep,
        logger: Logger | None = None,
    ):
        if concurrency < 1:
            raise ValueError("worker concurrency must be at least one")
        self.client = client
        self.components = components
        self.concurrency = concurrency
        self.idle_sleep_ms = idle_sleep_ms
        self._sleep = sleep
        self._logger = logger or (lambda _event, _fields: None)
        self._stop = asyncio.Event()
        self._active: set[asyncio.Task[None]] = set()

    def request_stop(self) -> None:
        self._stop.set()

    def install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for system_signal in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(system_signal, self.request_stop)
            except NotImplementedError:
                pass

    async def run_forever(
        self,
        component_selectors: list[str] | None = None,
        *,
        capabilities: list[str] | None = None,
    ) -> None:
        if (
            component_selectors is not None
            and capabilities is not None
            and set(component_selectors) != set(capabilities)
        ):
            raise ValueError("component_selectors conflicts with capabilities")
        selected = component_selectors if component_selectors is not None else capabilities
        selectors = sorted(selected if selected is not None else self.components)
        while not self._stop.is_set():
            await self._reap_completed()
            if len(self._active) >= self.concurrency:
                await asyncio.wait(
                    self._active,
                    timeout=0.1,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                continue

            try:
                claim = await self.client.claim(selectors)
            except WorkerSdkError as error:
                self._logger("claim_failed", {"error": redact(error)})
                await self._sleep(self.idle_sleep_ms / 1000)
                continue

            root = claim.root
            if isinstance(root, WorkerClaimResponse2):
                delay_ms = root.retryAfterMs or self.idle_sleep_ms
                await self._sleep(delay_ms / 1000)
                continue

            envelope = InvocationEnvelope.model_validate(root.envelope)
            task = asyncio.create_task(self._run_one(envelope))
            self._active.add(task)

        await self.shutdown()

    async def _reap_completed(self) -> None:
        completed = {task for task in self._active if task.done()}
        self._active.difference_update(completed)
        if completed:
            await asyncio.gather(*completed, return_exceptions=True)

    async def shutdown(self, timeout: float = 5.0) -> None:
        if not self._active:
            return
        _, pending = await asyncio.wait(self._active, timeout=timeout)
        for task in pending:
            task.cancel()
        await asyncio.gather(*self._active, return_exceptions=True)
        self._active.clear()

    async def _run_one(self, envelope: InvocationEnvelope) -> None:
        key = f"{envelope.component.definitionName}@{envelope.component.definitionVersion}"
        component = self.components.get(key)
        context = WorkerContext(self.client)
        heartbeat = asyncio.create_task(self._heartbeat_loop(envelope, context))

        try:
            if component is None:
                await self._submit_if_active(
                    envelope,
                    context,
                    _failure_result(
                        envelope,
                        code="WORKER_COMPONENT_NOT_REGISTERED",
                        message="Worker component implementation is not registered.",
                        retryable=False,
                        staged_artifacts=context.staged,
                    ),
                )
                return

            try:
                result = await component.run(envelope, context)
            except asyncio.CancelledError:
                context.cancellation.set()
                raise
            except Exception as error:
                self._logger(
                    "component_failed",
                    {"executionId": str(envelope.executionId), "error": redact(error)},
                )
                await self._submit_if_active(
                    envelope,
                    context,
                    _failure_result(
                        envelope,
                        code="WORKER_COMPONENT_ERROR",
                        message="Worker component execution failed.",
                        retryable=True,
                        staged_artifacts=context.staged,
                    ),
                )
                return

            await self._submit_if_active(
                envelope, context, _normalize_result_identity(envelope, result)
            )
        except asyncio.CancelledError:
            context.cancellation.set()
            raise
        except Exception as error:
            self._logger(
                "execution_failed",
                {"executionId": str(envelope.executionId), "error": redact(error)},
            )
        finally:
            context.cancellation.set()
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)

    async def _submit_if_active(
        self,
        envelope: InvocationEnvelope,
        context: WorkerContext,
        result: ProposedResult,
    ) -> None:
        await asyncio.sleep(0)
        if context.cancellation.is_set() or context.lease_lost.is_set():
            return
        try:
            observation = await self.client.cancellation(envelope)
        except WorkerSdkError as error:
            context.lease_lost.set()
            context.cancellation.set()
            self._logger(
                "cancellation_observation_failed",
                {"executionId": str(envelope.executionId), "error": redact(error)},
            )
            return
        if observation.state.value != "continue":
            context.cancellation.set()
            return
        await self.client.submit_result(envelope, result, envelope.traceContext)

    async def _heartbeat_loop(
        self, envelope: InvocationEnvelope, context: WorkerContext
    ) -> None:
        interval = max(0.05, envelope.limits.heartbeatIntervalMs / 1000 / 2)
        while not context.cancellation.is_set():
            try:
                response = await self.client.heartbeat(envelope)
            except WorkerSdkError as error:
                context.lease_lost.set()
                context.cancellation.set()
                self._logger(
                    "heartbeat_failed",
                    {"executionId": str(envelope.executionId), "error": redact(error)},
                )
                return
            if (
                not response.leaseValid
                or response.cancellation.value == "cancellation_requested"
            ):
                context.lease_lost.set()
                context.cancellation.set()
                return
            try:
                await asyncio.wait_for(context.cancellation.wait(), timeout=interval)
            except TimeoutError:
                continue


def _normalize_result_identity(
    envelope: InvocationEnvelope, result: ProposedResult
) -> ProposedResult:
    payload = result.model_dump(mode="json", by_alias=True, exclude_none=True)
    payload.update(
        {
            "protocolVersion": PROTOCOL_VERSION,
            "executionId": envelope.executionId,
            "attemptId": envelope.attemptId,
            "leaseToken": envelope.leaseToken,
            "lifecycleEpoch": envelope.lifecycleEpoch,
        }
    )
    return ProposedResult.model_validate(payload)


def _failure_result(
    envelope: InvocationEnvelope,
    *,
    code: str,
    message: str,
    retryable: bool,
    staged_artifacts: list[StagedArtifact] | None = None,
) -> ProposedResult:
    staged = list(staged_artifacts or [])
    return ProposedResult(
        root=ProposedResult2(
            protocolVersion=PROTOCOL_VERSION,
            executionId=envelope.executionId,
            attemptId=envelope.attemptId,
            leaseToken=envelope.leaseToken,
            lifecycleEpoch=envelope.lifecycleEpoch,
            stagedArtifacts=staged,
            proposedEvents=[],
            externalActionProposals=[],
            resourceUsage=ResourceUsage(
                cpuMilliseconds=0,
                wallMilliseconds=0,
                inputBytes=0,
                outputBytes=sum(artifact.sizeBytes for artifact in staged),
                externalCalls=0,
            ),
            status="failed",
            failure=FailureDescriptor(
                code=code,
                message=message,
                category=Category.unknown,
                retryable=retryable,
                details={
                    "component": f"{envelope.component.definitionName}@{envelope.component.definitionVersion}"
                },
            ),
        )
    )
