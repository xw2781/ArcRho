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

from arcrho_bridge.bundled_sources import (
    BUNDLED_SOURCES,
    CANONICAL_HIDDEN_IMPORTS,
    CANONICAL_MODULE_ROOT,
)
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
APP_NAME = component_app_name("bridge")
ICON = PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Engine.ico"
RESQ_IMPORT_CONTRACT_FILE = BASE_DIR / "resq_reserving_class_import_contract.json"
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
    ensure_python_310_venv(VENV_PYTHON)


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

    import_paths = tuple(
        dict.fromkeys(
            (
                *(bundled.import_root for bundled in BUNDLED_SOURCES),
                CANONICAL_MODULE_ROOT,
            )
        )
    )
    probe = (
        "import sys; "
        f"sys.path[:0] = {repr([str(path) for path in import_paths])}; "
        "from resq_migration.engine import get_engine_processing_provenance; "
        "from app_server.services.data_processing_rules_service import "
        "get_processing_provenance; "
        + "; ".join(f"import {name}" for name in CANONICAL_HIDDEN_IMPORTS)
    )
    print("\n>>> Validating canonical ResQ import dependencies")
    run([VENV_PYTHON, "-c", probe])


def build_exe():
    for bundled in BUNDLED_SOURCES:
        if not bundled.source.is_dir():
            raise FileNotFoundError(
                f"Canonical ResQ import bundle source was not found: {bundled.source}"
            )
    if not RESQ_IMPORT_CONTRACT_FILE.is_file():
        raise FileNotFoundError(
            f"ResQ reserving-class import contract was not found: {RESQ_IMPORT_CONTRACT_FILE}"
        )
    for module_name in CANONICAL_HIDDEN_IMPORTS:
        canonical_module = CANONICAL_MODULE_ROOT / f"{module_name}.py"
        if not canonical_module.is_file():
            raise FileNotFoundError(
                f"Canonical Bridge module not found: {canonical_module}"
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
        "--paths",
        CANONICAL_MODULE_ROOT,
        *[
            argument
            for name in CANONICAL_HIDDEN_IMPORTS
            for argument in ("--hidden-import", name)
        ],
        "--hidden-import",
        "utils",
        "--hidden-import",
        "server_config",
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
        *[
            argument
            for bundled in BUNDLED_SOURCES
            for argument in ("--add-data", f"{bundled.source};{bundled.target}")
        ],
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


def copy_tree_parallel(source, destination):
    """Copy a directory tree with robocopy's parallel streams.

    A PyInstaller dist is thousands of small files, and over the mapped-drive
    SMB link a single-threaded copy pays one network round trip per file.
    Robocopy exit codes below 8 are success variants.
    """

    result = subprocess.run([
        "robocopy", str(source), str(destination),
        "/E", "/MT:16", "/NP", "/NFL", "/NDL", "/R:2", "/W:2",
    ])
    if result.returncode >= 8:
        raise RuntimeError(
            f"robocopy failed copying {source} -> {destination} "
            f"(exit code {result.returncode})."
        )


def stage_deploy():
    """Copy the built app beside the deployment while the Bridge keeps running.

    PyInstaller builds into an isolated dist folder rather than straight into
    the deployed app folder. Building in place would delete the live Bridge
    before writing its replacement, so any locked file left the deployment
    destroyed with nothing to fall back to. The slow network copy touches only
    the private staging folder, so it needs no downtime; the Bridge is stopped
    only around the rename swap.
    """

    if not STAGED_APP_DIR.exists():
        raise FileNotFoundError(f"Built app not found: {STAGED_APP_DIR}")

    APPS_DIR.mkdir(parents=True, exist_ok=True)
    temp_app_dir = APPS_DIR / f".{APP_NAME}.new"
    backup_app_dir = APPS_DIR / f".{APP_NAME}.old"

    for path in (temp_app_dir, backup_app_dir):
        remove_tree_with_retry(path)

    print(f"\n>>> Staging the new build at {temp_app_dir}")
    copy_tree_parallel(STAGED_APP_DIR, temp_app_dir)
    return temp_app_dir, backup_app_dir


def remove_tree_with_retry(path, attempts=5, delay_seconds=2.0):
    """Delete a directory tree, retrying transient SMB failures.

    Deletes over the share complete asynchronously, so ``rmtree`` can lose the
    race against its own pending file deletes (``WinError 145`` directory not
    empty) or a scanner briefly holding a file (``WinError 5``).
    """

    for attempt in range(1, attempts + 1):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt == attempts:
                raise
            print(
                f">>> Remove busy ({Path(path).name}); "
                f"retrying in {delay_seconds:.0f}s ({attempt}/{attempts})"
            )
            time.sleep(delay_seconds)


def rename_with_retry(source, target, attempts=8, delay_seconds=5.0):
    """Rename, retrying transient access-denied failures.

    A directory tree freshly written over the SMB share can be briefly held by
    server-side antivirus scanning, which surfaces as ``WinError 5`` on the
    rename even though nothing else uses the folder.
    """

    for attempt in range(1, attempts + 1):
        try:
            source.rename(target)
            return
        except PermissionError:
            if attempt == attempts:
                raise
            print(
                f">>> Rename busy ({source.name} -> {target.name}); "
                f"retrying in {delay_seconds:.0f}s ({attempt}/{attempts})"
            )
            time.sleep(delay_seconds)


def swap_deploy(temp_app_dir, backup_app_dir):
    """Swap the staged folder into the deployed app folder with rollback.

    A failed rename falls back to the previous deployment instead of leaving
    nothing; this runs inside the stopped-Bridge window and takes seconds.
    """

    try:
        if DEPLOY_APP_DIR.exists():
            rename_with_retry(DEPLOY_APP_DIR, backup_app_dir)
        rename_with_retry(temp_app_dir, DEPLOY_APP_DIR)
    except Exception:
        if backup_app_dir.exists() and not DEPLOY_APP_DIR.exists():
            backup_app_dir.rename(DEPLOY_APP_DIR)
        raise

    # The swap already succeeded; a stubborn backup folder is cosmetic and the
    # next deploy's staging cleanup retries it, so never fail the deploy here.
    try:
        remove_tree_with_retry(backup_app_dir)
    except OSError as exc:
        print(f">>> Backup cleanup left {backup_app_dir.name} behind: {exc}")


def main():
    clean_build_dirs()
    ensure_venv()
    ensure_venv_python()
    install_requirements()
    validate_resq_import_environment()
    build_exe()
    if STAGE_ONLY:
        exe_path = STAGED_APP_DIR / f"{APP_NAME}.exe"
    else:
        temp_app_dir, backup_app_dir = stage_deploy()
        with bridge_stopped():
            swap_deploy(temp_app_dir, backup_app_dir)
        exe_path = DEPLOY_APP_DIR / f"{APP_NAME}.exe"
    print(f"\nBuild finished: {exe_path}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"\nERROR: Command failed with exit code {exc.returncode}")
        sys.exit(exc.returncode)
