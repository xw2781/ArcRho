"""Canonical Python runtime checks for ArcRho frozen-component builds."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping, MutableMapping


REQUIRED_PYTHON = (3, 10)
REQUIRED_PYTHON_LABEL = ".".join(map(str, REQUIRED_PYTHON))
DEPLOY_ROOT_ENV = "ARCRHO_DEPLOY_ROOT"
WORKSPACE_ROOT_ENVS = ("ARCRHO_ROOT", "ADAS_ROOT")
DRIVE_FIXED = 3


def align_workspace_root_env(
    environment: MutableMapping[str, str] | None = None,
) -> Path | None:
    """Point the workspace-root variable at an explicitly chosen deploy root.

    ``utils`` resolves the workspace root once at import time and only reaches
    the deploy root through a folder-name heuristic, so a UNC or differently
    named ``ARCRHO_DEPLOY_ROOT`` silently resolves to the repository instead.
    A build script that deploys to one workspace while reading its config,
    kill switch, and heartbeats from another would swap the deployed app out
    from under a live process, so resolve both from the same value before
    ``utils`` is imported and refuse a conflicting pair outright.

    Returns the deploy root, or ``None`` when the caller set no deploy root and
    the normal ``utils`` resolution still applies.
    """

    env = os.environ if environment is None else environment
    deploy_root = str(env.get(DEPLOY_ROOT_ENV) or "").strip()
    if not deploy_root:
        return None

    resolved = Path(deploy_root).expanduser()
    for name in WORKSPACE_ROOT_ENVS:
        configured = str(env.get(name) or "").strip()
        if not configured:
            continue
        if os.path.normcase(str(Path(configured).expanduser())) != os.path.normcase(str(resolved)):
            raise RuntimeError(
                f"{name}={configured} and {DEPLOY_ROOT_ENV}={deploy_root} name different "
                "ArcRho workspaces. Set both to the workspace being deployed to."
            )
        return resolved

    env[WORKSPACE_ROOT_ENVS[0]] = str(resolved)
    return resolved


def is_local_fixed_path(path: str | Path) -> bool:
    """Report whether a path lives on this machine's own fixed disk.

    A build that deploys to a mapped or UNC workspace must not start the
    deployed executable, because it would run the server's component on the
    build machine.
    """

    if os.name != "nt":
        return True
    drive = Path(path).drive
    if not drive or drive.startswith("\\\\"):
        return False
    import ctypes

    return int(ctypes.windll.kernel32.GetDriveTypeW(f"{drive}\\")) == DRIVE_FIXED


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
