# App Server Domain: User Identity

## Purpose
<!-- MANUAL:BEGIN -->
Resolve the current Windows login to the display name used by the ArcRho Home brand and by every user-facing metadata field ArcRho writes, including dataset and method sidecar `user`/`modified_by` values and audit-log records.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/app/user-identity` | Return the current `login_name` and resolved `display_name`. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/user_identity_router.py` - Thin identity API route.
- `app_server/services/user_identity_service.py` - Windows-login and username-index resolution, and the session cache in front of it.
- `app_server/config.py` - Canonical workspace-root and username-index path resolution.
- `app_server/services/dataset_service.py`, `calculated_dataset_service.py`, `result_selection_service.py`, `dfm_service.py`, `bornhuetter_ferguson_service.py`, `cape_cod_service.py`, `bootstrap_service.py`, `arcrho_runtime_service.py`, `audit_service.py` - Writers that stamp the resolved display name onto persisted metadata.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- The mapping is read from `<workspace_root>/config/username_index.json`.
- `login_name` matching is case-insensitive.
- A matching row uses its non-empty `full_name`; a missing, invalid, or unmapped entry falls back to the unchanged Windows login name.
- The parsed mapping and the current account's resolved display name are cached for the life of the app-server process, keyed by index path, because every dataset save now resolves a name and the index is workspace-global configuration that rarely changes. A mapping edit takes effect for a running session only after the app server restarts.
- Resolution happens where a value is written, not where it is read. Sidecars store the display name, and the reserving-class `index.json`, the Project Instance table, and the audit tabs pass that stored text through unchanged.
- Machine-facing identity stays on the raw login: engine and bridge request `UserName` fields, dependent-propagation requests, and the per-user preference folder name are not remapped, since a display name is many-to-one and cannot key an account.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- The login comes from the backend process account. If the app server runs under a service account, that account is resolved instead of the interactive desktop user.
- Sidecars written before this resolution keep whatever text they already hold, so a reserving class can show a mix of full names and login names until each row is saved again.
<!-- MANUAL:END -->
