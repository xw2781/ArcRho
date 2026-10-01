"""The app server's restart and stop markers, which the development supervisor watches.

They are named per port, so two apps run from one checkout each obey only their
own server's marker. The Electron host clears the same names before it starts
a server (`backendControlFlagNames` in `electron/backend_lifecycle.js`).
"""
from __future__ import annotations

from pathlib import Path


def restart_flag(base_dir: Path, port: object) -> Path:
    return Path(base_dir) / f".restart_app_{port}"


def shutdown_flag(base_dir: Path, port: object) -> Path:
    return Path(base_dir) / f".shutdown_app_{port}"
