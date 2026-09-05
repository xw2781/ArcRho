# App Server Domain: source_table

## Purpose
<!-- MANUAL:BEGIN -->
The project-owned imported source table.

Every project folder owns exactly one imported raw table at a fixed location and a fixed name:

```
<project dir>/source/master_table.csv     the table every ArcRho consumer reads
<project dir>/source/source_import.json   which source produced it, plus the SQL Server profile
```

Two import routes write that same copy:

- **`csv`** - copied from the external path in `field_mapping.json::table_path`. The copy is refreshed automatically whenever that file's identity (path, mtime, size) differs from the recorded import, so existing projects keep working with no user action.
- **`mssql`** - streamed from SQL Server with the caller's Windows identity. Never re-read implicitly; only an explicit import writes the copy.

The external CSV path and the SQL Server table are *import sources*. Nothing downstream reads them: table summary, reserving class values, data processing rules/values, and the data engine all resolve `source/master_table.csv`.

The SQL Server profile lives with the project and is shared by every user of that project. It stores `server`, `database`, `table`, and `authentication` only - never credentials. `windows` is the only supported authentication mode; `sql_login` exists in the shape as a reserved placeholder and every service path rejects it until it is implemented.

`POST /source_table/profile` also accepts an optional `csv_path` for `csv`-sourced projects and writes it into the project's `field_mapping.json::table_path`, making the profile save the single writer of the external CSV selection; an omitted `csv_path` leaves the stored path unchanged.

`GET /source_table/file_status` reads the external source file's own identity - modified time, size, and whether it still matches the recorded import - without importing anything, so the Source Data details panel can show the file's live modified time rather than the one captured when the copy was taken. It runs on the caller's machine rather than the ArcRho Server host on purpose: an import source is not project data, and the configured path may be a Client PC drive the server cannot see, which is the same reason `resolve_import_source_for_server` exists. An unreachable file answers `exists: false` instead of failing.

`POST /source_table/tables` lists the tables and views the caller can see in one database, so the Source Data picker never has to assemble a name itself. It validates only the server/database half of the profile, because choosing the table is exactly what it is for.

Server/database pairs that connect successfully are recorded in a **server-shared** preference at `<workspace_root>/config/mssql_connections.json`, resolved by `config.get_mssql_connections_path()` - never a hardcoded server root. Every user of that ArcRho Server sees and can prune the same list through `GET /source_table/connections` and `POST /source_table/connections/forget`. The file holds `server`, `database`, and `last_used_at` only: no credentials, and no table name, since the table is a per-project choice. Recording is best-effort - a read-only config folder must not fail a good connect or a committed import.

`POST /source_table/refresh_job` submits the Engine-hosted refresh (`python-api/src/arcrho_source_refresh_contract.py` owns the request). It takes an optional scope: `dataset_types`, a list of engine-built dataset type names, and `reserving_class_types`, a list of `{Name, Level}` reserving class types. The router forwards each only when non-empty, because the hosted-mutation contract reads an empty list argument as a malformed request and an absent one as "everything"; the contract writes them into the request file as `DatasetTypes` and `ReservingClassTypes` under the same rule, so a whole-project refresh is the payload every deployed Engine already accepts. `reserving_class_matches_scope` in the contract is the one owner of the class rule: a class is in scope when its path segment at every listed level is one of the names listed for that level, and a level not listed accepts every value. The Engine worker (`server-components/src/arcrho_engine/source_table_refresh.py`) applies that rule to the class list and regenerates only engine datasets whose index row `dataset_type` is a listed type; the dependent walk that follows starts from whatever was regenerated, so calculated datasets and methods downstream of a skipped type are left as they were. The job then records the scope it ran in `source_import.json::refresh_scope` (`dataset_types`, `reserving_class_types`, `chosen_by`, `chosen_at`; `normalize_refresh_scope` in the contract owns the shape) through `source_table_service.record_refresh_scope`. It is project-owned, so every user of the project sees the same record, and the Source Data tab opens its Import Scope step on it; "everything" is recorded as two empty lists, so a narrowing never outlives the next whole-project import. The Engine writes it on the server host, which is why no client-side write of the record was added.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.source_table.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/source_table` | `get_source_table` | `str` | - | `source_table_service.get_source_table_state` |
| `GET` | `/source_table/connections` | `get_source_table_connections` | - | - | `source_table_service.load_mssql_connections` |
| `POST` | `/source_table/connections/forget` | `forget_source_table_connection` | `MssqlConnectionForgetRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_table_service.forget_mssql_connection` |
| `GET` | `/source_table/file_status` | `get_source_table_file_status` | `str` | - | `source_table_service.get_source_file_status` |
| `POST` | `/source_table/import` | `import_source_table` | `SourceTableImportRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_table_service.import_from_mssql` |
| `POST` | `/source_table/profile` | `save_source_table_profile` | `SourceProfileSaveRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_table_service.get_source_table_state`, `source_table_service.save_source_profile` |
| `POST` | `/source_table/refresh` | `refresh_source_table` | `SourceTableRefreshRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_table_service.ensure_master_table` |
| `POST` | `/source_table/refresh_job` | `submit_source_refresh_job` | `SourceRefreshJobSubmitRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_refresh_service.submit_source_table_refresh_job`, `workspace_mutation_client.run_workspace_mutation` |
| `GET` | `/source_table/refresh_job/plan` | `get_source_refresh_plan` | `str` | - | `source_refresh_service.describe_source_refresh_plan` |
| `GET` | `/source_table/refresh_job/status` | `get_source_refresh_job_status` | `str` | - | `source_refresh_service.get_source_table_refresh_status`, `workspace_read_client.run_workspace_read` |
| `POST` | `/source_table/tables` | `list_source_table_candidates` | `MssqlTableListRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_table_service.list_mssql_tables` |
| `POST` | `/source_table/test_connection` | `test_source_table_connection` | `MssqlConnectionTestRequest` | [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) | `source_table_service.test_mssql_connection` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.source_table.key_files -->
- [`app_server/api/source_table_router.py`](../../../app_server/api/source_table_router.py) - Import source profile, connection test, and import routes.
- [`app_server/services/source_table_service.py`](../../../app_server/services/source_table_service.py) - Project-owned master table copy and SQL Server import.
- [`app_server/schemas/source_table.py`](../../../app_server/schemas/source_table.py) - Import source request schemas.
- [`../python-api/src/arcrho_api/source_table_contract.py`](../../../../python-api/src/arcrho_api/source_table_contract.py) - Canonical master-table layout and source_import.json schema.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `python-api/src/arcrho_api/source_table_contract.py` is the canonical owner of the folder/file names, the `source_import.json` schema, the normalization rules, and the CSV staleness rule. `app_server/config.py` delegates its path helpers to it.
- The Engine ships as its own frozen bundle and cannot import `arcrho_api`, so `arcrho_engine/data_processing.py` mirrors `SOURCE_IMPORT_DIR` and `MASTER_TABLE_FILE` locally. `frontend/tests/test_source_table_contract.py` fails when the mirror drifts, and also asserts the engine resolves the master path without consulting `table_path`.
- Requires `pyodbc` plus a Microsoft ODBC Driver for SQL Server (18, 17, or a Native Client fallback) on the client PC. Both are optional at import time: a missing driver answers `503` with an explicit message rather than failing at startup.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Writes are serialized per project by an in-process lock, and both import routes stage to `master_table.csv.import.tmp` and `os.replace` on success. A failed or interrupted import discards the staging file and leaves the previous master copy intact.
- SQL Server rows stream in `_MSSQL_FETCH_BATCH` (20000) batches straight to CSV, so a large table never materializes in memory.
- Table names are bracket-quoted per part and rejected when they are empty, deeper than three parts, or contain a `]`; the query is always a plain `SELECT * FROM <quoted>`.
- A transient CSV read failure (missing or locked external file) preserves the last good import instead of clearing the project.
- `resolve_source_table_for_read` returns `""` when nothing is configured or imported, matching the historical "no table path" behavior of its callers.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add a field to `source_import.json`: extend `normalize_source_import` in `arcrho_api/source_table_contract.py` first, then the service and the Source Data tab consumer.
2. Enable SQL Server login: extend `SUPPORTED_MSSQL_AUTH_MODES`, add the credential handling (which must not persist to the shared project folder), and enable the disabled radio in `ui/project_settings/project_settings.html`.
3. Move or rename the master table: change only the contract constants, then update the data-engine mirror; the parity test names both.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- A project switched to `mssql` before its first import answers `409` until the user imports; this is deliberate, since the app server must never open a database connection implicitly.
- The master copy doubles the on-disk footprint of the raw table inside the project folder, and `source/` is carried along by project duplicate.
- The in-process per-project lock does not coordinate across app-server processes; concurrent imports of the same project from two PCs rely on the atomic replace for correctness, and the last writer wins.
<!-- MANUAL:END -->
