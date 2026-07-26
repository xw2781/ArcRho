# Runtime: Data and Cache Files

## Purpose
<!-- MANUAL:BEGIN -->
Index cache/data files and refresh points used by app-server services.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN runtime.data_cache_files.entry_points -->
| Method | Path | Domain | Handler |
| --- | --- | --- | --- |
| `POST` | `/arcrho/headers/cache/clear` | `arcrho` | `clear_arcrho_headers_cache` |
| `POST` | `/arcrho/tri/refresh` | `arcrho` | `arcrho_tri_refresh` |
| `POST` | `/arcrho/vec/refresh` | `arcrho` | `arcrho_vec_refresh` |
| `POST` | `/dataset/cache/load` | `dataset` | `load_dataset_cache` |
| `GET` | `/datasets/cached` | `dataset` | `list_cached_dataset_names` |
| `POST` | `/datasets/cached/delete` | `dataset` | `delete_cached_datasets` |
| `POST` | `/datasets/cached/empty` | `dataset` | `create_empty_cached_dataset` |
| `POST` | `/dfm/method-index/refresh` | `dfm_method_index` | `refresh_dfm_method_index` |
| `POST` | `/project_settings/{source}/generated_dataset_cache/clear` | `project_settings` | `clear_generated_dataset_csv_caches` |
| `POST` | `/reserving_class_values/refresh` | `reserving_class` | `refresh_reserving_class_values` |
| `GET` | `/table_summary` | `table_summary` | `get_table_summary` |
| `POST` | `/table_summary/refresh` | `table_summary` | `refresh_table_summary` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN runtime.data_cache_files.key_files -->
- [`app_server/config.py`](../../app_server/config.py) - Cache/data file names and lock constants.

Cache/lock constants detected:
- `AUDIT_LOG_FILE`
- `DATASET_NUMBER_FORMATS_FILE`
- `DATASET_TYPES_FILE`
- `DATA_PROCESSING_RULES_FILE`
- `DATA_PROCESSING_VALUES_FILE`
- `FIELD_MAPPING_FILE`
- `GENERAL_SETTINGS_FILE`
- `LOCAL_PROJECT_PREFS_FILE`
- `PROJECT_INDEX_FILE`
- `PROJECT_SETTINGS_XLSX_FILE`
- `PROJECT_USER_PREFERENCES_FILE`
- `RESERVING_CLASS_COMBINATIONS_FILE`
- `RESERVING_CLASS_PATH_TREE_FILE`
- `RESERVING_CLASS_TYPES_FILE`
- `RESERVING_CLASS_VALUES_FILE`
- `SCRIPTING_PREFS_FILE`
- `USERNAME_INDEX_FILE`
- `_AUDIT_LOG_LOCK`
- `_RESERVING_CLASS_PATH_TREE_LOCK`
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Cache refresh is exposed via route endpoints and service calls.
- Several caches are project-folder scoped; others are user AppData scoped.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- File names and limits are defined in `app_server/config.py` constants.
- `projects/<project>/data_processing_values.json` is the lazy `arcrho-source-vocab-v1` cache used by the Data Processing Rules editor. It contains de-duplicated mapped reserving-class key combinations for each source measure and is invalidated by the source CSV path/mtime/size fingerprint or a Field Mapping signature change.
- Project data is organized by reserving class as `data/<ReservingClassFolder>/datasets` for CSV caches, `data/<ReservingClassFolder>/methods` for method JSON and method RPC temp files, `data/<ReservingClassFolder>/sidecars` for dataset metadata and notes, and `data/<ReservingClassFolder>/index.json` for the Project Instance cache index. Background `WriteSidecar: false` engine requests keep per-CSV processing provenance in `data/<ReservingClassFolder>/.arcrho-cache-provenance/`; each atomic technical record includes the current processing hash and the CSV size, modification time, and SHA-256 content fingerprint, letting non-mutating Dataset/DFM/Result Selection loads reuse only the recorded file without changing the user-editable base sidecar. Dataset deletion and generated-cache clearing remove the corresponding technical record; a mismatched or replaced CSV invalidates it automatically.
- Dataset Viewer and DFM store the local last selected Project Name in `%APPDATA%\ArcRho\local_project_prefs.json` so it can be checked and edited manually without opening the server project folder. The same file also stores `recentProjectNames`, capped to the last three project names selected from the project tree picker, which appear in the picker's blue virtual `Recent Projects` folder above real project folders, and `projectExplorer.expandedFolders`, which restores the Project Settings folder expansion state.
- Reserving-class tree filter specs are stored in each project-user preference file under `projects/<project>/users/<windows-login>/preferences.json`; `%APPDATA%\ArcRho\cache\reserving_class_filter_spec.json` is obsolete and is no longer read or written.
- Refresh endpoints can clear and rebuild cache files.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add cache file constant: update config, service readers/writers, and this index.
2. Change refresh logic: verify endpoint side effects and lock behavior.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Cache invalidation bugs can surface as stale or mismatched UI data.
- File locking can fail writes under concurrent access.
- Source-vocabulary generation must not publish a cache if the source CSV changes during its scan.
<!-- MANUAL:END -->
