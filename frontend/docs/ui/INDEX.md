# Frontend Index

## Purpose
<!-- MANUAL:BEGIN -->
Frontend module map for page entrypoints, shell orchestration, and feature-specific scripts.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.index.entry_points -->
| HTML Entrypoint | External Scripts | Inline Imports |
| --- | --- | --- |
| `ui/index.html` | 1 external script | - |
| `ui/dataset/dataset_viewer.html` | - | 2 inline imports |
| `ui/dfm/dfm.html` | - | 2 inline imports |
| `ui/workflow/workflow.html` | 1 external script | - |
| `ui/project_settings/project_settings.html` | 1 external script | - |
| `ui/project_instance/project_instance.html` | 1 external script | - |
| `ui/scripting_console/scripting_console.html` | 9 external scripts | - |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.index.key_files -->
- [`docs/ui/shell.md`](shell.md) - Shell tab host index.
- [`docs/ui/dataset.md`](dataset.md) - Dataset feature index.
- [`docs/ui/dfm.md`](dfm.md) - DFM feature index.
- [`docs/ui/workflow.md`](workflow.md) - Workflow feature index.
- [`docs/ui/project_settings.md`](project_settings.md) - Project settings feature index.
- [`docs/ui/scripting_console.md`](scripting_console.md) - Scripting console feature index.
<!-- AUTO-GEN:END -->

## Non-Negotiable Contracts
<!-- MANUAL:BEGIN -->
Mandatory before frontend behavior changes:
1. [`../contracts/frontend_behavior_contract.md`](../contracts/frontend_behavior_contract.md)
2. [`../contracts/business_logic_contract.md`](../contracts/business_logic_contract.md)
3. [`../architecture/architecture_guardrails.md`](../architecture/architecture_guardrails.md)

High-risk files that must follow contracts:
- `ui/shell/ui_shell.js`
- `ui/workflow/workflow_main.js`
- `ui/dataset/dataset_main.js`
- `ui/dfm/dfm.html` and `ui/dfm/dfm_*.js`
- `ui/project_settings/project_settings.js`
- `ui/scripting_console/scripting_console*.js` and `ui/scripting_console/scripting_console.html`
- `ui/arcode/arcode_shell.js` and `ui/arcode/index.html`
<!-- MANUAL:END -->

## Design References
<!-- MANUAL:BEGIN -->
- [`design.md`](design.md) - Atlas-based global UI design reference for future ArcRho interface work.
- [`global_app_ui_demo.html`](global_app_ui_demo.html) - Standalone UI style demo with Workbench, Atlas, and Assistant Studio concepts.
<!-- MANUAL:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- App-server HTTP interface via `fetch(...)` calls.
- Cross-iframe messaging via `window.postMessage` (`arcrho:*` message types).
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Shell/tab state persisted in browser storage (`localStorage`, IndexedDB handles DB).
- Per-page state lives in each iframe module.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Shell tab lifecycle change -> [`shell.md`](shell.md).
2. Dataset behavior change -> [`dataset.md`](dataset.md).
3. DFM behavior change -> [`dfm.md`](dfm.md).
4. Workflow editor change -> [`workflow.md`](workflow.md).
5. Project settings flow change -> [`project_settings.md`](project_settings.md).
6. Scripting console change -> [`scripting_console.md`](scripting_console.md).
7. Arcode standalone scripting app change -> [`arcode.md`](arcode.md).
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Shell/iframe messaging changes can break hotkeys and dirty-state sync.
- Endpoint path changes in JS can silently break page-level features.
- Arcode shares scripting-console iframes with ArcRho, so scripting message changes must account for both hosts.
<!-- MANUAL:END -->
