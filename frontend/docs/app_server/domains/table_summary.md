# App Server Domain: table_summary

## Purpose
<!-- MANUAL:BEGIN -->
Table summary generation/cache and refresh domain.
Each column carries `name`, `dtype`, `type`, the preformatted `values` string, `distinct_count` (strings and booleans only), `null_count`, `null_ratio`, and a `distribution` block: `{kind: "categorical", items[{label, share}], other_share, other_count}` for strings, `{kind: "numeric", bins}` with 16 peak-normalized heights for numeric and datetime columns, and `{kind: "none"}` otherwise.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.table_summary.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/table_summary` | `get_table_summary` | `str` | - | `table_summary_service.generate_table_summary`, `table_summary_service.load_valid_cache` |
| `POST` | `/table_summary/refresh` | `refresh_table_summary` | `TableSummaryRefreshRequest` | [`app_server/schemas/table_summary.py`](../../../app_server/schemas/table_summary.py) | `reserving_class_service.refresh_reserving_class_values`, `table_summary_service.generate_table_summary` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.table_summary.key_files -->
- [`app_server/api/table_summary_router.py`](../../../app_server/api/table_summary_router.py) - Table summary read/refresh routes.
- [`app_server/services/table_summary_service.py`](../../../app_server/services/table_summary_service.py) - CSV summary generation and cache validity.
- [`app_server/services/reserving_class_service.py`](../../../app_server/services/reserving_class_service.py) - Optional refresh chaining.
- [`app_server/schemas/table_summary.py`](../../../app_server/schemas/table_summary.py) - Table summary refresh schema.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Used by project settings and reserving class refresh workflows.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Can trigger reserving class value refresh as side effect.
- The cached payload carries `summary_version`. `load_valid_cache` serves a cache only when it is newer than the CSV **and** matches the current version, so a version bump regenerates stale caches instead of returning payloads without the newer keys.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change refresh contract: align request schema and downstream reserve refresh behavior.
2. Add or change a per-column field: extend `generate_table_summary`, bump `SUMMARY_VERSION`, and update the Source Data consumer in `ui/project_settings/project_settings_source_data.js`.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Cache invalidation and side-effect refresh can impact performance.
- Distribution statistics run inside the existing single `read_csv` pass (one `value_counts` or `numpy.histogram` per column), so they add work proportional to column count on every cache miss.
<!-- MANUAL:END -->
