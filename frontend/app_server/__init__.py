"""ArcRho application package.

Importing a service (for example the canonical processing-provenance helper)
must not also construct the full FastAPI application.  That keeps non-HTTP
workers, including the deployed ResQ Bridge, on the same service contract
without pulling in unrelated routers and their optional dependencies.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


_PYTHON_API_SRC = Path(__file__).resolve().parents[2] / "python-api" / "src"
if _PYTHON_API_SRC.is_dir() and str(_PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(_PYTHON_API_SRC))

__all__ = ["app"]


def __getattr__(name: str) -> Any:
    """Load the ASGI app only for callers that explicitly request it."""

    if name == "app":
        from .main import app

        return app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
