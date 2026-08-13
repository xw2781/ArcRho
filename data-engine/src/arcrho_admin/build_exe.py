import shutil
import os
import subprocess
import sys
import time
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent.parent
REPOSITORY_ROOT = PROJECT_ROOT.parent
SOURCE_ROOT = BASE_DIR.parent
for path in (PROJECT_ROOT, SOURCE_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from build_runtime import ensure_python_310_venv
from utils import component_app_name

BUILD_ROOT = PROJECT_ROOT / "builds" / BASE_DIR.name
DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))
APPS_DIR = DEPLOY_ROOT / "apps"
VENV_PYTHON = PROJECT_ROOT / "venvs" / BASE_DIR.name / "Scripts" / "python.exe"
ENTRY_PY = BASE_DIR / "main.py"
CANONICAL_SOURCE_ROOT = REPOSITORY_ROOT / "python-api" / "src"
STAGE_ONLY = os.environ.get("ARCRHO_STAGE_ONLY", "").strip() == "1"
APP_NAME = component_app_name("admin")
ICON = PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Orchestrator.ico"

BUILD_DIR = BUILD_ROOT / "build"
SPEC_DIR = BUILD_ROOT / "spec"
DIST_DIR = BUILD_ROOT / "dist"
STAGED_APP_DIR = DIST_DIR / APP_NAME
DEPLOY_APP_DIR = APPS_DIR / APP_NAME


def run(cmd, check=True):
    print("\n>>>", " ".join(map(str, cmd)))
    return subprocess.run(list(map(str, cmd)), check=check)


def remove_tree(path, attempts=5, delay=0.5):
    for attempt in range(1, attempts + 1):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if attempt == attempts:
                raise
            time.sleep(delay * attempt)


def rename_path(source, target, attempts=10, delay=0.5):
    for attempt in range(1, attempts + 1):
        try:
            source.rename(target)
            return
        except PermissionError as exc:
            if attempt == attempts:
                raise PermissionError(
                    f"Could not replace {source}. Close any running {APP_NAME} instance "
                    "or window using that folder, then build again."
                ) from exc
            time.sleep(delay * attempt)


def clean_build_dirs():
    for path in (BUILD_DIR, SPEC_DIR, DIST_DIR):
        remove_tree(path)


def ensure_venv():
    ensure_python_310_venv(VENV_PYTHON)


def install_pyinstaller():
    run([VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
    run([VENV_PYTHON, "-m", "pip", "install", "pyinstaller>=6.15,<7"])


def build_exe():
    cmd = [
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
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "_tkinter",
        f"--icon={ICON}",
        "--add-data",
        f"{BASE_DIR / 'index.html'};.",
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
    run(cmd)


def deploy_exe():
    if not STAGED_APP_DIR.exists():
        raise FileNotFoundError(f"Built app not found: {STAGED_APP_DIR}")

    APPS_DIR.mkdir(parents=True, exist_ok=True)
    temp_app_dir = APPS_DIR / f".{APP_NAME}.new"
    backup_app_dir = APPS_DIR / f".{APP_NAME}.old"

    remove_tree(temp_app_dir)
    remove_tree(backup_app_dir)
    shutil.copytree(STAGED_APP_DIR, temp_app_dir)

    try:
        if DEPLOY_APP_DIR.exists():
            rename_path(DEPLOY_APP_DIR, backup_app_dir)
        rename_path(temp_app_dir, DEPLOY_APP_DIR)
    except Exception:
        if backup_app_dir.exists() and not DEPLOY_APP_DIR.exists():
            rename_path(backup_app_dir, DEPLOY_APP_DIR)
        raise

    remove_tree(backup_app_dir)


def main():
    clean_build_dirs()
    ensure_venv()
    install_pyinstaller()
    build_exe()
    if not STAGE_ONLY:
        deploy_exe()
    output_dir = STAGED_APP_DIR if STAGE_ONLY else DEPLOY_APP_DIR
    print(f"\nBuild finished: {output_dir / f'{APP_NAME}.exe'}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"\nERROR: Command failed with exit code {exc.returncode}")
        sys.exit(exc.returncode)
