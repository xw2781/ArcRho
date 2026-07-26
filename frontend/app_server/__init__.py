import sys
from pathlib import Path


_PYTHON_API_SRC = Path(__file__).resolve().parents[2] / "python-api" / "src"
if _PYTHON_API_SRC.is_dir() and str(_PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(_PYTHON_API_SRC))

from .main import app

__all__ = ["app"]
