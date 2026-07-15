from __future__ import annotations

import asyncio, signal
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_contracts.proposed_result_schema import ProposedResult
from factory_floor_contracts.worker.claim_response_schema import WorkerClaimResponse1, WorkerClaimResponse2

from .client import WorkerClient

class WorkerComponent(Protocol):
    async def run(self, envelope: InvocationEnvelope, context: 'WorkerContext') -> ProposedResult: ...

@dataclass
class WorkerContext:
    client: WorkerClient
    cancellation: asyncio.Event = field(default_factory=asyncio.Event)
    staged: list[Any] = field(default_factory=list)
    async def heartbeat(self, env: InvocationEnvelope): return await self.client.heartbeat(env)
    async def observe_cancellation(self, env: InvocationEnvelope): return await self.client.cancellation(env)

class WorkerRunner:
    def __init__(self, client: WorkerClient, components: dict[str, WorkerComponent], *, concurrency: int = 1, idle_sleep_ms: int = 250):
        self.client=client; self.components=components; self.concurrency=concurrency; self.idle_sleep_ms=idle_sleep_ms
        self._stop=asyncio.Event(); self._active:set[asyncio.Task[Any]]=set()
    def request_stop(self): self._stop.set()
    def install_signal_handlers(self):
        loop=asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try: loop.add_signal_handler(sig, self.request_stop)
            except NotImplementedError: pass
    async def run_forever(self, capabilities:list[str]) -> None:
        while not self._stop.is_set():
            self._active={t for t in self._active if not t.done()}
            if len(self._active)>=self.concurrency:
                done,_=await asyncio.wait(self._active, timeout=0.1, return_when=asyncio.FIRST_COMPLETED)
                for t in done: await t
                continue
            claim=await self.client.claim(capabilities)
            root=claim.root
            if isinstance(root, WorkerClaimResponse2):
                await asyncio.sleep(root.retryAfterMs/1000 if root.retryAfterMs else self.idle_sleep_ms/1000); continue
            env=InvocationEnvelope.model_validate(root.envelope)
            task=asyncio.create_task(self._run_one(env)); self._active.add(task)
        await self.shutdown()
    async def shutdown(self, timeout:float=5.0)->None:
        if self._active:
            await asyncio.wait(self._active, timeout=timeout)
            for t in self._active:
                if not t.done(): t.cancel()
            await asyncio.gather(*self._active, return_exceptions=True)
    async def _run_one(self, env:InvocationEnvelope)->None:
        key=f"{env.component.definitionName}@{env.component.definitionVersion}"
        comp=self.components.get(key)
        ctx=WorkerContext(self.client)
        hb=asyncio.create_task(self._heartbeat_loop(env, ctx))
        try:
            if comp is None: raise LookupError(f"no component registered for {key}")
            result=await comp.run(env, ctx)
            if not ctx.cancellation.is_set(): await self.client.submit_result(result, env.traceContext)
        except asyncio.CancelledError:
            ctx.cancellation.set(); raise
        finally:
            hb.cancel(); await asyncio.gather(hb, return_exceptions=True)
    async def _heartbeat_loop(self, env:InvocationEnvelope, ctx:WorkerContext)->None:
        interval=max(0.05, env.limits.heartbeatIntervalMs/1000/2)
        while not ctx.cancellation.is_set():
            await asyncio.sleep(interval)
            resp=await self.client.heartbeat(env)
            if not resp.leaseValid or resp.cancellation.value == 'cancellation_requested': ctx.cancellation.set(); return
