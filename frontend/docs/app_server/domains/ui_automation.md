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
| `POST` | `/ui_automation/commands/drain` | `drain_ui_automation_commands` | `Request` | - | `ui_automation_service.drain_pending` |
| `POST` | `/ui_automation/commands/poll` | `poll_ui_automation_command` | `UiAutomationPollRequest` | [`app_server/schemas/ui_automation.py`](../../../app_server/schemas/ui_automation.py) | `ui_automation_service.poll_command` |
| `POST` | `/ui_automation/commands/{command_id}/cancel` | `cancel_ui_automation_command` | `Request` | - | `ui_automation_service.cancel_command` |
| `POST` | `/ui_automation/commands/{command_id}/complete` | `complete_ui_automation_command` | `UiAutomationCommandResult` | [`app_server/schemas/ui_automation.py`](../../../app_server/schemas/ui_automation.py) | `ui_automation_service.complete_command` |
| `GET` | `/ui_automation/queue` | `get_ui_automation_queue` | `Request` | - | `ui_automation_service.queue_status` |
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
- Supported commands include `ui.messageBox`, `ui.progressOpen`, `ui.progressUpdate`, `ui.progressClose`, the asynchronous `ui.reviewTableOpen`/`ui.reviewTableStatus`/`ui.reviewTableClose` review flow, `macro.captureActiveDfmContext`, `macro.reviewAndApplyResult`, `taskDesigner.*`, `projectInstance.context`, `projectInstance.openDataset`, `projectInstance.refreshDatasets`, and Project Instance window actions. `projectInstance.openDataset` can open DFM and Result Selection method windows when the caller supplies `openMethod` plus the method type.
- An ArcRho macro run started from Arcode uses two short macro commands: capture returns the live unsaved DFM JSON plus a one-use target token, then review/apply verifies the exact shell tab/Project Instance window and its context fingerprint before applying the source result. Python executes between the commands so macros remain free to issue nested message-box, progress, Task Designer, and other UI automation calls without blocking the shell poll loop.
- `ui.messageBox` accepts optional `autoCloseMs`/`auto_close_ms` arguments for informational dialogs that should close themselves after a short delay.
- `ui.progressOpen`/`ui.progressUpdate`/`ui.progressClose` drive a shell-owned floating progress dialog with a close icon, resize handle, visible progress bar, and one-decimal percent text for long-running Python macros.
- `ui.reviewTableOpen` returns a `dialogId` immediately, so the automation queue remains available while a user searches, selects, and reviews typed rows. `ui.reviewTableStatus` returns `pending` until review finishes, then returns `{ accepted, selectedRowIds, optionStates }`; `ui.reviewTableClose` cancels an unfinished review and removes its transient state. Row IDs must be stable and unique, and disabled rows are never returned as selected actions.
- `ui.reviewTableOpen` accepts an optional `options` list of footer checkboxes (`{ key, label, checked, hint }`, keys unique). Their final on/off states come back as `optionStates`, keyed by option key, with every completion — accepted or cancelled — so one review window can carry a whole-batch choice such as merge-versus-overwrite beside the row selection. Both the shell modal and the Project Instance nested-window hosts render and return them identically.
- `ui.reviewTableOpen` accepts an optional `selectable` flag. `selectable: false` renders the same grid as a read-only report: no tick column or select-all, row clicks and the space bar tick nothing, the selection counter is blank, and the footer carries one button (`acceptLabel`, defaulting to `Close`) instead of Accept/Cancel. Sorting, filtering, search, and column handling are unchanged. The completion arrives through the same `ui.reviewTableStatus` protocol with an empty `selectedRowIds`, so a macro that shows results this way still polls until the user closes the window and then calls `ui.reviewTableClose`. The Sync Reserving Class with ResQ and Export Reserving Class to ResQ macros use it for their results tables, through `arcrho_api.ui.await_review_table`, which opens the table, polls it, and always closes it.
- `ui.reviewTableOpen` accepts an optional `host` argument. `host: "projectInstance"` asks the shell to host the review inside the active Project Instance page as a normal nested pi-window (minimizable to the toolbar, non-modal, closable like any dataset window); the shell pins follow-up status/close commands to the owning tab even after the user switches shell tabs. Without `host`, or when no Project Instance tab is active at open time, the review opens as the shell modal dialog. Closing the nested window (X, minimized-tab close, or closing the hosting tab) resolves the review as a cancelled completion rather than an error.
- Project Instance window actions with an explicit `windowId`/`windowKey` fail with "Project Instance window was not found." when the target is gone. The implicit active-window properties query (`projectInstance.activeWindow` with no target) instead succeeds with an empty `windowId` when no nested window is open or focused, which the Python API surfaces as `active_window() -> None`.
- `projectInstance.context` returns the active Project Instance `projectName` and selected reserving-class `selectedPath`, and fails clearly when no path is selected.
- `projectInstance.refreshDatasets` asks the active Project Instance page to reload its selected reserving-class dataset table from disk and returns `{ refreshed, projectName, selectedPath }`.
- Requests are restricted to local clients; the bridge is for the running desktop/local app session and does not use the shared ArcRho Server `requests` folder.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Commands live only in app-server memory while they are pending.
- Review-table rows and completion state live only in memory for the returned `dialogId` — in the shell for modal reviews, or in the hosting Project Instance page for `host: "projectInstance"` reviews; callers close the review after consuming its completed status.
- Captured external-macro targets live only in shell memory, expire after five minutes, and are consumed once by review/apply; no active-context file is written. Each review also carries a shorter backend deadline, and the shell closes/rejects an expired preview before any payload can be applied.
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
- Synchronous modal commands such as `ui.messageBox` block the Python caller until the shell completes or the timeout expires. The review-table commands deliberately use open/status/close polling so human review does not hold the command queue.
- Do not wrap arbitrary macro execution inside one shell automation command: nested UI calls would wait on the same sequential poll loop. Keep capture and review/apply short, with Python execution between them.
<!-- MANUAL:END -->
