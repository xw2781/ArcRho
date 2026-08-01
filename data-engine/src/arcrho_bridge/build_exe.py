import os
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent.parent
SOURCE_ROOT = BASE_DIR.parent
REPO_ROOT = PROJECT_ROOT.parent
for path in (PROJECT_ROOT, SOURCE_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from utils import (
    component_app_name,
    get_config_value,
    resolve_app_path,
    set_config_value,
)

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
DIST_DIR = BUILD_ROOT / "dist"
STAGED_APP_DIR = DIST_DIR / APP_NAME
DEPLOY_APP_DIR = APPS_DIR / APP_NAME

# The orchestrator relaunches the Bridge every few seconds, so a deploy that
# only stopped the running processes would race a fresh supervisor that
# re-locks the exe part way through the copy.
BRIDGE_KILL_ALL_KEY = "apps.bridge.kill_all"
BRIDGE_SHUTDOWN_TIMEOUT_SECONDS = 60
BRIDGE_SHUTDOWN_POLL_SECONDS = 1


def clean_build_dirs():
    for folder in (BUILD_DIR, SPEC_DIR, DIST_DIR):
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


def validate_resq_import_environment():
    """Fail the build if the canonical migration/provenance imports are incomplete."""

    import_paths = (RESQ_MIGRATION_SOURCE, RESQ_PYTHON_API_SOURCE, REPO_ROOT / "frontend")
    probe = (
        "import sys; "
        f"sys.path[:0] = {repr([str(path) for path in import_paths])}; "
        "from resq_migration.engine import get_engine_processing_provenance; "
        "from app_server.services.data_processing_rules_service import "
        "get_processing_provenance"
    )
    print("\n>>> Validating canonical ResQ import dependencies")
    run([VENV_PYTHON, "-c", probe])


def build_exe():
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
        DIST_DIR,
        "--workpath",
        BUILD_DIR,
        ENTRY_PY,
    ]

    print("\nRunning PyInstaller:")
    print(" ".join(map(str, cmd)))
    run(cmd)


def live_bridge_instance_count():
    total = 0
    for role in ("bridge", "bridge_worker"):
        try:
            entries = list(resolve_app_path(role, "instances").iterdir())
        except FileNotFoundError:
            continue
        total += sum(1 for entry in entries if entry.is_file())
    return total


def wait_for_bridge_shutdown():
    deadline = time.monotonic() + BRIDGE_SHUTDOWN_TIMEOUT_SECONDS
    while True:
        remaining = live_bridge_instance_count()
        if not remaining:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"The live ArcRho Bridge did not stop within "
                f"{BRIDGE_SHUTDOWN_TIMEOUT_SECONDS}s ({remaining} heartbeat(s) still "
                "present). Deploy aborted; the deployed Bridge was left untouched."
            )
        time.sleep(BRIDGE_SHUTDOWN_POLL_SECONDS)


@contextmanager
def bridge_stopped():
    """Hold the live Bridge down for the deploy window, then let it return.

    Stopping the supervisor and worker by hand is not enough: the orchestrator
    relaunches the Bridge on its own loop and would re-lock the exe mid-deploy.
    Setting the shared kill switch is what makes it stay down, and restoring the
    previous value is what lets the orchestrator bring the new build back up.
    """

    previous = get_config_value(BRIDGE_KILL_ALL_KEY, False)
    print(f"\n>>> Stopping the live ArcRho Bridge ({BRIDGE_KILL_ALL_KEY} = True)")
    set_config_value(BRIDGE_KILL_ALL_KEY, True)
    try:
        wait_for_bridge_shutdown()
        yield
    finally:
        print(f"\n>>> Releasing the ArcRho Bridge ({BRIDGE_KILL_ALL_KEY} = {previous})")
        set_config_value(BRIDGE_KILL_ALL_KEY, previous)


def deploy_exe():
    """Swap the staged build into the deployed app folder with rollback.

    PyInstaller builds into an isolated dist folder rather than straight into
    the deployed app folder. Building in place would delete the live Bridge
    before writing its replacement, so any locked file left the deployment
    destroyed with nothing to fall back to.
    """

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
    clean_build_dirs()
    ensure_venv()
    ensure_venv_python()
    install_requirements()
    validate_resq_import_environment()
    build_exe()
    with bridge_stopped():
        deploy_exe()
    print(f"\nBuild finished: {DEPLOY_APP_DIR / f'{APP_NAME}.exe'}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"\nERROR: Command failed with exit code {exc.returncode}")
        sys.exit(exc.returncode)
