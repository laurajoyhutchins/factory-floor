from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

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
VERIFICATION_SCHEMA_KEY = "verification-result.v1"
_SCHEMA_ENTRY = json.loads(os.environ.get("FACTORY_FLOOR_SCHEMA_DIGESTS", "{}")).get(
    VERIFICATION_SCHEMA_KEY, {}
)
VERIFICATION_SCHEMA_ID = _SCHEMA_ENTRY.get("id", VERIFICATION_SCHEMA_KEY)
VERIFICATION_SCHEMA_DIGEST = _SCHEMA_ENTRY.get(
    "digest", hashlib.sha256(VERIFICATION_SCHEMA_KEY.encode()).hexdigest()
)


@dataclass(frozen=True)
class DemoWorkerConfig:
    base_url: str
    bearer_token: str
    worker_id: str
    concurrency: int


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _worker_base_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(
            "FACTORY_FLOOR_WORKER_BASE_URL must be a valid http or https URL"
        )
    if parsed.username or parsed.password:
        raise RuntimeError(
            "FACTORY_FLOOR_WORKER_BASE_URL must not contain credentials"
        )
    return value.rstrip("/")


def load_demo_worker_config(env: Mapping[str, str]) -> DemoWorkerConfig:
    raw_concurrency = env.get("FACTORY_FLOOR_WORKER_CONCURRENCY", "1").strip()
    try:
        concurrency = int(raw_concurrency)
    except ValueError as error:
        raise RuntimeError(
            "FACTORY_FLOOR_WORKER_CONCURRENCY must be a positive integer"
        ) from error
    if concurrency < 1:
        raise RuntimeError(
            "FACTORY_FLOOR_WORKER_CONCURRENCY must be a positive integer"
        )
    return DemoWorkerConfig(
        base_url=_worker_base_url(_required(env, "FACTORY_FLOOR_WORKER_BASE_URL")),
        bearer_token=_required(env, "FACTORY_FLOOR_WORKER_TOKEN"),
        worker_id=_required(env, "FACTORY_FLOOR_WORKER_ID"),
        concurrency=concurrency,
    )


class DeterministicVerifier:
    async def run(
        self, envelope: InvocationEnvelope, context: WorkerContext
    ) -> ProposedResult:
        base = verify(envelope)
        if base.root.status == "failed":
            return base

        delay_ms = int(os.environ.get("FACTORY_FLOOR_VERIFIER_DELAY_MS", "0"))
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000)

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
    input_bytes = len(canonical_json_bytes([item.payload for item in envelope.inputs]))
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


async def start_demo_worker_from_env(
    env: Mapping[str, str] | None = None,
) -> None:
    config = load_demo_worker_config(env if env is not None else os.environ)
    client = WorkerClient(
        WorkerClientConfig(
            base_url=config.base_url,
            bearer_token=config.bearer_token,
            worker_id=config.worker_id,
        )
    )
    runner = WorkerRunner(
        client,
        create_demo_components(),
        concurrency=config.concurrency,
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
        envelope = InvocationEnvelope.model_validate_json(arguments.envelope.read_text())
        print(verify(envelope).model_dump_json(by_alias=True, exclude_none=True))
        return
    try:
        asyncio.run(start_demo_worker_from_env())
    except Exception as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
