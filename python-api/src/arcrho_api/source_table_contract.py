"""Canonical contract for the project-owned imported source table.

Every ArcRho project folder owns exactly one imported raw table at a fixed
location and a fixed name:

    <project dir>/source/master_table.csv

That copy is the only table any consumer reads. The external CSV path a user
picks in Project Settings and the SQL Server profile they configure are *import
sources*; they are never read directly by the data engine, the app server
summary/reserving/data-processing services, or any downstream method.

`source/source_import.json` records which source produced the current master
copy, plus the shared SQL Server profile for the project. It never stores
credentials: SQL Server access uses the caller's Windows identity.

This module is the single owner of the folder/file names, the JSON schema, the
normalization rules, and the staleness rule. Consumers must import from here
rather than rebuilding any of it. `data-engine` cannot import this package from
its frozen bundle, so it mirrors the two path constants locally and
`frontend/tests/test_source_table_contract.py` fails when the mirror drifts.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional


# --- Layout ---------------------------------------------------------------
SOURCE_IMPORT_DIR = "source"
MASTER_TABLE_FILE = "master_table.csv"
SOURCE_IMPORT_FILE = "source_import.json"
SOURCE_IMPORT_VERSION = 1

# --- Source kinds ---------------------------------------------------------
SOURCE_TYPE_CSV = "csv"
SOURCE_TYPE_MSSQL = "mssql"
SOURCE_TYPES = (SOURCE_TYPE_CSV, SOURCE_TYPE_MSSQL)

# --- SQL Server authentication -------------------------------------------
# Only Windows authentication is wired up. The SQL login mode is reserved so
# the profile shape does not change when it is implemented; services must
# reject it until then.
MSSQL_AUTH_WINDOWS = "windows"
MSSQL_AUTH_SQL_LOGIN = "sql_login"
MSSQL_AUTH_MODES = (MSSQL_AUTH_WINDOWS, MSSQL_AUTH_SQL_LOGIN)
SUPPORTED_MSSQL_AUTH_MODES = (MSSQL_AUTH_WINDOWS,)


def source_dir(project_dir: str) -> str:
    """Folder holding the imported master table and its import record."""
    return os.path.join(str(project_dir), SOURCE_IMPORT_DIR)


def master_table_path(project_dir: str) -> str:
    """The one table every ArcRho consumer reads for this project."""
    return os.path.join(source_dir(project_dir), MASTER_TABLE_FILE)


def source_import_path(project_dir: str) -> str:
    """The import record describing how the master table was produced."""
    return os.path.join(source_dir(project_dir), SOURCE_IMPORT_FILE)


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _int_or_none(value: Any) -> Optional[int]:
    try:
        if value is None or isinstance(value, bool):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_source_type(value: Any) -> str:
    candidate = _text(value).lower()
    return candidate if candidate in SOURCE_TYPES else SOURCE_TYPE_CSV


def normalize_mssql_auth(value: Any) -> str:
    candidate = _text(value).lower()
    return candidate if candidate in MSSQL_AUTH_MODES else MSSQL_AUTH_WINDOWS


def empty_mssql_profile() -> Dict[str, str]:
    return {
        "server": "",
        "database": "",
        "table": "",
        "authentication": MSSQL_AUTH_WINDOWS,
    }


def normalize_mssql_profile(profile: Any) -> Dict[str, str]:
    data = profile if isinstance(profile, dict) else {}
    return {
        "server": _text(data.get("server")),
        "database": _text(data.get("database")),
        "table": _text(data.get("table")),
        "authentication": normalize_mssql_auth(data.get("authentication")),
    }


def empty_last_import() -> Dict[str, Any]:
    return {
        "source_type": "",
        "source_label": "",
        "imported_at": "",
        "imported_by": "",
        "row_count": None,
        "column_count": None,
        # CSV imports record the origin file identity so a changed external
        # file can be detected and re-copied without asking the user.
        "csv_path": "",
        "csv_mtime_ns": None,
        "csv_size": None,
    }


def normalize_last_import(payload: Any) -> Dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    out = empty_last_import()
    out["source_type"] = normalize_source_type(data.get("source_type")) if _text(data.get("source_type")) else ""
    out["source_label"] = _text(data.get("source_label"))
    out["imported_at"] = _text(data.get("imported_at"))
    out["imported_by"] = _text(data.get("imported_by"))
    out["row_count"] = _int_or_none(data.get("row_count"))
    out["column_count"] = _int_or_none(data.get("column_count"))
    out["csv_path"] = _text(data.get("csv_path"))
    out["csv_mtime_ns"] = _int_or_none(data.get("csv_mtime_ns"))
    out["csv_size"] = _int_or_none(data.get("csv_size"))
    return out


def normalize_source_import(payload: Any, project_name: str = "") -> Dict[str, Any]:
    """Return the full canonical `source_import.json` payload.

    Every producer of this file must emit exactly this shape so the parsed
    payloads stay identical for the same logical inputs.
    """
    data = payload if isinstance(payload, dict) else {}
    return {
        "version": SOURCE_IMPORT_VERSION,
        "project_name": _text(data.get("project_name")) or _text(project_name),
        "source_type": normalize_source_type(data.get("source_type")),
        "mssql": normalize_mssql_profile(data.get("mssql")),
        "last_import": normalize_last_import(data.get("last_import")),
    }


def csv_identity(csv_path: str) -> Dict[str, Any]:
    """Identity of an external CSV used to decide whether a re-copy is due."""
    clean = _text(csv_path)
    identity: Dict[str, Any] = {
        "csv_path": clean,
        "csv_mtime_ns": None,
        "csv_size": None,
    }
    if not clean:
        return identity
    stat = os.stat(clean)
    identity["csv_mtime_ns"] = int(stat.st_mtime_ns)
    identity["csv_size"] = int(stat.st_size)
    return identity


def same_csv_identity(last_import: Any, identity: Dict[str, Any]) -> bool:
    """True when the recorded CSV import already matches `identity`."""
    recorded = normalize_last_import(last_import)
    if recorded.get("source_type") != SOURCE_TYPE_CSV:
        return False
    if recorded.get("csv_mtime_ns") is None or recorded.get("csv_size") is None:
        return False
    return (
        os.path.normcase(os.path.normpath(recorded.get("csv_path") or ""))
        == os.path.normcase(os.path.normpath(_text(identity.get("csv_path"))))
        and recorded.get("csv_mtime_ns") == identity.get("csv_mtime_ns")
        and recorded.get("csv_size") == identity.get("csv_size")
    )


# --- Shared SQL Server connection history --------------------------------
# Server-shared preference: every user of one ArcRho Server sees the same list
# of previously used server/database pairs. It records identifiers only - no
# credentials, and no table name, because the table is a per-project choice.
MSSQL_CONNECTIONS_FILE = "mssql_connections.json"
MSSQL_CONNECTIONS_VERSION = 1


def connection_key(server: Any, database: Any) -> str:
    """Case-insensitive identity of one server/database pair."""
    return f"{_text(server).casefold()}\x1f{_text(database).casefold()}"


def normalize_mssql_connection(entry: Any) -> Dict[str, str]:
    data = entry if isinstance(entry, dict) else {}
    return {
        "server": _text(data.get("server")),
        "database": _text(data.get("database")),
        "last_used_at": _text(data.get("last_used_at")),
    }


def normalize_mssql_connections(payload: Any) -> Dict[str, Any]:
    """Full canonical `mssql_connections.json` payload.

    Entries are de-duplicated case-insensitively, incomplete pairs are dropped,
    and the list is ordered most-recently-used first so the UI can present it
    without re-sorting.
    """
    data = payload if isinstance(payload, dict) else {}
    raw = data.get("connections")
    seen: set[str] = set()
    entries: list[Dict[str, str]] = []
    for item in raw if isinstance(raw, list) else []:
        entry = normalize_mssql_connection(item)
        if not entry["server"] or not entry["database"]:
            continue
        key = connection_key(entry["server"], entry["database"])
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)
    entries.sort(key=lambda item: item["last_used_at"], reverse=True)
    return {
        "version": MSSQL_CONNECTIONS_VERSION,
        "connections": entries,
    }


def upsert_mssql_connection(
    payload: Any,
    server: Any,
    database: Any,
    used_at: str,
) -> Dict[str, Any]:
    """Record one pair as most recently used, replacing any prior casing."""
    normalized = normalize_mssql_connections(payload)
    target = connection_key(server, database)
    kept = [
        entry for entry in normalized["connections"]
        if connection_key(entry["server"], entry["database"]) != target
    ]
    kept.append(
        {
            "server": _text(server),
            "database": _text(database),
            "last_used_at": _text(used_at),
        }
    )
    return normalize_mssql_connections({"connections": kept})


def remove_mssql_connections(
    payload: Any,
    server: Any,
    database: Optional[Any] = None,
) -> Dict[str, Any]:
    """Drop one pair, or every pair for a server when `database` is omitted."""
    normalized = normalize_mssql_connections(payload)
    server_key = _text(server).casefold()
    if database is None:
        kept = [
            entry for entry in normalized["connections"]
            if _text(entry["server"]).casefold() != server_key
        ]
    else:
        target = connection_key(server, database)
        kept = [
            entry for entry in normalized["connections"]
            if connection_key(entry["server"], entry["database"]) != target
        ]
    return normalize_mssql_connections({"connections": kept})


def mssql_source_label(profile: Any) -> str:
    """Stable display label for a SQL Server import source."""
    normalized = normalize_mssql_profile(profile)
    parts = [normalized["server"], normalized["database"], normalized["table"]]
    return ".".join(part for part in parts if part)
