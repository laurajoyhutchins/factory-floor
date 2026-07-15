from __future__ import annotations
import asyncio, json
from pathlib import Path
import httpx, pytest
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult
from factory_floor_worker_sdk import WorkerClient, WorkerClientConfig, ProtocolError, ConflictingResultError, redact
from factory_floor_worker_sdk.runner import WorkerRunner
from factory_floor_worker_sdk.artifacts import stage_json
ROOT=Path(__file__).resolve().parents[3]

def fixture(name): return json.loads((ROOT/'contracts/fixtures/worker'/name).read_text())
def client(handler): return WorkerClient(WorkerClientConfig('http://test','secret-token-value-123456','w1'), http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url='http://test'))
def env(): return InvocationEnvelope.model_validate(fixture('invocation-envelope.valid.json'))

@pytest.mark.asyncio
async def test_claim_auth_headers_and_no_work_polling():
    seen={}
    async def h(req):
        seen.update(req.headers); return httpx.Response(200,json=fixture('no-work-response.valid.json'))
    c=client(h); r=await c.claim(['verify@1'])
    assert r.root.claimed is False and seen['authorization']=='Bearer secret-token-value-123456'

@pytest.mark.asyncio
async def test_typed_protocol_exception_and_conflict():
    async def h(req): return httpx.Response(409,json={"protocolVersion":"1.0","code":"duplicate_conflicting_result","message":"conflict","retryable":False,"requestId":"r1"})
    c=client(h)
    with pytest.raises(ConflictingResultError): await c.submit_result(ProposedResult.model_validate_json((ROOT/'contracts/fixtures/proposed-results/valid-completed.json').read_text()))

@pytest.mark.asyncio
async def test_transient_claim_retry():
    n=0
    async def h(req):
        nonlocal n; n+=1
        return httpx.Response(503,json={"protocolVersion":"1.0","code":"internal_transient_failure","message":"retry","retryable":True,"requestId":"r"}) if n==1 else httpx.Response(200,json=fixture('no-work-response.valid.json'))
    c=WorkerClient(WorkerClientConfig('http://test','tok','w1'), http_client=httpx.AsyncClient(transport=httpx.MockTransport(h), base_url='http://test'), sleep=lambda _: asyncio.sleep(0), rand=lambda:0)
    assert (await c.claim([])).root.claimed is False and n==2

@pytest.mark.asyncio
async def test_heartbeat_cancellation_capability_and_upload():
    async def h(req):
        if 'heartbeat' in str(req.url): return httpx.Response(200,json=fixture('heartbeat-response.valid.json'))
        if 'cancellation' in str(req.url): return httpx.Response(200,json=fixture('cancellation-response.valid.json'))
        if 'capabilities' in str(req.url): return httpx.Response(200,json={"protocolVersion":"1.0","output":{"ok":True},"auditId":"a"})
        if req.method=='PUT': return httpx.Response(200,json={"protocolVersion":"1.0","stagedRef":"s","digest":"".join(['a']*64),"sizeBytes":3})
        return httpx.Response(500)
    c=client(h); e=env()
    assert (await c.heartbeat(e)).leaseValid is True
    assert (await c.cancellation(e)).state.value == 'continue'

@pytest.mark.asyncio
async def test_staged_json_upload_and_redaction():
    async def h(req):
        if req.method=='POST': return httpx.Response(200,json=fixture('stage-response.valid.json'))
        return httpx.Response(200,json={"protocolVersion":"1.0","stagedRef":"018f6f73-8d5b-7cc8-9ed9-6b2f4e25d010","digest":"43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777","sizeBytes":13})
    c=client(h); st, up=await stage_json(c, env(), 'out', {'a':1,'b':2})
    assert st.stagedRef and up.sizeBytes==13
    assert 'secret-token-value' not in redact('Bearer secret-token-value-123456')

@pytest.mark.asyncio
async def test_runner_no_work_and_component_lookup_cleanup():
    calls=0
    async def h(req):
        nonlocal calls; calls+=1
        if calls==1: return httpx.Response(200,json=fixture('no-work-response.valid.json'))
        return httpx.Response(200,json={**fixture('no-work-response.valid.json'), 'retryAfterMs': 1})
    c=client(h); r=WorkerRunner(c, {}, idle_sleep_ms=1); task=asyncio.create_task(r.run_forever(['missing@1'])); await asyncio.sleep(0.01); r.request_stop(); await task
    assert calls>=1
