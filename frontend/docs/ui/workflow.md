# Frontend: Workflow

## Purpose
<!-- MANUAL:BEGIN -->
Workflow editor page and save/load orchestration.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.workflow.entry_points -->
- `ui/workflow/workflow.html`: external scripts `/ui/workflow/workflow_main.js?v=20260712a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/arcrho/projects`
- `/reserving_class_combinations?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_filter_spec`
- `/reserving_class_filter_spec?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_hidden_paths`
- `/reserving_class_hidden_paths?project_name=${encodeURIComponent(projectName)}`
- `/reserving_class_types?project_name=${encodeURIComponent(projectName)}`
- `/workflow/save`
- `/workflow/save_as`

Detected `arcrho:*` message types in key JS files:
- `arcrho:close-active-tab`
- `arcrho:close-shell-menus`
- `arcrho:dfm-save`
- `arcrho:get-dataset-settings`
- `arcrho:get-dfm-settings`
- `arcrho:hotkey`
- `arcrho:set-app-font`
- `arcrho:set-zoom`
- `arcrho:tooltip`
- `arcrho:update-workflow-tab-title`
- `arcrho:workflow-dirty`
- `arcrho:workflow-global-changed`
- `arcrho:workflow-import`
- `arcrho:workflow-saved`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.workflow.key_files -->
- [`ui/workflow/workflow.html`](../../ui/workflow/workflow.html) - Workflow page layout and containers.
- [`ui/workflow/workflow_main.js`](../../ui/workflow/workflow_main.js) - Workflow editing logic, save/load events.
- [`ui/shared/menu_utils.js`](../../ui/shared/menu_utils.js) - Context menu helper utilities.
- [`ui/shared/reserving_class_lazy_picker.js`](../../ui/shared/reserving_class_lazy_picker.js) - Shared reserving-class tree selector.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Calls `/workflow/*` app-server routes.
- Coordinates with shell and embedded dataset/DFM iframes via message bridge.
- For DFM embeds, preserves optional `outputType` in step settings and forwards it as `output_type` URL param.
- Workflow Dataset and DFM embeds receive the workflow instance id so they can bind to Global Control defaults without hardcoding the resolved project/path into new objects.
- New Workflow Dataset steps do not inject a sample dataset ID; the embed receives `ds` only when the workflow step already has a selected dataset ID.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Persists workflow tab state using per-instance storage keys.
- Uses imported/exported `.arcwf` payloads.
- The workflow sidebar title supports inline rename from the title text and the adjacent pencil icon.
- The workflow sidebar supports folders for organizing steps. Sidebar context menus can create folders, folders can nest up to three levels, and drag/drop can reorder or move steps and folders into folders.
- Enforces a single `global_control` step per workflow; duplicate instances are blocked or normalized to `picker`.
- Stores DFM step settings snapshots (including optional `outputType`) via `arcrho:get-dfm-settings` / `arcrho:dfm-settings`.
- Global Control stores built-in `<Default Project>` and `Default Path` variables, auto-saves table edits, and uses the table context menu for row add/delete actions.
- Fresh workflows initialize Global Control's `<Default Project>` from the user's local last-project preference and `Default Path` from that project's user-specific `lastReservingClassPath`.
- Project and path pickers opened from a workflow context expose `Current Workflow` shortcuts populated from Global Control rows with type `Project` / `Reserving Class`; workflow project rows show the control variable name with the resolved project in muted detail text.
- Shared project/path picker windows load the app-wide `ui/shared/scrollbars.css` styling so their scrollable tree areas match the rest of ArcRho.
- Reserving-class tree view toggle preferences (auto-expand/auto-close) are shared globally across projects, and final path rows are always selected with a single click.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Extend workflow payload: update `workflow_main.js`, app-server schema/service, and save/load compatibility.
2. Add sidebar behavior: update `workflow.html` + resize/collapse handlers.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Save/load compatibility regressions across older workflow files.
- Dirty-state propagation to shell can become inconsistent.
<!-- MANUAL:END -->
