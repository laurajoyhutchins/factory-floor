from __future__ import annotations
from typing import Any, BinaryIO
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.worker.stage_request_schema import WorkerStageRequest
from .client import PROTOCOL_VERSION, WorkerClient, canonical_json_bytes, digest_bytes

async def stage_json(client:WorkerClient, env:InvocationEnvelope, port_name:str, value:Any, metadata:dict[str,Any]|None=None):
    data=canonical_json_bytes(value)
    return await stage_bytes(client, env, port_name, data, 'application/json', metadata)
async def stage_bytes(client:WorkerClient, env:InvocationEnvelope, port_name:str, data:bytes|BinaryIO, media_type:str, metadata:dict[str,Any]|None=None):
    b=data if isinstance(data, bytes) else data.read()
    req=WorkerStageRequest(protocolVersion=PROTOCOL_VERSION, executionId=env.executionId, attemptId=env.attemptId, leaseToken=env.leaseToken, lifecycleEpoch=env.lifecycleEpoch, portName=port_name, mediaType=media_type, expectedDigest=digest_bytes(b), expectedSizeBytes=len(b), metadata=metadata or {})
    stage=await client.stage_artifact(req, env.traceContext)
    upload=await client.upload(stage.uploadUrl, b)
    return stage, upload
