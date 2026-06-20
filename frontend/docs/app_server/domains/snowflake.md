# App Server Domain: Snowflake

## Purpose
<!-- MANUAL:BEGIN -->
Runs Arcode Snowflake SQL queries through the app server so connection profiles and authentication stay out of the renderer process.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.snowflake.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/snowflake/connections` | `snowflake_connections` | - | - | `snowflake_service.load_connections` |
| `POST` | `/snowflake/connections` | `snowflake_save_connection` | `SnowflakeConnectionSaveRequest` | [`app_server/schemas/scripting.py`](../../../app_server/schemas/scripting.py) | `snowflake_service.save_connection` |
| `POST` | `/snowflake/query` | `snowflake_query` | `SnowflakeQueryRequest` | [`app_server/schemas/scripting.py`](../../../app_server/schemas/scripting.py) | `snowflake_service.run_query` |
| `POST` | `/snowflake/test-connection` | `snowflake_test_connection` | `SnowflakeQueryRequest` | [`app_server/schemas/scripting.py`](../../../app_server/schemas/scripting.py) | `snowflake_service.test_connection` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.snowflake.key_files -->
- [`app_server/api/snowflake_router.py`](../../../app_server/api/snowflake_router.py) - Snowflake connection, test, and query routes.
- [`app_server/services/snowflake_service.py`](../../../app_server/services/snowflake_service.py) - Connection profile loading and Snowflake query execution.
- [`app_server/schemas/scripting.py`](../../../app_server/schemas/scripting.py) - Snowflake request models shared with scripting schemas.
- [`ui/arcode/snowflake-console/index.js`](../../../ui/arcode/snowflake-console/index.js) - Arcode Snowflake SQL editor client.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `GET /snowflake/connections` returns local Snowflake connection profiles and whether `snowflake-connector-python` is importable in the active Python runtime.
- `POST /snowflake/connections` saves a named connection profile to local JSON.
- `POST /snowflake/query` runs SQL for a named connection and returns column names, rows, query id, row count, and truncation status.
- `POST /snowflake/test-connection` runs a small current-context query for the selected connection.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Connection profiles are stored in `%APPDATA%\Arcode\snowflake_connections.json` when Arcode mode is active.
- If the local JSON file is missing, the service can seed `my_example_connection` from `E:\XWSpace\Snowflake Config.txt`.
- Passwords are not stored; the initial supported authentication mode is Snowflake `externalbrowser`.
- The app server keeps an in-process Snowflake session cache per named connection so repeated Run/Test actions can reuse external-browser authentication. Saving a connection profile closes that cached session.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Query execution requires `snowflake-connector-python` in the app-server Python runtime. Missing connector packages return an explicit error instead of failing silently.
- Large result sets are capped by the service and flagged as truncated.
<!-- MANUAL:END -->
