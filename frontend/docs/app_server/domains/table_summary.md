# App Server Domain: table_summary

## Purpose
<!-- MANUAL:BEGIN -->
Table summary generation/cache and refresh domain.

Both routes are addressed by `project_name` only and always summarize that project's imported master table at `<project>/source/master_table.csv`. There is no caller-supplied path: `_resolve_master_table` calls `source_table_service.ensure_master_table`, so a CSV-sourced project re-copies its external file first (`force=True` on refresh), and a SQL Server project without an imported copy answers `409` instead of reading anything external. See [`source_table`](source_table.md).

Each column carries `name`, `dtype`, `type`, `role`, the preformatted `values` string, `distinct_count` (strings and booleans only), `null_count`, `null_ratio`, a `stats` block with raw JSON-safe `min`/`max` (numbers for integer and float columns, strings for datetime, `null` otherwise or when the column is empty), and a `distribution` block: `{kind: "categorical", items[{label, share}], other_share, other_count}` for strings, `{kind: "numeric", bins, edges, clipped_low, clipped_high}` for numeric and datetime columns, and `{kind: "none"}` otherwise.

`role` is the column's `Origin Date`/`Development Date` significance, or `""`. Both routes resolve it through `field_mapping_service.load_date_role_fields` (see [`field_mapping`](field_mapping.md)) and pass it to `generate_table_summary`; names are matched trimmed and case-insensitively. The whole resolved mapping is echoed as the top-level `date_roles`. Consumers read `role` rather than fetching the mapping themselves.

A date-role column is binned by **calendar year, one bar per year**, and adds `bin_labels` (one year label per bar) to its distribution. Its `edges` are plain year numbers, and it is never quantile-clipped. Heights stay **linear**, because one year of rows against another is already a fair comparison. Values that are not real YYYYMM periods — placeholder zeros, months outside 1-12, years outside `DATE_MIN_YEAR`-`DATE_MAX_YEAR` — are excluded from the chart only; `stats` and the `values` string still report the column's raw minimum and maximum, so a column with placeholder zeros reads `0` as its minimum beside a chart that starts at its first real year. A column with no usable period, or one spanning more than `DATE_MAX_YEARS`, falls back to the free-form numeric pipeline below. Years with no rows stay in the span as empty bars.

A free-form (non-date-role) numeric `distribution` is shaped for reading, not for exact reconstruction, because the preview prints the true range beside it:
- **Domain.** The drawn window is the central `DISTRIBUTION_TAIL_QUANTILE` (0.5%) to 99.5% quantile range, and outlying rows are clipped into the end bins rather than dropped. A concentrated column with long tails otherwise spends its whole domain on outliers and renders as one bar. `clipped_low`/`clipped_high` report each end independently so the consumer labels only the bins that actually absorbed a tail. A column shorter than `DISTRIBUTION_CLIP_MIN_ROWS` is always drawn across its full range, since a 0.5% window there cannot hold one observation.
- **Smoothing.** Counts are accumulated `DISTRIBUTION_OVERSAMPLE` times finer than published, convolved with one Gaussian, then averaged back down. That is a binned kernel density estimate: it costs `O(rows)` plus a fixed-size array op instead of the `O(rows x grid)` of a direct KDE.
- **Bin count.** At most `DISTRIBUTION_BIN_COUNT` (40) and never more than the number of occupied fine bins, floored at `DISTRIBUTION_MIN_BIN_COUNT`. Occupancy is read off the counts already computed; a distinct-value pass over the rows would roughly double the per-column cost. Drawing more bins than the column can resolve combs it into alternating full and empty bars.
- **Heights.** `bins` are square roots of the peak-normalized density, so a column whose mass sits in one bin still shows its tails instead of a bare spike beside a flat line. They are not proportional to counts and must not be read as such.
- **Edges.** `bins` heights plus `len(bins) + 1` edges spanning the drawn domain, rounded to 12 significant digits rather than a fixed number of decimal places so a small-magnitude column does not collapse every edge to `0.0`.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.table_summary.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/table_summary` | `get_table_summary` | `str` | - | `field_mapping_service.load_date_role_fields`, `table_summary_service.generate_table_summary`, `table_summary_service.read_valid_cache` |
| `POST` | `/table_summary/refresh` | `refresh_table_summary` | `TableSummaryRefreshRequest` | [`app_server/schemas/table_summary.py`](../../../app_server/schemas/table_summary.py) | `field_mapping_service.load_date_role_fields`, `reserving_class_service.refresh_reserving_class_values`, `table_summary_service.discard_cached_summaries`, `table_summary_service.generate_table_summary` |
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
- The cached payload carries `summary_version` and `date_roles`. `load_valid_cache` serves a cache only when it is newer than the CSV, matches the current version, **and** was built against the project's current date-role mapping. A version bump regenerates stale caches instead of returning payloads without the newer keys; the mapping check exists because remapping Origin Date to another column leaves the CSV untouched, so an mtime-only check would keep serving the previous column's year bars.
- The cache file name is **version-scoped**: `table_summary.v<SUMMARY_VERSION>.json`, built by `config.get_cache_path(project_name, summary_version)` from `TABLE_SUMMARY_CACHE_PREFIX`/`TABLE_SUMMARY_CACHE_SUFFIX`. The cache lives in the shared project folder, so every user of the project reads the same file. Under one shared name, two installed app versions rejected each other's payload and rewrote it on every load, so a fleet running a dev build beside a released one never saw a warm cache and paid a full `read_csv` of the imported table on every Source Data load. Separate names let each version keep its own cache. The version inside the payload is still checked, so a hand-renamed file cannot be served.
- `read_valid_cache` adopts a pre-versioned `table_summary.json` once: when that file is fresh and already carries the running version's payload it is renamed onto the versioned name, so upgrading costs no re-read. A legacy file belonging to a different version is left alone - it is the only cache the version that wrote it can still use.
- `POST /table_summary/refresh` re-imports the master table, which advances its modification time and makes **every** cached payload stale, so it discards all of them (`config.list_table_summary_cache_paths` + `table_summary_service.discard_cached_summaries`) rather than only the running version's file. That is also what bounds accumulation of per-version cache files. `cache_cleared` reports whether anything was removed.
- `reserving_class_service._load_table_summary_cached_meta` reads only the CSV mtime and the column names, both version-independent, so it takes the newest cache any version left behind through the same folder listing and still compares that mtime against the imported table before trusting the column list.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change refresh contract: align request schema and downstream reserve refresh behavior.
2. Add or change a per-column field: extend `generate_table_summary`, bump `SUMMARY_VERSION`, and update the Source Data consumer in `ui/project_settings/project_settings_source_data.js`. The bump changes the cache file name automatically; do not add a second place that spells the name.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Cache invalidation and side-effect refresh can impact performance.
- Distribution statistics run inside the existing single `read_csv` pass, so they add work proportional to column count on every cache miss. A numeric column costs roughly three times the plain single-histogram version: the quantile window adds a partition pass, `numpy.clip` adds a copy, and the fine histogram is `DISTRIBUTION_OVERSAMPLE` times wider. Measured at about 41 ms per 1M-row numeric column against 14 ms for a plain 16-bin histogram. The second histogram in the low-cardinality branch only runs for columns that cannot fill the full bin count.
- `SUMMARY_VERSION` bumps regenerate every cached summary, so the first open of each project after a distribution change pays one full `read_csv`. That cost is now once per version per project rather than once per load: before the file name carried the version, running an un-released build against the same ArcRho Server as a released client made every load on both machines a cache miss. Measured on an 84 MB / 346k-row / 34-column table, a miss costs about 1.7 s of local CPU plus the whole file across the network, against about 1 ms for a hit.
- Bumping `SUMMARY_VERSION` leaves the previous version's cache file in the project folder until the next refresh sweeps it. That is deliberate - it is what an older installed client still reads - and it costs one small JSON file per version.
<!-- MANUAL:END -->
