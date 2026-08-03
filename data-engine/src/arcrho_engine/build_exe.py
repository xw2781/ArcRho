import subprocess
from pathlib import Path
import sys
import shutil
import os

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent.parent
REPOSITORY_ROOT = PROJECT_ROOT.parent
SOURCE_ROOT = BASE_DIR.parent
CANONICAL_SOURCE_ROOT = REPOSITORY_ROOT / "python-api" / "src"
for path in (SOURCE_ROOT,):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from utils import component_app_name

BUILD_ROOT = PROJECT_ROOT / "builds" / BASE_DIR.name
DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))
APPS_DIR = DEPLOY_ROOT / "apps"
VENV_PYTHON = PROJECT_ROOT / "venvs" / BASE_DIR.name / "Scripts" / "python.exe"
REQ_FILE = BASE_DIR / "requirements.txt"

ENTRY_PY = BASE_DIR / "main.py"
APP_NAME = component_app_name("engine")
ICON = PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Engine.ico"

BUILD_DIR = BUILD_ROOT / "build"
SPEC_DIR = BUILD_ROOT / "spec"
DIST_DIR = BUILD_ROOT / "dist"
STAGED_APP_DIR = DIST_DIR / APP_NAME
DEPLOY_APP_DIR = APPS_DIR / APP_NAME

for path in (BUILD_DIR, SPEC_DIR, DIST_DIR):
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass

def run(cmd, check=True):
    print("\n>>>", " ".join(map(str, cmd)))
    return subprocess.run(list(map(str, cmd)), check=check)


def ensure_venv():
    if VENV_PYTHON.exists():
        return

    print(f"\n>>> Creating virtual environment ({VENV_PYTHON.parent.parent})")
    run([sys.executable, "-m", "venv", VENV_PYTHON.parent.parent])

    if not VENV_PYTHON.exists():
        raise RuntimeError("Failed to create virtual environment")


def ensure_venv_python():
    if not VENV_PYTHON.exists():
        raise FileNotFoundError(f"Venv python not found: {VENV_PYTHON}")


def install_requirements():
    if not REQ_FILE.exists():
        raise FileNotFoundError(f"requirements.txt not found: {REQ_FILE}")

    # Upgrade pip tooling first (more reliable installs)
    run([VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])

    # Install requirements
    run([VENV_PYTHON, "-m", "pip", "install", "-r", REQ_FILE])


def build_exe():
    contract_module = CANONICAL_SOURCE_ROOT / "arcrho_project_duplication_contract.py"
    if not contract_module.is_file():
        raise FileNotFoundError(
            f"Canonical project duplication contract not found: {contract_module}"
        )

    cmd = [
        VENV_PYTHON,
        "-m", "PyInstaller",
        "--specpath", SPEC_DIR,
        "--noconfirm",   
        "--onedir",
        "--paths", SOURCE_ROOT,
        "--paths", CANONICAL_SOURCE_ROOT,
        "--hidden-import", "utils",
        "--hidden-import", "arcrho_project_duplication_contract",
        f"--icon={ICON}",
        "--add-data", f"{ICON};.",
        "--noconsole",
        "--clean",
        "--name", APP_NAME,
        "--distpath", DIST_DIR,
        "--workpath", BUILD_DIR,
        ENTRY_PY,
    ]

    print("\nRunning PyInstaller:")
    print(" ".join(map(str, cmd)))
    run(cmd)


def deploy_exe():
    if not STAGED_APP_DIR.exists():
        raise FileNotFoundError(f"Built app not found: {STAGED_APP_DIR}")

    APPS_DIR.mkdir(parents=True, exist_ok=True)
    temp_app_dir = APPS_DIR / f".{APP_NAME}.new"
    backup_app_dir = APPS_DIR / f".{APP_NAME}.old"

    for path in (temp_app_dir, backup_app_dir):
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            pass

    shutil.copytree(STAGED_APP_DIR, temp_app_dir)

    try:
        if DEPLOY_APP_DIR.exists():
            DEPLOY_APP_DIR.rename(backup_app_dir)
        temp_app_dir.rename(DEPLOY_APP_DIR)
    except Exception:
        if backup_app_dir.exists() and not DEPLOY_APP_DIR.exists():
            backup_app_dir.rename(DEPLOY_APP_DIR)
        raise

    try:
        shutil.rmtree(backup_app_dir)
    except FileNotFoundError:
        pass


def main():
    ensure_venv()
    ensure_venv_python()
    install_requirements()
    build_exe()
    deploy_exe()

    print(f"\nBuild finished: {DEPLOY_APP_DIR / f'{APP_NAME}.exe'}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        print(f"\nERROR: Command failed with exit code {e.returncode}")
        sys.exit(e.returncode)
