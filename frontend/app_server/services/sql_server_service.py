"""Arcode SQL Server console: connection profiles and query execution.

A profile names a server and a database. Nothing else is stored, because SQL
Server access always uses the caller's Windows identity - the same rule the
project-owned source-table import follows, and the reason no credential ever
reaches disk.

This module owns the `sql_server_connections.json` payload: its version, field
projection, normalization, and the rule that the stored default must name an
existing profile. `config.SQL_SERVER_CONNECTIONS_PATH` owns where it lives, and
`mssql_odbc` owns how a connection is opened.

Profiles are per user, so this file has one writer. Writes are still serialized
in-process and committed atomically so two Arcode windows cannot interleave.
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from arcrho_api.source_table_contract import (
    MSSQL_AUTH_SQL_LOGIN,
    SUPPORTED_MSSQL_AUTH_MODES,
    normalize_mssql_auth,
)

from app_server import config
from app_server.services import mssql_odbc
from app_server.services.sql_console_results import clamp_row_limit, json_safe_cell


CONNECTIONS_VERSION = 1

# Opening a Windows-authenticated connection is cheap, so the console opens one
# per query instead of caching sessions. A query therefore never inherits state
# from an earlier one, and an abandoned tab holds nothing open on the server.
_CONNECT_TIMEOUT_SECONDS = 15
# A console query that has not returned by this point is a runaway statement,
# not a slow report; the user re-runs a narrower query instead.
_QUERY_TIMEOUT_SECONDS = 120

_STORE_LOCK = threading.Lock()


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def normalize_profile(profile: Any, name: str = "") -> Dict[str, str]:
    data = profile if isinstance(profile, dict) else {}
    return {
        "name": _text(data.get("name")) or _text(name),
        "server": _text(data.get("server")),
        "database": _text(data.get("database")),
        "authentication": normalize_mssql_auth(data.get("authentication")),
    }


def normalize_store(payload: Any) -> Dict[str, Any]:
    """Return the full canonical `sql_server_connections.json` payload."""

    data = payload if isinstance(payload, dict) else {}
    raw_connections = data.get("connections")
    connections: Dict[str, Dict[str, str]] = {}
    if isinstance(raw_connections, dict):
        for key, profile in raw_connections.items():
            name = _text(key)
            if not name:
                continue
            connections[name] = normalize_profile(profile, name)
    default = _text(data.get("default"))
    if default not in connections:
        default = ""
    return {
        "version": CONNECTIONS_VERSION,
        "connections": connections,
        "default": default,
    }


def _read_store() -> Dict[str, Any]:
    try:
        with open(config.SQL_SERVER_CONNECTIONS_PATH, "r", encoding="utf-8-sig") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return normalize_store({})
    return normalize_store(raw)


def _write_store(payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized = normalize_store(payload)
    path = config.SQL_SERVER_CONNECTIONS_PATH
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(normalized, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp_path, path)
    except OSError as error:
        raise HTTPException(500, f"Failed to save SQL Server connections: {error}")
    return normalized


def _default_connection_name(store: Dict[str, Any]) -> str:
    names = sorted(store["connections"], key=str.casefold)
    if store["default"]:
        return store["default"]
    return names[0] if names else ""


def _driver_state() -> Tuple[bool, str, str]:
    """Whether this PC can reach SQL Server, and what to say when it cannot.

    Driver lookup covers both halves of the answer: a missing `pyodbc` and a PC
    with no Microsoft ODBC driver installed produce different sentences, and the
    console shows whichever one applies.
    """

    try:
        return True, mssql_odbc.installed_odbc_driver(), ""
    except mssql_odbc.MssqlDriverUnavailableError as error:
        return False, "", str(error)


def load_connections() -> Dict[str, Any]:
    store = _read_store()
    connector_available, driver, connector_error = _driver_state()
    return {
        "ok": True,
        "path": config.SQL_SERVER_CONNECTIONS_PATH,
        "connections": store["connections"],
        "defaultConnection": _default_connection_name(store),
        "connectorAvailable": connector_available,
        "connectorError": connector_error,
        "driver": driver,
        "supportedAuthentication": list(SUPPORTED_MSSQL_AUTH_MODES),
    }


def _require_valid_profile(profile: Dict[str, str]) -> Dict[str, str]:
    normalized = normalize_profile(profile)
    if not normalized["name"]:
        raise HTTPException(400, "Connection name is required.")
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


def save_connection(
    connection: str,
    profile: Any,
    make_default: bool = False,
) -> Dict[str, Any]:
    """Add or update one profile.

    `connection` is the profile being edited, so an edit that changes the name
    renames in place instead of leaving the old profile behind.
    """

    normalized = _require_valid_profile(profile)
    previous_name = _text(connection)
    with _STORE_LOCK:
        store = _read_store()
        connections = dict(store["connections"])
        if previous_name and previous_name != normalized["name"]:
            connections.pop(previous_name, None)
        connections[normalized["name"]] = normalized
        default = store["default"]
        if make_default or default == previous_name or not default:
            default = normalized["name"]
        _write_store({"connections": connections, "default": default})
    return load_connections()


def delete_connection(connection: str) -> Dict[str, Any]:
    name = _text(connection)
    if not name:
        raise HTTPException(400, "Connection name is required.")
    with _STORE_LOCK:
        store = _read_store()
        connections = dict(store["connections"])
        if name not in connections:
            raise HTTPException(404, f"SQL Server connection not found: {name}")
        connections.pop(name)
        default = "" if store["default"] == name else store["default"]
        _write_store({"connections": connections, "default": default})
    return load_connections()


def _resolve_profile(connection: str) -> Dict[str, str]:
    store = _read_store()
    name = _text(connection) or _default_connection_name(store)
    profile = store["connections"].get(name)
    if not profile:
        raise HTTPException(404, f"SQL Server connection not found: {name or '(none)'}")
    return _require_valid_profile(profile)


def _failed(name: str, message: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": message,
        "connection": name,
        "columns": [],
        "rows": [],
        "rowCount": 0,
    }


def _read_first_result_set(cursor: Any, row_limit: int) -> Tuple[List[str], List[List[Any]], int]:
    """First grid the batch produces, plus rows affected by the statements before it.

    A console batch is often several statements. The first one that returns a
    result set is what the grid shows; statements before it only contribute
    their affected-row counts, so an INSERT followed by a SELECT still reports
    both halves.
    """

    affected = 0
    while True:
        if cursor.description:
            columns = [str(column[0]) for column in cursor.description]
            rows = [
                [json_safe_cell(cell) for cell in row]
                for row in cursor.fetchmany(row_limit)
            ]
            return columns, rows, affected
        count = cursor.rowcount
        if isinstance(count, int) and count > 0:
            affected += count
        try:
            if not cursor.nextset():
                return [], [], affected
        except Exception:
            # Drivers raise instead of returning False once the batch is drained.
            return [], [], affected


def run_query(sql: str, connection: str = "", limit: Optional[int] = None) -> Dict[str, Any]:
    profile = _resolve_profile(connection)
    name = profile["name"]
    statement = str(sql or "")
    if not statement.strip():
        return _failed(name, "SQL is empty.")
    try:
        driver = mssql_odbc.get_pyodbc()
        connection_string = mssql_odbc.windows_connection_string(
            profile["server"], profile["database"]
        )
    except mssql_odbc.MssqlDriverUnavailableError as error:
        return _failed(name, str(error))

    row_limit = clamp_row_limit(limit)
    try:
        with driver.connect(
            connection_string,
            autocommit=True,
            timeout=_CONNECT_TIMEOUT_SECONDS,
        ) as handle:
            handle.timeout = _QUERY_TIMEOUT_SECONDS
            cursor = handle.cursor()
            try:
                cursor.execute(statement)
                columns, rows, affected = _read_first_result_set(cursor, row_limit)
            finally:
                cursor.close()
    except Exception as error:  # pyodbc.Error and driver-specific subclasses.
        return _failed(name, str(error))

    return {
        "ok": True,
        "connection": name,
        "server": profile["server"],
        "database": profile["database"],
        "columns": columns,
        "rows": rows,
        "rowCount": len(rows),
        "rowsAffected": affected,
        "truncated": bool(columns) and len(rows) >= row_limit,
    }


def test_connection(connection: str = "") -> Dict[str, Any]:
    return run_query(
        "SELECT @@SERVERNAME AS [Server], DB_NAME() AS [Database], "
        "SUSER_NAME() AS [Login], @@VERSION AS [Version]",
        connection,
        1,
    )
