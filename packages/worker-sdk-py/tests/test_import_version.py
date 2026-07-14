from factory_floor_worker_sdk import __version__


def test_imports_version() -> None:
    assert __version__ == "0.1.0"
