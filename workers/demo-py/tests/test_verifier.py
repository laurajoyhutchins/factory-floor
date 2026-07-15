from pathlib import Path
from factory_floor_contracts.invocation_envelope_schema import InvocationEnvelope
from factory_floor_demo_py.verifier import FAILURE_CODE, verify
ROOT=Path(__file__).resolve().parents[3]
def env(attempt:int, fail:bool=True):
    data=(ROOT/'contracts/fixtures/worker/invocation-envelope.valid.json').read_text()
    e=InvocationEnvelope.model_validate_json(data)
    d=e.model_dump(mode='json'); d['attemptNumber']=attempt; d['component']['definitionName']='verify'; d['component']['configuration']={'failFirstAttemptForDemo':fail}
    return InvocationEnvelope.model_validate(d)
def test_first_attempt_intentional_failure_is_from_immutable_attempt_number():
    r=verify(env(1)).root
    assert r.status=='failed' and r.failure.code==FAILURE_CODE and r.failure.details['derivedFrom']=='invocation.attemptNumber'
def test_later_attempt_succeeds_after_restart_without_counter():
    assert verify(env(2)).model_dump_json() == verify(env(2)).model_dump_json()
    assert verify(env(2)).root.status=='completed'
def test_disabled_fail_first_succeeds_attempt_one():
    assert verify(env(1, False)).root.status=='completed'
