# App Server Domain: field_mapping

## Purpose
<!-- MANUAL:BEGIN -->
Field mapping persistence domain for project settings.

`table_path` in `field_mapping.json` is the *external CSV selection* a user picked in Project Settings, not the table anything reads. It is the copy source for a `csv`-sourced project's imported master table; see [`source_table`](source_table.md). Saving a mapping refreshes reserving class values from the imported copy, so no path override is passed.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.field_mapping.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/field_mapping` | `get_field_mapping` | `str` | - | - |
| `POST` | `/field_mapping` | `save_field_mapping` | `FieldMappingSaveRequest` | [`app_server/schemas/field_mapping.py`](../../../app_server/schemas/field_mapping.py) | `field_mapping_service.save_field_mapping` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.field_mapping.key_files -->
- [`app_server/api/field_mapping_router.py`](../../../app_server/api/field_mapping_router.py) - Field mapping read/save routes.
- [`app_server/services/field_mapping_service.py`](../../../app_server/services/field_mapping_service.py) - Field mapping persistence and validation.
- [`app_server/schemas/field_mapping.py`](../../../app_server/schemas/field_mapping.py) - Field mapping request schema.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Used by project settings field mapping feature and by data-engine project source CSV lookup.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores mapping files under project folders. `table_path` is the canonical source CSV path for a project; global project registry files do not store source table paths.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add mapping attributes: update schema, service validation, and UI module.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Invalid mappings propagate into reserving class/dataset processing.
<!-- MANUAL:END -->
