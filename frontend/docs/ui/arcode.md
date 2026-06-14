# Frontend: Arcode

## Purpose
<!-- MANUAL:BEGIN -->
Standalone ArcRho scripting app for opening notebooks and code files in a dedicated tabbed workspace.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.arcode.entry_points -->
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.arcode.key_files -->
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Loads as `/ui/arcode/` in Electron app mode `ARCRHO_APP_MODE=arcode` or in a secondary Arcode window launched from ArcRho.
- Uses the same custom app-frame structure as ArcRho, including `win10-borders` and `win11-frame` body classes from the Electron Windows-version bridge.
- Matches the ArcRho titlebar mark, native window control styling, and ArcBot panel controls while keeping Arcode-specific tab and file navigation in its own shell.
- Uses the same ArcRho backend service and scripting APIs as the original scripting console. Arcode and ArcRho can run as independent frontend apps against one compatible backend; later frontends reuse an already-running backend instead of replacing it.
- Hosts each open file as an isolated `ui/scripting_console/scripting_console.html` iframe with a tab-scoped scripting instance id.
- Sends scripting commands to the active iframe using existing `arcrho:scripting-*` messages.
- Receives `arcrho:update-active-tab-title`, `arcrho:scripting-dirty`, and `arcrho:status` messages from scripting iframes to keep tab titles, dirty indicators, close prompts, and the status bar current.
- Reuses `ui/shell/ai_assistant.js` by registering a minimal shell-compatible state object whose active tab points to the active Arcode scripting iframe.
- ArcRho shell scripting launch actions prefer the desktop `openArcodeWindow` bridge and fall back to the legacy in-shell scripting tab when that bridge is unavailable.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Stores Arcode recent files in browser local storage under `arcode_recent_files_v1`.
- Leaves notebook persistence, execution, autosave, disk conflict checks, and shortcut preferences inside the reused scripting console modules.
- Uses Electron host dialogs for opening and saving files, parented to the requesting Arcode window.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change Arcode shell/tab behavior: update `ui/arcode/arcode_shell.js` and this doc together.
2. Change notebook/editor behavior: update the scripting console modules and `scripting_console.md`.
3. Change Electron launch behavior: update `electron/main.js`, `electron/preload.js`, package scripts, and architecture notes together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Arcode intentionally shares the scripting console iframe implementation, so scripting message contracts must stay coordinated with both ArcRho shell and Arcode shell consumers.
- ArcBot is reused through a compatibility shell state adapter; deeper assistant refactors should preserve active-context requests for both ArcRho tabs and Arcode tabs.
- Standalone Arcode can start the shared backend like ArcRho. If another ArcRho/Arcode frontend client is still running, the backend owner leaves the shared backend alive on close.
<!-- MANUAL:END -->
