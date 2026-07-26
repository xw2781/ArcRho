import shutil
import os
import shutil
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent.parent
SOURCE_ROOT = BASE_DIR.parent
REPO_ROOT = PROJECT_ROOT.parent
for path in (PROJECT_ROOT, SOURCE_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from utils import component_app_name

BUILD_ROOT = PROJECT_ROOT / "builds" / BASE_DIR.name
DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))
APPS_DIR = DEPLOY_ROOT / "apps"
VENV_PYTHON = PROJECT_ROOT / "venvs" / BASE_DIR.name / "Scripts" / "python.exe"
REQ_FILE = BASE_DIR / "requirements.txt"

ENTRY_PY = BASE_DIR / "main.py"
APP_NAME = component_app_name("bridge")
ICON = PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Engine.ico"
RESQ_MIGRATION_SOURCE = REPO_ROOT / "python-api" / "migration"
RESQ_PYTHON_API_SOURCE = REPO_ROOT / "python-api" / "src"
RESQ_FRONTEND_APP_SERVER_SOURCE = REPO_ROOT / "frontend" / "app_server"
RESQ_IMPORT_CONTRACT_FILE = BASE_DIR / "resq_reserving_class_import_contract.json"
RESQ_MIGRATION_BUNDLE_TARGET = r"resq_importer\python-api\migration"
RESQ_PYTHON_API_BUNDLE_TARGET = r"resq_importer\python-api\src"
RESQ_IMPORT_CONTRACT_BUNDLE_TARGET = "arcrho_bridge"

BUILD_DIR = BUILD_ROOT / "build"
SPEC_DIR = BUILD_ROOT / "spec"


for folder in (BUILD_DIR, SPEC_DIR):
    try:
        shutil.rmtree(folder)
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

    run([VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
    run([VENV_PYTHON, "-m", "pip", "install", "-r", REQ_FILE])


def build_exe():
    APPS_DIR.mkdir(parents=True, exist_ok=True)
    for source in (
        RESQ_MIGRATION_SOURCE,
        RESQ_PYTHON_API_SOURCE,
        RESQ_FRONTEND_APP_SERVER_SOURCE,
    ):
        if not source.is_dir():
            raise FileNotFoundError(
                f"Canonical ResQ import bundle source was not found: {source}"
            )
    if not RESQ_IMPORT_CONTRACT_FILE.is_file():
        raise FileNotFoundError(
            f"ResQ reserving-class import contract was not found: {RESQ_IMPORT_CONTRACT_FILE}"
        )
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
        REPO_ROOT / "frontend",
        "--hidden-import",
        "utils",
        "--hidden-import",
        "win32timezone",
        "--hidden-import",
        "app_server.services.data_processing_rules_service",
        "--hidden-import",
        "app_server.services.data_processing_values_service",
        "--hidden-import",
        "app_server.services.audit_service",
        "--hidden-import",
        "arcrho_bridge.resq_import_runner",
        f"--icon={ICON}",
        "--add-data",
        f"{ICON};.",
        "--add-data",
        f"{RESQ_MIGRATION_SOURCE};{RESQ_MIGRATION_BUNDLE_TARGET}",
        "--add-data",
        f"{RESQ_PYTHON_API_SOURCE};{RESQ_PYTHON_API_BUNDLE_TARGET}",
        "--add-data",
        f"{RESQ_FRONTEND_APP_SERVER_SOURCE};resq_importer/frontend/app_server",
        "--add-data",
        f"{RESQ_IMPORT_CONTRACT_FILE};{RESQ_IMPORT_CONTRACT_BUNDLE_TARGET}",
        "--noconsole",
        "--clean",
        "--name",
        APP_NAME,
        "--distpath",
        APPS_DIR,
        "--workpath",
        BUILD_DIR,
        ENTRY_PY,
    ]

    print("\nRunning PyInstaller:")
    print(" ".join(map(str, cmd)))
    run(cmd)


def main():
    ensure_venv()
    ensure_venv_python()
    install_requirements()
    build_exe()
    print(f"\nBuild finished: {APPS_DIR / APP_NAME / f'{APP_NAME}.exe'}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"\nERROR: Command failed with exit code {exc.returncode}")
        sys.exit(exc.returncode)
