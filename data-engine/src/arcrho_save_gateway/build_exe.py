"""Build, atomically deploy, and restart ArcRho Save Gateway."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent.parent
REPOSITORY_ROOT = PROJECT_ROOT.parent
SOURCE_ROOT = BASE_DIR.parent
CANONICAL_SOURCE_ROOT = REPOSITORY_ROOT / "python-api" / "src"
for path in (PROJECT_ROOT, SOURCE_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from build_runtime import ensure_python_310_venv
from utils import component_app_name, get_config_value, resolve_app_path, set_config_value


BUILD_ROOT = PROJECT_ROOT / "builds" / BASE_DIR.name
BUILD_CACHE_ROOT = BUILD_ROOT / "cache"
DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))
APPS_DIR = DEPLOY_ROOT / "apps"
VENV_PYTHON = PROJECT_ROOT / "venvs" / BASE_DIR.name / "Scripts" / "python.exe"
REQ_FILE = BASE_DIR / "requirements.txt"
ENTRY_PY = BASE_DIR / "main.py"
APP_NAME = component_app_name("save_gateway")
ICON = PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Orchestrator.ico"
STAGE_ONLY = os.environ.get("ARCRHO_STAGE_ONLY", "").strip() == "1"
BUILD_DIR = BUILD_ROOT / "build"
SPEC_DIR = BUILD_ROOT / "spec"
DIST_DIR = BUILD_ROOT / "dist"
STAGED_APP_DIR = DIST_DIR / APP_NAME
DEPLOY_APP_DIR = APPS_DIR / APP_NAME
KILL_ALL_KEY = "apps.save_gateway.kill_all"
SHUTDOWN_TIMEOUT_SECONDS = 30

for name, folder in {
    "TEMP": BUILD_CACHE_ROOT / "tmp",
    "TMP": BUILD_CACHE_ROOT / "tmp",
    "PIP_CACHE_DIR": BUILD_CACHE_ROOT / "pip",
    "PYINSTALLER_CONFIG_DIR": BUILD_CACHE_ROOT / "pyinstaller",
}.items():
    folder.mkdir(parents=True, exist_ok=True)
    os.environ[name] = str(folder)


def run(command: list[object]) -> None:
    print("\n>>>", " ".join(map(str, command)))
    subprocess.run(list(map(str, command)), check=True)


def _remove_tree(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


def live_instance_count() -> int:
    try:
        return sum(
            1
            for path in resolve_app_path("save_gateway", "instances").iterdir()
            if path.is_file() and path.suffix.lower() == ".json"
        )
    except FileNotFoundError:
        return 0


def wait_for_shutdown() -> None:
    deadline = time.monotonic() + SHUTDOWN_TIMEOUT_SECONDS
    while live_instance_count():
        if time.monotonic() >= deadline:
            raise RuntimeError("The live Save Gateway did not stop; deploy aborted.")
        time.sleep(0.5)


def start_gateway() -> None:
    if live_instance_count():
        return
    executable = DEPLOY_APP_DIR / f"{APP_NAME}.exe"
    if not executable.is_file():
        raise FileNotFoundError(f"Deployed Save Gateway not found: {executable}")
    subprocess.Popen(
        [str(executable)],
        cwd=str(executable.parent),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


@contextmanager
def gateway_stopped():
    previous = get_config_value(KILL_ALL_KEY, False)
    set_config_value(KILL_ALL_KEY, True)
    try:
        wait_for_shutdown()
        yield
    finally:
        set_config_value(KILL_ALL_KEY, previous)
        if not previous:
            start_gateway()


def build_exe() -> None:
    for path in (BUILD_DIR, SPEC_DIR, DIST_DIR):
        _remove_tree(path)
    ensure_python_310_venv(VENV_PYTHON)
    run([VENV_PYTHON, "-m", "pip", "install", "-r", REQ_FILE])
    run(
        [
            VENV_PYTHON,
            "-m",
            "PyInstaller",
            "--specpath",
            SPEC_DIR,
            "--noconfirm",
            "--onedir",
            "--paths",
            SOURCE_ROOT,
            "--paths",
            CANONICAL_SOURCE_ROOT,
            "--hidden-import",
            "utils",
            "--hidden-import",
            "server_config",
            "--hidden-import",
            "arcrho_engine_save_contract",
            "--hidden-import",
            "arcrho_hosted_save_http_contract",
            "--hidden-import",
            "arcrho_dependent_propagation_contract",
            f"--icon={ICON}",
            "--noconsole",
            "--clean",
            "--name",
            APP_NAME,
            "--distpath",
            DIST_DIR,
            "--workpath",
            BUILD_DIR,
            ENTRY_PY,
        ]
    )


def deploy_exe() -> None:
    if not STAGED_APP_DIR.is_dir():
        raise FileNotFoundError(f"Built Save Gateway not found: {STAGED_APP_DIR}")
    APPS_DIR.mkdir(parents=True, exist_ok=True)
    temporary = APPS_DIR / f".{APP_NAME}.new"
    backup = APPS_DIR / f".{APP_NAME}.old"
    _remove_tree(temporary)
    _remove_tree(backup)
    shutil.copytree(STAGED_APP_DIR, temporary)
    try:
        if DEPLOY_APP_DIR.exists():
            DEPLOY_APP_DIR.rename(backup)
        temporary.rename(DEPLOY_APP_DIR)
    except Exception:
        if backup.exists() and not DEPLOY_APP_DIR.exists():
            backup.rename(DEPLOY_APP_DIR)
        raise
    _remove_tree(backup)


def main() -> int:
    build_exe()
    if not STAGE_ONLY:
        with gateway_stopped():
            deploy_exe()
    output = STAGED_APP_DIR if STAGE_ONLY else DEPLOY_APP_DIR
    print(f"\nBuild finished: {output / f'{APP_NAME}.exe'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
