from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.staged_artifact_schema import StagedArtifact
from factory_floor_demo_py.verifier import (
    FAILURE_CODE,
    DeterministicVerifier,
    create_demo_components,
    verify,
)

ROOT = Path(__file__).resolve().parents[3]


def env(attempt: int, fail: bool = True) -> InvocationEnvelope:
    data = (ROOT / "contracts/fixtures/worker/invocation-envelope.valid.json").read_text()
    envelope = InvocationEnvelope.model_validate_json(data)
    values = envelope.model_dump(mode="json")
    values["attemptNumber"] = attempt
    values["component"]["definitionName"] = "verify"
    values["component"]["configuration"] = {"failFirstAttemptForDemo": fail}
    return InvocationEnvelope.model_validate(values)


def test_first_attempt_intentional_failure_is_from_immutable_attempt_number() -> None:
    result = verify(env(1)).root
    assert result.status == "failed"
    assert result.failure.code == FAILURE_CODE
    assert result.failure.details["derivedFrom"] == "invocation.attemptNumber"


def test_later_attempt_succeeds_after_restart_without_counter() -> None:
    assert verify(env(2)).model_dump_json() == verify(env(2)).model_dump_json()
    assert verify(env(2)).root.status == "completed"


def test_disabled_fail_first_succeeds_attempt_one() -> None:
    assert verify(env(1, False)).root.status == "completed"


class FakeContext:
    def __init__(self) -> None:
        self.staged: list[tuple[str, Any]] = []

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
        self.staged.append((port_name, value))
        return StagedArtifact(
            stagingId="018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010",
            portName=port_name,
            digest="a" * 64,
            sizeBytes=1,
            mediaType="application/json",
            schemaId=schema_id,
            schemaDigest=schema_digest,
            provenance={
                "kind": "execution",
                "executionId": envelope.executionId,
                "attemptId": envelope.attemptId,
            },
        )


@pytest.mark.asyncio
async def test_successful_verifier_stages_canonical_verified_claims() -> None:
    context = FakeContext()
    result = await DeterministicVerifier().run(env(2), context)  # type: ignore[arg-type]
    assert [port for port, _value in context.staged] == ["verified-claims"]
    assert result.root.status == "completed"
    assert [artifact.portName for artifact in result.root.stagedArtifacts] == [
        "verified-claims"
    ]
    assert context.staged[0][1]["passed"] is True


def test_demo_registry_exposes_verify_component() -> None:
    assert sorted(create_demo_components()) == ["verify@1"]
