"""Shared macro library on the Arco Server workspace.

Lists the deployer-managed read-only library folder and copies ("loads")
selected macros into the user's local macro folder, which remains the only
place the Macro panel runs macros from. A local copy the library holds a
strictly newer version of is replaced on its own: for every loaded macro when
the Macros panel lists them, and for the one macro about to run, so a user
always runs the latest published version. Metadata parsing and local macro
path safety are delegated to scripting_macro_service so there is a single
owner for both.

The library is read on the server host through the Gateway
(``macro_library_listing`` and ``macro_library_file``); a Client PC never
opens it over the share, and every write lands in its own local macros folder.
"""
from __future__ import annotations

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from app_server import config
from app_server.services import workspace_read_client
from app_server.services.scripting_macro_service import (
    _parse_macro_metadata,
    _safe_macro_path,
)

_LIBRARY_READ_WORKERS = 8
_MAX_LIBRARY_SOURCE_CHARS = 2_000_000

STATUS_NOT_INSTALLED = "not_installed"
STATUS_UP_TO_DATE = "up_to_date"
STATUS_UPDATE_AVAILABLE = "update_available"
STATUS_LOCAL_DIFFERS = "local_differs"


def _get_library_dir() -> str:
    return str(getattr(config, "MACRO_LIBRARY_DIR", "") or "").strip()


def _safe_library_path(macro_id: str) -> str:
    library_dir = os.path.abspath(_get_library_dir())
    if not library_dir:
        raise ValueError("Macro library is not configured.")
    safe_name = os.path.basename(str(macro_id or "").strip().replace("\\", "/"))
    if not safe_name:
        raise ValueError("Macro id is required.")
    if not safe_name.lower().endswith(".py"):
        safe_name = f"{safe_name}.py"
    path = os.path.abspath(os.path.join(library_dir, safe_name))
    if not path.startswith(library_dir + os.sep):
        raise ValueError("Macro path is outside the macro library.")
    return path


def _parse_version(value: Any) -> Optional[Tuple[int, int, int]]:
    parts = str(value or "").strip().split(".")
    if len(parts) != 3:
        return None
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def _normalize_source(text: str) -> str:
    """Compare macro content ignoring line endings and BOM differences."""
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _read_macro_file(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return f.read(_MAX_LIBRARY_SOURCE_CHARS)
    except OSError:
        return None


def _library_status(library_text: str, library_version: str, local_text: Optional[str], local_version: str) -> str:
    if local_text is None:
        return STATUS_NOT_INSTALLED
    if _normalize_source(library_text) == _normalize_source(local_text):
        return STATUS_UP_TO_DATE
    lib_parsed = _parse_version(library_version)
    local_parsed = _parse_version(local_version)
    if lib_parsed is not None and local_parsed is not None:
        if lib_parsed > local_parsed:
            return STATUS_UPDATE_AVAILABLE
        return STATUS_LOCAL_DIFFERS
    if library_version and library_version != local_version:
        return STATUS_UPDATE_AVAILABLE
    return STATUS_LOCAL_DIFFERS


def _list_library_entries(library_dir: str) -> List[str]:
    entries: List[str] = []
    with os.scandir(library_dir) as it:
        for entry in it:
            if entry.is_file() and entry.name.lower().endswith(".py"):
                entries.append(entry.name)
    return sorted(entries, key=str.lower)


def _read_library_text(path: str) -> Optional[str]:
    """A library macro's exact text, line endings included, so a load copies it as published."""

    try:
        with open(path, "rb") as f:
            return f.read(_MAX_LIBRARY_SOURCE_CHARS).decode("utf-8-sig", errors="replace")
    except OSError:
        return None


def read_library_files() -> Dict[str, Any]:
    """Every macro the library holds, with its text; runs where the library is local disk."""

    library_dir = _get_library_dir()
    if not library_dir:
        return {"available": False, "message": "Macro library is not configured.", "files": []}
    if not os.path.isdir(library_dir):
        return {
            "available": False,
            "message": f"Macro library folder is not reachable: {library_dir}",
            "files": [],
        }
    try:
        entries = _list_library_entries(library_dir)
    except OSError as exc:
        return {
            "available": False,
            "message": f"Macro library folder could not be read: {exc}",
            "files": [],
        }
    library_paths = [os.path.join(library_dir, entry) for entry in entries]
    with ThreadPoolExecutor(max_workers=_LIBRARY_READ_WORKERS) as pool:
        library_texts = list(pool.map(_read_library_text, library_paths))
    files = [
        {"name": entry, "text": text}
        for entry, text in zip(entries, library_texts)
        if text is not None
    ]
    return {"available": True, "message": "", "files": files}


def read_library_file(macro_id: str) -> Dict[str, Any]:
    """One library macro's text; runs where the library is local disk."""

    try:
        library_path = _safe_library_path(macro_id)
    except ValueError as exc:
        return {"found": False, "name": "", "text": "", "message": str(exc)}
    name = os.path.basename(library_path)
    text = _read_library_text(library_path) if os.path.isfile(library_path) else None
    if text is None:
        return {"found": False, "name": name, "text": "", "message": f"Macro not found in library: {name}"}
    return {"found": True, "name": name, "text": text, "message": ""}


# A Client PC reads the library through the Gateway, never over the share; a
# server process (and a test that stands in for one) runs the read itself.
def _library_listing() -> Dict[str, Any]:
    try:
        return workspace_read_client.run_workspace_read(
            "macro_library_listing", {}, local=read_library_files, gateway_required=True
        )
    except HTTPException as exc:
        return {"available": False, "message": str(exc.detail), "files": []}


def _library_file(macro_id: str) -> Dict[str, Any]:
    try:
        return workspace_read_client.run_workspace_read(
            "macro_library_file",
            {"macro_id": macro_id},
            local=lambda: read_library_file(macro_id),
            gateway_required=True,
        )
    except HTTPException as exc:
        return {"found": False, "name": "", "text": "", "message": str(exc.detail)}


def _local_text(macro_id: str) -> Tuple[str, Optional[str]]:
    try:
        local_path = _safe_macro_path(macro_id)
    except ValueError:
        return "", None
    if not os.path.isfile(local_path):
        return local_path, None
    return local_path, _read_macro_file(local_path)


def list_library_macros() -> Dict[str, Any]:
    """List the shared library with install/update status per macro."""
    listing = _library_listing()
    macros: List[Dict[str, Any]] = []
    for item in listing.get("files") or []:
        entry = str(item.get("name") or "")
        text = str(item.get("text") or "")
        meta = _parse_macro_metadata(text, entry)
        _, local_text = _local_text(entry)
        local_version = _parse_macro_metadata(local_text, entry)["version"] if local_text is not None else ""
        macros.append({
            "id": entry,
            "name": meta["title"],
            "description": meta["description"],
            "scope": meta["scope"],
            "scopes": meta["scopes"],
            "version": meta["version"],
            "release_note": meta["release_note"],
            "local_version": local_version,
            "status": _library_status(text, meta["version"], local_text, local_version),
        })
    return {"available": bool(listing.get("available")), "message": str(listing.get("message") or ""), "macros": macros}


def install_library_macro(macro_id: str, overwrite: bool = False) -> Dict[str, Any]:
    """Copy a library macro exactly as published into the local macro folder atomically."""
    try:
        local_path = _safe_macro_path(macro_id)
    except ValueError as exc:
        return {"success": False, "message": str(exc)}
    library = _library_file(macro_id)
    if not library.get("found"):
        return {"success": False, "message": str(library.get("message") or "")}
    return _install_text(local_path, str(library.get("text") or ""), overwrite)


def _install_text(local_path: str, library_text: str, overwrite: bool) -> Dict[str, Any]:
    meta = _parse_macro_metadata(library_text, os.path.basename(local_path))
    library_label = f"v{meta['version']}" if meta["version"] else "unversioned"

    local_text = _read_macro_file(local_path) if os.path.isfile(local_path) else None
    if local_text is not None:
        if _normalize_source(local_text) == _normalize_source(library_text):
            return {
                "success": True,
                "installed": False,
                "macro_id": os.path.basename(local_path),
                "version": meta["version"],
                "message": f"{meta['title']} is already up to date.",
            }
        if not overwrite:
            local_version = _parse_macro_metadata(local_text, os.path.basename(local_path))["version"]
            local_label = f"v{local_version}" if local_version else "unversioned"
            return {
                "success": False,
                "needs_confirmation": True,
                "macro_id": os.path.basename(local_path),
                "version": meta["version"],
                "local_version": local_version,
                "message": (
                    f"Your local copy of {os.path.basename(local_path)} ({local_label}) differs "
                    f"from the library version ({library_label})."
                ),
            }

    macro_dir = os.path.dirname(local_path)
    os.makedirs(macro_dir, exist_ok=True)
    try:
        fd, temp_path = tempfile.mkstemp(prefix=".macro_library_", suffix=".tmp", dir=macro_dir)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(library_text.encode("utf-8"))
            os.replace(temp_path, local_path)
        except BaseException:
            try:
                os.remove(temp_path)
            except OSError:
                pass
            raise
    except OSError as exc:
        return {"success": False, "message": f"Could not copy macro to the local macro folder: {exc}"}

    version_suffix = f" v{meta['version']}" if meta["version"] else ""
    return {
        "success": True,
        "installed": True,
        "macro_id": os.path.basename(local_path),
        "name": meta["title"],
        "version": meta["version"],
        "message": f"Loaded {meta['title']}{version_suffix} into your local macros.",
    }


def sync_library_macro(macro_id: str) -> Optional[Dict[str, Any]]:
    """Replace one local macro when the library holds a strictly newer version.

    Reads only that macro's library file, so the check before a run costs one
    Gateway read. Returns the install result when a copy was replaced,
    otherwise None: a macro the library does not hold, an unreachable library,
    a copy that is current, and a local copy that differs at the same or a
    higher version are all left alone.
    """
    local_path, local_text = _local_text(macro_id)
    if local_text is None:
        return None
    library = _library_file(macro_id)
    if not library.get("found"):
        return None
    library_text = str(library.get("text") or "")
    name = os.path.basename(local_path)
    library_version = _parse_macro_metadata(library_text, name)["version"]
    local_version = _parse_macro_metadata(local_text, name)["version"]
    if _library_status(library_text, library_version, local_text, local_version) != STATUS_UPDATE_AVAILABLE:
        return None
    result = _install_text(local_path, library_text, overwrite=True)
    if not result.get("installed"):
        return None
    result["local_version"] = local_version
    return result


def sync_library_updates() -> Dict[str, Any]:
    """Replace every local macro the library holds a strictly newer version of."""
    listing = list_library_macros()
    updated: List[Dict[str, Any]] = []
    for macro in listing["macros"]:
        if macro["status"] != STATUS_UPDATE_AVAILABLE:
            continue
        result = install_library_macro(macro["id"], overwrite=True)
        if result.get("installed"):
            result["local_version"] = macro["local_version"]
            updated.append(result)
    return {"available": listing["available"], "message": listing["message"], "updated": updated}
