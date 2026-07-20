from __future__ import annotations

import asyncio
import hashlib
import json
import random
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, BinaryIO, Callable, cast

import httpx
from pydantic import BaseModel, ValidationError

from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult
from factory_floor_contracts.worker.cancellation_response_schema import (
    WorkerCancellationResponse,
)
from factory_floor_contracts.worker.capability_request_schema import (
    WorkerCapabilityRequest,
)
from factory_floor_contracts.worker.capability_response_schema import (
    WorkerCapabilityResponse,
)
from factory_floor_contracts.worker.claim_request_schema import (
    ComponentSelector,
    WorkerClaimRequest,
    WorkerClaimRequest1,
)
from factory_floor_contracts.worker.claim_response_schema import WorkerClaimResponse
from factory_floor_contracts.worker.error_schema import WorkerError
from factory_floor_contracts.worker.heartbeat_response_schema import (
    WorkerHeartbeatResponse,
)
from factory_floor_contracts.worker.heartbeat_schema import WorkerHeartbeat
from factory_floor_contracts.worker.stage_request_schema import WorkerStageRequest
from factory_floor_contracts.worker.stage_response_schema import WorkerStageResponse
from factory_floor_contracts.worker.upload_response_schema import WorkerUploadResponse

PROTOCOL_VERSION = "1.0"
_UPLOAD_CHUNK_SIZE = 64 * 1024
_SECRET = re.compile(
    r"(Bearer\s+)[^\s,]+|"
    r"([?&](?:token|signature|uploadHandle|leaseToken)=)[^&\s]+|"
    r"((?:leaseToken|capabilityHandle|uploadUrl|signedUrl)=)[^\s&]+"
)


def redact(value: object) -> str:
    return _SECRET.sub(
        lambda match: (match.group(1) or match.group(2) or match.group(3) or "")
        + "[REDACTED]",
        str(value),
    )


def _error_kind(code: str, status_code: int) -> str:
    if "auth" in code:
        return "authentication"
    if "version" in code:
        return "unsupported_protocol_version"
    if "lease" in code or "inactive" in code or "stale" in code:
        return "lease"
    if "conflicting" in code:
        return "conflict"
    if "capability" in code:
        return "capability_denied"
    if status_code >= 500:
        return "transient"
    return "invalid_request"


class WorkerSdkError(Exception):
    kind = "protocol"
    retryable = False


class TransportError(WorkerSdkError):
    kind = "network"
    retryable = True


class ProtocolError(WorkerSdkError):
    def __init__(self, error: WorkerError, status_code: int):
        super().__init__(redact(f"{error.code}: {error.message} ({error.requestId})"))
        self.error = error
        self.status_code = status_code
        self.kind = _error_kind(str(error.code), status_code)
        self.retryable = error.retryable


class ConflictingResultError(ProtocolError):
    pass


class ProtocolValidationError(WorkerSdkError):
    kind = "protocol"


def _response_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ProtocolValidationError(
            "worker protocol returned non-json response"
        ) from exc


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
    def __init__(
        self,
        config: WorkerClientConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
        sleep: Callable[[float], Any] = asyncio.sleep,
        rand: Callable[[], float] = random.random,
    ):
        self.config = config
        timeout = httpx.Timeout(
            config.request_timeout,
            connect=config.connect_timeout,
            read=config.read_timeout,
            write=config.write_timeout,
        )
        self._client = http_client or httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"), timeout=timeout
        )
        self._own = http_client is None
        self._sleep = sleep
        self._rand = rand

    async def aclose(self) -> None:
        if self._own:
            await self._client.aclose()

    def _headers(self, trace: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.config.bearer_token}",
            "Factory-Floor-Protocol-Version": PROTOCOL_VERSION,
            "x-worker-id": self.config.worker_id,
        }
        if trace:
            headers.update(trace)
        return headers

    async def _json(
        self,
        method: str,
        url: str,
        model: type[BaseModel] | None,
        *,
        body: BaseModel | dict[str, Any] | None = None,
        trace: dict[str, str] | None = None,
        retry_safe: bool = False,
    ) -> Any:
        delays = [0.05, 0.1, 0.2] if retry_safe else [0]
        last: Exception | None = None
        for index, base_delay in enumerate(delays):
            if index:
                await self._sleep(min(1.0, base_delay + self._rand() * base_delay))
            try:
                data = (
                    body.model_dump(mode="json", by_alias=True, exclude_none=True)
                    if isinstance(body, BaseModel)
                    else body
                )
                response = await self._client.request(
                    method, url, json=data, headers=self._headers(trace)
                )
                if response.status_code >= 400:
                    try:
                        error = WorkerError.model_validate(_response_json(response))
                    except ProtocolValidationError:
                        raise
                    except Exception as exc:
                        raise ProtocolValidationError(redact(response.text)) from exc
                    error_class = (
                        ConflictingResultError
                        if error.code == "duplicate_conflicting_result"
                        else ProtocolError
                    )
                    protocol_error = error_class(error, response.status_code)
                    if (
                        retry_safe
                        and protocol_error.retryable
                        and index < len(delays) - 1
                    ):
                        last = protocol_error
                        continue
                    raise protocol_error

                payload = _response_json(response)
                if model is None:
                    if payload.get("protocolVersion") != PROTOCOL_VERSION:
                        raise ProtocolValidationError(
                            "unsupported worker protocol version"
                        )
                    return payload
                parsed = model.model_validate(payload)
                return parsed
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = TransportError(redact(exc))
                if retry_safe and index < len(delays) - 1:
                    continue
                raise last from exc
            except ValidationError as exc:
                raise ProtocolValidationError(str(exc)) from exc
        assert last is not None
        raise last

    async def claim(
        self,
        component_selectors: list[str] | None = None,
        *,
        capabilities: list[str] | None = None,
    ) -> WorkerClaimResponse:
        if (
            component_selectors is not None
            and capabilities is not None
            and set(component_selectors) != set(capabilities)
        ):
            raise ValueError("component_selectors conflicts with capabilities")
        selectors = component_selectors if component_selectors is not None else capabilities
        if selectors is None:
            raise ValueError("component_selectors is required")
        request = WorkerClaimRequest(
            WorkerClaimRequest1(
                protocolVersion=PROTOCOL_VERSION,
                workerId=self.config.worker_id,
                componentSelectors=[
                    ComponentSelector(selector) for selector in selectors
                ],
            )
        )
        return await self._json(
            "POST",
            "/worker/v1/claim",
            WorkerClaimResponse,
            body=request,
            retry_safe=True,
        )

    async def heartbeat(self, envelope: InvocationEnvelope) -> WorkerHeartbeatResponse:
        return await self._json(
            "POST",
            str(envelope.heartbeatUrl),
            WorkerHeartbeatResponse,
            body=self._lease_body(envelope),
            trace=envelope.traceContext,
            retry_safe=True,
        )

    async def cancellation(
        self, envelope: InvocationEnvelope
    ) -> WorkerCancellationResponse:
        return await self._json(
            "POST",
            str(envelope.cancellationUrl),
            WorkerCancellationResponse,
            body=self._lease_body(envelope),
            trace=envelope.traceContext,
            retry_safe=True,
        )

    def _lease_body(self, envelope: InvocationEnvelope) -> WorkerHeartbeat:
        return WorkerHeartbeat(
            protocolVersion=PROTOCOL_VERSION,
            executionId=envelope.executionId,
            attemptId=envelope.attemptId,
            leaseToken=envelope.leaseToken,
            lifecycleEpoch=envelope.lifecycleEpoch,
        )

    async def stage_artifact(
        self, envelope: InvocationEnvelope, request: WorkerStageRequest
    ) -> WorkerStageResponse:
        return await self._json(
            "POST",
            str(envelope.artifactStagingUrl),
            WorkerStageResponse,
            body=request,
            trace=envelope.traceContext,
        )

    async def upload(
        self,
        upload_url: str,
        content: bytes | BinaryIO | AsyncIterator[bytes],
        trace: dict[str, str] | None = None,
    ) -> WorkerUploadResponse:
        try:
            headers = self._headers(trace)
            headers["Content-Type"] = "application/octet-stream"
            response = await self._client.put(
                upload_url,
                content=_as_async_content(content),
                headers=headers,
            )
            if response.status_code >= 400:
                try:
                    error = WorkerError.model_validate(_response_json(response))
                except ProtocolValidationError:
                    raise
                except Exception as exc:
                    raise ProtocolValidationError(redact(response.text)) from exc
                raise ProtocolError(error, response.status_code)
            return WorkerUploadResponse.model_validate(_response_json(response))
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise TransportError(redact(exc)) from exc
        except ValidationError as exc:
            raise ProtocolValidationError(str(exc)) from exc

    async def submit_result(
        self,
        envelope: InvocationEnvelope,
        result: ProposedResult,
        trace: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return await self._json(
            "POST",
            str(envelope.resultSubmissionUrl),
            None,
            body=result,
            trace=trace or envelope.traceContext,
            retry_safe=True,
        )

    async def invoke_capability(
        self,
        envelope: InvocationEnvelope,
        request: WorkerCapabilityRequest,
        trace: dict[str, str] | None = None,
        *,
        retry_safe: bool = False,
    ) -> WorkerCapabilityResponse:
        return await self._json(
            "POST",
            str(envelope.capabilityInvocationUrl),
            WorkerCapabilityResponse,
            body=request,
            trace=trace or envelope.traceContext,
            retry_safe=retry_safe,
        )


def _as_async_content(
    content: bytes | BinaryIO | AsyncIterator[bytes],
) -> bytes | AsyncIterator[bytes]:
    if isinstance(content, bytes):
        return content
    if hasattr(content, "__aiter__"):
        return cast(AsyncIterator[bytes], content)
    return _file_chunks(content)


async def _file_chunks(stream: BinaryIO) -> AsyncIterator[bytes]:
    while chunk := stream.read(_UPLOAD_CHUNK_SIZE):
        yield chunk
        await asyncio.sleep(0)


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode()
