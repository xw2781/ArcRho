# App Server Domain: field_mapping

## Purpose
<!-- MANUAL:BEGIN -->
Field mapping persistence domain for project settings.

`field_mapping_service.load_date_role_fields` is the canonical answer to "which columns of this project hold a reserving period". It returns `{column name: significance}` for the significances in `config.FIELD_MAPPING_DATE_SIGNIFICANCES` (`Origin Date`, `Development Date`), first mapped row winning per significance, and an empty mapping when the file is missing or unreadable. Consumers call it instead of re-deriving the rule from `field_mapping.json`; `table_summary` uses it to publish each column's `role` and to bin date columns by year. `FIELD_MAPPING_SIGNIFICANCES` is built from that same tuple, so the date pair is declared once. The pair itself is named in `arcrho_api.field_mapping_contract` and re-exported here, because the Engine reads the granularity recorded against it too.

`field_mapping_service.load_source_period_months` is the canonical answer to "how fine is this project's source data". It returns `{significance: months per period}` — `12` for a four-digit `YYYY` column, `1` for a `YYYYMM` one, by the rule `arcrho_api.field_mapping_contract.period_months_from_date_value` owns — persisted under `source_period_months` in `field_mapping.json`. A mapping save measures it from the imported master table and writes it; a mapping saved before the field existed is measured once on the first read and written back, so no consumer has to cope with its absence twice. A role whose column is missing or holds nothing readable is simply absent, which is how a caller tells "annual" from "not recorded".

That granularity is the shape an Engine-generated dataset can be rebuilt at, whatever period it was last generated at, so it is what such a dataset's sidecar records as its stored shape (see [`dataset`](dataset.md)). The Engine mirrors the rule in `arcrho_engine.data_processing`, prefers the recorded value over its own reading of the source column, and writes a line to `runtime/logs/engine_requests.log` when the two disagree; `server-components/tests/test_engine_source_granularity.py` fails if the mirror drifts.

`table_path` in `field_mapping.json` is the *external CSV selection* a user picked in Project Settings, not the table anything reads. It is the copy source for a `csv`-sourced project's imported master table; see [`source_table`](source_table.md). Its writer is the import-profile save (`POST /source_table/profile` with `csv_path`); a field-mapping save that omits `table_path` preserves the stored value. Saving a mapping refreshes reserving class values from the imported copy, so no path override is passed.
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
