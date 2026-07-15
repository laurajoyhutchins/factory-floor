from __future__ import annotations

import asyncio, hashlib, json, random, re
from dataclasses import dataclass
from typing import Any, AsyncIterator, BinaryIO, Callable
from urllib.parse import urljoin

import httpx
from pydantic import BaseModel, ValidationError

from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult
from factory_floor_contracts.worker.cancellation_response_schema import WorkerCancellationResponse
from factory_floor_contracts.worker.capability_request_schema import WorkerCapabilityRequest
from factory_floor_contracts.worker.capability_response_schema import WorkerCapabilityResponse
from factory_floor_contracts.worker.claim_request_schema import Capability, WorkerClaimRequest
from factory_floor_contracts.worker.claim_response_schema import WorkerClaimResponse
from factory_floor_contracts.worker.error_schema import WorkerError
from factory_floor_contracts.worker.heartbeat_response_schema import WorkerHeartbeatResponse
from factory_floor_contracts.worker.heartbeat_schema import WorkerHeartbeat
from factory_floor_contracts.worker.stage_request_schema import WorkerStageRequest
from factory_floor_contracts.worker.stage_response_schema import WorkerStageResponse
from factory_floor_contracts.worker.upload_response_schema import WorkerUploadResponse

PROTOCOL_VERSION = "1.0"
_SECRET = re.compile(r"(Bearer\s+)[^\s,]+|([?&](?:token|signature|uploadHandle|leaseToken)=)[^&\s]+|([A-Za-z0-9_-]{16,})")


def redact(value: object) -> str:
    return _SECRET.sub(lambda m: (m.group(1) or m.group(2) or "") + "[REDACTED]", str(value))


class WorkerSdkError(Exception):
    retryable = False


class TransportError(WorkerSdkError):
    retryable = True


class ProtocolError(WorkerSdkError):
    def __init__(self, error: WorkerError, status_code: int):
        super().__init__(f"{error.code}: {error.message} ({error.requestId})")
        self.error = error
        self.status_code = status_code
        self.retryable = error.retryable


class ConflictingResultError(ProtocolError):
    pass


class ProtocolValidationError(WorkerSdkError):
    pass


@dataclass(frozen=True)
class WorkerClientConfig:
    base_url: str
    bearer_token: str
    worker_id: str
    connect_timeout: float = 2.0
    read_timeout: float = 10.0
    write_timeout: float = 10.0
    request_timeout: float = 15.0


class WorkerClient:
    def __init__(self, config: WorkerClientConfig, *, http_client: httpx.AsyncClient | None = None, sleep: Callable[[float], Any] = asyncio.sleep, rand: Callable[[], float] = random.random):
        self.config = config
        timeout = httpx.Timeout(config.request_timeout, connect=config.connect_timeout, read=config.read_timeout, write=config.write_timeout)
        self._client = http_client or httpx.AsyncClient(base_url=config.base_url.rstrip("/"), timeout=timeout)
        self._own = http_client is None
        self._sleep = sleep
        self._rand = rand

    async def aclose(self) -> None:
        if self._own:
            await self._client.aclose()

    def _headers(self, trace: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Authorization": f"Bearer {self.config.bearer_token}", "Factory-Floor-Protocol-Version": PROTOCOL_VERSION}
        if trace:
            h.update(trace)
        return h

    async def _json(self, method: str, url: str, model: type[BaseModel], *, body: BaseModel | dict[str, Any] | None = None, trace: dict[str, str] | None = None, retry_safe: bool = False) -> Any:
        delays = [0.05, 0.1, 0.2] if retry_safe else [0]
        last: Exception | None = None
        for i, base in enumerate(delays):
            if i:
                await self._sleep(min(1.0, base + self._rand() * base))
            try:
                data = body.model_dump(mode="json", by_alias=True, exclude_none=True) if isinstance(body, BaseModel) else body
                r = await self._client.request(method, url, json=data, headers=self._headers(trace))
                if r.status_code >= 400:
                    try:
                        err = WorkerError.model_validate(r.json())
                    except Exception as exc:
                        raise ProtocolValidationError(redact(r.text)) from exc
                    cls = ConflictingResultError if r.status_code == 409 or err.code == "duplicate_conflicting_result" else ProtocolError
                    ex = cls(err, r.status_code)
                    if retry_safe and ex.retryable and i < len(delays) - 1:
                        last = ex; continue
                    raise ex
                payload = r.json()
                if model is dict:
                    if payload.get("protocolVersion", PROTOCOL_VERSION) != PROTOCOL_VERSION:
                        raise ProtocolValidationError("unsupported protocol version")
                    return payload
                parsed = model.model_validate(payload)
                if getattr(parsed, "protocolVersion", PROTOCOL_VERSION) != PROTOCOL_VERSION:
                    raise ProtocolValidationError("unsupported protocol version")
                return parsed
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = TransportError(redact(exc))
                if retry_safe and i < len(delays) - 1: continue
                raise last from exc
            except ValidationError as exc:
                raise ProtocolValidationError(str(exc)) from exc
        assert last
        raise last

    async def claim(self, capabilities: list[str]) -> WorkerClaimResponse:
        req = WorkerClaimRequest(protocolVersion=PROTOCOL_VERSION, workerId=self.config.worker_id, capabilities=[Capability(c) for c in capabilities])
        return await self._json("POST", "/worker/v1/claim", WorkerClaimResponse, body=req, retry_safe=True)

    async def heartbeat(self, env: InvocationEnvelope) -> WorkerHeartbeatResponse:
        return await self._json("POST", str(env.heartbeatUrl), WorkerHeartbeatResponse, body=self._lease_body(env), trace=env.traceContext, retry_safe=True)

    async def cancellation(self, env: InvocationEnvelope) -> WorkerCancellationResponse:
        return await self._json("POST", str(env.cancellationUrl), WorkerCancellationResponse, body=self._lease_body(env), trace=env.traceContext, retry_safe=True)

    def _lease_body(self, env: InvocationEnvelope) -> WorkerHeartbeat:
        return WorkerHeartbeat(protocolVersion=PROTOCOL_VERSION, executionId=env.executionId, attemptId=env.attemptId, leaseToken=env.leaseToken, lifecycleEpoch=env.lifecycleEpoch)

    async def stage_artifact(self, req: WorkerStageRequest, trace: dict[str, str] | None = None) -> WorkerStageResponse:
        return await self._json("POST", "/worker/v1/artifacts/stage", WorkerStageResponse, body=req, trace=trace)

    async def upload(self, upload_url: str, content: bytes | BinaryIO | AsyncIterator[bytes]) -> WorkerUploadResponse:
        try:
            r = await self._client.put(upload_url, content=content, headers={"Authorization": f"Bearer {self.config.bearer_token}", "Content-Type":"application/octet-stream"})
            if r.status_code >= 400:
                raise ProtocolError(WorkerError.model_validate(r.json()), r.status_code)
            return WorkerUploadResponse.model_validate(r.json())
        except httpx.HTTPError as exc:
            raise TransportError(redact(exc)) from exc

    async def submit_result(self, result: ProposedResult, trace: dict[str, str] | None = None) -> dict[str, Any]:
        return await self._json("POST", "/worker/v1/results", dict, body=result, trace=trace, retry_safe=True)

    async def invoke_capability(self, req: WorkerCapabilityRequest, trace: dict[str, str] | None = None, *, retry_safe: bool = False) -> WorkerCapabilityResponse:
        return await self._json("POST", "/worker/v1/capabilities/invoke", WorkerCapabilityResponse, body=req, trace=trace, retry_safe=retry_safe)


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
