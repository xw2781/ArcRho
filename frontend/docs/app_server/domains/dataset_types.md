# App Server Domain: dataset_types

## Purpose
<!-- MANUAL:BEGIN -->
Dataset types catalog domain.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.dataset_types.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/dataset_types` | `get_dataset_types` | `str` | - | `dataset_types_service.normalize_dataset_types_data` |
| `POST` | `/dataset_types` | `save_dataset_types` | `DatasetTypesSaveRequest` | [`app_server/schemas/dataset_types.py`](../../../app_server/schemas/dataset_types.py) | `audit_service.safe_append_project_audit_log`, `calculated_dataset_service.changed_formula_dataset_type_names`, `calculated_dataset_service.refresh_sidecar_graphs_and_recalculate`, `dataset_types_service._build_dataset_source_resolver`, `dataset_types_service._extract_formula_components`, `dataset_types_service._is_source_generated_from_field_names`, `dataset_types_service._load_dataset_source_map`, `dataset_types_service._load_field_mapping_field_names`, `dataset_types_service.normalize_dataset_types_data`, `dataset_types_service.save_dataset_types_payload` |
| `POST` | `/dataset_types/import_local_file` | `import_local_dataset_types_file` | `DatasetTypesImportLocalFileRequest` | [`app_server/schemas/dataset_types.py`](../../../app_server/schemas/dataset_types.py) | `dataset_types_service.parse_local_dataset_types_file` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.dataset_types.key_files -->
- [`app_server/api/dataset_types_router.py`](../../../app_server/api/dataset_types_router.py) - Dataset type catalog read/save routes.
- [`app_server/services/dataset_types_service.py`](../../../app_server/services/dataset_types_service.py) - Dataset type storage and normalization.
- [`app_server/schemas/dataset_types.py`](../../../app_server/schemas/dataset_types.py) - Dataset type save schema.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Used by project settings dataset types panel and dependent flows.
- `GET /dataset_types` keeps normalized 5-column `data.columns/data.rows` for compatibility and also returns `data.source_by_name` (dataset name -> Source expression) derived from project `dataset_types.json`.
- `POST /dataset_types/import_local_file` parses local `.json`/`.xlsx` Dataset Types files for UI-side local import; for `.xlsx`, parser assumes one sheet and the header exactly matches JSON column layout (supports 5-column local format, 6-column persisted format with trailing `Source`, or 7-column persisted format with trailing `Source` and `Generated`).
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Persists dataset type definitions under project folders.
- `POST /dataset_types` saves both `dataset_types.json` and same-folder `dataset_types.xlsx` with matching columns/rows (`Name`, `Data Format`, `Category`, `Calculated`, `Formula`, `Source`, `Generated`); XLSX header row is bold and column widths are auto-sized from header + cell contents (bounded min/max).
- `GET /dataset_types` source metadata extraction is backward-compatible with legacy files: `source_by_name` reads from a `Source` column when present or falls back to row index 5 for older row layouts.
- `POST /dataset_types` recomputes the persisted `Generated` flag from each row's saved `Source`: it is `true` only when the source is non-empty and every non-operator component is covered by a `field_name` in project `field_mapping.json`.
- After saving Dataset Types, formula changes refresh existing dataset sidecars for the project with current `formula`, `Precedents`, and `Dependents` values, then recalculate existing instances of changed calculated dataset types and their downstream dependent chains.
- Save validation treats calculated formulas as valid when referenced components resolve to Dataset Type `Name` values; it no longer requires field-mapping source resolution for those components.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add type metadata field: align schema, service normalization, and frontend editor.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Type schema drift can break downstream interpretation logic.
<!-- MANUAL:END -->
