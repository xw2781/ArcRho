"""Canonical ODBC access to Microsoft SQL Server.

Every SQL Server connection this app server opens goes through this module: it
owns the ordered ODBC driver candidates, the optional `pyodbc` import, the
installed-driver lookup, and the Windows-authenticated connection string. No
other module may restate any of them, so changing a supported driver or a
connection-string option is a one-file change.

The module stays transport-neutral. `MssqlDriverUnavailableError` carries a
finished user-facing sentence; an HTTP caller maps it to its own response shape
(`source_table_service` raises 503, the Arcode console returns it as a failed
query result) rather than this module knowing about FastAPI.

No credential is ever handled here. SQL Server access uses the caller's Windows
identity.
"""
from __future__ import annotations

from typing import Any

from app_server import config


# ODBC drivers are tried newest first; the first installed one wins.
ODBC_DRIVER_CANDIDATES = (
    "ODBC Driver 18 for SQL Server",
    "ODBC Driver 17 for SQL Server",
    "SQL Server Native Client 11.0",
    "SQL Server",
)

_DRIVER_IMPORT_ERROR = ""

try:  # pragma: no cover - depends on the packaged runtime.
    import pyodbc  # type: ignore
except Exception as exc:  # pragma: no cover - driver is an optional runtime dep.
    pyodbc = None  # type: ignore
    _DRIVER_IMPORT_ERROR = str(exc)


class MssqlDriverUnavailableError(RuntimeError):
    """`pyodbc` is missing, or no supported ODBC driver is installed."""


def driver_available() -> bool:
    """Whether the runtime can open a SQL Server connection at all."""

    return pyodbc is not None


def get_pyodbc() -> Any:
    """Return the `pyodbc` module, or explain what the user has to install."""

    if pyodbc is None:
        detail = f" ({_DRIVER_IMPORT_ERROR})" if _DRIVER_IMPORT_ERROR else ""
        raise MssqlDriverUnavailableError(
            f"SQL Server support is not installed in the {config.app_runtime_name()} "
            f"Python runtime{detail}. Install the Microsoft ODBC Driver for SQL Server "
            "and pyodbc."
        )
    return pyodbc


def installed_odbc_driver() -> str:
    """Name of the best ODBC driver installed on this PC."""

    driver = get_pyodbc()
    try:
        installed = {str(name).strip() for name in driver.drivers()}
    except Exception:
        installed = set()
    for candidate in ODBC_DRIVER_CANDIDATES:
        if candidate in installed:
            return candidate
    raise MssqlDriverUnavailableError(
        "No Microsoft ODBC Driver for SQL Server is installed on this PC. "
        "Install ODBC Driver 17 or 18 for SQL Server."
    )


def windows_connection_string(server: str, database: str) -> str:
    """Windows-authenticated connection string. No credentials are ever stored."""

    parts = [
        f"DRIVER={{{installed_odbc_driver()}}}",
        f"SERVER={str(server or '').strip()}",
        f"DATABASE={str(database or '').strip()}",
        "Trusted_Connection=yes",
        "Encrypt=no",
    ]
    return ";".join(parts) + ";"
