# App Server Domain: app_control

## Purpose
<!-- MANUAL:BEGIN -->
Application lifecycle control domain (restart/shutdown flags) coordinated between app-server routes and Electron host startup/shutdown flow.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.app_control.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/app/restart` | `app_restart` | - | - | - |
| `POST` | `/app/restart_electron` | `app_restart_electron` | - | - | - |
| `POST` | `/app/shutdown` | `app_shutdown` | - | - | - |
| `POST` | `/app/shutdown_electron` | `app_shutdown_electron` | - | - | - |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.app_control.key_files -->
- [`app_server/api/app_control_router.py`](../../../app_server/api/app_control_router.py) - Restart/shutdown control endpoints.
- [`app_server/config.py`](../../../app_server/config.py) - Flag-file paths for app control.
- [`app_launcher.py`](../../../app_launcher.py) - Launcher process watching control flags.
- [`electron/main.js`](../../../electron/main.js) - Electron host restart/shutdown integration.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called by shell app control actions.
- Coordinated with launcher/electron host watchers.
- Electron host startup clears stale lifecycle flags before spawning the app server on preferred local port `28765` by default; when that port is held by a listener it can neither reuse nor clear (for example another user session on the same machine), it reuses a compatible sibling-instance backend port or falls back to an automatically chosen free local port, then publishes the effective endpoint to the per-user `%APPDATA%\ArcRho\app_endpoint.json` discovery file. Each packaged backend build contains a `backend-artifact.json` manifest whose identity hashes the complete collected PyInstaller bundle, including the executable and served assets. The host reuses an existing listener only when the health response has the matching app mode and either the current per-launch token or that exact artifact identity; a same-version older or unknown backend is cleared before startup. Development keeps same-project-root reuse because it has no packaged artifact. Shutdown paths post `/app/shutdown` then wait before force-kill fallback.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses lifecycle flag files under project root: `.restart_app`, `.shutdown_app`, `.restart_electron`, `.shutdown_electron`.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add lifecycle action: define flag contract and watcher handling in launcher/host.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Incorrect flag behavior can cause app restart loops.
- Stale `.shutdown_app` plus premature process kill can cause next-launch startup timeout.
<!-- MANUAL:END -->
