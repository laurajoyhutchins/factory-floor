from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult
from factory_floor_contracts.worker.capability_request_schema import WorkerCapabilityRequest
from factory_floor_contracts.worker.stage_request_schema import WorkerStageRequest
from factory_floor_worker_sdk import (
    WorkerClient,
    WorkerClientConfig,
    WorkerSdkError,
)
from factory_floor_worker_sdk.client import PROTOCOL_VERSION

ROOT = Path(__file__).resolve().parents[3]
CORPUS = json.loads(
    (ROOT / "contracts/conformance/worker-protocol-v1.cases.json").read_text()
)


def fixture(path: str) -> Any:
    return json.loads((ROOT / path).read_text())


def response_body(case: dict[str, Any]) -> Any:
    response = case["response"]
    if fixture_path := response.get("fixture"):
        return fixture(fixture_path)
    return response.get("body", {})


def classification(error: WorkerSdkError) -> str:
    return {
        "lease": "lease_error",
        "capability_denied": "capability_denied",
        "conflict": "conflict",
    }.get(error.kind, error.kind)


def normalized_json_value(value: Any) -> Any:
    value = json.loads(json.dumps(value, default=str))
    if isinstance(value, list):
        return [normalized_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: normalized_json_value(item) for key, item in value.items()}
    if isinstance(value, str) and "T" in value and value.endswith("Z"):
        try:
            instant = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
        except ValueError:
            return value
        return (
            instant.astimezone(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    return value


async def run_operation_case(case: dict[str, Any]) -> dict[str, Any]:
    envelope = InvocationEnvelope.model_validate(
        fixture("contracts/fixtures/worker/invocation-envelope.valid.json")
    )
    if mutations := case["request"].get("bodyMutations"):
        envelope = envelope.model_copy(update=mutations)
    uploaded = bytearray()
    wire_body: dict[str, Any] | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal wire_body
        if request.method == "PUT":
            stage = fixture("contracts/fixtures/worker/stage-response.valid.json")
            assert str(request.url) == f"http://conformance.local{stage['uploadUrl']}"
            assert request.headers["content-type"] == "application/octet-stream"
            assert request.headers["authorization"] == "Bearer conformance-token"
            assert request.headers["x-worker-id"] == "conformance-worker"
            uploaded.extend(await request.aread())
            return httpx.Response(
                200,
                json={
                    "protocolVersion": "1.0",
                    "stagedRef": stage["stagedRef"],
                    "digest": case["request"].get("body", {}).get(
                        "expectedDigest", "a" * 64
                    ),
                    "sizeBytes": len(uploaded),
                },
            )

        expected_request = case["request"]
        assert request.method == expected_request["method"]
        endpoint = getattr(envelope, expected_request["endpointFromEnvelope"])
        assert str(request.url) == str(endpoint)
        wire_body = json.loads(request.content)
        if fixture_path := expected_request.get("fixture"):
            expected_body = fixture(fixture_path)
        else:
            expected_body = {
                "protocolVersion": "1.0",
                "executionId": envelope.executionId,
                "attemptId": envelope.attemptId,
                "leaseToken": envelope.leaseToken,
                "lifecycleEpoch": envelope.lifecycleEpoch,
                **expected_request.get("body", {}),
            }
        assert normalized_json_value(wire_body) == normalized_json_value(expected_body)
        return httpx.Response(
            case["response"].get("status", 200), json=response_body(case)
        )

    worker = WorkerClient(
        WorkerClientConfig(
            "http://conformance.local", "conformance-token", "conformance-worker"
        ),
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="http://conformance.local",
        ),
        sleep=lambda _delay: asyncio.sleep(0),
        rand=lambda: 0,
    )

    try:
        operation = case["operation"]
        if operation == "heartbeat":
            await worker.heartbeat(envelope)
        elif operation == "cancellation":
            await worker.cancellation(envelope)
        elif operation == "capability":
            values = case["request"]["body"]
            await worker.invoke_capability(
                envelope,
                WorkerCapabilityRequest(
                    protocolVersion=PROTOCOL_VERSION,
                    executionId=envelope.executionId,
                    attemptId=envelope.attemptId,
                    leaseToken=envelope.leaseToken,
                    lifecycleEpoch=envelope.lifecycleEpoch,
                    handle=values["handle"],
                    input=values["input"],
                ),
            )
        elif operation == "artifact":
            values = case["request"]["body"]
            stage = await worker.stage_artifact(
                envelope,
                WorkerStageRequest(
                    protocolVersion=PROTOCOL_VERSION,
                    executionId=envelope.executionId,
                    attemptId=envelope.attemptId,
                    leaseToken=envelope.leaseToken,
                    lifecycleEpoch=envelope.lifecycleEpoch,
                    portName=values["portName"],
                    mediaType=values["mediaType"],
                    expectedDigest=values["expectedDigest"],
                    expectedSizeBytes=values["expectedSizeBytes"],
                    metadata=values["metadata"],
                ),
            )
            content = case["request"]["uploadBytesUtf8"].encode()
            await worker.upload(str(stage.uploadUrl), content)
            assert uploaded == content
            return {"classification": "staged", "retryable": False}
        elif operation == "result":
            result = ProposedResult.model_validate(fixture(case["request"]["fixture"]))
            response = await worker.submit_result(envelope, result)
            return {
                "classification": "duplicate"
                if response["duplicate"]
                else "accepted",
                "retryable": False,
            }
        else:
            raise AssertionError(f"unsupported operation {operation}")
        raise AssertionError(f"case {case['id']} unexpectedly succeeded")
    except WorkerSdkError as error:
        if case["id"] == "cancellation.stale-epoch":
            assert wire_body is not None
            assert wire_body["lifecycleEpoch"] == 0
        return {
            "classification": classification(error),
            "retryable": error.retryable,
        }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS["cases"] if case["operation"] != "claim"],
    ids=lambda case: case["id"],
)
async def test_python_worker_operation_conformance(case: dict[str, Any]) -> None:
    assert await run_operation_case(case) == case["expected"]
