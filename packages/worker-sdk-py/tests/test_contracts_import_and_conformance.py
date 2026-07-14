from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from factory_floor_contracts import ProposedEvent, ProposedResult

ROOT = Path(__file__).resolve().parents[3]


def fixture(path: str) -> str:
    return (ROOT / "contracts" / "fixtures" / path).read_text()


@pytest.mark.parametrize(
    "path",
    [
        "proposed-results/valid-completed.json",
        "proposed-results/valid-failed.json",
    ],
)
def test_proposed_result_fixtures_validate_with_pydantic(path: str) -> None:
    assert ProposedResult.model_validate_json(fixture(path))


@pytest.mark.parametrize(
    "path",
    [
        "proposed-results/invalid-failed-missing-failure.json",
        "proposed-results/invalid-completed-with-failure.json",
    ],
)
def test_proposed_result_invalid_fixtures_fail_with_pydantic(path: str) -> None:
    with pytest.raises(ValidationError):
        ProposedResult.model_validate_json(fixture(path))


def test_proposed_event_can_be_imported_and_validated() -> None:
    assert ProposedEvent.model_validate_json(fixture("proposed-events/valid-event.json"))


def test_invalid_proposed_event_fails_with_pydantic() -> None:
    with pytest.raises(ValidationError):
        ProposedEvent.model_validate_json(
            fixture("proposed-events/invalid-event-missing-subject.json")
        )
