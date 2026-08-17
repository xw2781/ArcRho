"""The deployed-component model shared by the Build Manager, the build
listener, and the client deploy CLI.

This was extracted from ``arcrho_build_manager`` when builds became remotely
triggerable. The component table, the trees whose edits make a deployed
component stale, and the freshness rule now have one owner, so the GUI a human
drives and the CLI an agent drives can never disagree about which components a
change makes stale — the exact mistake this module is meant to prevent, where
an ``app_server`` edit silently left the Gateway on old code because only the
Bridge and Engine were rebuilt.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

# The Bridge owns the list of repository trees it freezes; read it rather than
# restating it, so a change to what the Bridge bundles cannot silently stop
# being reported as stale here.
from arcrho_bridge.bundled_sources import BUNDLED_SOURCE_ROOTS
from arcrho_engine.bundled_sources import ENGINE_BUNDLED_SOURCES
from utils import DEPLOYED_COMPONENT_ROLES, component_app_name


BASE_DIR = Path(__file__).resolve().parent
DATA_ENGINE_ROOT = BASE_DIR.parent
REPOSITORY_ROOT = DATA_ENGINE_ROOT.parent
DEPLOY_ROOT = Path(os.environ.get("ARCRHO_DEPLOY_ROOT", r"E:\ArcRho Server"))
APPS_DIR = DEPLOY_ROOT / "apps"
INSTANCES_DIR = DEPLOY_ROOT / "runtime" / "instances"

SOURCE_EXTENSIONS = {".html", ".ico", ".json", ".py", ".txt"}
# "logs" holds run output, not source; counting it reports a component as stale
# every time it runs.
SOURCE_SKIP_DIRS = {"__pycache__", "build", "dist", "logs", "spec"}

STALE_FRESHNESS_VALUES = frozenset({"Missing EXE", "Source newer"})


@dataclass(frozen=True)
class Component:
    key: str
    label: str
    source_dir: Path
    exe_name: str
    instance_roles: tuple[str, ...]
    # Repository trees outside source_dir that the component freezes into its
    # executable. Editing one of these leaves the deployed app stale even though
    # source_dir is untouched, so freshness has to consider them too.
    bundled_source_roots: tuple[Path, ...] = ()

    @property
    def build_script(self) -> Path:
        return self.source_dir / "build_exe.py"

    @property
    def deploy_exe(self) -> Path:
        return APPS_DIR / Path(self.exe_name).stem / self.exe_name

    @property
    def freshness_source_dirs(self) -> tuple[Path, ...]:
        return (self.source_dir, *self.bundled_source_roots)


SHARED_COMPONENT_SOURCES = (
    BASE_DIR / "utils.py",
    BASE_DIR / "server_config.py",
    BASE_DIR / "build_runtime.py",
)

# The Engine and the Gateway freeze the same trees: the Gateway's build script
# bundles ENGINE_BUNDLED_SOURCES directly, which is why an app_server edit
# makes three components stale rather than two.
_ENGINE_BUNDLED_ROOTS = tuple(item.source for item in ENGINE_BUNDLED_SOURCES)


def _role_bundled_roots(role: str) -> tuple[Path, ...]:
    if role == "bridge":
        return BUNDLED_SOURCE_ROOTS
    if role in ("engine", "gateway"):
        return _ENGINE_BUNDLED_ROOTS
    return ()


def _build_component(role: str) -> Component:
    if role == "launcher":
        instance_roles: tuple[str, ...] = ()
    elif role == "bridge":
        instance_roles = ("arcrho_bridge", "arcrho_bridge_worker")
    else:
        instance_roles = (f"arcrho_{role}",)
    return Component(
        role,
        "Admin Control" if role == "admin" else role.title(),
        BASE_DIR / f"arcrho_{role}",
        f"{component_app_name(role)}.exe",
        instance_roles,
        bundled_source_roots=(*_role_bundled_roots(role), *SHARED_COMPONENT_SOURCES),
    )


COMPONENTS = tuple(_build_component(role) for role in DEPLOYED_COMPONENT_ROLES)
COMPONENT_KEYS = tuple(component.key for component in COMPONENTS)


def component_by_key(key: str) -> Component:
    normalized = str(key or "").strip().lower()
    for component in COMPONENTS:
        if component.key == normalized:
            return component
    known = ", ".join(COMPONENT_KEYS)
    raise KeyError(f"Unknown component {key!r}. Known components: {known}")


def instance_folder(role: str) -> Path:
    return INSTANCES_DIR / role


def read_json(path: Path) -> dict[str, object]:
    try:
        with open(path, mode="r", encoding="utf-8") as file:
            payload = json.load(file)
            return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def list_instance_files(component: Component) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for role in component.instance_roles:
        folder = instance_folder(role)
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            payload = read_json(path)
            rows.append(
                {
                    "role": role,
                    "path": path,
                    "name": path.name,
                    "server": payload.get("Server") or path.stem,
                    "user": payload.get("User") or "",
                    "last_seen": payload.get("Last seen") or "",
                    "age": max(0, int(time.time() - path.stat().st_mtime)),
                }
            )
    return rows


def latest_source_timestamp(component: Component) -> float | None:
    latest: float | None = None
    for root in component.freshness_source_dirs:
        if not root.exists():
            continue
        candidates = (root,) if root.is_file() else root.rglob("*")
        for path in candidates:
            if not path.is_file():
                continue
            if any(part in SOURCE_SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
                continue
            if path.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            try:
                timestamp = path.stat().st_mtime
            except OSError:
                continue
            latest = timestamp if latest is None else max(latest, timestamp)
    return latest


def build_freshness(component: Component) -> str:
    exe_path = component.deploy_exe
    if not exe_path.exists():
        return "Missing EXE"

    latest_source = latest_source_timestamp(component)
    if latest_source is None:
        return "No source"

    try:
        exe_timestamp = exe_path.stat().st_mtime
    except OSError:
        return "EXE inaccessible"

    return "Updated" if exe_timestamp >= latest_source else "Source newer"


def stale_components() -> list[Component]:
    """Every deployed component whose bundled sources are newer than its EXE.

    Both the Build Manager's status table and ``deploy.py --auto`` read this, so
    "which components does my change make stale?" has exactly one answer.
    """

    return [
        component
        for component in COMPONENTS
        if build_freshness(component) in STALE_FRESHNESS_VALUES
    ]


def remove_instance_file(path: Path, attempts: int = 5, delay: float = 0.1) -> bool:
    resolved = path.resolve()
    instances_root = INSTANCES_DIR.resolve()
    if instances_root not in resolved.parents:
        raise ValueError(f"Refusing to remove file outside instances folder: {path}")

    for _ in range(attempts):
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False
        except PermissionError:
            time.sleep(delay)
    path.unlink()
    return True
