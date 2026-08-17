"""Snowflake connection and query helpers for Arcode."""
from __future__ import annotations

import json
import os
import re
import threading
from typing import Any, Dict, List

from app_server import config
from app_server.services.sql_console_results import clamp_row_limit, json_safe_cell


DEFAULT_CONNECTION_NAME = "my_example_connection"
SNOWFLAKE_CONFIG_IMPORT_PATH = r"E:\XWSpace\Snowflake Config.txt"
_CONNECTOR_IMPORT_ERROR = ""
_CONNECTION_CACHE: Dict[str, Dict[str, Any]] = {}
_CONNECTION_CACHE_LOCK = threading.Lock()

try:
    import snowflake.connector  # type: ignore
except Exception as exc:  # pragma: no cover - depends on optional runtime package.
    snowflake = None  # type: ignore
    _CONNECTOR_IMPORT_ERROR = str(exc)


def _empty_profile(name: str = DEFAULT_CONNECTION_NAME) -> Dict[str, str]:
    return {
        "name": name,
        "account": "",
        "user": "",
        "authenticator": "externalbrowser",
        "role": "",
        "warehouse": "",
        "database": "",
        "schema": "",
    }


def _normalize_name(value: Any) -> str:
    name = str(value or "").strip()
    return name or DEFAULT_CONNECTION_NAME


def _normalize_profile(profile: Any, name: str = DEFAULT_CONNECTION_NAME) -> Dict[str, str]:
    if not isinstance(profile, dict):
        profile = {}
    out = _empty_profile(name)
    out["name"] = _normalize_name(profile.get("name") or name)
    for key in ("account", "user", "authenticator", "role", "warehouse", "database"):
        value = str(profile.get(key) or "").strip()
        if value:
            out[key] = value
    schema_value = profile.get("schema")
    if schema_value is None:
        schema_value = profile.get("schema_name")
    out["schema"] = str(schema_value or "").strip()
    return out


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _write_json(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp_path, path)


def _parse_snowflake_config_text(text: str) -> Dict[str, str]:
    in_connection = False
    profile: Dict[str, str] = {}
    pattern = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            in_connection = line.strip("[]").strip() == f"connections.{DEFAULT_CONNECTION_NAME}"
            continue
        if not in_connection:
            continue
        match = pattern.match(line)
        if not match:
            continue
        key, value = match.groups()
        value = value.strip().strip('"').strip("'").strip()
        if key == "schema":
            profile["schema"] = value
        elif key in {"account", "user", "authenticator", "role", "warehouse", "database"}:
            profile[key] = value
    return _normalize_profile(profile, DEFAULT_CONNECTION_NAME) if profile else {}


def _load_imported_connection() -> Dict[str, str]:
    try:
        if not os.path.exists(SNOWFLAKE_CONFIG_IMPORT_PATH):
            return {}
        with open(SNOWFLAKE_CONFIG_IMPORT_PATH, "r", encoding="utf-8") as f:
            return _parse_snowflake_config_text(f.read())
    except Exception:
        return {}


def load_connections() -> Dict[str, Any]:
    raw = _read_json(config.SNOWFLAKE_CONNECTIONS_PATH)
    connections_raw = raw.get("connections") if isinstance(raw.get("connections"), dict) else {}
    connections: Dict[str, Dict[str, str]] = {}
    for name, profile in connections_raw.items():
        normalized_name = _normalize_name(name)
        connections[normalized_name] = _normalize_profile(profile, normalized_name)

    if DEFAULT_CONNECTION_NAME not in connections:
        imported = _load_imported_connection()
        if imported:
            connections[DEFAULT_CONNECTION_NAME] = imported
            if not raw:
                try:
                    _write_json(config.SNOWFLAKE_CONNECTIONS_PATH, {"connections": connections})
                except Exception:
                    # Loading connections must still work when AppData is read-only.
                    pass

    return {
        "ok": True,
        "path": config.SNOWFLAKE_CONNECTIONS_PATH,
        "connections": connections,
        "defaultConnection": DEFAULT_CONNECTION_NAME if DEFAULT_CONNECTION_NAME in connections else "",
        "connectorAvailable": snowflake is not None,
    }


def save_connection(name: str, profile: Dict[str, Any]) -> Dict[str, Any]:
    connection_name = _normalize_name(name)
    existing = load_connections()["connections"]
    existing[connection_name] = _normalize_profile(profile, connection_name)
    payload = {"connections": existing}
    _write_json(config.SNOWFLAKE_CONNECTIONS_PATH, payload)
    _close_cached_connection(connection_name)
    return load_connections()


def _connection_params(profile: Dict[str, str]) -> Dict[str, str]:
    params: Dict[str, str] = {}
    for key in ("account", "user", "authenticator", "role", "warehouse", "database"):
        value = str(profile.get(key) or "").strip()
        if value:
            params[key] = value
    schema_value = str(profile.get("schema") or "").strip()
    if schema_value:
        params["schema"] = schema_value
    return params


def _connection_signature(params: Dict[str, str]) -> str:
    return json.dumps(params, sort_keys=True, separators=(",", ":"))


def _close_connection(conn: Any) -> None:
    try:
        conn.close()
    except Exception:
        pass


def _connection_is_open(conn: Any) -> bool:
    if conn is None:
        return False
    try:
        is_closed = getattr(conn, "is_closed", None)
        if callable(is_closed):
            return not bool(is_closed())
        if isinstance(is_closed, bool):
            return not is_closed
    except Exception:
        return False
    return True


def _get_cached_connection(name: str, profile: Dict[str, str]) -> tuple[Any, Any]:
    params = _connection_params(profile)
    signature = _connection_signature(params)
    with _CONNECTION_CACHE_LOCK:
        cached = _CONNECTION_CACHE.get(name)
        if (
            cached
            and cached.get("signature") == signature
            and _connection_is_open(cached.get("conn"))
        ):
            return cached["conn"], cached["lock"]

        if cached:
            _close_connection(cached.get("conn"))

        conn = snowflake.connector.connect(**params)  # type: ignore[union-attr]
        entry = {"signature": signature, "conn": conn, "lock": threading.RLock()}
        _CONNECTION_CACHE[name] = entry
        return conn, entry["lock"]


def _discard_cached_connection(name: str, conn: Any) -> None:
    with _CONNECTION_CACHE_LOCK:
        cached = _CONNECTION_CACHE.get(name)
        if not cached or cached.get("conn") is not conn:
            return
        _CONNECTION_CACHE.pop(name, None)
    _close_connection(conn)


def _close_cached_connection(name: str) -> None:
    with _CONNECTION_CACHE_LOCK:
        cached = _CONNECTION_CACHE.pop(name, None)
    if not cached:
        return
    with cached["lock"]:
        _close_connection(cached.get("conn"))


def _validate_query_request(sql: str, profile: Dict[str, str]) -> str:
    query = str(sql or "").strip()
    if not query:
        return "SQL is empty."
    missing = [key for key in ("account", "user", "authenticator", "role", "warehouse", "database", "schema") if not profile.get(key)]
    if missing:
        return f"Snowflake connection is missing: {', '.join(missing)}."
    return ""


def run_query(sql: str, connection: str = DEFAULT_CONNECTION_NAME, limit: int = 1000) -> Dict[str, Any]:
    connections = load_connections()["connections"]
    name = _normalize_name(connection)
    profile = connections.get(name) or {}
    error = _validate_query_request(sql, profile)
    if error:
        return {"ok": False, "error": error, "rows": [], "columns": [], "connection": name}
    if snowflake is None:
        detail = f" ({_CONNECTOR_IMPORT_ERROR})" if _CONNECTOR_IMPORT_ERROR else ""
        return {
            "ok": False,
            "error": f"Snowflake connector is not installed in the Arcode Python runtime{detail}.",
            "rows": [],
            "columns": [],
            "connection": name,
        }

    row_limit = clamp_row_limit(limit)
    conn = None
    cur = None
    try:
        conn, conn_lock = _get_cached_connection(name, profile)
        with conn_lock:
            try:
                cur = conn.cursor()
                cur.execute(str(sql))
                columns = [col[0] for col in (cur.description or [])]
                rows: List[List[Any]] = []
                for row in cur.fetchmany(row_limit):
                    rows.append([json_safe_cell(cell) for cell in row])
                query_id = getattr(cur, "sfqid", "") or ""
            finally:
                try:
                    if cur is not None:
                        cur.close()
                except Exception:
                    pass
                cur = None
        return {
            "ok": True,
            "connection": name,
            "queryId": query_id,
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "truncated": len(rows) >= row_limit,
        }
    except Exception as exc:
        if conn is not None:
            _discard_cached_connection(name, conn)
        return {"ok": False, "error": str(exc), "rows": [], "columns": [], "connection": name}


def test_connection(connection: str = DEFAULT_CONNECTION_NAME) -> Dict[str, Any]:
    return run_query("select current_role(), current_warehouse(), current_database(), current_schema()", connection, 1)
