"""Which Arco Server components are running, read from their heartbeats.

Every long-running component rewrites a heartbeat file under
``<root>\\runtime\\instances\\arcrho_<role>\\`` while it runs, named
``<machine>@<user>@...@<stamp>.json`` and holding ``Last seen`` in the server
host's local time, and every role has a stop switch at ``apps.<role>.kill_all``
in ``<root>\\config\\config.json``. Admin Control, the Gateway (through the
``server_component_status`` workspace read) and the desktop app's Server tab all
read them through this module, so the rule for when a heartbeat is stale is
written once.
"""

from __future__ import annotations

import ctypes
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from arcrho_api.config import SERVER_CONFIG_RELATIVE_PATH


INSTANCES_RELATIVE_PATH = Path("runtime") / "instances"
# Role -> label, in the order the Server tab lists them.
COMPONENT_ROLES: dict[str, str] = {
    "orchestrator": "Orchestrator",
    "engine": "Engine",
    "gateway": "Gateway",
    "bridge": "Bridge",
    "bridge_worker": "Bridge Worker",
    "admin": "Admin Control",
}
DEFAULT_STALE_AFTER_SECONDS = 60
# Engines and Bridge workers rewrite their heartbeat every second or two, so a
# few seconds of silence already means the process is gone.
FAST_STALE_AFTER_SECONDS = 6
FAST_HEARTBEAT_ROLES = frozenset({"engine", "bridge_worker"})
LAST_SEEN_FORMAT = "%Y-%m-%d %H:%M:%S"
_DRIVE_FIXED = 3


def instance_folder(root: str | os.PathLike[str], role: str) -> Path:
    return Path(root) / INSTANCES_RELATIVE_PATH / f"arcrho_{role}"


def stale_after_seconds(role: str) -> int:
    return FAST_STALE_AFTER_SECONDS if role in FAST_HEARTBEAT_ROLES else DEFAULT_STALE_AFTER_SECONDS


def stale_after_seconds_by_role() -> dict[str, int]:
    return {role: stale_after_seconds(role) for role in COMPONENT_ROLES}


def heartbeat_age(last_seen: str, now: datetime) -> int | None:
    try:
        seen = datetime.strptime(str(last_seen or ""), LAST_SEEN_FORMAT)
    except ValueError:
        return None
    return max(0, int((now - seen).total_seconds()))


def instance_machine(server_name: str) -> str:
    parts = str(server_name or "").split("@")
    return parts[0] if len(parts) >= 3 else ""


def instance_user(server_name: str) -> str:
    parts = str(server_name or "").split("@")
    return parts[1] if len(parts) >= 3 and parts[1] else ""


def instance_created(server_name: str, path: Path) -> str:
    token = str(server_name or "").split("@")[-1]
    try:
        created = datetime.strptime("-".join(token.split("-")[:2]), "%y%m%d-%H%M%S")
    except ValueError:
        try:
            created = datetime.fromtimestamp(path.stat().st_ctime)
        except OSError:
            return ""
    return created.strftime(LAST_SEEN_FORMAT)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
    except (OSError, UnicodeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _heartbeat_files(folder: Path) -> list[Path]:
    """The folder's heartbeat files, newest first; a file removed mid-listing is skipped."""

    found = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if not entry.name.lower().endswith(".json"):
                    continue
                try:
                    found.append((entry.stat().st_mtime, Path(entry.path)))
                except OSError:
                    continue
    except OSError:
        return []
    return [path for _, path in sorted(found, key=lambda item: item[0], reverse=True)]


def list_instances(root: str | os.PathLike[str], *, now: datetime | None = None) -> list[dict[str, Any]]:
    """One row per heartbeat file of every role; a garbled file still lists, with no age."""

    now = now or datetime.now()
    rows = []
    for role, label in COMPONENT_ROLES.items():
        for path in _heartbeat_files(instance_folder(root, role)):
            data = _read_json(path)
            last_seen = str(data.get("Last seen") or "")
            server = str(data.get("Server") or path.stem)
            age = heartbeat_age(last_seen, now)
            stale_after = stale_after_seconds(role)
            rows.append({
                "role": role,
                "role_label": label,
                "name": path.name,
                "server": server,
                "machine": instance_machine(server),
                "user": data.get("User") or instance_user(server),
                "created": data.get("Created") or instance_created(server, path),
                "last_seen": last_seen,
                "age_seconds": age,
                "stale_after_seconds": stale_after,
                "status": "Active" if age is None or age <= stale_after else "Stale",
            })
    return rows


def read_stop_switches(root: str | os.PathLike[str]) -> dict[str, bool]:
    """Whether each role's ``apps.<role>.kill_all`` is set; an unreadable config sets none."""

    apps = _read_json(Path(root) / SERVER_CONFIG_RELATIVE_PATH).get("apps")
    apps = apps if isinstance(apps, dict) else {}
    return {
        role: bool(apps.get(role, {}).get("kill_all")) if isinstance(apps.get(role), dict) else False
        for role in COMPONENT_ROLES
    }


def component_status(root: str | os.PathLike[str], *, now: datetime | None = None) -> dict[str, Any]:
    """Every role with its stop switch and its instances, as the Server tab shows them."""

    now = now or datetime.now()
    rows = list_instances(root, now=now)
    switches = read_stop_switches(root)
    return {
        "checked_at": now.strftime(LAST_SEEN_FORMAT),
        "roles": [
            {
                "role": role,
                "label": label,
                "stale_after_seconds": stale_after_seconds(role),
                "stop_switch": switches[role],
                "instances": [row for row in rows if row["role"] == role],
            }
            for role, label in COMPONENT_ROLES.items()
        ],
    }


def is_on_local_fixed_disk(path: str | os.PathLike[str]) -> bool:
    """Whether ``path`` is on a fixed disk of this PC: not UNC, not a mapped or removable drive."""

    text = os.fspath(path)
    if text.startswith(("\\\\", "//")) or os.name != "nt":
        return False
    drive = os.path.splitdrive(text)[0]
    if not drive:
        return False
    return int(ctypes.windll.kernel32.GetDriveTypeW(f"{drive}\\")) == _DRIVE_FIXED
