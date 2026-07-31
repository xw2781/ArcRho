# App Server Domain: reserving_class

## Purpose
<!-- MANUAL:BEGIN -->
Reserving class values/tree/preferences/types domain.

Values are always collected from the project-owned imported master table resolved by `source_table_service.resolve_source_table_for_read`; see [`source_table`](source_table.md). `refresh_reserving_class_values` and `get_reserving_class_path_tree_children` no longer accept a `table_path` override, and `POST /reserving_class_values/refresh` no longer accepts a `table_path` field. `mapping_rows_override` remains, so a field-mapping save can refresh against rows it has not committed yet.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.reserving_class.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/reserving_class_combinations` | `get_reserving_class_combinations` | `str` | - | - |
| `GET` | `/reserving_class_filter_spec` | `get_reserving_class_filter_spec` | `str` | - | `reserving_class_service.get_filter_spec_for_project` |
| `POST` | `/reserving_class_filter_spec` | `save_reserving_class_filter_spec` | `ReservingClassFilterSpecSaveRequest` | [`app_server/schemas/reserving_class.py`](../../../app_server/schemas/reserving_class.py) | `reserving_class_service.save_filter_spec_for_project` |
| `GET` | `/reserving_class_hidden_paths` | `get_reserving_class_hidden_paths` | `str` | - | `reserving_class_service.get_hidden_paths_for_project` |
| `POST` | `/reserving_class_hidden_paths` | `save_reserving_class_hidden_paths` | `ReservingClassHiddenPathsSaveRequest` | [`app_server/schemas/reserving_class.py`](../../../app_server/schemas/reserving_class.py) | `reserving_class_service.save_hidden_paths_for_project` |
| `GET` | `/reserving_class_path_tree` | `get_reserving_class_path_tree` | `str` | - | - |
| `GET` | `/reserving_class_path_tree/children` | `get_reserving_class_path_tree_children` | `str` | - | `reserving_class_service.get_reserving_class_path_tree_children` |
| `GET` | `/reserving_class_types` | `get_reserving_class_types` | `str` | - | `reserving_class_service.refresh_reserving_class_types_json` |
| `POST` | `/reserving_class_types` | `save_reserving_class_types` | `ReservingClassTypesSaveRequest` | [`app_server/schemas/reserving_class.py`](../../../app_server/schemas/reserving_class.py) | `audit_service.safe_append_project_audit_log`, `reserving_class_service.normalize_reserving_class_types_data`, `reserving_class_service.refresh_reserving_class_types_json` |
| `POST` | `/reserving_class_types/import_local_file` | `import_local_reserving_class_types_file` | `ReservingClassTypesImportLocalFileRequest` | [`app_server/schemas/reserving_class.py`](../../../app_server/schemas/reserving_class.py) | `reserving_class_service.parse_local_reserving_class_types_file` |
| `POST` | `/reserving_class_values/refresh` | `refresh_reserving_class_values` | `RefreshReservingClassValuesRequest` | [`app_server/schemas/reserving_class.py`](../../../app_server/schemas/reserving_class.py) | `reserving_class_service.refresh_reserving_class_values` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.reserving_class.key_files -->
- [`app_server/api/reserving_class_router.py`](../../../app_server/api/reserving_class_router.py) - Reserving-class routes for values/tree/preferences/types.
- [`app_server/services/reserving_class_service.py`](../../../app_server/services/reserving_class_service.py) - Cache generation, refresh, and preference persistence.
- [`app_server/schemas/reserving_class.py`](../../../app_server/schemas/reserving_class.py) - Reserving class request models.
- [`ui/shared/components/pickers/reserving_class_picker.js`](../../../ui/shared/components/pickers/reserving_class_picker.js) - Frontend caller for reserving-class endpoints.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Consumed by dataset, DFM, and project settings features.
- Exposes refresh and cache children endpoints.
- `POST /reserving_class_types` writes both `reserving_class_types.json` and a same-folder mirror workbook `reserving_class_types.xlsx` with `Name`, `Level`, `Formula`, and resolved `Source`.
- `POST /reserving_class_types/import_local_file` parses local reserving-class-type `.json`/`.xlsx` files for Project Settings local load; the JSON parser accepts either UI columns (`Name`, `Level`, `Formula`) or persisted file columns with trailing `Source` and silently discards a retired `EEX Formula` column.
- Source-derived reserving class type rows are generated independently per `(Name, Level)` pair (not deduped by `Name` only), so the same name can appear in multiple level groups when present in distinct source levels.
- Reserving class `Source` expressions always wrap each resolved component in double quotes (including single-component formulas), and quoted tokens in `Formula` are treated as atomic components so operator-normalization does not insert spaces inside quoted names or collapse user-entered spacing within quoted text (for example `/` in `"Affinity/Referral Partners"` or the double space in `"eSales -  Teachers"`).
- `POST /reserving_class_types` rejects changed user-defined formulas when they reference a reserving class type name that does not exist in the submitted/current table, or when they reference a name containing `+`, `-`, `*`, or `/` without wrapping that full name in double quotes; invalid saves return `400` with the offending row/field details. Unchanged legacy rows are not revalidated on save, formulas may reference user-defined rows as well as source-derived rows, and quoted components are validated by exact name match, including repeated spaces inside the quotes.
- `EEX Formula` is no longer part of Reserving Class Types persistence or validation. Legacy JSON payloads may still contain that column, but readers discard it so Project Settings and dependent features remain available. XLSX imports continue to return an explicit conversion-required error; measure-specific row filters belong in `data_processing_rules.json`.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses multiple JSON cache files with lock protection plus project-user preference files under `projects/<project>/users/<windows-login>/preferences.json`.
- Reserving class types persistence uses paired JSON/XLSX writes with rollback-safe ordering (write XLSX then JSON, rollback XLSX on JSON failure).
- Active tree `filter_spec`, `rcprefs-window` preferences, favorite path nicknames/folders from `ptree-window`, and hidden paths from the tree context menu are stored in the project-user preference file under `reservingClassTree`, so they are user-specific and copy with project duplication. The tree preferences include automatic single-child expansion and whether segment labels are hidden; reserving-class trees remain open after a final path is selected. Reverting a favorite nickname removes that path's nickname entry so the UI falls back to the original raw path label.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add a reserving-class endpoint: keep schema/service lock logic consistent.
2. Change cache structure: update readers/writers and UI consumers together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- High route volume and file-lock contention make regression risk higher here.
<!-- MANUAL:END -->
