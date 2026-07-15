from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult
from factory_floor_contracts.staged_artifact_schema import StagedArtifact
from factory_floor_contracts.worker.cancellation_response_schema import (
    WorkerCancellationResponse,
)
from factory_floor_contracts.worker.heartbeat_response_schema import WorkerHeartbeatResponse
from factory_floor_worker_sdk.runner import WorkerRunner

ROOT = Path(__file__).resolve().parents[3]


def fixture(name: str) -> dict[str, Any]:
    return json.loads((ROOT / "contracts/fixtures/worker" / name).read_text())


def envelope() -> InvocationEnvelope:
    return InvocationEnvelope.model_validate(fixture("invocation-envelope.valid.json"))


class StagingThenFailingComponent:
    async def run(self, invocation: InvocationEnvelope, context: Any) -> ProposedResult:
        context.staged.append(
            StagedArtifact(
                stagingId="018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010",
                portName="verified-claims",
                digest="a" * 64,
                sizeBytes=17,
                mediaType="application/json",
                schemaId="verification-result.v1",
                schemaDigest="b" * 64,
                provenance={
                    "kind": "execution",
                    "executionId": invocation.executionId,
                    "attemptId": invocation.attemptId,
                },
            )
        )
        raise RuntimeError("failure after staging useful output")


class FakeClient:
    def __init__(self) -> None:
        self.submitted: list[ProposedResult] = []

    async def heartbeat(self, _invocation: InvocationEnvelope) -> WorkerHeartbeatResponse:
        return WorkerHeartbeatResponse.model_validate(
            fixture("heartbeat-response.valid.json")
        )

    async def cancellation(
        self, _invocation: InvocationEnvelope
    ) -> WorkerCancellationResponse:
        return WorkerCancellationResponse.model_validate(
            fixture("cancellation-response.valid.json")
        )

    async def submit_result(
        self,
        _invocation: InvocationEnvelope,
        result: ProposedResult,
        _trace: Any = None,
    ) -> dict[str, Any]:
        self.submitted.append(result)
        return {
            "protocolVersion": "1.0",
            "accepted": True,
            "duplicate": False,
            "handoff": "recorded_for_task_8_commit",
        }


@pytest.mark.asyncio
async def test_failed_result_preserves_staged_partial_progress() -> None:
    client = FakeClient()
    runner = WorkerRunner(  # type: ignore[arg-type]
        client,
        {"demo@1": StagingThenFailingComponent()},
    )
    invocation = envelope()
    values = invocation.model_dump(mode="json")
    values["component"]["definitionName"] = "demo"
    values["component"]["definitionVersion"] = "1"

    await runner._run_one(InvocationEnvelope.model_validate(values))

    assert len(client.submitted) == 1
    result = client.submitted[0].root
    assert result.status == "failed"
    assert [artifact.portName for artifact in result.stagedArtifacts] == [
        "verified-claims"
    ]
    assert result.resourceUsage.outputBytes == 17
