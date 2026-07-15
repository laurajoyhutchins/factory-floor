from pathlib import Path
import sys
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

sys.path.insert(0, str(PACKAGE_ROOT / "src"))
sys.path.insert(0, str(REPOSITORY_ROOT / "workers/demo-py/src"))


def pytest_terminal_summary(terminalreporter: Any) -> None:
    reports = [
        report.longreprtext
        for category in ("failed", "error")
        for report in terminalreporter.stats.get(category, [])
        if hasattr(report, "longreprtext")
    ]
    if reports:
        (REPOSITORY_ROOT / "integration-test.log").write_text(
            "\n\n".join(reports), encoding="utf-8"
        )
