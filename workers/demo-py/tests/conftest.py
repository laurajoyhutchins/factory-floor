from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'workers/demo-py/src'))
sys.path.insert(0, str(ROOT / 'packages/worker-sdk-py/src'))
