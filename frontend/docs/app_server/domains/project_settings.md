# App Server Domain: project_settings

## Purpose
<!-- MANUAL:BEGIN -->
Project settings source and project-index management domain.
Also persists per-project Source Data date boundaries in `general_settings.json`.
Provides project-folder filesystem operations used by Project Settings tree actions (rename/duplicate/create/delete).
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.project_settings.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/general_settings` | `get_general_settings` | `str` | - | `project_settings_service.get_general_settings` |
| `POST` | `/general_settings` | `update_general_settings` | `GeneralSettingsUpdateRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.update_general_settings` |
| `GET` | `/project_settings/{source}` | `get_project_settings` | `str` | - | `project_settings_service.get_project_settings` |
| `POST` | `/project_settings/{source}` | `update_project_settings` | `ProjectSettingsUpdateRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.update_project_settings` |
| `POST` | `/project_settings/{source}/create_project_folder` | `create_project_folder` | `CreateProjectFolderRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.create_project_folder` |
| `POST` | `/project_settings/{source}/delete_project_folder` | `delete_project_folder` | `DeleteProjectFolderRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.delete_project_folder` |
| `POST` | `/project_settings/{source}/duplicate_project_folder` | `duplicate_project_folder` | `DuplicateProjectFolderRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.duplicate_project_folder` |
| `GET` | `/project_settings/{source}/duplicate_project_folder/status/{request_id}` | `get_duplicate_project_folder_status` | `str` | - | `project_settings_service.get_duplicate_project_folder_status` |
| `GET` | `/project_settings/{source}/folders` | `get_project_folders` | `str` | - | `project_settings_service.get_project_folders` |
| `POST` | `/project_settings/{source}/folders` | `update_project_folders` | `FolderStructureUpdateRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.update_project_folders` |
| `POST` | `/project_settings/{source}/generated_dataset_cache/clear` | `clear_generated_dataset_csv_caches` | `GeneratedDatasetCacheClearRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.clear_generated_dataset_csv_caches` |
| `POST` | `/project_settings/{source}/open_project_folder` | `open_project_folder` | `OpenProjectFolderRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.open_project_folder` |
| `POST` | `/project_settings/{source}/rename_project_folder` | `rename_project_folder` | `RenameProjectFolderRequest` | [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) | `project_settings_service.rename_project_folder` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.project_settings.key_files -->
- [`app_server/api/project_settings_router.py`](../../../app_server/api/project_settings_router.py) - Project settings CRUD and folder ops routes.
- [`app_server/services/project_settings_service.py`](../../../app_server/services/project_settings_service.py) - Project settings persistence service.
- [`app_server/schemas/project_settings.py`](../../../app_server/schemas/project_settings.py) - Project settings request schemas.
- [`ui/project_settings/project_settings.js`](../../../ui/project_settings/project_settings.js) - Frontend caller for project settings endpoints.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Heavily used by `project_settings.js` UI flows.
- Provides `/general_settings` read/write for Source Data Origin/Development boundary values.
- Provides project-folder CRUD-style endpoints under `/project_settings/{source}/*_project_folder` (including empty-folder creation for new-project tree action).
- Provides `POST /project_settings/{source}/open_project_folder` for opening a selected project directory in the host OS file explorer.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Handles project-index CRUD and settings JSON writes. Project names and virtual UI folders live in `projects/index.json`; source table paths live in each project's `field_mapping.json`.
- `get_general_settings` serves repeat reads of an unchanged `general_settings.json` from the shared mtime-validated in-memory cache (`app_server/services/file_read_cache.py`); any timestamp or size change, including atomic replacement by settings saves, forces a fresh read, and recently written files are always re-read.
- `POST /project_settings/{source}/folders` applies new project paths supplied by multi-step create/duplicate flows and returns the updated project-index `mtime` so clients can keep optimistic concurrency checks current.
- Handles project folder open requests by resolving the project directory through config path helpers before launching OS file explorer.
- `create_project_folder` creates an empty project folder plus a `data` subfolder; client coordinates rollback if later folder-structure/settings saves fail.
- `POST /project_settings/{source}/duplicate_project_folder` validates the client request ID, logical source/target names, and normalized server-root-relative projects-directory setting, then writes a canonical location-independent submission receipt before atomically publishing the queued `ArcRhoDuplicateProject` v1 request under the fixed `<server-root>/requests` Engine protocol. An identical request-ID replay returns `202` from that receipt, repairs only missing queued publication, and never overwrites a valid Engine processing or terminal status; reusing the ID for different logical input or a different projects-directory setting returns `409`.
- `GET /project_settings/{source}/duplicate_project_folder/status/{request_id}` reads and validates the matching atomic Engine status. Request and status payloads are owned by `python-api/src/arcrho_project_duplication_contract.py`, contain no client-local paths, and derive their protocol locations from the configured ArcRho Server root.
- ArcRho Engine copies project-level files and materialized reserving-class folders on the server host, excludes the transient `data/.arcrho-resq-import-staging` and `data/tmp` folders, and exposes a target folder only after its same-parent staging copy completes.
- `POST /project_settings/{source}/generated_dataset_cache/clear` clears project `data/*/datasets/*.csv` files during Source Data refresh while preserving CSVs identified by canonical scalar `index.json` entries with `source_kind: input`. Independent reserving-class scans/deletes use bounded parallelism, sidecar and method JSON remain unchanged, and each affected reserving class is rebuilt through the canonical index producer under the shared update lock before the request completes or reports a partial-delete failure.
- Handles per-project `general_settings.json` persistence in each project folder.
- Normalizes stored Origin/Development boundary values to plain integer strings (no commas, no trailing `.0`/`.00`).
- Stores `auto_generated` in `general_settings.json`; the app server writes `project_name` as current project folder name to detect stale duplicated files.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add source key support: update router path params + service source resolution.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Folder operation rollbacks can leave partial state when interrupted.
<!-- MANUAL:END -->
