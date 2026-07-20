from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from factory_floor_worker_sdk import (
    ProtocolValidationError,
    WorkerClient,
    WorkerClientConfig,
    WorkerSdkError,
)

ROOT = Path(__file__).resolve().parents[3]
CORPUS = json.loads(
    (ROOT / "contracts/conformance/worker-protocol-v1.cases.json").read_text()
)
CLAIM_CASE_IDS = {
    "claim.claimed",
    "claim.no-work",
    "claim.deprecated-capabilities",
    "response.malformed",
    "transport.retryable",
}


def fixture(path: str) -> Any:
    return json.loads((ROOT / path).read_text())


def response_body(case: dict[str, Any]) -> Any:
    response = case["response"]
    if fixture_path := response.get("fixture"):
        return fixture(fixture_path)
    if body := response.get("body"):
        body = dict(body)
        envelope_fixture = body.pop("envelopeFixture", None)
        if envelope_fixture:
            body["envelope"] = fixture(envelope_fixture)
        return body
    if success_fixture := response.get("successFixture"):
        return fixture(success_fixture)
    return {}


async def run_claim_case(case: dict[str, Any]) -> dict[str, Any]:
    attempts = 0
    wire_body: dict[str, Any] | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts, wire_body
        attempts += 1
        wire_body = json.loads(request.content)
        response = case["response"]
        if response.get("transportError") and attempts <= response.get(
            "succeedAfterAttempts", 0
        ):
            raise httpx.ConnectError(response["transportError"])
        if "rawBody" in response:
            return httpx.Response(
                response.get("status", 200), content=response["rawBody"].encode()
            )
        return httpx.Response(response.get("status", 200), json=response_body(case))

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
        request = case.get("request", {})
        selectors = request.get("componentSelectors", ["verify@1"])
        if request.get("sdkInputAlias") == "capabilities":
            result = await worker.claim(capabilities=selectors)
        else:
            result = await worker.claim(selectors)
        if expected_wire_body := request.get("expectedWireBody"):
            assert wire_body == expected_wire_body
            assert "capabilities" not in wire_body
        return {
            "classification": "claimed" if result.root.claimed else "no_work",
            "retryable": attempts > 1,
        }
    except ProtocolValidationError as error:
        return {"classification": "protocol_error", "retryable": error.retryable}
    except WorkerSdkError as error:
        return {
            "classification": type(error).__name__,
            "retryable": error.retryable,
        }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [case for case in CORPUS["cases"] if case["id"] in CLAIM_CASE_IDS],
    ids=lambda case: case["id"],
)
async def test_python_worker_claim_conformance(case: dict[str, Any]) -> None:
    assert await run_claim_case(case) == case["expected"]
