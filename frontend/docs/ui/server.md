# Frontend: Server

## Purpose
<!-- MANUAL:BEGIN -->
Server tab: lists the servers this PC knows by name and Gateway address, marks the one in use, adds a server from its folder, and switches between them by restarting the app.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.server.entry_points -->
- `ui/server/server.html`: external scripts `./server.js?v=20260926a`, `/ui/shared/services/color_theme.js?v=20260923c`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/server_profiles`
- `/server_profiles/activate`
- `/server_profiles/health${healthQuery(row)}`
- `/server_profiles/inspect?root=${encodeURIComponent(folder)}`

Detected `arcrho:*` message types in key JS files:
- `arcrho:agent-guide-load-result`
- `arcrho:assistant-context-request`
- `arcrho:open-path-result`
- `arcrho:project-settings-progress-cancel`
- `arcrho:server-switch`
- `arcrho:server-switch-result`
- `arcrho:task-designer-context-response`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.server.key_files -->
- [`ui/server/server.html`](../../ui/server/server.html) - Server tab iframe entrypoint: server list, add form, components placeholder, switch dialog.
- [`ui/server/server.js`](../../ui/server/server.js) - Server tab controller: listing, health, add server, and the switch request to the shell.
- [`ui/server/server_model.js`](../../ui/server/server_model.js) - Pure rules for rows, labels, set-at-launch, add validation, and switch messages.
- [`ui/server/server.css`](../../ui/server/server.css) - Server tab styling on the shared theme tokens.
- [`ui/shell/shell_messages.js`](../../ui/shell/shell_messages.js) - Shell side of a switch: unsaved-changes guard, activation, and restart.
- [`app_server/services/server_profile_service.py`](../../app_server/services/server_profile_service.py) - Server profile listing, health probe, folder inspection, and activation.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Opened from the Home Server card or the Server Connection dialog as one restorable `server` shell tab.
- Reads `GET /server_profiles`, `GET /server_profiles/health` (the app server probes each Gateway) and `GET /server_profiles/inspect`, and adds with `POST /server_profiles`.
- Switches by posting `arcrho:server-switch` to the shell, which refuses while any tab is dirty, activates the profile, runs the ordinary restart, and answers with `arcrho:server-switch-result`.
- Uses the host `pickFolder` bridge when present; the folder text field is the fallback.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Holds no state of its own; the profile list lives in `%APPDATA%\ArcRho\workspace_paths.json`, owned by `arcrho_api.config`.
- While a launch override is set (`set_at_launch`), shows that server as `Set at launch` and turns switching and adding off.
- The Components panel is a placeholder until component status lands.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change what a row shows: update `server_model.js`, `server.js`, and `tests/server_tab.test.mjs` together.
2. Change what a switch does: update the shell handler in `shell_messages.js`, the activate route, and both test files.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- A switch restarts the app server; it must stay blocked while any tab holds unsaved changes.
- Never save profiles from a `launch-app` session; the routes refuse with 409 and the page disables the controls.
<!-- MANUAL:END -->
