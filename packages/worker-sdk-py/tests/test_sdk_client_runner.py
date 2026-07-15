from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult, ProposedResult1
from factory_floor_contracts.resource_usage_schema import ResourceUsage
from factory_floor_contracts.worker.capability_request_schema import WorkerCapabilityRequest
from factory_floor_contracts.worker.cancellation_response_schema import (
    WorkerCancellationResponse,
)
from factory_floor_contracts.worker.heartbeat_response_schema import WorkerHeartbeatResponse
from factory_floor_contracts.worker.stage_request_schema import WorkerStageRequest
from factory_floor_worker_sdk import (
    ConflictingResultError,
    TransportError,
    WorkerClient,
    WorkerClientConfig,
    redact,
)
from factory_floor_worker_sdk.artifacts import stage_bytes, stage_json
from factory_floor_worker_sdk.client import PROTOCOL_VERSION
from factory_floor_worker_sdk.runner import WorkerRunner

ROOT = Path(__file__).resolve().parents[3]


def fixture(name: str) -> dict[str, Any]:
    return json.loads((ROOT / "contracts/fixtures/worker" / name).read_text())


def client(handler: Any) -> WorkerClient:
    return WorkerClient(
        WorkerClientConfig("http://test", "secret-token-value-123456", "w1"),
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://test"
        ),
    )


def env() -> InvocationEnvelope:
    return InvocationEnvelope.model_validate(fixture("invocation-envelope.valid.json"))


def completed_result(envelope: InvocationEnvelope) -> ProposedResult:
    return ProposedResult(
        root=ProposedResult1(
            protocolVersion=PROTOCOL_VERSION,
            executionId=envelope.executionId,
            attemptId=envelope.attemptId,
            leaseToken=envelope.leaseToken,
            lifecycleEpoch=envelope.lifecycleEpoch,
            stagedArtifacts=[],
            proposedEvents=[],
            externalActionProposals=[],
            resourceUsage=ResourceUsage(
                cpuMilliseconds=0,
                wallMilliseconds=0,
                inputBytes=0,
                outputBytes=0,
                externalCalls=0,
            ),
            status="completed",
        )
    )


@pytest.mark.asyncio
async def test_claim_auth_headers_and_no_work_polling() -> None:
    seen: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json=fixture("no-work-response.valid.json"))

    worker = client(handler)
    response = await worker.claim(["verify@1"])
    assert response.root.claimed is False
    assert seen["authorization"] == "Bearer secret-token-value-123456"


@pytest.mark.asyncio
async def test_typed_protocol_exception_and_conflict() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={
                "protocolVersion": "1.0",
                "code": "duplicate_conflicting_result",
                "message": "conflict",
                "retryable": False,
                "requestId": "r1",
            },
        )

    worker = client(handler)
    with pytest.raises(ConflictingResultError):
        await worker.submit_result(
            env(),
            ProposedResult.model_validate_json(
                (ROOT / "contracts/fixtures/proposed-results/valid-completed.json").read_text()
            ),
        )


@pytest.mark.asyncio
async def test_transient_claim_retry() -> None:
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                503,
                json={
                    "protocolVersion": "1.0",
                    "code": "internal_transient_failure",
                    "message": "retry",
                    "retryable": True,
                    "requestId": "r",
                },
            )
        return httpx.Response(200, json=fixture("no-work-response.valid.json"))

    worker = WorkerClient(
        WorkerClientConfig("http://test", "tok", "w1"),
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://test"
        ),
        sleep=lambda _delay: asyncio.sleep(0),
        rand=lambda: 0,
    )
    assert (await worker.claim([])).root.claimed is False
    assert calls == 2


@pytest.mark.asyncio
async def test_uses_invocation_endpoint_references() -> None:
    seen: list[str] = []
    values = env().model_dump(mode="json")
    values.update(
        {
            "artifactStagingUrl": "http://test/custom/stage",
            "resultSubmissionUrl": "http://test/custom/results",
            "capabilityInvocationUrl": "http://test/custom/capability",
        }
    )
    envelope = InvocationEnvelope.model_validate(values)

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/custom/stage":
            return httpx.Response(200, json=fixture("stage-response.valid.json"))
        if request.url.path == "/custom/results":
            return httpx.Response(
                200,
                json={
                    "protocolVersion": "1.0",
                    "accepted": True,
                    "duplicate": False,
                    "handoff": "recorded_for_task_8_commit",
                },
            )
        if request.url.path == "/custom/capability":
            return httpx.Response(
                200,
                json={"protocolVersion": "1.0", "output": {}, "auditId": "a"},
            )
        raise AssertionError(f"unexpected endpoint {request.url.path}")

    worker = client(handler)
    request = WorkerStageRequest(
        protocolVersion=PROTOCOL_VERSION,
        executionId=envelope.executionId,
        attemptId=envelope.attemptId,
        leaseToken=envelope.leaseToken,
        lifecycleEpoch=envelope.lifecycleEpoch,
        portName="verified-claims",
        mediaType="application/json",
        expectedDigest="a" * 64,
        expectedSizeBytes=2,
        metadata={},
    )
    await worker.stage_artifact(envelope, request)
    await worker.submit_result(envelope, completed_result(envelope))
    await worker.invoke_capability(
        envelope,
        WorkerCapabilityRequest(
            protocolVersion=PROTOCOL_VERSION,
            executionId=envelope.executionId,
            attemptId=envelope.attemptId,
            leaseToken=envelope.leaseToken,
            lifecycleEpoch=envelope.lifecycleEpoch,
            handle="opaque-handle",
            input={},
        ),
    )
    assert seen == ["/custom/stage", "/custom/results", "/custom/capability"]


@pytest.mark.asyncio
async def test_heartbeat_and_cancellation() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if "heartbeat" in str(request.url):
            return httpx.Response(200, json=fixture("heartbeat-response.valid.json"))
        if "cancellation" in str(request.url):
            return httpx.Response(200, json=fixture("cancellation-response.valid.json"))
        raise AssertionError(str(request.url))

    worker = client(handler)
    envelope = env()
    assert (await worker.heartbeat(envelope)).leaseValid is True
    assert (await worker.cancellation(envelope)).state.value == "continue"


class ChunkOnlyBytesIO(io.BytesIO):
    def read(self, size: int = -1) -> bytes:
        if size < 0:
            raise AssertionError("artifact helpers must read streams in bounded chunks")
        return super().read(size)


@pytest.mark.asyncio
async def test_staged_json_and_chunked_binary_upload() -> None:
    uploaded = bytearray()
    expected = b'{"a":1,"b":2}'
    expected_digest = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json=fixture("stage-response.valid.json"))
        uploaded.extend(await request.aread())
        return httpx.Response(
            200,
            json={
                "protocolVersion": "1.0",
                "stagedRef": "018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010",
                "digest": expected_digest,
                "sizeBytes": len(expected),
            },
        )

    worker = client(handler)
    envelope = env()
    staged = await stage_json(
        worker,
        envelope,
        "verified-claims",
        {"a": 1, "b": 2},
        schema_id="verification-result.v1",
        schema_digest="b" * 64,
    )
    assert staged.portName == "verified-claims"
    assert staged.sizeBytes == len(expected)
    assert uploaded == expected

    uploaded.clear()
    staged_stream = await stage_bytes(
        worker,
        envelope,
        "verified-claims",
        ChunkOnlyBytesIO(expected),
        "application/json",
        schema_id="verification-result.v1",
        schema_digest="b" * 64,
    )
    assert staged_stream.sizeBytes == len(expected)
    assert uploaded == expected
    assert "secret-token-value" not in redact("Bearer secret-token-value-123456")


class ThrowingComponent:
    async def run(
        self, envelope: InvocationEnvelope, context: Any
    ) -> ProposedResult:
        raise RuntimeError("secret component failure")


class SuccessfulComponent:
    async def run(
        self, envelope: InvocationEnvelope, context: Any
    ) -> ProposedResult:
        await asyncio.sleep(0)
        return completed_result(envelope)


class FakeRunnerClient:
    def __init__(self, *, heartbeat_error: Exception | None = None) -> None:
        self.heartbeat_error = heartbeat_error
        self.submitted: list[ProposedResult] = []

    async def heartbeat(self, _envelope: InvocationEnvelope) -> WorkerHeartbeatResponse:
        await asyncio.sleep(0)
        if self.heartbeat_error is not None:
            raise self.heartbeat_error
        return WorkerHeartbeatResponse.model_validate(
            fixture("heartbeat-response.valid.json")
        )

    async def cancellation(
        self, _envelope: InvocationEnvelope
    ) -> WorkerCancellationResponse:
        return WorkerCancellationResponse.model_validate(
            fixture("cancellation-response.valid.json")
        )

    async def submit_result(
        self, _envelope: InvocationEnvelope, result: ProposedResult, _trace: Any = None
    ) -> dict[str, Any]:
        self.submitted.append(result)
        return {
            "protocolVersion": "1.0",
            "accepted": True,
            "duplicate": False,
            "handoff": "recorded_for_task_8_commit",
        }


@pytest.mark.asyncio
async def test_runner_submits_failed_result_for_component_exception() -> None:
    fake = FakeRunnerClient()
    runner = WorkerRunner(fake, {"retrieve@1": ThrowingComponent()})  # type: ignore[arg-type]
    await runner._run_one(env())
    assert len(fake.submitted) == 1
    result = fake.submitted[0].root
    assert result.status == "failed"
    assert result.failure.code == "WORKER_COMPONENT_ERROR"
    assert "secret component failure" not in result.model_dump_json()


@pytest.mark.asyncio
async def test_heartbeat_failure_fences_result_submission() -> None:
    fake = FakeRunnerClient(heartbeat_error=TransportError("heartbeat unavailable"))
    runner = WorkerRunner(fake, {"retrieve@1": SuccessfulComponent()})  # type: ignore[arg-type]
    await runner._run_one(env())
    assert fake.submitted == []


@pytest.mark.asyncio
async def test_runner_no_work_and_component_lookup_cleanup() -> None:
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json=fixture("no-work-response.valid.json"))
        return httpx.Response(
            200,
            json={**fixture("no-work-response.valid.json"), "retryAfterMs": 1},
        )

    worker = client(handler)
    runner = WorkerRunner(worker, {}, idle_sleep_ms=1)
    task = asyncio.create_task(runner.run_forever())
    await asyncio.sleep(0.01)
    runner.request_stop()
    await task
    assert calls >= 1
