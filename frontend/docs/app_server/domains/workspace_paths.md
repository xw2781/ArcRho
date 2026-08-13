# App Server Domain: workspace_paths

## Purpose
<!-- MANUAL:BEGIN -->
Runtime workspace path read/update domain.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.workspace_paths.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/workspace_paths` | `get_workspace_paths` | - | - | - |
| `POST` | `/workspace_paths` | `update_workspace_paths` | `WorkspacePathsUpdateRequest` | [`app_server/schemas/workspace_paths.py`](../../../app_server/schemas/workspace_paths.py) | - |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.workspace_paths.key_files -->
- [`app_server/api/workspace_paths_router.py`](../../../app_server/api/workspace_paths_router.py) - Read/update workspace path config.
- [`app_server/config.py`](../../../app_server/config.py) - Config loader and runtime path refresh.
- [`app_server/schemas/workspace_paths.py`](../../../app_server/schemas/workspace_paths.py) - Workspace path request models.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Used by shell root-path settings modal.
- Triggers `config.refresh_runtime_paths()` and clears absolute-path runtime caches on updates.
- `GET /workspace_paths` reports whether the AppData config file already exists so the shell can detect first-time setup.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Persists config in `%APPDATA%\ArcRho\workspace_paths.json`.
- ArcRho Server Components Setup can optionally set this root for the installing Windows user by calling the canonical `arcrho_api.config.set_server_root`; it does not maintain a second installer-specific workspace setting.
- Uses built-in defaults until Server Connection is saved. Only `POST /workspace_paths` creates that file, so a fresh client install runs entirely on the defaults.
- Resolution order is owned by `arcrho_api/config.py` and shared with the Python API and macros: `ARCRHO_SERVER_ROOT`/`ARCRHO_RUNTIME_SERVER_ROOT`, then the config file, then the packaged default root. `app_server/config.py` adds only the Arcode-mode AppData branch and `paths` normalization.
- `GET /workspace_paths` is also how a macro process outside the app discovers the workspace root when no config file exists.
- Clears the in-memory dataset registry after updates so stale dataset IDs do not keep writing to the previous workspace root.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add config field: update schema + router serialization + config readers.
2. Rename config fields by updating producers, consumers, and docs together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Invalid path config writes can impact all path-dependent domains.
- Adding a resolution step here without adding it to `arcrho_api/config.py` reintroduces the split where the app resolves a root but macros raise `InvalidArcRhoServerError`.
<!-- MANUAL:END -->
