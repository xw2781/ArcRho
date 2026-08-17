from typing import Optional

from pydantic import BaseModel

from arcrho_api.source_table_contract import MSSQL_AUTH_WINDOWS

from app_server.services.sql_console_results import DEFAULT_QUERY_ROWS


class SqlServerConnectionProfile(BaseModel):
    name: str = ""
    server: str = ""
    database: str = ""
    # Only Windows authentication is supported today; the SQL login mode is
    # accepted by the shape and rejected by the service.
    authentication: Optional[str] = MSSQL_AUTH_WINDOWS


class SqlServerConnectionSaveRequest(BaseModel):
    # The profile being edited. Empty adds one; a different `profile.name`
    # renames the existing profile instead of leaving a copy behind.
    connection: str = ""
    profile: SqlServerConnectionProfile
    make_default: bool = False


class SqlServerConnectionDeleteRequest(BaseModel):
    connection: str


class SqlServerQueryRequest(BaseModel):
    sql: str = ""
    # Empty runs against the stored default connection.
    connection: str = ""
    limit: int = DEFAULT_QUERY_ROWS
