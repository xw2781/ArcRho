"""Publish frontend/user-manual to the configured Server root without a rebuild."""

from pathlib import Path
import sys

SOURCE_ROOT = Path(__file__).resolve().parent / "src"
sys.path.insert(0, str(SOURCE_ROOT))

from build_runtime import align_workspace_root_env  # noqa: E402

align_workspace_root_env()

from arcrho_gateway.publish_guide import publish_guide  # noqa: E402
from utils import get_project_root  # noqa: E402


if __name__ == "__main__":
    print(f"Published User Guide: {publish_guide(get_project_root())}")
