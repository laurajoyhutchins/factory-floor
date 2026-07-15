from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from factory_floor_contracts.failure_descriptor_schema import Category, FailureDescriptor
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import (
    ProposedResult,
    ProposedResult1,
    ProposedResult2,
)
from factory_floor_contracts.resource_usage_schema import ResourceUsage
from factory_floor_worker_sdk.client import (
    PROTOCOL_VERSION,
    WorkerClient,
    WorkerClientConfig,
    canonical_json_bytes,
)
from factory_floor_worker_sdk.runner import WorkerContext, WorkerRunner

FAILURE_CODE = "DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE"
VERIFICATION_SCHEMA_ID = "verification-result.v1"
VERIFICATION_SCHEMA_DIGEST = hashlib.sha256(
    VERIFICATION_SCHEMA_ID.encode()
).hexdigest()


class DeterministicVerifier:
    async def run(
        self, envelope: InvocationEnvelope, context: WorkerContext
    ) -> ProposedResult:
        base = verify(envelope)
        if base.root.status == "failed":
            return base

        payload = _payload(envelope)
        artifact = await context.stage_json(
            envelope,
            "verified-claims",
            payload,
            schema_id=VERIFICATION_SCHEMA_ID,
            schema_digest=VERIFICATION_SCHEMA_DIGEST,
            metadata={"producer": "demo-py@verify@1"},
        )
        usage = _usage(envelope, payload)
        return ProposedResult(
            root=ProposedResult1(
                protocolVersion=PROTOCOL_VERSION,
                executionId=envelope.executionId,
                attemptId=envelope.attemptId,
                leaseToken=envelope.leaseToken,
                lifecycleEpoch=envelope.lifecycleEpoch,
                stagedArtifacts=[artifact],
                proposedEvents=[],
                externalActionProposals=[],
                resourceUsage=usage,
                status="completed",
            )
        )


def _payload(envelope: InvocationEnvelope) -> dict[str, Any]:
    values = []
    for item in sorted(envelope.inputs, key=lambda input_item: input_item.portName):
        values.append(
            {
                "portName": item.portName,
                "payload": item.payload,
                "artifacts": [
                    artifact.model_dump(mode="json") for artifact in item.artifacts
                ],
            }
        )
    return {
        "passed": True,
        "attemptNumber": envelope.attemptNumber,
        "component": (
            f"{envelope.component.definitionName}@"
            f"{envelope.component.definitionVersion}"
        ),
        "inputs": values,
        "checks": [{"name": "declared-evidence-present", "passed": True}],
        "uncertainty": [],
    }


def _usage(
    envelope: InvocationEnvelope, output: dict[str, Any] | None = None
) -> ResourceUsage:
    input_bytes = len(
        canonical_json_bytes([item.payload for item in envelope.inputs])
    )
    output_bytes = len(canonical_json_bytes(output)) if output is not None else 0
    return ResourceUsage(
        cpuMilliseconds=0,
        wallMilliseconds=0,
        inputBytes=input_bytes,
        outputBytes=output_bytes,
        externalCalls=0,
    )


def verify(envelope: InvocationEnvelope) -> ProposedResult:
    should_fail = bool(
        isinstance(envelope.component.configuration, dict)
        and envelope.component.configuration.get("failFirstAttemptForDemo")
    ) and envelope.attemptNumber == 1
    if should_fail:
        return ProposedResult(
            root=ProposedResult2(
                protocolVersion=PROTOCOL_VERSION,
                executionId=envelope.executionId,
                attemptId=envelope.attemptId,
                leaseToken=envelope.leaseToken,
                lifecycleEpoch=envelope.lifecycleEpoch,
                stagedArtifacts=[],
                proposedEvents=[],
                externalActionProposals=[],
                resourceUsage=_usage(envelope),
                status="failed",
                failure=FailureDescriptor(
                    code=FAILURE_CODE,
                    message=(
                        "Intentional deterministic first-attempt verifier failure "
                        "for the demo."
                    ),
                    category=Category.model,
                    retryable=True,
                    details={
                        "attemptNumber": envelope.attemptNumber,
                        "derivedFrom": "invocation.attemptNumber",
                    },
                ),
            )
        )

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
            resourceUsage=_usage(envelope, _payload(envelope)),
            status="completed",
        )
    )


def create_demo_components() -> dict[str, DeterministicVerifier]:
    return {"verify@1": DeterministicVerifier()}


async def start_demo_worker_from_env() -> None:
    token = os.environ.get("FACTORY_FLOOR_WORKER_TOKEN", "")
    if not token:
        raise RuntimeError("FACTORY_FLOOR_WORKER_TOKEN is required")
    config = WorkerClientConfig(
        base_url=os.environ.get(
            "FACTORY_FLOOR_WORKER_BASE_URL", "http://127.0.0.1:3000"
        ),
        bearer_token=token,
        worker_id=os.environ.get(
            "FACTORY_FLOOR_WORKER_ID", "demo-py-worker"
        ),
    )
    client = WorkerClient(config)
    runner = WorkerRunner(
        client,
        create_demo_components(),
        concurrency=int(os.environ.get("FACTORY_FLOOR_WORKER_CONCURRENCY", "1")),
        logger=lambda event, fields: print(
            json.dumps({"event": event, **fields}, sort_keys=True)
        ),
    )
    runner.install_signal_handlers()
    try:
        await runner.run_forever()
    finally:
        await client.aclose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("envelope", nargs="?", type=Path)
    arguments = parser.parse_args()
    if arguments.envelope is not None:
        envelope = InvocationEnvelope.model_validate_json(
            arguments.envelope.read_text()
        )
        print(verify(envelope).model_dump_json(by_alias=True, exclude_none=True))
        return
    asyncio.run(start_demo_worker_from_env())


if __name__ == "__main__":
    main()
