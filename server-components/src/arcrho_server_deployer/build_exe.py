"""Freeze the standalone ArcRho Server deployment helper."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = BASE_DIR.parent
SERVER_COMPONENTS_ROOT = SOURCE_ROOT.parent
REPOSITORY_ROOT = SERVER_COMPONENTS_ROOT.parent
CANONICAL_API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
BUILD_ROOT = SERVER_COMPONENTS_ROOT / "builds" / BASE_DIR.name
BUILD_DIR = BUILD_ROOT / "build"
SPEC_DIR = BUILD_ROOT / "spec"
DIST_DIR = BUILD_ROOT / "dist"
VENV_DIR = SERVER_COMPONENTS_ROOT / "venvs" / BASE_DIR.name
VENV_PYTHON = VENV_DIR / "Scripts" / "python.exe"
REQ_FILE = BASE_DIR / "requirements.txt"
ENTRY_PY = BASE_DIR / "main.py"
APP_NAME = "ArcRho Server Deployer"
OUTPUT_EXE = DIST_DIR / f"{APP_NAME}.exe"
ICON = REPOSITORY_ROOT / "assets" / "icons" / "ArcRho Launcher.ico"
CACHE_ROOT = BUILD_ROOT / "cache"

if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from build_runtime import ensure_python_310_venv, require_python_310


def build_environment() -> dict[str, str]:
    environment = os.environ.copy()
    temporary = CACHE_ROOT / "tmp"
    pyinstaller_cache = CACHE_ROOT / "pyinstaller"
    for path in (temporary, pyinstaller_cache):
        path.mkdir(parents=True, exist_ok=True)
    environment.update(
        {
            "PYINSTALLER_CONFIG_DIR": str(pyinstaller_cache),
            "TEMP": str(temporary),
            "TMP": str(temporary),
        }
    )
    return environment


def run(command: list[object], *, env: dict[str, str] | None = None) -> None:
    print("\n>>>", " ".join(map(str, command)))
    subprocess.run(list(map(str, command)), check=True, env=env)


def ensure_venv() -> None:
    environment = build_environment()
    ensure_python_310_venv(VENV_PYTHON, env=environment)
    run(
        [
            VENV_PYTHON,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-cache-dir",
            "-r",
            REQ_FILE,
        ],
        env=environment,
    )


def build() -> Path:
    for path in (BUILD_DIR, SPEC_DIR, DIST_DIR):
        shutil.rmtree(path, ignore_errors=True)
    run(
        [
            VENV_PYTHON,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--console",
            "--specpath",
            SPEC_DIR,
            "--workpath",
            BUILD_DIR,
            "--distpath",
            DIST_DIR,
            "--paths",
            SOURCE_ROOT,
            "--paths",
            CANONICAL_API_SOURCE,
            "--hidden-import",
            "utils",
            "--hidden-import",
            "server_config",
            "--hidden-import",
            "server_deployment_contract",
            "--hidden-import",
            "arcrho_api.config",
            "--hidden-import",
            "arcrho_api.io",
            f"--icon={ICON}",
            "--name",
            APP_NAME,
            ENTRY_PY,
        ],
        env=build_environment(),
    )
    if not OUTPUT_EXE.is_file():
        raise FileNotFoundError(f"Frozen deployment helper was not produced: {OUTPUT_EXE}")
    return OUTPUT_EXE


def main() -> int:
    require_python_310()
    ensure_venv()
    output = build()
    print(f"\nBuild finished: {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode)
