from __future__ import annotations

import hashlib
from tempfile import SpooledTemporaryFile
from typing import Any, BinaryIO, Callable

from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.staged_artifact_schema import StagedArtifact
from factory_floor_contracts.worker.stage_request_schema import WorkerStageRequest

from .client import (
    PROTOCOL_VERSION,
    ProtocolValidationError,
    WorkerClient,
    canonical_json_bytes,
)

_CHUNK_SIZE = 64 * 1024


async def stage_json(
    client: WorkerClient,
    envelope: InvocationEnvelope,
    port_name: str,
    value: Any,
    *,
    schema_id: str,
    schema_digest: str,
    metadata: dict[str, Any] | None = None,
) -> StagedArtifact:
    return await stage_bytes(
        client,
        envelope,
        port_name,
        canonical_json_bytes(value),
        "application/json",
        schema_id=schema_id,
        schema_digest=schema_digest,
        metadata=metadata,
    )


async def stage_bytes(
    client: WorkerClient,
    envelope: InvocationEnvelope,
    port_name: str,
    data: bytes | BinaryIO,
    media_type: str,
    *,
    schema_id: str,
    schema_digest: str,
    metadata: dict[str, Any] | None = None,
) -> StagedArtifact:
    content, digest, size, cleanup = _prepare_content(data)
    request_metadata = dict(metadata or {})
    request_metadata.update({"schemaId": schema_id, "schemaDigest": schema_digest})
    request = WorkerStageRequest(
        protocolVersion=PROTOCOL_VERSION,
        executionId=envelope.executionId,
        attemptId=envelope.attemptId,
        leaseToken=envelope.leaseToken,
        lifecycleEpoch=envelope.lifecycleEpoch,
        portName=port_name,
        mediaType=media_type,
        expectedDigest=digest,
        expectedSizeBytes=size,
        metadata=request_metadata,
    )
    try:
        stage = await client.stage_artifact(envelope, request)
        upload = await client.upload(
            str(stage.uploadUrl), content, envelope.traceContext
        )
    finally:
        cleanup()

    if upload.digest != digest or upload.sizeBytes != size:
        raise ProtocolValidationError(
            "artifact upload receipt did not match the staged digest and size"
        )

    return StagedArtifact(
        stagingId=upload.stagedRef,
        portName=port_name,
        digest=upload.digest,
        sizeBytes=upload.sizeBytes,
        mediaType=media_type,
        schemaId=schema_id,
        schemaDigest=schema_digest,
        provenance={
            "kind": "execution",
            "executionId": envelope.executionId,
            "attemptId": envelope.attemptId,
        },
    )


def _prepare_content(
    data: bytes | BinaryIO,
) -> tuple[bytes | BinaryIO, str, int, Callable[[], None]]:
    if isinstance(data, bytes):
        return data, hashlib.sha256(data).hexdigest(), len(data), lambda: None

    try:
        start = data.tell()
        data.seek(start)
        seekable = True
    except (AttributeError, OSError):
        start = 0
        seekable = False

    digest = hashlib.sha256()
    size = 0
    if seekable:
        while chunk := data.read(_CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
        data.seek(start)
        return data, digest.hexdigest(), size, lambda: None

    spool = SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b")
    while chunk := data.read(_CHUNK_SIZE):
        digest.update(chunk)
        size += len(chunk)
        spool.write(chunk)
    spool.seek(0)
    return spool, digest.hexdigest(), size, spool.close
