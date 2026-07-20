from __future__ import annotations

import pytest

from factory_floor_demo_py.verifier import DemoWorkerConfig, load_demo_worker_config

VALID_ENV = {
    "FACTORY_FLOOR_WORKER_BASE_URL": "http://127.0.0.1:3000",
    "FACTORY_FLOOR_WORKER_TOKEN": "worker-secret",
    "FACTORY_FLOOR_WORKER_ID": "demo-py-worker",
    "FACTORY_FLOOR_WORKER_CONCURRENCY": "2",
}


def test_loads_complete_fail_closed_worker_configuration() -> None:
    assert load_demo_worker_config(VALID_ENV) == DemoWorkerConfig(
        base_url="http://127.0.0.1:3000",
        bearer_token="worker-secret",
        worker_id="demo-py-worker",
        concurrency=2,
    )


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        (
            {"FACTORY_FLOOR_WORKER_BASE_URL": "not-a-url"},
            "FACTORY_FLOOR_WORKER_BASE_URL must be a valid http or https URL",
        ),
        (
            {"FACTORY_FLOOR_WORKER_TOKEN": " "},
            "FACTORY_FLOOR_WORKER_TOKEN is required",
        ),
        (
            {"FACTORY_FLOOR_WORKER_ID": ""},
            "FACTORY_FLOOR_WORKER_ID is required",
        ),
        (
            {"FACTORY_FLOOR_WORKER_CONCURRENCY": "0"},
            "FACTORY_FLOOR_WORKER_CONCURRENCY must be a positive integer",
        ),
        (
            {"FACTORY_FLOOR_WORKER_CONCURRENCY": "many"},
            "FACTORY_FLOOR_WORKER_CONCURRENCY must be a positive integer",
        ),
    ],
)
def test_rejects_invalid_configuration_before_startup(
    patch: dict[str, str], message: str
) -> None:
    with pytest.raises(RuntimeError, match=message):
        load_demo_worker_config({**VALID_ENV, **patch})


def test_rejects_credentials_embedded_in_worker_url() -> None:
    with pytest.raises(
        RuntimeError,
        match="FACTORY_FLOOR_WORKER_BASE_URL must not contain credentials",
    ):
        load_demo_worker_config(
            {
                **VALID_ENV,
                "FACTORY_FLOOR_WORKER_BASE_URL": "http://user:secret@127.0.0.1:3000",
            }
        )
