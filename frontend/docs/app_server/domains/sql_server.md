# App Server Domain: sql_server

## Purpose
<!-- MANUAL:BEGIN -->
SQL Server connection profiles and T-SQL execution for the Arcode SQL Server console.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.sql_server.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/sqlserver/connections` | `sql_server_connections` | - | - | `sql_server_service.load_connections` |
| `POST` | `/sqlserver/connections` | `sql_server_save_connection` | `SqlServerConnectionSaveRequest` | [`app_server/schemas/sql_server.py`](../../../app_server/schemas/sql_server.py) | `sql_server_service.save_connection` |
| `POST` | `/sqlserver/connections/delete` | `sql_server_delete_connection` | `SqlServerConnectionDeleteRequest` | [`app_server/schemas/sql_server.py`](../../../app_server/schemas/sql_server.py) | `sql_server_service.delete_connection` |
| `POST` | `/sqlserver/query` | `sql_server_query` | `SqlServerQueryRequest` | [`app_server/schemas/sql_server.py`](../../../app_server/schemas/sql_server.py) | `sql_server_service.run_query` |
| `POST` | `/sqlserver/reset-connection` | `sql_server_reset_connection` | `SqlServerConnectionResetRequest` | [`app_server/schemas/sql_server.py`](../../../app_server/schemas/sql_server.py) | `sql_server_service.reset_connection` |
| `POST` | `/sqlserver/test-connection` | `sql_server_test_connection` | `SqlServerQueryRequest` | [`app_server/schemas/sql_server.py`](../../../app_server/schemas/sql_server.py) | `sql_server_service.test_connection` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.sql_server.key_files -->
- [`app_server/api/sql_server_router.py`](../../../app_server/api/sql_server_router.py) - SQL Server connection, test, reset, and query routes.
- [`app_server/services/sql_server_service.py`](../../../app_server/services/sql_server_service.py) - Connection profile store and SQL Server query execution.
- [`app_server/services/mssql_odbc.py`](../../../app_server/services/mssql_odbc.py) - Canonical ODBC driver selection and Windows connection string.
- [`app_server/services/sql_console_results.py`](../../../app_server/services/sql_console_results.py) - Row limit and driver-cell conversion shared by the SQL consoles.
- [`app_server/schemas/sql_server.py`](../../../app_server/schemas/sql_server.py) - SQL Server connection and query request models.
- [`ui/arcode/sql-server-console/index.js`](../../../ui/arcode/sql-server-console/index.js) - Arcode SQL Server editor page.
- [`ui/arcode/shared/sql_engines.js`](../../../ui/arcode/shared/sql_engines.js) - Canonical Snowflake and SQL Server engine descriptors shared by the editors and the connections dialog.
- [`ui/arcode/database-connections/dialog.js`](../../../ui/arcode/database-connections/dialog.js) - Arcode Database Connections dialog, which edits both engines' profiles.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `GET /sqlserver/connections` returns the per-user profiles, the stored default, and whether an ODBC driver is available.
- `POST /sqlserver/connections` adds, edits, or renames one profile; `POST /sqlserver/connections/delete` removes one.
- `POST /sqlserver/query` and `/sqlserver/test-connection` execute T-SQL as the caller's Windows identity.
- `POST /sqlserver/reset-connection` answers what the next Run starts from. Nothing is cached to close, because a query opens and closes its own connection, so the route states that rather than pretending to reset a session; it never fails on an unknown or unset name. The Arcode SQL Server editor's Reconnect command calls it, so both engines offer the same command.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores profiles in `%APPDATA%\Arcode\sql_server_connections.json` in Arcode mode and the ArcRho per-user config folder otherwise. This is not the ArcRho Server's shared server/database history used by Project Settings Source Data.
- Profiles hold a name, server, database, and authentication mode only; no credential is ever written.
- A query opens and closes its own connection, so no session state survives between runs.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change the profile payload: update `sql_server_service` normalization, `config.py`, the connection manager client, and this doc together.
2. Change how a connection is opened: change `mssql_odbc` only, so the Project Settings source-table import stays identical.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Only Windows authentication is wired up; the SQL login mode is rejected until it is implemented.
- Execution is not read-only: a batch runs with autocommit, so a user's statement can change data their Windows account may change.
- Results are capped and reported as truncated; the grid is for inspection, not export.
<!-- MANUAL:END -->
