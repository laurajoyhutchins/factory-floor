from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "contracts/conformance/worker-protocol-v1.cases.json"

REQUIRED_CASE_IDS = {
    "claim.claimed",
    "claim.no-work",
    "claim.deprecated-capabilities",
    "heartbeat.lease-error",
    "cancellation.stale-epoch",
    "artifact.stage-upload",
    "capability.denied",
    "result.accepted",
    "result.duplicate-identical",
    "result.duplicate-conflict",
    "response.malformed",
    "transport.retryable",
}


def test_shared_worker_protocol_conformance_corpus() -> None:
    corpus = json.loads(CORPUS.read_text())
    cases = corpus["cases"]
    case_ids = [case["id"] for case in cases]

    assert corpus["schemaVersion"] == 1
    assert corpus["protocolVersion"] == "1.0"
    assert len(case_ids) == len(set(case_ids))
    assert REQUIRED_CASE_IDS.issubset(case_ids)
    for case in cases:
        assert case["operation"]
        assert case["expected"]["classification"]
        assert isinstance(case["expected"]["retryable"], bool)
