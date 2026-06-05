# Runtime: Config and Path Resolution

## Purpose
<!-- MANUAL:BEGIN -->
Document path/config setup, AppData-backed workspace path persistence, and runtime path refresh behavior.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN runtime.config_paths.entry_points -->
- Path/config helper functions in `app_server/config.py`:
  - `_clean_path_segment`
  - `_find_existing_project_dir`
  - `_get_project_map_dir`
  - `_get_requests_dir`
  - `_get_scripting_dir`
  - `_get_user_appdata_cache_dir`
  - `_get_user_appdata_dir`
  - `_get_workflow_dir`
  - `_infer_project_name_from_table_path`
  - `_sanitize_project_dir_name`
  - `clear_runtime_path_caches`
  - `get_audit_log_path`
  - `get_cache_path`
  - `get_dataset_types_path`
  - `get_field_mapping_path`
  - `get_general_settings_path`
  - `get_local_project_prefs_path`
  - `get_path`
  - `get_project_data_dir`
  - `get_project_generated_data_dir`
  - `get_project_instance_default_preferences_path`
  - `get_project_manual_data_dir`
  - `get_project_settings_workbook_path`
  - `get_reserving_class_combinations_path`
  - `get_reserving_class_path_tree_path`
  - `get_reserving_class_types_path`
  - `get_reserving_class_values_path`
  - `get_root_path`
  - `get_scripting_prefs_path`
  - `load_workspace_paths`
  - `refresh_runtime_paths`
  - `save_workspace_paths`
  - `workspace_paths_file_exists`
- Workspace path config routes:
  - `GET` `/workspace_paths` handled by `get_workspace_paths`
  - `POST` `/workspace_paths` handled by `update_workspace_paths`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN runtime.config_paths.key_files -->
- [`app_server/config.py`](../../app_server/config.py) - Primary runtime path + config module, including AppData workspace path persistence.
- [`app_server/api/workspace_paths_router.py`](../../app_server/api/workspace_paths_router.py) - HTTP interface for workspace path updates.
- [`app_server/main.py`](../../app_server/main.py) - App bootstrap and static path mounting.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Frontend shell settings modal calls `/workspace_paths` routes.
- App-server modules import `app_server.config` for runtime path resolution.
- On first-time setup, the Electron shell searches `D:\ArcRho Server` through `Z:\ArcRho Server` and fills the Server Connection root path when found.
- Saving Server Connection hot-applies the new config by refreshing `app_server.config` runtime globals and notifying open UI frames; app restart is not required for new server requests.
- DFM RPC Bridge writes request files under `<workspace_root>/<requests_dir>/RPC bridge` and expects remote DFM/SyncDFM JSON files under `<workspace_root>/<projects_dir>/<project>/data/manual/<ReservingClassFolder>/tmp_rpc`.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- `%APPDATA%\ArcRho\workspace_paths.json` is the persistent user-local source-of-truth for workspace root/path mapping.
- If the AppData workspace path file does not exist yet, the app uses built-in defaults until the Server Connection setting is saved.
- Runtime globals in `app_server/config.py` are refreshed from config after `/workspace_paths` updates.
- In-memory runtime caches that contain absolute workspace paths, including the app-server dataset registry, are cleared after `/workspace_paths` updates.
- Dataset valid-value caches and the DFM root-path cache are cleared or replaced when the shell broadcasts a Server Connection update.
- User-local fixed paths are also refreshed in `app_server/config.py`, including workflow export path (`~/Documents/ArcRho/workflows`) and scripting path (`~/Documents/ArcRho/scripts`) used for notebooks and editable macros.
- Project, reserving-class, dataset, DFM method, workflow, and project-user folder/file components encode Windows-invalid filename characters with the reversible `_%XX_` rule, for example `/` becomes `_%2F_`, `:` becomes `_%3A_`, and ASCII control characters use their two-digit hex code. Backend paths use `app_server.config.encode_filename_segment`; direct renderer-side file paths use the shared `/ui/shared/filename_sanitizer.js` helper so DFM, Dataset, and future pages follow the same convention.
- ArcRhoTri generated dataset CSV caches use `projects/<project>/data/generated/<ReservingClassFolder>/<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv` with one base `<DatasetName>.json` sidecar, so period length, cumulative/incremental, and development/calendar shape changes rebuild separate CSV caches without creating extra metadata files. Runtime cache creation writes the sidecar only if it is missing; the Dataset page Save button updates saved period lengths and user fields. Dataset sidecars record the current Windows login user in `user` and `modified_by` for Project Instance's `User` column.
- DFM local method files use `projects/<project>/data/manual/<ReservingClassFolder>/DFM@<Name>.json`; within one project/reserving-class pair, the DFM `Name` is the sole local instance identity. DFM RPC Bridge remote responses use `data/manual/<ReservingClassFolder>/tmp_rpc/DFM@<Name>.json`, while remote-update status files start with `SyncDFM@`.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add a new configurable path: update the AppData `workspace_paths.json` contract + `app_server/config.py` getters.
2. Change path refresh behavior: validate all services that depend on runtime globals.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Path changes affect every filesystem-backed domain.
- Environment-specific path assumptions can break packaged deployments.
<!-- MANUAL:END -->
