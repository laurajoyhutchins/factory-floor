from __future__ import annotations
import argparse, asyncio, json
from typing import Any
from factory_floor_contracts.failure_descriptor_schema import Category, FailureDescriptor
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult, ProposedResult1, ProposedResult2
from factory_floor_contracts.resource_usage_schema import ResourceUsage
from factory_floor_worker_sdk.runner import WorkerContext

FAILURE_CODE="DEMO_FIRST_ATTEMPT_INTENTIONAL_FAILURE"

class DeterministicVerifier:
    async def run(self, envelope:InvocationEnvelope, context:WorkerContext|None=None)->ProposedResult:
        return verify(envelope)

def _payload(env:InvocationEnvelope)->dict[str,Any]:
    vals=[]
    for i in sorted(env.inputs, key=lambda x: x.portName): vals.append({"portName":i.portName,"payload":i.payload,"artifacts":[a.model_dump(mode='json') for a in i.artifacts]})
    return {"attemptNumber": env.attemptNumber, "component": f"{env.component.definitionName}@{env.component.definitionVersion}", "inputs": vals, "checks":[{"name":"declared-evidence-present","passed": True}], "uncertainty": []}

def verify(env:InvocationEnvelope)->ProposedResult:
    usage=ResourceUsage(cpuMilliseconds=0, wallMilliseconds=0, inputBytes=len(json.dumps([i.payload for i in env.inputs], sort_keys=True)), outputBytes=0, externalCalls=0)
    fail=bool(isinstance(env.component.configuration, dict) and env.component.configuration.get("failFirstAttemptForDemo")) and env.attemptNumber == 1
    if fail:
        return ProposedResult(root=ProposedResult2(protocolVersion="1.0", executionId=env.executionId, attemptId=env.attemptId, leaseToken=env.leaseToken, lifecycleEpoch=env.lifecycleEpoch, stagedArtifacts=[], proposedEvents=[], externalActionProposals=[], resourceUsage=usage, status="failed", failure=FailureDescriptor(code=FAILURE_CODE, message="Intentional deterministic first-attempt verifier failure for the demo.", category=Category.model, retryable=True, details={"attemptNumber": env.attemptNumber, "derivedFrom":"invocation.attemptNumber"})))
    payload=_payload(env); usage.outputBytes=len(json.dumps(payload, sort_keys=True))
    return ProposedResult(root=ProposedResult1(protocolVersion="1.0", executionId=env.executionId, attemptId=env.attemptId, leaseToken=env.leaseToken, lifecycleEpoch=env.lifecycleEpoch, stagedArtifacts=[], proposedEvents=[], externalActionProposals=[], resourceUsage=usage, status="completed"))

def main()->None:
    ap=argparse.ArgumentParser(); ap.add_argument("envelope")
    ns=ap.parse_args(); env=InvocationEnvelope.model_validate_json(open(ns.envelope).read())
    print(verify(env).model_dump_json(by_alias=True, exclude_none=True))
if __name__=="__main__": main()
