# App Server Domain: data_processing_rules

## Purpose
<!-- MANUAL:BEGIN -->
Validates and persists project-specific row-filter rules used before data-engine aggregation.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.data_processing_rules.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/data_processing_rules` | `get_data_processing_rules` | `str` | - | `data_processing_rules_service.get_data_processing_rules` |
| `POST` | `/data_processing_rules` | `save_data_processing_rules` | `DataProcessingRulesSaveRequest` | [`app_server/schemas/data_processing_rules.py`](../../../app_server/schemas/data_processing_rules.py) | `data_processing_rules_service.save_data_processing_rules` |
| `POST` | `/data_processing_rules/validate` | `validate_data_processing_rules` | `DataProcessingRulesValidateRequest` | [`app_server/schemas/data_processing_rules.py`](../../../app_server/schemas/data_processing_rules.py) | `data_processing_rules_service.validate_data_processing_rules` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.data_processing_rules.key_files -->
- [`app_server/api/data_processing_rules_router.py`](../../../app_server/api/data_processing_rules_router.py) - Rule read, validate, and revision-safe save routes.
- [`app_server/services/data_processing_rules_service.py`](../../../app_server/services/data_processing_rules_service.py) - Rule validation, persistence, audit, options, and processing hashes.
- [`app_server/schemas/data_processing_rules.py`](../../../app_server/schemas/data_processing_rules.py) - Typed data-processing rule request models.
- [`app_server/config.py`](../../../app_server/config.py) - Rule filename, format, algorithm version, and project path helper.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `GET /data_processing_rules?project_name=<name>` returns the canonical rules document, its semantic hash, validation state, and picker options for source measures, source fields, reserving-class fields/types/members, and the dataset-scoped source-combination vocabulary used by the editor.
- `POST /data_processing_rules/validate` validates an unsaved `{project_name, data}` payload without writing.
- `POST /data_processing_rules` accepts `{project_name, expected_revision, data}`. It returns `409` when the editor revision is stale, `423` for write-lock contention, and `400` with rule validation details when references or action semantics are invalid.
- Conditions use `{field, level?, operator, value}`. Request conditions support positive `equals`/`in` and negative `not_equals`/`not_in`; row conditions additionally support blank and ordered comparisons. List operators use a non-empty JSON array in `value`, and blank operators do not require `value`.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Rules are stored in `projects/<project>/data_processing_rules.json` with format `arcrho-data-processing-rules-v1`.
- Dataset-scoped source values are derived lazily into `projects/<project>/data_processing_values.json` with cache format `arcrho-source-vocab-v2`. The cache stores each distinct, complete reserving-class key-combination list once under `combination_sets`; mapped source measures reference that list by its content-hash ID. The app server materializes the existing `arcrho-source-vocab-v1` picker response, so this storage optimization does not change the persisted rules contract or editor API shape.
- The source-vocabulary cache is reused only when both the source CSV path/mtime/size fingerprint and the ordered Field Mapping signature still match. A stale, malformed, or older-format cache is rebuilt with a bounded chunked CSV scan, a project-cache lock, and atomic replacement.
- Source-field options expose per-measure values for mapped reserving-class key fields while retaining flat values for non-key fields and legacy responses that do not carry the vocabulary contract. An authoritative empty per-measure vocabulary stays empty rather than inheriting values from another dataset. Complete combinations let the editor narrow suggestions by other `Then` conditions and distinguish a missing value from an individually valid combination that currently matches no source rows.
- `json_format`, `revision`, `updated_at`, and `updated_by` are server managed. Revision increments when rule semantics or the persisted rule-array order changes.
- Rule-array order is preserved exactly as submitted so Project Settings row reordering is reflected in `data_processing_rules.json`. Because rule masks are combined without order-dependent behavior, an order-only save does not change the processing configuration hash or invalidate generated caches.
- Saves use a project-path lock, unique temporary file, and atomic replacement. Audit entries summarize added, edited, removed, enabled, disabled, and reordered rules.
- A semantic rules save removes project-owned CSV artifacts under `datasets/.temporary-view` before committing the new revision, so retained generated previews cannot be reused under a changed rule set; durable input/import caches outside that hidden folder are preserved.
- Validation resolves source columns from Field Mapping's table path, atomic source measures from Dataset mappings, request scopes from mapped Reserving Class levels/types, and action members from refreshed reserving-class values. Dataset-scoped value and no-combination findings are warnings, not save blockers, because a later source refresh may introduce new combinations.
- `keep_members` action members are validated against the requested reserving-class type's full membership tree - its own name, every intermediate composite label from the `Formula` column, and the atomic `Source` leaves - not just the atomic leaves. This matches the data-engine's row-matching membership, so a rule may keep an aggregate label (for example `IBNRCAT = "PD+UMPD"`) when a measure is stored at that composite granularity instead of atomic members. Members outside that membership are still rejected as base-excluded.
- The processing configuration hash covers the processing algorithm version, Field Mapping, Dataset Types, Reserving Class Types/Sources, General Settings, semantic rules, and source-table path/mtime/size. Audit-only metadata is excluded. Generated sidecars store provenance per CSV filename so refreshing one period/mode variant cannot validate stale sibling variants.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Extend rule operators by updating the typed schema, service validation, data-engine evaluator, UI editor, and this contract together.
2. Change processing-hash inputs only as a coordinated app-server/data-engine cache-contract update.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- A stale or absent processing hash must never make an engine-generated cache appear current.
- Missing source metadata can make stored rule references stale; GET returns their validation errors so Project Settings can surface and repair them.
- A source CSV that changes while its vocabulary is being scanned must not produce a mixed cache snapshot; generation retries once and then fails explicitly.
<!-- MANUAL:END -->
