# Frontend: Shell

## Purpose
<!-- MANUAL:BEGIN -->
Shell-level tab/iframe host for all feature pages.
It owns the main desktop frame, home view, docked/floating tab layout, scoped menus, hotkeys, shell preferences, iframe message routing, and Electron host bridge coordination.
The shell keeps one active top-level tab across docked and floating tabs while preserving iframe sessions as tabs move between layouts.
The desktop shell also hosts ArcBot, a bottom-right floating Codex CLI assistant panel.
The floating window minimize control docks that window back to the end of the main tab strip without activating the docked tab; focus remains on the prior docked tab unless another floating window is still present, in which case the top layered floating window becomes active.
Detailed menu, floating-window, lifecycle, and bridge behavior belongs in focused sections or source-specific docs, not this overview.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.shell.entry_points -->
- `ui/index.html`: external scripts `/ui/shell/ui_shell.js?v=20260608a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/`
- `/app/restart`
- `/app/restart_electron`
- `/app/shutdown`
- `/workflow/default_dir`
- `/workflow/load`
- `/workspace_paths`

Detected `arcrho:*` message types in key JS files:
- `arcrho:agent-guide-load-result`
- `arcrho:autosave-toggle`
- `arcrho:browsing-history-updated`
- `arcrho:close-active-tab`
- `arcrho:dfm-tab-activated`
- `arcrho:dfm-tab-closing`
- `arcrho:force-rebuild-toggle`
- `arcrho:hotkey`
- `arcrho:open-path-result`
- `arcrho:project-instance-restore-state`
- `arcrho:scripting-open-path`
- `arcrho:scripting-rename-notebook`
- `arcrho:server-connection-updated`
- `arcrho:set-app-font`
- `arcrho:set-zoom`
- `arcrho:tab-activated`
- `arcrho:workflow-load`
- `arcrho:zoom`
- `arcrho:zoom-reset`
- `arcrho:zoom-step`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.shell.key_files -->
- [`ui/index.html`](../../ui/index.html) - Main desktop shell page and menu structure.
- [`ui/shell/ui_shell.js`](../../ui/shell/ui_shell.js) - Shell bootstrap and controller composition.
- [`ui/shell/shell_state.js`](../../ui/shell/shell_state.js) - Shell tab state persistence and invariants.
- [`ui/shell/tab_actions.js`](../../ui/shell/tab_actions.js) - Tab open/close/activate/float/dock actions.
- [`ui/shell/tab_strip.js`](../../ui/shell/tab_strip.js) - Docked tab strip rendering, reordering, plus menu, and tab context menu.
- [`ui/shell/shell_content.js`](../../ui/shell/shell_content.js) - Home, iframe host, and floating content layout orchestration.
- [`ui/shell/iframe_host.js`](../../ui/shell/iframe_host.js) - Iframe creation, URL construction, and iframe event bridge.
- [`ui/shell/floating_tabs.js`](../../ui/shell/floating_tabs.js) - In-shell floating tab window movement, resize, chrome, and layering.
- [`ui/shell/shell_menus.js`](../../ui/shell/shell_menus.js) - Shell menubar state, command dispatch, and scoped menu visibility.
- [`ui/shell/shell_hotkeys.js`](../../ui/shell/shell_hotkeys.js) - Global shell hotkey routing.
- [`ui/shell/shell_messages.js`](../../ui/shell/shell_messages.js) - Cross-frame shell message handling.
- [`ui/shell/shell_preferences.js`](../../ui/shell/shell_preferences.js) - Zoom, autosave, app font, force rebuild, and tooltip preferences.
- [`ui/shell/root_path_settings.js`](../../ui/shell/root_path_settings.js) - Server Connection root path settings modal.
- [`ui/shell/workflow_host_actions.js`](../../ui/shell/workflow_host_actions.js) - Workflow import and shell-side workflow helpers.
- [`ui/shell/app_lifecycle.js`](../../ui/shell/app_lifecycle.js) - Refresh, restart, shutdown, and app confirmation flows.
- [`ui/shell/titlebar_controls.js`](../../ui/shell/titlebar_controls.js) - Electron titlebar minimize, maximize, close, and drag-restore controls.
- [`ui/shell/status_bar.js`](../../ui/shell/status_bar.js) - Status bar text, clock, and timestamp helpers.
- [`ui/shell/shell_context.js`](../../ui/shell/shell_context.js) - Shared shell dependency registry.
- [`electron/preload.js`](../../electron/preload.js) - Renderer-safe host bridge APIs.
- [`electron/main.js`](../../electron/main.js) - Window lifecycle and shell-to-host wiring.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Communicates with child iframes via `arcrho:*` postMessage events.
- Invokes app-server endpoints for workflow import helpers and configuration endpoints.
- Uses Electron host bridge and explicit shell commands for shutdown/clear-cache actions; ordinary document unloads and reloads do not send app shutdown.
- The desktop host consumes F5 and Ctrl+F5 as no-op shortcuts so accidental refreshes do not reload the app; Ctrl+R remains the explicit shell refresh shortcut.
- The desktop shell status bar shows a decorative resize glyph only; it does not expose custom drag-to-resize behavior, so window resizing is left to the native Electron window frame while in-shell floating tab windows keep their own resize controls.
- Clear Cache & Reload reloads the shell with a fresh timestamped UI URL after clearing Electron cache/storage, and Project Settings iframes include the shell UI version query parameter so reloads fetch the current Project Settings HTML/module graph consistently.
- App-server startup is host-managed on fixed local port `28765` by default, with retry on transient launch failures; Electron verifies a per-launch `/app/health` token so it does not attach to a stale backend process that happens to be listening on the same port, clears mismatched listeners before starting its backend, writes packaged app-server stdout/stderr logs under the Electron user-data `logs` folder, and writes Electron main-process startup logs plus a visible startup-failure dialog for diagnostics.
- After the desktop shell is visible, the Electron host checks `E:\ArcRho Server\releases\installers` for a newer ArcRho installer without blocking startup. The About dialog also exposes a Check for Updates button that runs the same host check and reports when ArcRho is already current, when the update location is unavailable, or when a newer installer exists but is missing the required SHA-256 checksum. Update checks time out quickly, require a SHA-256 checksum before launching an installer, ask the user whether to update, and reuse the normal shutdown confirmation before starting the installer and quitting ArcRho.
- The home sidebar brand reads the Windows username from the Electron host bridge when available, then renders the username and a low-contrast circular SVG initial mark; plain browser sessions keep the default ArcRho brand.
- Uses Electron host bridge for Server Connection folder browsing and first-time `ArcRho Server` drive detection.
- ArcBot-specific Electron IPC handlers, request/client state, Codex/Claude command integration, prompt assembly, edit-apply helpers, and lifecycle cleanup live in `electron/arcbot_host.js`; `electron/main.js` registers that host module while keeping app startup, windows, menus, backend control, updates, and general shell bridge handlers separate.
- Uses Electron host bridge for desktop-only ArcBot Codex CLI status, install, login, persisted chat sessions, streamed activity/output events, file revision checks, per-request timing logs under `Documents\ArcRho\ArcBot\request_logs`, and warm `codex app-server` turns with fallback to one-shot `codex exec` requests; warm ArcBot requests grant default read access to the configured Server Connection root plus user-added readable folders from the ArcBot settings Folder Permissions page while keeping write access scoped to the ArcBot working folder and validated apply flow. Timing logs are JSON files that include elapsed and delta timings for request setup, active context, attachments, prompt building, context estimate, warm Codex execution, fallback CLI execution, edited JSON reading, apply flow, and the live activity events shown in the chat. For Edit Mode, the host writes the active page JSON-backed object into the shared local `Documents\ArcRho\ArcBot\workspace` exchange folder using the canonical DFM method shape grouped by GUI tab when the active tab is DFM, or the current notebook payload when the active tab is Scripting. ArcBot edits only that temporary copy, then the host validates the target path, backs up the original JSON-backed file under a `history` folder or the active page snapshot when direct read is denied, applies the edited temp copy, and can revert the latest ArcBot edit from that backup. Active scripting notebooks supplied by page context may be edited even when they live outside the configured Server Connection root.
- ArcBot reads its behavior prompt from the configured Server Connection root at `config\arcbot\arcbot_prompt.md` and appends Markdown files from `config\arcbot\instructions` so teams can share first-level and topic-specific instructions without rebuilding the app; when the new server prompt is missing, the Electron host seeds it from the legacy `config\arcbot_prompt.md` file when present or the bundled default prompt otherwise, and creates placeholder instruction files for data labels, DFM workflow, reserving practice, project workflow, scripting console, and Excel add-in guidance. The ArcBot settings menu includes a Prompt Guide action that opens an `agent_guide` main shell tab with a brief workflow overview, page switches for the entry prompt and each instruction file, rendered Markdown previews, and raw Markdown sections.
- ArcBot's DFM prompt prefers the bundled `python -m arcrho_api.agent ... inspect` helper for read/planning work, avoids repeated summary/component reads in the same turn, and runs the DFM `validate` helper only after an edit helper or direct temp JSON edit.
- Before applying an ArcBot temp-copy edit, the Electron host requires valid JSON and can strip accidental explanatory text around a single JSON object before the normal validation/backup/apply flow.
- Shell pages import the shared 20px `ui/shared/scrollbars.css` WebKit scrollbar treatment so ArcBot chat/debug/context scroll areas use the same scrollbar visual style as Dataset/DFM, with the ArcBot panel overriding the shared scrollbar size to a narrower 16px width.
- The `agent_guide` main tab renders ArcBot prompt documentation inside an iframe and requests live prompt components through the shell using `arcrho:agent-guide-load` / `arcrho:agent-guide-load-result`, because feature iframes do not rely on direct Electron preload access.
- ArcBot chat uses a pro-grey minimalist panel with flat controls, a small grey non-persisted AI disclaimer at the top of each chat, low-contrast circular user-initial avatars and ArcBot Mini assistant avatars in the conversation, an Online/Offline stamp and refresh control beside the ArcBot title, right-side icon-only New Chat and History actions where New Chat reuses an existing empty non-archived session instead of creating duplicate blank chats, a flat icon-only chat history panel with clipped long session titles where clicking the session title/meta area opens the chat and icon buttons are reserved for archive/restore/delete, a header settings popover that stores the current session model and reasoning effort, opens the Folder Permissions page, opens the Prompt Guide page, and shows token usage, readable-folder count, status, Windows login name, and Codex login status, a rounded composer frame with file-type preview attachment cards, a plus menu with an Attach files and more action for adding common text-like files as one-request context, centered App Context and Edit Automatically / Read Only mode controls, a bottom App Context toggle with a styled tooltip that previews the active tab/file on hover when enabled and prevents ArcBot from receiving active app contents when disabled, a ring-only context-window meter beside the attach button with a matching styled token-count hover tooltip plus a context panel with estimated usage and percent used, a right-aligned send button that switches to a cancel action while a request is running, conversation history that renders only user and assistant messages without a separate centered system hint, an animated `Thinking ...` assistant bubble with a blue-purple running edge light and soft glow, safe rich-text rendering for assistant replies with bullets, bold emphasis, inline code, code blocks, and a bounded typing reveal for successful final responses, live bullet-list work updates with typing animation that use ArcBot as the user-facing actor and explain ArcRho Python helper activity in natural language while raw helper-call details stay in the debug drawer, a collapsed work archive that shows `Worked for Xm Ys` or `Stopped after Xm Ys` once the request completes or terminates and expands without clipping its detail body, a resizable chat panel, auto-growing frameless composer input, and a title-bar debug drawer with copyable raw stdout/stderr and host event logs.
- The View menu includes a global Show/Hide AI Bot Icon action that controls the ArcBot launcher without affecting the assistant chat history; the launcher uses the ArcBot Mini PNG mark clipped by the circular launcher frame, can be freely dragged within the app window, smoothly snaps to either fully visible or exactly halfway tucked offscreen at window edges, rotates the same image when tucked, preserves tucked edge/corner attachment plus the icon-center offset from the nearest corner during window resize, hides while the ArcBot chat panel is open, and fades back in when the panel closes.
- The Help menu includes `View Dev Panel`, available globally through Ctrl+Shift+I in the desktop host.
- When a DFM tab is active, the Help menu includes `Open DFM JSON`; the desktop host opens the active DFM method JSON in VS Code when available and falls back to the OS default file opener.
- When a DFM Ratios tab has undoable or redoable ratio-state changes, the Edit menu enables `Undo Ratio Change` / `Redo Ratio Change` and dispatches them to the active DFM iframe; the same actions are available through Ctrl+Z and Ctrl+Y while the Ratios tab is focused.
- When a Project Instance tab has an active floating DFM window, the shell treats that nested DFM as the active DFM command target: DFM-scoped Edit/Help items are visible, ratio hotkeys and `Open DFM JSON` route through Project Instance to the nested DFM iframe, and shell macros request/apply DFM context through the same message contract used by standalone DFM tabs.
- The menubar includes `Macro` after Settings. Clicking it opens a shell-owned floating macro panel owned by `ui/macro/macro_window.js`, with the same in-app titlebar drag behavior used by the ArcBot panel plus resize handles on every edge and corner; it lists `.py` files from the user scripting directory plus non-runnable demo examples, shows macro descriptions in the list and detail pane with a draggable splitter between those panes, reports run/edit results through the app status bar, and can run real selected macros against the active DFM tab/window or open them in a new Scripting Console tab for code viewing/editing. The seeded Apply Growth Adjustments macro marks each pre-adjustment selected average cell with a DFM summary-table cell note before writing the adjusted user ratio.
- Saving Server Connection updates `/workspace_paths` without restarting the app, then broadcasts `arcrho:server-connection-updated` to open feature iframes so page-local path caches can refresh.
- Consumes dataset-page browsing updates (`arcrho:dataset-settings-changed`, `arcrho:browsing-history-updated`) and forwards updates to any open Browsing History tab.
- Receives `arcrho:open-dataset-from-history` from Browsing History tab to open dataset tabs with selected inputs.
- Records the latest active restore-capable pages in the Browsing History tab's Restore Pages section and receives `arcrho:open-shell-activity-history-entry` from that tab to reopen Dataset, DFM, Workflow, Project Explorer, Project Instance, Scripting, and Agent Guide pages. Project Instance restore entries include the selected reserving-class path plus nested floating Dataset/DFM window state when available.
- Handles `arcrho:open-dfm` messages by opening a DFM tab with optional initial project, reserving-class path, method name, output type, input triangle values, and starting DFM subtab.
- Receives `arcrho:open-project-instance` from Project Settings to open or focus a top-level `project_instance` tab for the selected project.
- Handles `arcrho:open-path` requests from feature iframes through the Electron host bridge, including optional read-only Excel workbook opening via the host-side `openPath({ readOnly: true })` payload.
- Shell zoom is owned by `shell_preferences.js`; feature iframe pages use the shared `ui/shared/zoom_bridge.js` relay so Ctrl+wheel, Ctrl+plus/minus, and zoom slider changes apply consistently across Dataset, DFM, Workflow, Project Settings, Project Instance, Browsing History, Agent Guide, and Scripting Console tabs, including nested Dataset iframes where the parent page rebroadcasts zoom messages.
- The docked tab and floating titlebar context menus include scripting-only actions for `Rename Notebook`, `Open File Location`, and `Copy File Path`; scripting title updates include the tab instance id and current file path so background scripting tabs update their own tab title/path rather than the active tab. Holding the pointer still over a saved scripting tab or floating scripting titlebar for two seconds shows the full file path in the shell styled tooltip; moving the pointer hides or cancels it.
- In the desktop app, dragging files from File Explorer over the shell or an open feature iframe shows a shell-owned drop overlay. Dropping `.ipynb` or `.arcnb` files opens each notebook in a fresh Scripting Console tab, then forwards the disk path to that tab with `arcrho:scripting-open-path`.
- When Scripting Console is active, File > Recent ... shows up to five recent `.ipynb` files from user AppData in a second-level menu and opens the selected notebook in a fresh scripting tab.
- Before closing the active top-level tab for `Ctrl+W`/close-tab shortcuts, the shell lets the active iframe consume the shortcut through `window.__arcrho_consume_close_shortcut`; project instance tabs use this to close their top floating dataset window first.
- OS-level detached tab pop-out windows are not supported; floating tabs stay inside the main shell and reuse the same iframe/message contracts as docked tabs.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Persists tab state, docked/floating layout, floating window position/size/z-order, zoom, and toggles in `localStorage`.
- Persists project instance tab identity using the selected project name plus project folder/table-path metadata.
- Persists dataset browsing history entries (latest 15) via `browsing_history.js`.
- Persists the latest 10 active restore-capable page entries under `shellActivityHistory.entries` in `%APPDATA%\ArcRho\local_project_prefs.json`, so Restore Pages survives Clear Cache & Reload. Project Instance entries also persist selected path, nested floating Dataset/DFM window names, hidden/active/maximized/dirty flags, DFM subtab, and restore rectangles.
- Persists the ArcBot launcher icon visibility and position in `localStorage`.
- Persists ArcBot chat sessions as local JSON under Electron user data, including messages, activity, mode, archived state, latest active-tab context summary, and estimated context usage; ArcBot writes shared exchange JSON/CSV copies under the user `Documents\ArcRho\ArcBot\workspace` folder while keeping per-request edit metadata under `Documents\ArcRho\ArcBot\sessions`, and latest ArcBot edit metadata is stored under Electron user data so a later `revert latest` request can restore the backed-up method JSON when the file has not changed again.
- ArcBot panel resizing clamps saved and live widths to a 420px minimum that keeps the composer controls visible without clipping, and each app session's first ArcBot panel open starts at that minimum width while preserving the saved height. Resizing the main app window repositions the open ArcBot panel back into view without changing the panel's current width or height.
- The ArcBot model selector groups OpenAI models (Codex default, GPT-5.5, GPT-5.4, GPT-5.4 Mini) and Anthropic Claude models (Claude Opus 4.8, Claude Sonnet 4.6, Claude Haiku 4.5); all models share the same session context, messages, attachments, and active-tab context flow. The reasoning/thinking effort selector is hidden for models that do not support it (GPT-5.4 Mini and Claude Haiku 4.5); for Claude models the selector label reads "Thinking" instead of "Reasoning". Both `model` and `reasoningEffort` are persisted with each session and forwarded to the host via `codexAssistantSend`. Switching provider (OpenAI ↔ Anthropic) re-triggers the status check automatically.
- Claude requests in the Electron host are authenticated using the OAuth access token in `~/.claude/.credentials.json` written by the Claude CLI (`claude login`); no separate API key is required. The `codex-assistant-status` IPC now returns `claudeAuthenticated` alongside the existing Codex fields, and `codex-assistant-login` accepts an optional `{ provider: "anthropic" }` payload to open `claude login` instead of `codex login`. Claude messages are sent to the Anthropic Messages API (`/v1/messages`) over HTTPS with SSE streaming; edit sessions are skipped for Claude models (responses are conversational only).
- Dirty-state messages from workflow, DFM, and scripting tabs update the shared tab dirty indicator for both docked tabs and floating tab titlebars.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add a new tab type: update `tab_actions.js`, `iframe_host.js`, relevant menu/hotkey dispatch modules, and any state persistence in `shell_state.js`.
2. Add shell menu action: wire menu item + action handler in `shell_menus.js` and hotkey mapping in `shell_hotkeys.js`; for `Edit`/`View` items, always set `data-page-scopes` (`*` for global visibility) because those dropdowns require explicit scope declarations.
3. Change tab layout behavior: update `tab_strip.js`, `floating_tabs.js`, `shell_content.js`, active-tab dispatch in `tab_actions.js`, localStorage migration in `shell_state.js`, and close/dirty-state flows together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- DOM replacement in shell can invalidate iframe references.
- Unsaved-state handling must stay consistent for close/close-all flows.
- Floating/docking must reposition existing iframes without recreating or reparenting them, or feature pages can lose in-memory state.
- Active-tab styling and menu dispatch must stay single-source through `state.activeId` so docked background content does not behave as active while a floating window is focused.
- Host/app-server startup races can surface as blank shell or startup timeout if lifecycle flags/process teardown are not coordinated.
- Offline, slow, or inaccessible update feed folders must not block startup; failures should remain a skipped update check.
<!-- MANUAL:END -->
