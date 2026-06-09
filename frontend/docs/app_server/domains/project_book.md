# App Server Domain: project_book

## Purpose
<!-- MANUAL:BEGIN -->
Project registry compatibility domain backed by `projects/index.json`.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.project_book.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/project_book/meta` | `project_book_meta` | - | - | - |
| `POST` | `/project_book/patch` | `project_book_patch` | `XlsmPatchRequest` | [`app_server/schemas/book.py`](../../../app_server/schemas/book.py) | `project_settings_service._read_project_index`, `project_settings_service._write_project_index`, `project_settings_service.project_index_to_sheet_data`, `project_settings_service.update_project_index_from_sheet_data` |
| `GET` | `/project_book/sheet` | `project_book_sheet` | `str` | - | `project_settings_service._read_project_index`, `project_settings_service.project_index_to_sheet_data` |
| `GET` | `/project_settings` | `list_project_settings_sources` | - | - | `project_settings_service.list_project_settings_sources` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.project_book.key_files -->
- [`app_server/api/project_book_router.py`](../../../app_server/api/project_book_router.py) - Project workbook metadata/sheet/patch routes.
- [`app_server/services/book_service.py`](../../../app_server/services/book_service.py) - Workbook patching implementation.
- [`app_server/services/project_settings_service.py`](../../../app_server/services/project_settings_service.py) - Project-folder path resolution.
- [`app_server/schemas/book.py`](../../../app_server/schemas/book.py) - Project workbook patch schema.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Used by project settings/dataset flows that still call the project-book compatibility endpoints.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Depends on project settings path resolution.
- Reads/writes `projects/index.json` as the project registry. The compatibility sheet view exposes `Project Name` plus a `Table Path` value hydrated from each project's `field_mapping.json`, but persisted registry entries contain only project `name` and virtual UI `folder`.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change project-book lookup rules: update router checks and service path resolvers.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Mismatched source/folder mappings can route to wrong files.
<!-- MANUAL:END -->
