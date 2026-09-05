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
| `POST` | `/data_processing_rules/save_job` | `submit_data_processing_rules_save_job` | `DataProcessingRulesSaveJobRequest` | [`app_server/schemas/data_processing_rules.py`](../../../app_server/schemas/data_processing_rules.py) | `data_processing_rules_job_service.submit_data_processing_rules_job`, `workspace_mutation_client.run_workspace_mutation` |
| `GET` | `/data_processing_rules/save_job/status` | `get_data_processing_rules_save_job_status` | `str` | - | `data_processing_rules_job_service.get_data_processing_rules_job_status`, `workspace_read_client.run_workspace_read` |
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
- `POST /data_processing_rules/save_job` accepts the same body plus a client-owned `request_id` and queues the identical save for ArcRho Engine (`python-api/src/arcrho_data_processing_rules_job_contract.py` owns the request and status shapes; `server-components/src/arcrho_engine/data_processing_rules_jobs.py` runs it). It answers `{ok, job_id, status, resumed}`; a re-submitted id resumes the job the server already has. It returns `503` when no Engine is running (the Project Settings page then saves through `POST /data_processing_rules` instead) and `423` while a source refresh, a dataset-type change, or another rules save holds the project. The submission travels as the `data_processing_rules_save_submit` hosted mutation and the poll as the `data_processing_rules_job_status` hosted read, so from a Client PC both are one Gateway exchange rather than SMB file I/O.
- `GET /data_processing_rules/save_job/status?project_name=<name>&job_id=<id>` returns the job's `status` (`queued`, `processing`, `success`, `error`), its `progress` (`{stage, completed, total, label}`, republished on a 5 s heartbeat while a stage runs), `busy` for the project-scope hold, and on success a `result` that is the direct save route's whole response plus a `refresh` block (`classes_total`, `classes_refreshed`, `datasets_regenerated`, `datasets_failed`, `methods_updated`, `failures`) describing the dataset refresh that followed the write. A refresh that fell short still ends in `success`, because the rules are committed, and carries a `message` naming the first problem. A refusal carries `message` and the `status_code` the direct route would have used (`409`, `400`, `423`), so the page reacts to a stale revision exactly as before.
- Conditions use `{field, level?, operator, value}`. Request conditions support positive `equals`/`in` and negative `not_equals`/`not_in`; row conditions additionally support blank and ordered comparisons. List operators use a non-empty JSON array in `value`, and blank operators do not require `value`.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Rules are stored in `projects/<project>/data_processing_rules.json` with format `arcrho-data-processing-rules-v1`.
- Dataset-scoped source values are derived lazily into `projects/<project>/data_processing_values.json` with cache format `arcrho-source-vocab-v2`. The cache stores each distinct, complete reserving-class key-combination list once under `combination_sets`; mapped source measures reference that list by its content-hash ID. The app server materializes the existing `arcrho-source-vocab-v1` picker response, so this storage optimization does not change the persisted rules contract or editor API shape.
- The source-vocabulary cache is reused only when both the source CSV path/mtime/size fingerprint and the ordered Field Mapping signature still match. A stale, malformed, or older-format cache is rebuilt with a bounded chunked CSV scan, a project-cache lock, and atomic replacement.
- Source-field options expose per-measure values for mapped reserving-class key fields while retaining flat values for non-key fields and legacy responses that do not carry the vocabulary contract. An authoritative empty per-measure vocabulary stays empty rather than inheriting values from another dataset. Complete combinations let the editor narrow suggestions by other `Then` conditions and distinguish a missing value from an individually valid combination that currently matches no source rows.
- `json_format`, `revision`, `updated_at`, and `updated_by` are server managed. Revision increments when rule semantics, a rule's display name, or the persisted rule-array order changes.
- Rule-array order is preserved exactly as submitted so Project Settings row reordering is reflected in `data_processing_rules.json`. Because rule masks are combined without order-dependent behavior, an order-only save does not change the processing configuration hash or invalidate generated caches. The same holds for a rename: the rule `name` is left out of the semantic hash (the engine reads it for nothing but a presence check), so a rename-only save writes the file, bumps the revision, and audits as `edited N; no processing change` without a cache walk, a cache invalidation, or a dataset refresh.
- Saves use a project-path lock, unique temporary file, and atomic replacement. Audit entries summarize added, edited, removed, enabled, disabled, and reordered rules.
- The save reports its stages through an optional progress callback (`validating`, `clearing`, `writing`, then `checking` once per sidecar it opens to count stale generated caches). The Engine job publishes those stages to its status; a direct save passes no callback. The rules file's `updated_by` and the audit entry name the user the save acts for, which under the Engine is the submitting user, not the service account.
- The Engine job holds the project-scope propagation lease for the seconds the save takes (the lease is also how several Engine instances claim one request exactly once), its queue lives under `requests/data_processing_rules/{requests,statuses}`, and it logs to `runtime/logs/data_processing_rules_jobs.log`.
- After a save that changed the rules' meaning, the Engine job refreshes the datasets the change reaches: it lists the reserving classes holding an engine-generated instance of an `affected_dataset_types` type (a `scanning` stage), narrows the project-scope lease to exactly those classes so every other class is writable again, then for each one (a `classes` stage, one tick per class and per dataset) regenerates those instances in place through the canonical dataset run and walks the class's dependents, reusing the source-table refresh job's per-class step and its class lease. An order-only, rename-only, or no-op save refreshes nothing. A class or dataset that fails is named under `result.refresh.failures` and in the status message, the job still succeeds, and the datasets left behind rebuild on their own when next opened because their stored processing hash no longer matches. The direct save (no Engine) still only counts stale caches.
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
