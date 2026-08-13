"""Canonical Python runtime checks for ArcRho frozen-component builds."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping


REQUIRED_PYTHON = (3, 10)
REQUIRED_PYTHON_LABEL = ".".join(map(str, REQUIRED_PYTHON))


def require_python_310() -> None:
    if sys.version_info[:2] != REQUIRED_PYTHON:
        raise RuntimeError(
            f"ArcRho frozen releases require Python {REQUIRED_PYTHON_LABEL}, "
            f"not {sys.version.split()[0]}."
        )


def _interpreter_version(python_exe: Path) -> tuple[int, int] | None:
    try:
        completed = subprocess.run(
            [
                str(python_exe),
                "-c",
                "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    pieces = completed.stdout.strip().split(".")
    if len(pieces) != 2 or not all(piece.isdigit() for piece in pieces):
        return None
    return int(pieces[0]), int(pieces[1])


def ensure_python_310_venv(
    venv_python: str | Path,
    *,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Create or replace a component venv so it always uses Python 3.10."""

    require_python_310()
    executable = Path(venv_python)
    venv_dir = executable.parent.parent
    existing_version = _interpreter_version(executable) if executable.exists() else None
    if executable.exists() and existing_version != REQUIRED_PYTHON:
        print(
            f"\n>>> Replacing {venv_dir}; cached interpreter is "
            f"{existing_version or 'unusable'}, expected {REQUIRED_PYTHON_LABEL}."
        )
        shutil.rmtree(venv_dir)
    if not executable.exists():
        print(f"\n>>> Creating Python {REQUIRED_PYTHON_LABEL} environment ({venv_dir})")
        subprocess.run(
            [sys.executable, "-m", "venv", str(venv_dir)],
            check=True,
            env=env,
        )
    actual_version = _interpreter_version(executable)
    if actual_version != REQUIRED_PYTHON:
        raise RuntimeError(
            f"Virtual environment {venv_dir} uses {actual_version or 'an unknown version'}; "
            f"Python {REQUIRED_PYTHON_LABEL} is required."
        )
    return executable
