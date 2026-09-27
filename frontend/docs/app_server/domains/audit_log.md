# App Server Domain: audit_log

## Purpose
<!-- MANUAL:BEGIN -->
Audit log read/write domain for project actions.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.audit_log.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/audit_log` | `get_audit_log` | `str` | - | `audit_service.read_audit_log`, `workspace_read_client.run_workspace_read` |
| `POST` | `/audit_log` | `write_audit_log` | `AuditLogWriteRequest` | [`app_server/schemas/audit_log.py`](../../../app_server/schemas/audit_log.py) | `audit_service.submit_project_audit_log_append` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.audit_log.key_files -->
- [`app_server/api/audit_log_router.py`](../../../app_server/api/audit_log_router.py) - Audit read/write routes.
- [`app_server/services/audit_service.py`](../../../app_server/services/audit_service.py) - Audit persistence helpers and locking.
- [`app_server/schemas/audit_log.py`](../../../app_server/schemas/audit_log.py) - Audit write payload schema.
- [`app_server/config.py`](../../../app_server/config.py) - Audit file constants and lock objects.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called from settings/type update flows.
- Service enforces safe append logic.
- Transport: a Client PC never opens `audit_log.json` over the share. `GET /audit_log` is the hosted read `project_audit_log` and every client append (the `POST /audit_log` route and every `safe_append_project_audit_log` caller that runs in the client app server) is the hosted mutation `project_audit_log_append`, both with `gateway_required=True`: without the Gateway the route answers `503` and `safe_append_project_audit_log` drops the entry, as it always has for a failed write. A server process (`ARCRHO_RUNTIME_SERVER_ROOT` set: the Engine's rules and dataset-type change jobs, a source refresh job's SQL Server import) appends on its own disk with no Gateway hop.
- Client callers routed through the Gateway: the Project Settings audit table and its `POST`, reserving-class types save, the presentation-only dataset-types save, source import profile save, SQL Server import, the source CSV path rewrite, project folder create and rename, General Settings save, generated CSV cache clear, field mapping save, and the direct rules save.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores rolling JSON audit records with lock protection, capped at `PROJECT_AUDIT_LOG_MAX_ENTRIES` (500) from `arcrho_api.sidecar_audit_contract`, the same module that owns the dataset-sidecar cap, so there is one audit policy rather than one per file kind.
- Idempotent append: the mutation transport needs a repeat to change nothing, so the client names every append with a fresh `entry_id`, stored on the record, and an id already among the current entries is answered from the log instead of written again. Records written without an id (every entry before 2026-09-27 and every server-process append) read unchanged and keep no id.
- The lock is per process. Hosted, every PC's append passes the Gateway's one lock; an Engine job's append runs in the Engine's process under its own lock.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add audit event fields: update schema and writer helper together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Lock/file contention may surface under concurrent writes.
<!-- MANUAL:END -->
