"""Canonical Python runtime checks and deployment for ArcRho frozen components."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, MutableMapping


REQUIRED_PYTHON = (3, 10)
REQUIRED_PYTHON_LABEL = ".".join(map(str, REQUIRED_PYTHON))
DEPLOY_ROOT_ENV = "ARCRHO_DEPLOY_ROOT"
WORKSPACE_ROOT_ENVS = ("ARCRHO_ROOT", "ADAS_ROOT")
DRIVE_FIXED = 3

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
# Every ArcRho component in this repository ships under one bundle version.
# ``server-installer/build_release.py`` already refuses a server payload whose
# ``product_version`` differs from the desktop app's, so this file is the
# version, and a directly deployed component must read it rather than mint a
# second one that could disagree with what the installed bundle reports.
PRODUCT_VERSION_PATH = REPOSITORY_ROOT / "frontend" / "package.json"

# A PyInstaller dist is ~1650 files but only ~93 MB, so the deploy is dominated
# by per-file network round trips rather than bandwidth. Parallel streams are
# what make it finish in seconds instead of minutes.
DEPLOY_COPY_THREADS = 32
SLOT_SUFFIX = ".slot"
PREVIOUS_SUFFIX = ".prev"
HASH_CHUNK_BYTES = 1 << 20
# The manifest lives inside the folder it describes, so it rotates with that
# folder during a swap and can never drift from the build it records.
DEPLOY_MANIFEST_NAME = ".arcrho-deploy-manifest.json"
# 1 recorded files only; 2 added the build stamp that identifies the release a
# deployed folder holds. A version 1 manifest is still a usable delta base, so
# the reader never rejects one.
DEPLOY_MANIFEST_SCHEMA_VERSION = 2
STAMP_FIELDS = ("bundle_version", "built_at", "built_by", "git_commit", "git_dirty")


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


def deploy_manifest_path(app_dir: str | Path) -> Path:
    """Where a deployed folder records what it currently holds.

    Keeping it inside the folder is what keeps it honest: ``swap_deploy``
    rotates whole folders, so the record moves with the build it describes
    instead of having to be renamed in step with it.

    This is build metadata describing a deployed folder, not ArcRho project
    data, so it is written as plain compact JSON rather than through the
    persisted-JSON contract.
    """

    return Path(app_dir) / DEPLOY_MANIFEST_NAME


def bundle_version() -> str:
    """The single version every ArcRho component in this repository ships under.

    Read from the canonical source at build time so a component deployed
    straight from the repository carries the same version the offline installer
    would have stamped on it.
    """

    try:
        payload = json.loads(PRODUCT_VERSION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Could not read the bundle version from {PRODUCT_VERSION_PATH}: {exc}"
        ) from exc
    version = str(payload.get("version") or "").strip()
    if not version:
        raise RuntimeError(f"{PRODUCT_VERSION_PATH} does not declare a version.")
    return version


def _git_output(*arguments: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(REPOSITORY_ROOT), *arguments],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return completed.stdout.strip()


def source_revision() -> dict[str, Any]:
    """The commit a build came from, and whether the tree still had edits.

    ``git_dirty`` is what makes the commit honest. Components are routinely
    rebuilt from a working tree mid-change, and recording a commit alone would
    describe such a build as reproducible when nothing in the repository
    reconstructs it.
    """

    commit = _git_output("rev-parse", "--short", "HEAD")
    if commit is None:
        return {"git_commit": "", "git_dirty": False}
    return {"git_commit": commit, "git_dirty": bool(_git_output("status", "--porcelain"))}


def build_stamp() -> dict[str, Any]:
    """Identify the build being deployed: version, time, machine, and source."""

    user = str(os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()
    return {
        "bundle_version": bundle_version(),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "built_by": f"{user}@{platform.node()}".strip("@"),
        **source_revision(),
    }


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_deploy_payload(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _read_deploy_manifest(path: Path) -> dict[str, Any]:
    entries = _read_deploy_payload(path).get("files")
    return entries if isinstance(entries, dict) else {}


def read_deploy_stamp(app_dir: str | Path) -> dict[str, Any]:
    """What a deployed or parked folder says it holds.

    Every field defaults to empty rather than raising, because a folder
    deployed before the stamp existed is still a folder someone has to be able
    to ask about.
    """

    payload = _read_deploy_payload(deploy_manifest_path(app_dir))
    stamp = {field: payload.get(field, "") for field in STAMP_FIELDS}
    stamp["git_dirty"] = bool(payload.get("git_dirty"))
    stamp["app"] = str(payload.get("app") or Path(app_dir).name)
    return stamp


def describe_stamp(stamp: Mapping[str, Any]) -> str:
    """One line naming a build, for a deploy log or a rollback prompt."""

    version = str(stamp.get("bundle_version") or "").strip()
    if not version:
        return "(unstamped build)"
    commit = str(stamp.get("git_commit") or "").strip()
    source = f"{commit}+edits" if stamp.get("git_dirty") else commit
    built_at = str(stamp.get("built_at") or "").strip()
    details = " ".join(part for part in (source, built_at) if part)
    return f"{version} ({details})" if details else version


def align_staged_timestamps(staged_app_dir: str | Path, manifest_path: str | Path) -> int:
    """Give unchanged files back the timestamp they carry in the slot.

    PyInstaller stamps every file it collects with the moment of the build, so
    a rebuilt dist looks entirely new to robocopy's size-and-timestamp compare
    even though the interpreter, site-packages, and DLLs are byte for byte what
    was deployed last time. Without this, a mirror re-sends all ~1650 files and
    the delta is worth nothing.

    Comparing content is what makes the difference, and it is done against a
    manifest so the bytes are read from the local dist rather than pulled back
    across the network. A file whose path, size, and SHA-256 all match what was
    deployed gets that deployment's timestamp restored, and robocopy then skips
    it for the cost of one metadata round trip.

    Returns the number of files that will be skipped.
    """

    staged = Path(staged_app_dir)
    recorded = _read_deploy_manifest(Path(manifest_path))
    if not recorded:
        return 0

    aligned = 0
    for path in staged.rglob("*"):
        if not path.is_file():
            continue
        entry = recorded.get(path.relative_to(staged).as_posix())
        if not isinstance(entry, dict):
            continue
        # Size first: it is free and rules out most changed files before the
        # read that hashing costs.
        if entry.get("size") != path.stat().st_size:
            continue
        if entry.get("sha256") != _file_digest(path):
            continue
        mtime = entry.get("mtime")
        if not isinstance(mtime, (int, float)):
            continue
        os.utime(path, (mtime, mtime))
        aligned += 1
    return aligned


def write_deploy_manifest(
    staged_app_dir: str | Path,
    manifest_path: str | Path,
    stamp: Mapping[str, Any] | None = None,
) -> None:
    """Record what the slot now holds, so the next build can diff against it.

    The same record identifies the build. Because it rotates with its folder,
    the parked previous build keeps saying which release it is, which is what
    makes a rollback something you can inspect before you run it.
    """

    staged = Path(staged_app_dir)
    files: dict[str, dict[str, Any]] = {}
    for path in sorted(staged.rglob("*")):
        if not path.is_file():
            continue
        stat = path.stat()
        files[path.relative_to(staged).as_posix()] = {
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "sha256": _file_digest(path),
        }
    payload = {
        "schema_version": DEPLOY_MANIFEST_SCHEMA_VERSION,
        "app": staged.name,
        **(build_stamp() if stamp is None else dict(stamp)),
        "files": files,
    }
    target = Path(manifest_path)
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
        os.replace(temporary, target)
    except OSError as exc:
        # A missing manifest only costs the next deploy its delta; it must never
        # fail a deploy that has already succeeded.
        print(f">>> Could not record the deploy manifest {target.name}: {exc}")
        try:
            temporary.unlink()
        except OSError:
            pass


def deploy_slot_paths(apps_dir: str | Path, app_name: str) -> tuple[Path, Path, Path]:
    """Return the live, standby-slot, and transient previous folders.

    The standby slot persists between deploys. It is what makes the copy a
    delta: it already holds a build of this component, so a rebuilt dist
    differs from it by little more than the executable.
    """

    apps = Path(apps_dir)
    return (
        apps / app_name,
        apps / f".{app_name}{SLOT_SUFFIX}",
        apps / f".{app_name}{PREVIOUS_SUFFIX}",
    )


def copy_tree_delta(
    source: str | Path,
    destination: str | Path,
    *,
    threads: int = DEPLOY_COPY_THREADS,
) -> None:
    """Mirror a directory tree, transferring only what differs.

    ``/MIR`` copies files whose size or timestamp differs and removes files the
    source no longer has, so the destination ends up matching the source
    exactly. Files that already match cost one metadata round trip instead of a
    transfer, which is the whole point over an SMB deploy: a rebuilt PyInstaller
    dist reuses the interpreter, site-packages, and DLLs byte for byte and
    changes little beyond the executable.

    ``/MIR`` deletes, so callers must pass a destination they own outright.
    ``stage_deploy`` derives one rather than accepting it from the caller.

    Robocopy exit codes below 8 are success variants.
    """

    result = subprocess.run(
        [
            "robocopy",
            str(source),
            str(destination),
            "/MIR",
            f"/MT:{threads}",
            "/NP",
            "/NFL",
            "/NDL",
            "/R:2",
            "/W:2",
            # The destination's own manifest is not part of the source tree;
            # without this /MIR would purge the record of what it holds.
            "/XF",
            DEPLOY_MANIFEST_NAME,
        ]
    )
    if result.returncode >= 8:
        raise RuntimeError(
            f"robocopy failed copying {source} -> {destination} "
            f"(exit code {result.returncode})."
        )


def remove_tree_with_retry(
    path: str | Path, attempts: int = 5, delay_seconds: float = 2.0
) -> None:
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


def rename_with_retry(
    source: str | Path,
    target: str | Path,
    attempts: int = 8,
    delay_seconds: float = 5.0,
) -> None:
    """Rename, retrying transient access-denied failures.

    A directory tree freshly written over the SMB share can be briefly held by
    server-side antivirus scanning, which surfaces as ``WinError 5`` on the
    rename even though nothing else uses the folder.
    """

    source_path, target_path = Path(source), Path(target)
    for attempt in range(1, attempts + 1):
        try:
            source_path.rename(target_path)
            return
        except PermissionError:
            if attempt == attempts:
                raise
            print(
                f">>> Rename busy ({source_path.name} -> {target_path.name}); "
                f"retrying in {delay_seconds:.0f}s ({attempt}/{attempts})"
            )
            time.sleep(delay_seconds)


def stage_deploy(
    staged_app_dir: str | Path, apps_dir: str | Path, app_name: str
) -> Path:
    """Sync a freshly built app into its standby slot, and return that slot.

    This runs while the component is still live: the slot is a private folder
    no process reads, so the copy needs no downtime. Only ``swap_deploy`` has
    to happen inside the stopped window, and that is three renames.
    """

    staged = Path(staged_app_dir)
    if not staged.exists():
        raise FileNotFoundError(f"Built app not found: {staged}")

    apps = Path(apps_dir)
    apps.mkdir(parents=True, exist_ok=True)
    live, slot, previous = deploy_slot_paths(apps, app_name)

    # A swap killed between its renames leaves the last good build parked as
    # .prev with nothing live. Put it back before reusing the name, so an
    # interrupted deploy heals instead of compounding.
    if not live.exists() and previous.is_dir():
        print(f"\n>>> Restoring {previous.name} left by an interrupted deploy")
        rename_with_retry(previous, live)

    # A slot left half-written by an interrupted swap is still a valid delta
    # base: the mirror below reconciles it against the new build either way.
    remove_tree_with_retry(previous)

    stamp = build_stamp()
    total = sum(1 for path in staged.rglob("*") if path.is_file())
    unchanged = align_staged_timestamps(staged, deploy_manifest_path(slot))
    print(
        f"\n>>> Syncing the new build into {slot.name} "
        f"({total - unchanged} of {total} files changed)"
    )
    print(f">>> Deploying {app_name} {describe_stamp(stamp)}")
    copy_tree_delta(staged, slot)
    # The slot now holds exactly this build, so its manifest describes it and
    # travels with it through every later rotation.
    write_deploy_manifest(staged, deploy_manifest_path(slot), stamp)
    return slot


def swap_deploy(apps_dir: str | Path, app_name: str) -> None:
    """Rotate the standby slot into place, keeping the previous build.

    Three renames, each executed by the file server rather than streamed over
    the wire, so this costs about a second even on a mapped drive. The build
    that was live lands back in the slot, where it serves as both the rollback
    copy and the delta base the next deploy compares against.
    """

    live, slot, previous = deploy_slot_paths(apps_dir, app_name)
    if not slot.is_dir():
        raise FileNotFoundError(f"Staged slot not found: {slot}")

    parked = False
    try:
        if live.exists():
            rename_with_retry(live, previous)
            parked = True
        rename_with_retry(slot, live)
    except Exception:
        # Only the first rename can have landed here, so the previous build is
        # intact under .prev; put it back rather than leave nothing deployed.
        if parked and previous.exists() and not live.exists():
            previous.rename(live)
        raise

    # The deploy has already succeeded. Failing to park the previous build only
    # costs the next deploy its delta base, so never turn it into a failure.
    if previous.exists():
        try:
            rename_with_retry(previous, slot)
        except OSError as exc:
            print(f">>> Could not park the previous build as {slot.name}: {exc}")


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
