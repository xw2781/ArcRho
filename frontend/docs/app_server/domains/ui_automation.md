# App Server Domain: ui_automation

## Purpose
<!-- MANUAL:BEGIN -->
Local UI automation command bridge for Python macros and scripts that need to ask the running ArcRho shell to perform typed UI operations.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.ui_automation.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/ui_automation/commands` | `submit_ui_automation_command` | `UiAutomationCommandRequest` | [`app_server/schemas/ui_automation.py`](../../../app_server/schemas/ui_automation.py) | `ui_automation_service.submit_command` |
| `POST` | `/ui_automation/commands/poll` | `poll_ui_automation_command` | `UiAutomationPollRequest` | [`app_server/schemas/ui_automation.py`](../../../app_server/schemas/ui_automation.py) | `ui_automation_service.poll_command` |
| `POST` | `/ui_automation/commands/{command_id}/complete` | `complete_ui_automation_command` | `UiAutomationCommandResult` | [`app_server/schemas/ui_automation.py`](../../../app_server/schemas/ui_automation.py) | `ui_automation_service.complete_command` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.ui_automation.key_files -->
- [`app_server/api/ui_automation_router.py`](../../../app_server/api/ui_automation_router.py) - Local UI automation command endpoints.
- [`app_server/services/ui_automation_service.py`](../../../app_server/services/ui_automation_service.py) - In-memory command queue and completion handling.
- [`app_server/schemas/ui_automation.py`](../../../app_server/schemas/ui_automation.py) - UI automation command request and result schemas.
- [`ui/shell/ui_automation.js`](../../../ui/shell/ui_automation.js) - Shell-side command polling and execution.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `POST /ui_automation/commands` submits a typed command from local Python code and waits for the frontend shell result.
- `POST /ui_automation/commands/poll` is consumed by the active shell to receive pending commands.
- `POST /ui_automation/commands/{command_id}/complete` lets the shell return `{ ok, result, error }` for the waiting Python caller.
- Supported commands include `ui.messageBox`, `ui.progressOpen`, `ui.progressUpdate`, `ui.progressClose`, `taskDesigner.*`, `projectInstance.context`, `projectInstance.openDataset`, `projectInstance.refreshDatasets`, and Project Instance window actions. `projectInstance.openDataset` can open DFM and Result Selection method windows when the caller supplies `openMethod` plus the method type.
- `ui.messageBox` accepts optional `autoCloseMs`/`auto_close_ms` arguments for informational dialogs that should close themselves after a short delay.
- `ui.progressOpen`/`ui.progressUpdate`/`ui.progressClose` drive a shell-owned floating progress dialog with a close icon, resize handle, visible progress bar, and one-decimal percent text for long-running Python macros.
- `projectInstance.context` returns the active Project Instance `projectName` and selected reserving-class `selectedPath`, and fails clearly when no path is selected.
- `projectInstance.refreshDatasets` asks the active Project Instance page to reload its selected reserving-class dataset table from disk and returns `{ refreshed, projectName, selectedPath }`.
- Requests are restricted to local clients; the bridge is for the running desktop/local app session and does not use the shared ArcRho Server `requests` folder.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Commands live only in app-server memory while they are pending.
- Command submitters wait up to the requested timeout, capped by the service.
- No project files or workspace caches are written by this domain.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add a UI automation command by extending the shell executor in `ui/shell/ui_automation.js`.
2. If the command targets a feature iframe, add an explicit `arcrho:*` message handler in that page and return a structured result to the shell.
3. Add a convenience wrapper in `python-api/src/arcrho_api/ui.py` for macro authors.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Commands act on active UI state, so automation should return clear errors when the expected active page is not available.
- Long-running or modal commands block the Python caller until the shell completes or the timeout expires.
<!-- MANUAL:END -->
