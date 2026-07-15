from pathlib import Path
import sys

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

sys.path.insert(0, str(PACKAGE_ROOT / "src"))
sys.path.insert(0, str(REPOSITORY_ROOT / "workers/demo-py/src"))
