"""Project-owned imported source table: master copy, import record, SQL Server import.

Every project folder owns one imported table at `source/master_table.csv`. This
module is the only writer of that copy and the only resolver every reader goes
through, so no consumer ever reads an external CSV path or a SQL Server table
directly.

Two import sources produce the same master copy:
  * `csv`   - copied from the external path in `field_mapping.json::table_path`,
              refreshed automatically whenever that file's identity changes.
  * `mssql` - streamed from SQL Server using the caller's Windows identity.
              Never re-read automatically; an explicit import writes the copy.

The SQL Server profile lives with the project and is shared by every user of
that project. No credentials are stored: Windows authentication only.
"""
from __future__ import annotations

import csv
import json
import os
import shutil
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from arcrho_api.source_table_contract import (
    MSSQL_AUTH_SQL_LOGIN,
    MSSQL_AUTH_WINDOWS,
    normalize_mssql_connections,
    remove_mssql_connections,
    upsert_mssql_connection,
    SOURCE_TYPE_CSV,
    SOURCE_TYPE_MSSQL,
    SUPPORTED_MSSQL_AUTH_MODES,
    csv_identity,
    mssql_source_label,
    normalize_mssql_profile,
    normalize_source_import,
    normalize_source_type,
    same_csv_identity,
)

from arcrho_api.io import persisted_json_text
from app_server import config
from app_server.services import mssql_odbc
from app_server.services.audit_service import safe_append_project_audit_log
from app_server.services.user_identity_service import get_windows_login_name


# Rows streamed from SQL Server per fetch batch. Large enough to keep the
# round-trip count low on a shared server, small enough to bound memory.
_MSSQL_FETCH_BATCH = 20000


# One writer per project so a copy and an import can never interleave on the
# same master file.
_PROJECT_LOCKS: Dict[str, threading.Lock] = {}
_PROJECT_LOCKS_GUARD = threading.Lock()


class SourceTableNotConfiguredError(Exception):
    """No import source is configured for the project yet."""


class SourceTableMissingError(Exception):
    """An import source is configured but no master copy has been produced."""


def _project_lock(project_name: str) -> threading.Lock:
    key = str(project_name or "").strip().casefold()
    with _PROJECT_LOCKS_GUARD:
        lock = _PROJECT_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PROJECT_LOCKS[key] = lock
        return lock


def _require_project_name(project_name: str) -> str:
    name = str(project_name or "").strip()
    if not name:
        raise HTTPException(400, "project_name is required")
    return name


def _utc_now_text() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _read_json_object(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        handle.write(persisted_json_text(payload))
    os.replace(tmp_path, path)


def _configured_csv_path(project_name: str) -> str:
    """External CSV the user picked in Project Settings, if any."""
    try:
        mapping_path = config.get_field_mapping_path(project_name)
    except ValueError:
        return ""
    mapping = _read_json_object(mapping_path)
    return str(mapping.get("table_path") or "").strip()


def _save_configured_csv_path(project_name: str, csv_path: str) -> None:
    """Persist the external CSV selection into `field_mapping.json::table_path`.

    `field_mapping.json` stays the storage location because the data engine and
    Python API read the path from there; the import profile save is its writer.
    """
    try:
        mapping_path = config.get_field_mapping_path(project_name)
    except ValueError as error:
        raise HTTPException(404, str(error))
    payload = _read_json_object(mapping_path)
    payload["project_name"] = project_name
    payload["table_path"] = str(csv_path or "").strip()
    payload.setdefault("rows", [])
    payload["updated_at"] = _utc_now_text()
    try:
        _write_json_atomic(mapping_path, payload)
    except PermissionError:
        raise HTTPException(423, "Field mapping file is locked. Another user may have it open.")
    except OSError as error:
        raise HTTPException(500, f"Failed to save the CSV source path: {str(error)}")


# --- Import record --------------------------------------------------------

def read_source_import(project_name: str) -> Dict[str, Any]:
    """Normalized `source_import.json` for the project (defaults when absent)."""
    name = _require_project_name(project_name)
    try:
        path = config.get_project_source_import_path(name)
    except ValueError as error:
        raise HTTPException(404, str(error))
    return normalize_source_import(_read_json_object(path), name)


def _write_source_import(project_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized = normalize_source_import(payload, project_name)
    path = config.get_project_source_import_path(project_name)
    try:
        _write_json_atomic(path, normalized)
    except PermissionError:
        raise HTTPException(423, "Source import settings are locked. Another user may have them open.")
    except OSError as error:
        raise HTTPException(500, f"Failed to save source import settings: {str(error)}")
    return normalized


def save_source_profile(
    project_name: str,
    source_type: str,
    mssql: Optional[Dict[str, Any]] = None,
    csv_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist the project-shared import source selection and SQL Server profile."""
    name = _require_project_name(project_name)
    requested_type = str(source_type or "").strip().lower()
    if requested_type not in (SOURCE_TYPE_CSV, SOURCE_TYPE_MSSQL):
        raise HTTPException(400, f"Unknown source type: {source_type}")

    current = read_source_import(name)
    profile = normalize_mssql_profile(mssql if mssql is not None else current.get("mssql"))
    if profile["authentication"] not in SUPPORTED_MSSQL_AUTH_MODES:
        raise HTTPException(
            400,
            "SQL Server login is not supported yet. Use Windows authentication.",
        )
    if requested_type == SOURCE_TYPE_MSSQL:
        _require_complete_mssql_profile(profile)

    with _project_lock(name):
        if requested_type == SOURCE_TYPE_CSV and csv_path is not None:
            _save_configured_csv_path(name, csv_path)
        saved = _write_source_import(
            name,
            {**current, "project_name": name, "source_type": requested_type, "mssql": profile},
        )
    safe_append_project_audit_log(
        project_name=name,
        action=(
            f"Saved source import profile (source: {requested_type}"
            + (f", {mssql_source_label(profile)}" if requested_type == SOURCE_TYPE_MSSQL else "")
            + ")"
        ),
    )
    return saved


# --- SQL Server connection ------------------------------------------------

def _require_complete_mssql_profile(profile: Dict[str, Any]) -> Dict[str, str]:
    normalized = normalize_mssql_profile(profile)
    missing = [key for key in ("server", "database", "table") if not normalized[key]]
    if missing:
        raise HTTPException(400, f"SQL Server profile is missing: {', '.join(missing)}.")
    if normalized["authentication"] == MSSQL_AUTH_SQL_LOGIN:
        raise HTTPException(
            400,
            "SQL Server login is not supported yet. Use Windows authentication.",
        )
    if normalized["authentication"] not in SUPPORTED_MSSQL_AUTH_MODES:
        raise HTTPException(400, f"Unknown authentication mode: {normalized['authentication']}")
    return normalized


def _require_driver() -> Any:
    """The canonical ODBC entry point, reported as a service-unavailable error."""
    try:
        return mssql_odbc.get_pyodbc()
    except mssql_odbc.MssqlDriverUnavailableError as error:
        raise HTTPException(503, str(error)) from error


def _connection_string(profile: Dict[str, str]) -> str:
    """Windows-authenticated connection string. No credentials are ever stored."""
    try:
        return mssql_odbc.windows_connection_string(profile["server"], profile["database"])
    except mssql_odbc.MssqlDriverUnavailableError as error:
        raise HTTPException(503, str(error)) from error


def _quote_object_name(table: str) -> str:
    """Quote a possibly schema-qualified table name for a SELECT statement."""
    raw = str(table or "").strip()
    parts = [part.strip().strip("[]") for part in raw.split(".") if part.strip().strip("[]")]
    if not parts or len(parts) > 3:
        raise HTTPException(400, f"Invalid SQL Server table name: {table}")
    for part in parts:
        if "]" in part:
            raise HTTPException(400, f"Invalid SQL Server table name: {table}")
    return ".".join(f"[{part}]" for part in parts)


# --- Shared connection history -------------------------------------------
# The history file is shared by every user of this ArcRho Server, so writes are
# serialized in-process and committed atomically.
_CONNECTIONS_LOCK = threading.Lock()


def load_mssql_connections() -> Dict[str, Any]:
    """Previously used server/database pairs, most recently used first."""
    path = config.get_mssql_connections_path()
    payload = normalize_mssql_connections(_read_json_object(path))
    return {"ok": True, "path": path, **payload}


def _write_mssql_connections(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = config.get_mssql_connections_path()
    normalized = normalize_mssql_connections(payload)
    try:
        _write_json_atomic(path, normalized)
    except PermissionError:
        raise HTTPException(423, "Saved SQL Server connections are locked. Another user may have them open.")
    except OSError as error:
        raise HTTPException(500, f"Failed to save SQL Server connections: {str(error)}")
    return {"ok": True, "path": path, **normalized}


def remember_mssql_connection(server: str, database: str) -> Dict[str, Any]:
    """Record a pair that just connected successfully."""
    clean_server = str(server or "").strip()
    clean_database = str(database or "").strip()
    if not clean_server or not clean_database:
        return load_mssql_connections()
    with _CONNECTIONS_LOCK:
        current = normalize_mssql_connections(
            _read_json_object(config.get_mssql_connections_path())
        )
        return _write_mssql_connections(
            upsert_mssql_connection(current, clean_server, clean_database, _utc_now_text())
        )


def forget_mssql_connection(server: str, database: Optional[str] = None) -> Dict[str, Any]:
    """Drop one saved pair, or every pair for a server when no database is given."""
    clean_server = str(server or "").strip()
    if not clean_server:
        raise HTTPException(400, "server is required.")
    clean_database = str(database).strip() if database is not None else None
    with _CONNECTIONS_LOCK:
        current = normalize_mssql_connections(
            _read_json_object(config.get_mssql_connections_path())
        )
        return _write_mssql_connections(
            remove_mssql_connections(current, clean_server, clean_database or None)
        )


def _require_connectable_mssql_profile(
    server: str,
    database: str,
    authentication: str,
) -> Dict[str, str]:
    """Validate the server/database half of a profile, ignoring the table."""
    normalized = normalize_mssql_profile(
        {"server": server, "database": database, "authentication": authentication}
    )
    missing = [key for key in ("server", "database") if not normalized[key]]
    if missing:
        raise HTTPException(400, f"SQL Server profile is missing: {', '.join(missing)}.")
    if normalized["authentication"] == MSSQL_AUTH_SQL_LOGIN:
        raise HTTPException(
            400,
            "SQL Server login is not supported yet. Use Windows authentication.",
        )
    if normalized["authentication"] not in SUPPORTED_MSSQL_AUTH_MODES:
        raise HTTPException(400, f"Unknown authentication mode: {normalized['authentication']}")
    return normalized


def list_mssql_tables(
    server: str,
    database: str,
    authentication: str = MSSQL_AUTH_WINDOWS,
) -> Dict[str, Any]:
    """List the tables and views the caller can see in one database.

    Returns schema-qualified names ready to paste back into the profile, so the
    UI never has to assemble them itself.
    """
    profile = _require_connectable_mssql_profile(server, database, authentication)
    driver = _require_driver()
    statement = (
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE "
        "FROM INFORMATION_SCHEMA.TABLES "
        "WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') "
        "ORDER BY TABLE_SCHEMA, TABLE_NAME"
    )
    try:
        with driver.connect(_connection_string(profile), autocommit=True) as connection:
            cursor = connection.cursor()
            try:
                cursor.execute(statement)
                rows = cursor.fetchall()
            finally:
                cursor.close()
    except HTTPException:
        raise
    except Exception as error:
        return {"ok": False, "error": str(error), "tables": [], "table_count": 0}

    # The pair reached a real database, so it is worth offering again.
    try:
        remember_mssql_connection(profile["server"], profile["database"])
    except HTTPException:
        # A read-only config folder must not fail an otherwise good listing.
        pass

    tables: List[Dict[str, str]] = []
    for row in rows:
        schema_name = str(row[0] or "").strip()
        table_name = str(row[1] or "").strip()
        if not table_name:
            continue
        raw_type = str(row[2] or "").strip().upper()
        tables.append(
            {
                "schema": schema_name,
                "name": table_name,
                "kind": "view" if raw_type == "VIEW" else "table",
                "qualified_name": f"{schema_name}.{table_name}" if schema_name else table_name,
            }
        )
    return {
        "ok": True,
        "server": profile["server"],
        "database": profile["database"],
        "tables": tables,
        "table_count": len(tables),
    }


def test_mssql_connection(
    server: str,
    database: str,
    table: str,
    authentication: str = MSSQL_AUTH_WINDOWS,
) -> Dict[str, Any]:
    """Open a connection and read the target table's column list."""
    profile = _require_complete_mssql_profile(
        {
            "server": server,
            "database": database,
            "table": table,
            "authentication": authentication,
        }
    )
    driver = _require_driver()
    statement = f"SELECT TOP 0 * FROM {_quote_object_name(profile['table'])}"
    try:
        with driver.connect(_connection_string(profile), autocommit=True) as connection:
            cursor = connection.cursor()
            try:
                cursor.execute(statement)
                columns = [str(item[0]) for item in (cursor.description or [])]
            finally:
                cursor.close()
    except HTTPException:
        raise
    except Exception as error:  # pyodbc.Error and driver-specific subclasses.
        return {
            "ok": False,
            "error": str(error),
            "source_label": mssql_source_label(profile),
            "columns": [],
        }
    return {
        "ok": True,
        "source_label": mssql_source_label(profile),
        "columns": columns,
        "column_count": len(columns),
    }


# --- Master copy writers --------------------------------------------------

def _staging_path(master_path: str) -> str:
    return f"{master_path}.import.tmp"


def _commit_master(master_path: str, staging_path: str) -> None:
    os.replace(staging_path, master_path)


def _discard_staging(staging_path: str) -> None:
    try:
        if os.path.exists(staging_path):
            os.remove(staging_path)
    except OSError:
        pass


def _copy_csv_to_master(csv_path: str, master_path: str) -> None:
    os.makedirs(os.path.dirname(master_path), exist_ok=True)
    staging_path = _staging_path(master_path)
    try:
        shutil.copyfile(csv_path, staging_path)
        _commit_master(master_path, staging_path)
    except BaseException:
        _discard_staging(staging_path)
        raise


def _stream_mssql_to_master(profile: Dict[str, str], master_path: str) -> Tuple[int, int]:
    """Write the whole SQL Server table to the master copy. Returns (rows, columns)."""
    driver = _require_driver()
    os.makedirs(os.path.dirname(master_path), exist_ok=True)
    staging_path = _staging_path(master_path)
    statement = f"SELECT * FROM {_quote_object_name(profile['table'])}"
    row_count = 0
    column_count = 0
    try:
        with driver.connect(_connection_string(profile), autocommit=True) as connection:
            cursor = connection.cursor()
            try:
                cursor.execute(statement)
                columns = [str(item[0]) for item in (cursor.description or [])]
                column_count = len(columns)
                with open(staging_path, "w", encoding="utf-8", newline="") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(columns)
                    while True:
                        batch = cursor.fetchmany(_MSSQL_FETCH_BATCH)
                        if not batch:
                            break
                        writer.writerows(
                            [_csv_safe_cell(cell) for cell in row] for row in batch
                        )
                        row_count += len(batch)
            finally:
                cursor.close()
        _commit_master(master_path, staging_path)
    except BaseException:
        _discard_staging(staging_path)
        raise
    return row_count, column_count


def _csv_safe_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return value
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return isoformat()
    return str(value)


def _master_row_count(master_path: str) -> Optional[int]:
    """Data-row count of the master copy, header excluded."""
    try:
        with open(master_path, "r", encoding="utf-8-sig", newline="") as handle:
            total = sum(1 for _line in handle)
    except OSError:
        return None
    return max(0, total - 1)


def _master_column_count(master_path: str) -> Optional[int]:
    try:
        with open(master_path, "r", encoding="utf-8-sig", newline="") as handle:
            header = next(csv.reader(handle), None)
    except (OSError, StopIteration):
        return None
    return len(header) if header is not None else None


# --- Resolution -----------------------------------------------------------

def resolve_master_table_path(project_name: str) -> str:
    """Path of the project's master copy without touching the filesystem."""
    name = _require_project_name(project_name)
    try:
        return config.get_project_master_table_path(name)
    except ValueError as error:
        raise HTTPException(404, str(error))


def ensure_master_table(project_name: str, *, force: bool = False) -> Dict[str, Any]:
    """Return the master copy path, refreshing it from the configured source first.

    A `csv` project re-copies whenever the external file's identity changed (or
    `force` is set), so existing projects keep working without an explicit
    import. An `mssql` project is never re-read implicitly; its master copy is
    only written by `import_from_mssql`.
    """
    name = _require_project_name(project_name)
    master_path = resolve_master_table_path(name)

    with _project_lock(name):
        record = read_source_import(name)
        source_type = normalize_source_type(record.get("source_type"))
        master_exists = os.path.isfile(master_path)

        if source_type == SOURCE_TYPE_MSSQL:
            if not master_exists:
                raise SourceTableMissingError(
                    f"No table has been imported from SQL Server for project '{name}'. "
                    "Import the table in Project Settings > Source Data."
                )
            return _master_status(name, master_path, record, refreshed=False)

        csv_path = _configured_csv_path(name)
        if not csv_path:
            if master_exists:
                return _master_status(name, master_path, record, refreshed=False)
            raise SourceTableNotConfiguredError(
                f"No source table is configured for project '{name}'."
            )

        try:
            identity = csv_identity(csv_path)
        except FileNotFoundError:
            if master_exists:
                # Keep serving the last good import instead of losing the project
                # when the external file is temporarily unreachable.
                return _master_status(name, master_path, record, refreshed=False)
            raise FileNotFoundError(f"Source table file was not found: {csv_path}")
        except PermissionError:
            raise HTTPException(423, f"Source table file is locked: {csv_path}")

        if not force and master_exists and same_csv_identity(record.get("last_import"), identity):
            return _master_status(name, master_path, record, refreshed=False)

        try:
            _copy_csv_to_master(csv_path, master_path)
        except PermissionError:
            raise HTTPException(423, f"Source table file is locked: {csv_path}")
        except OSError as error:
            raise HTTPException(500, f"Failed to import the source table: {str(error)}")

        record = _write_source_import(
            name,
            {
                **record,
                "project_name": name,
                "source_type": SOURCE_TYPE_CSV,
                "last_import": {
                    "source_type": SOURCE_TYPE_CSV,
                    "source_label": csv_path,
                    "imported_at": _utc_now_text(),
                    "imported_by": get_windows_login_name(),
                    "row_count": _master_row_count(master_path),
                    "column_count": _master_column_count(master_path),
                    **identity,
                },
            },
        )
        return _master_status(name, master_path, record, refreshed=True)


def import_from_mssql(project_name: str) -> Dict[str, Any]:
    """Replace the master copy with the configured SQL Server table."""
    name = _require_project_name(project_name)
    master_path = resolve_master_table_path(name)

    with _project_lock(name):
        record = read_source_import(name)
        profile = _require_complete_mssql_profile(record.get("mssql"))
        try:
            row_count, column_count = _stream_mssql_to_master(profile, master_path)
        except HTTPException:
            raise
        except PermissionError:
            raise HTTPException(423, "The imported table file is locked. Another user may have it open.")
        except OSError as error:
            raise HTTPException(500, f"Failed to write the imported table: {str(error)}")
        except Exception as error:  # driver/query failures
            raise HTTPException(502, f"SQL Server import failed: {str(error)}")

        source_label = mssql_source_label(profile)
        record = _write_source_import(
            name,
            {
                **record,
                "project_name": name,
                "source_type": SOURCE_TYPE_MSSQL,
                "mssql": profile,
                "last_import": {
                    "source_type": SOURCE_TYPE_MSSQL,
                    "source_label": source_label,
                    "imported_at": _utc_now_text(),
                    "imported_by": get_windows_login_name(),
                    "row_count": row_count,
                    "column_count": column_count,
                },
            },
        )

    try:
        remember_mssql_connection(profile["server"], profile["database"])
    except HTTPException:
        # A read-only config folder must not fail a committed import.
        pass

    safe_append_project_audit_log(
        project_name=name,
        action=f"Imported source table from SQL Server ({source_label}, {row_count:,} rows)",
    )
    return _master_status(name, master_path, record, refreshed=True)


def _master_status(
    project_name: str,
    master_path: str,
    record: Dict[str, Any],
    *,
    refreshed: bool,
) -> Dict[str, Any]:
    try:
        stat = os.stat(master_path)
        exists = True
        size = int(stat.st_size)
        mtime = float(stat.st_mtime)
    except OSError:
        exists = False
        size = 0
        mtime = 0.0
    return {
        "project_name": project_name,
        "master_table_path": master_path,
        "master_table_exists": exists,
        "master_table_size": size,
        "master_table_mtime": mtime,
        "refreshed": bool(refreshed),
        "source_type": normalize_source_type(record.get("source_type")),
        "mssql": normalize_mssql_profile(record.get("mssql")),
        "last_import": record.get("last_import"),
    }


def get_source_table_state(project_name: str) -> Dict[str, Any]:
    """Import record plus master-copy status, without importing anything."""
    name = _require_project_name(project_name)
    record = read_source_import(name)
    master_path = resolve_master_table_path(name)
    state = _master_status(name, master_path, record, refreshed=False)
    state["csv_path"] = _configured_csv_path(name)
    state["driver_available"] = mssql_odbc.driver_available()
    state["supported_authentication"] = list(SUPPORTED_MSSQL_AUTH_MODES)
    return state


def resolve_source_table_for_read(project_name: str) -> str:
    """Master copy path for readers; refreshes a CSV project first.

    Returns an empty string when the project has no configured source at all,
    matching the historical "no table path" behavior of the callers.
    """
    try:
        status = ensure_master_table(project_name)
    except SourceTableNotConfiguredError:
        return ""
    except SourceTableMissingError:
        return ""
    return str(status.get("master_table_path") or "")


def source_table_columns(project_name: str, limit: int = 0) -> List[str]:
    """Header of the master copy, or an empty list when it is unavailable."""
    master_path = resolve_source_table_for_read(project_name)
    if not master_path or not os.path.isfile(master_path):
        return []
    try:
        with open(master_path, "r", encoding="utf-8-sig", newline="") as handle:
            header = next(csv.reader(handle), None)
    except OSError:
        return []
    columns = [str(name) for name in (header or [])]
    return columns[:limit] if limit and limit > 0 else columns
