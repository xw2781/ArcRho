# App Server Domain: workspace_paths

## Purpose
<!-- MANUAL:BEGIN -->
Runtime workspace path read/update domain, and the server profiles: the servers this PC knows, which one is active, and each one's Gateway sign-in.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.workspace_paths.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/server/status` | `get_server_component_status` | - | - | `server_profile_service.server_component_status` |
| `GET` | `/server_profiles` | `get_server_profiles` | - | - | `server_profile_service.list_server_profiles` |
| `POST` | `/server_profiles` | `save_server_profile` | `ServerProfileSaveRequest` | [`app_server/schemas/workspace_paths.py`](../../../app_server/schemas/workspace_paths.py) | `server_profile_service.save_server_profile` |
| `POST` | `/server_profiles/activate` | `activate_server_profile` | `ServerProfileActivateRequest` | [`app_server/schemas/workspace_paths.py`](../../../app_server/schemas/workspace_paths.py) | `server_profile_service.activate_server_profile` |
| `GET` | `/server_profiles/health` | `get_server_health` | `str` | - | `server_profile_service.server_health` |
| `GET` | `/server_profiles/inspect` | `inspect_server_folder` | `str` | - | `server_profile_service.inspect_server_folder` |
| `GET` | `/workspace_paths` | `get_workspace_paths` | - | - | - |
| `POST` | `/workspace_paths` | `update_workspace_paths` | `WorkspacePathsUpdateRequest` | [`app_server/schemas/workspace_paths.py`](../../../app_server/schemas/workspace_paths.py) | `hosted_save_enrollment_service.auto_enroll_current_user` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.workspace_paths.key_files -->
- [`app_server/api/workspace_paths_router.py`](../../../app_server/api/workspace_paths_router.py) - Read/update workspace path config.
- [`app_server/config.py`](../../../app_server/config.py) - Config loader and runtime path refresh.
- [`app_server/schemas/workspace_paths.py`](../../../app_server/schemas/workspace_paths.py) - Workspace path request models.
- [`app_server/services/server_profile_service.py`](../../../app_server/services/server_profile_service.py) - Server profiles: list, add, activate, and what a switch does in this process.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Used by the shell root-path settings modal and the Server tab (`ui/server/`).
- Triggers `config.refresh_runtime_paths()` and clears absolute-path runtime caches on updates.
- After persisting a Server Connection, retries automatic Gateway enrollment for a user who has no local gateway configuration.
- `GET /workspace_paths` reports whether the AppData config file already exists so the shell can detect first-time setup.
- `GET /server_profiles` lists every saved server with its folder, credential file, the credential's user, Gateway address (read from that credential, or from the folder's Gateway registry before the first switch creates it) and whether the credential exists, marks the active one, returns under `current` the server this process actually uses, and reports under `set_at_launch` any root or credential fixed by `ARCRHO_SERVER_ROOT`/`ARCRHO_RUNTIME_SERVER_ROOT`/`ARCRHO_GATEWAY_CONFIG`, so a page can show that server read-only.
- `GET /server_profiles/health?id=<profile>` asks that server's Gateway `/api/health` from the app server with the short capability timeout and returns `ok` plus a reason; without an `id` it asks about this process's own server. The Server tab uses it for each row's dot, so the page never contacts a Gateway itself.
- `GET /server_profiles/inspect?root=<folder>` checks a folder is a server root (it holds `projects`) and returns its resolved path, its leaf name as a suggested server name, and the address its `config\arcrho_gateway.json` registry gives clients (`client_url`, else `host:port` unless the host is a wildcard). It writes nothing. The registry is read from the folder (over the share for a remote server) on purpose: it is how a client learns a Gateway's address before it holds a credential for it, the same read enrollment makes, so there is no Gateway to ask yet.
- `POST /server_profiles` adds a server (or replaces the one with the same `id`; without an `id` one is derived from the name). The folder must hold a `projects` folder.
- `POST /server_profiles/activate` makes one server active. When the active server changes, the response carries `restart_required: true` and the caller restarts the app the way File > Restart does (`restartApplication` in `ui/shell/app_lifecycle.js`). The route refreshes runtime paths, clears path caches, and enrolls against the new server's Gateway registry when that server's credential does not exist yet, but restarts nothing itself.
- Both profile writes are refused with 409 while a launch override is set, because they would change the per-machine file the production app reads.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Persists config in `%APPDATA%\ArcRho\workspace_paths.json`.
- Server profiles live in the same file (`profiles`, `active_profile`) and `workspace_root` mirrors the active one. A file with no list reads as one `default` profile, and nothing is written until a profile or Server Connection save. `arcrho_api.config` owns the shape; `app_server/services/server_profile_service.py` adds only what the app shows and does on a switch.
- Each profile's credential comes from `arcrho_api.config.profile_gateway_config_path`: `arcrho_gateway.json` for `default`, `arcrho_gateway.<id>.json` otherwise, unless the profile names a file. `app_server/config.get_gateway_config_path` and `arcrho_api.gateway` both resolve it through `arcrho_api.config.gateway_config_path`, after the `ARCRHO_GATEWAY_CONFIG` override.
- ArcRho Server Components Setup can optionally set this root for the installing Windows user by calling the canonical `arcrho_api.config.set_server_root`; it does not maintain a second installer-specific workspace setting.
- Uses built-in defaults until Server Connection is saved. Only `POST /workspace_paths` creates that file, so a fresh client install runs entirely on the defaults.
- Resolution order is owned by `arcrho_api/config.py` and shared with the Python API and macros: `ARCRHO_SERVER_ROOT`/`ARCRHO_RUNTIME_SERVER_ROOT`, then the config file, then the packaged default root. `app_server/config.py` adds only the Arcode-mode AppData branch and `paths` normalization.
- `GET /workspace_paths` is also how a macro process outside the app discovers the workspace root when no config file exists.
- Clears the in-memory dataset registry after updates so stale dataset IDs do not keep writing to the previous workspace root.
- ArcRho also attempts enrollment during app startup. It creates the active profile's credential (`%APPDATA%\ArcRho\arcrho_gateway.json` for the default profile) only after the shared Gateway configuration supplies a canonical `client_url` and the endpoint probe succeeds; existing local files are never overwritten.
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
