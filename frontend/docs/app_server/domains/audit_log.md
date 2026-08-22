# App Server Domain: audit_log

## Purpose
<!-- MANUAL:BEGIN -->
Audit log read/write domain for project actions.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.audit_log.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/audit_log` | `get_audit_log` | `str` | - | `audit_service.read_audit_log` |
| `POST` | `/audit_log` | `write_audit_log` | `AuditLogWriteRequest` | [`app_server/schemas/audit_log.py`](../../../app_server/schemas/audit_log.py) | `audit_service.append_project_audit_log` |
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
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores rolling JSON audit records with lock protection, capped at `PROJECT_AUDIT_LOG_MAX_ENTRIES` (500) from `arcrho_api.sidecar_audit_contract`, the same module that owns the dataset-sidecar cap, so there is one audit policy rather than one per file kind.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add audit event fields: update schema and writer helper together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Lock/file contention may surface under concurrent writes.
<!-- MANUAL:END -->
