import subprocess
import time
from contextlib import contextmanager
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

from arcrho_engine.bundled_sources import ENGINE_BUNDLED_SOURCES
from build_runtime import ensure_python_310_venv
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
STAGE_ONLY = os.environ.get("ARCRHO_STAGE_ONLY", "").strip() == "1"

ENTRY_PY = BASE_DIR / "main.py"
APP_NAME = component_app_name("engine")
ICON = PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Engine.ico"

BUILD_DIR = BUILD_ROOT / "build"
SPEC_DIR = BUILD_ROOT / "spec"
DIST_DIR = BUILD_ROOT / "dist"
STAGED_APP_DIR = DIST_DIR / APP_NAME
DEPLOY_APP_DIR = APPS_DIR / APP_NAME

# The orchestrator relaunches Engine instances up to apps.orchestrator.
# max_workers, so a deploy that only stopped the running processes would race
# fresh instances that re-lock the exe part way through the copy. An instance
# finishing a long durable job (propagation, duplication) delays its shutdown,
# so the wait is longer than the Bridge's.
ENGINE_KILL_ALL_KEY = "apps.engine.kill_all"
ENGINE_SHUTDOWN_TIMEOUT_SECONDS = 180
ENGINE_SHUTDOWN_POLL_SECONDS = 1

for path in (BUILD_DIR, SPEC_DIR, DIST_DIR):
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass

def run(cmd, check=True):
    print("\n>>>", " ".join(map(str, cmd)))
    return subprocess.run(list(map(str, cmd)), check=check)


def ensure_venv():
    ensure_python_310_venv(VENV_PYTHON)


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


def validate_canonical_runtime_environment():
    """Fail the build if the bundled app_server import graph is incomplete."""

    import_paths = [str(CANONICAL_SOURCE_ROOT), str(REPOSITORY_ROOT / "frontend")]
    probe = (
        "import sys; "
        f"sys.path[:0] = {import_paths!r}; "
        "from app_server.services import calculated_dataset_service; "
        "from app_server.services import dfm_service, result_selection_service; "
        "from app_server.services import bornhuetter_ferguson_service; "
        "from app_server.services import cape_cod_service, bootstrap_service; "
        "from app_server.services import arcrho_runtime_service; "
        "import arcrho_dependent_propagation_contract; "
        "import arcrho_engine_job_lease"
    )
    print("\n>>> Validating canonical dependent-propagation dependencies")
    run([VENV_PYTHON, "-c", probe])


def build_exe():
    for module_name in (
        "arcrho_project_duplication_contract.py",
        "arcrho_dependent_propagation_contract.py",
        "arcrho_engine_job_lease.py",
    ):
        contract_module = CANONICAL_SOURCE_ROOT / module_name
        if not contract_module.is_file():
            raise FileNotFoundError(
                f"Canonical contract module not found: {contract_module}"
            )
    for bundled in ENGINE_BUNDLED_SOURCES:
        if not bundled.source.is_dir():
            raise FileNotFoundError(
                f"Canonical propagation bundle source was not found: {bundled.source}"
            )

    cmd = [
        VENV_PYTHON,
        "-m", "PyInstaller",
        "--specpath", SPEC_DIR,
        "--noconfirm",
        "--onedir",
        "--paths", SOURCE_ROOT,
        "--paths", CANONICAL_SOURCE_ROOT,
        "--paths", REPOSITORY_ROOT / "frontend",
        "--hidden-import", "utils",
        "--hidden-import", "server_config",
        "--hidden-import", "arcrho_project_duplication_contract",
        "--hidden-import", "arcrho_dependent_propagation_contract",
        "--hidden-import", "arcrho_engine_job_lease",
        "--hidden-import", "app_server.services.calculated_dataset_service",
        "--hidden-import", "app_server.services.dfm_service",
        "--hidden-import", "app_server.services.result_selection_service",
        "--hidden-import", "app_server.services.bornhuetter_ferguson_service",
        "--hidden-import", "app_server.services.cape_cod_service",
        "--hidden-import", "app_server.services.bootstrap_service",
        "--hidden-import", "app_server.services.arcrho_runtime_service",
        f"--icon={ICON}",
        "--add-data", f"{ICON};.",
        *[
            argument
            for bundled in ENGINE_BUNDLED_SOURCES
            for argument in ("--add-data", f"{bundled.source};{bundled.target}")
        ],
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


def live_engine_instance_count():
    try:
        entries = list(resolve_app_path("engine", "instances").iterdir())
    except FileNotFoundError:
        return 0
    return sum(1 for entry in entries if entry.is_file())


def wait_for_engine_shutdown():
    deadline = time.monotonic() + ENGINE_SHUTDOWN_TIMEOUT_SECONDS
    while True:
        remaining = live_engine_instance_count()
        if not remaining:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"The live ArcRho Engine did not stop within "
                f"{ENGINE_SHUTDOWN_TIMEOUT_SECONDS}s ({remaining} heartbeat(s) still "
                "present). Deploy aborted; the deployed Engine was left untouched."
            )
        time.sleep(ENGINE_SHUTDOWN_POLL_SECONDS)


@contextmanager
def engines_stopped():
    """Hold live Engine instances down for the deploy window, then release.

    Setting the shared kill switch makes every instance exit on its next
    heartbeat cycle and keeps the orchestrator from launching replacements;
    restoring the previous value lets the orchestrator bring the new build
    back up to its configured worker count.
    """

    previous = get_config_value(ENGINE_KILL_ALL_KEY, False)
    print(f"\n>>> Stopping live ArcRho Engine instances ({ENGINE_KILL_ALL_KEY} = True)")
    set_config_value(ENGINE_KILL_ALL_KEY, True)
    try:
        wait_for_engine_shutdown()
        yield
    finally:
        print(f"\n>>> Releasing the ArcRho Engine ({ENGINE_KILL_ALL_KEY} = {previous})")
        set_config_value(ENGINE_KILL_ALL_KEY, previous)


def deploy_exe():
    """Swap the staged build into the deployed app folder with rollback.

    PyInstaller builds into an isolated dist folder rather than straight into
    the deployed app folder, so a failed swap can fall back to the previous
    deployment instead of leaving nothing.
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
    ensure_venv()
    ensure_venv_python()
    install_requirements()
    validate_canonical_runtime_environment()
    build_exe()
    if not STAGE_ONLY:
        with engines_stopped():
            deploy_exe()

    output_dir = STAGED_APP_DIR if STAGE_ONLY else DEPLOY_APP_DIR
    print(f"\nBuild finished: {output_dir / f'{APP_NAME}.exe'}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        print(f"\nERROR: Command failed with exit code {e.returncode}")
        sys.exit(e.returncode)
