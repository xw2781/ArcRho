# Frontend: Ai Assistant

## Purpose
<!-- MANUAL:BEGIN -->
Shared ArcBot widget package used by both the ArcRho shell and Arcode shell.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.ai_assistant.entry_points -->
_No entrypoints configured._
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.ai_assistant.key_files -->
- [`ui/ai-assistant/index.js`](../../ui/ai-assistant/index.js) - Shared ArcBot widget behavior and host-configurable message/storage contracts.
- [`ui/ai-assistant/template.js`](../../ui/ai-assistant/template.js) - Idempotent assistant launcher and panel DOM creation.
- [`ui/ai-assistant/assistant.css`](../../ui/ai-assistant/assistant.css) - Shared assistant launcher, panel, composer, message, history, and activity styling.
- [`ui/ai-assistant/skills.js`](../../ui/ai-assistant/skills.js) - ArcBot skill contracts, SQL formatting client, and structured SQL review schema.
- [`ui/ai-assistant/run-gate.js`](../../ui/ai-assistant/run-gate.js) - Single-owner gate preventing overlapping chat and skill runs.
- [`ui/ai-assistant/arcrho.js`](../../ui/ai-assistant/arcrho.js) - ArcRho host adapter for arcrho messages, storage keys, and DFM edit approval.
- [`ui/ai-assistant/arcode.js`](../../ui/ai-assistant/arcode.js) - Arcode host adapter for arcode notebook context messages and storage keys.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Hosts configure the widget through `ui/ai-assistant/arcrho.js` or `ui/ai-assistant/arcode.js`.
- Uses Electron preload `codexAssistant*` APIs without changing IPC names.
- Exchanges assistant context/update messages with active iframes using host-specific namespaces.
- Right-clicking the ArcBot launcher opens a compact launcher menu with a Hide action; the View menu remains the restore path when the launcher is hidden.
- The settings popover's Current Chat login row shows the local user name, the Codex login email when available, and the current auth status/provider.
- ArcBot chat responses render SQL-looking inline code snippets and fenced `sql`, `mssql`, and `tsql` code blocks with the same lightweight SQL token colors used by the SQL review diff.
- Shows a slash-triggered Skills menu in the composer. The SQL Format Validation skill reads active Arcode SQL editor context or selected SQL lines, resolves T-SQL versus Snowflake explicitly, requests the same parser-backed formatting preview used by the editor toolbar, and opens the deterministic diff immediately while optional AI review continues in ArcBot. Formatting is applicable only after parse/token/protected-text/idempotence safety checks pass; unsafe or stale previews leave the editor unchanged. Optional Codex review uses a strict structured-output schema, groups material findings into syntax/formatting and performance/optimization sections, and omits duplicate SQL from App Context. A host-namespaced `assistant-replace-text` message is sent only after the user accepts the draggable and resizable syntax-highlighted diff. Activating the ArcBot chat panel raises it above the SQL review window.
- Warm Codex turns stream assistant text into the active chat bubble as deltas arrive, then replace that plain streaming view with the normal rich-text rendering when the final response completes. SQL structured-review turns suppress raw JSON delta rendering.
- ArcRho supplies host-specific App Context tooltip rows for project-instance DFM windows, including project, path, method name, and DFM tab when available.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses host-specific storage prefixes so ArcRho keeps `arcrho_ai_assistant_*` keys and Arcode keeps `arcode_ai_assistant_*` keys.
- Persists chat/session data through the existing Electron assistant host APIs.
- Persists launcher visibility per host prefix in the local ArcBot UI settings JSON, with localStorage kept as a browser fallback.
- Creates the assistant DOM once per host page at runtime.
- Keeps SQL skill diff/review state in memory only; applying the proposed SQL relies on the active editor's normal dirty/save behavior.
- SQL formatting itself is owned by the app-server SQL formatting domain; the shared widget contains only its API client, dialect/context mapping, structured AI-review contract, and preview/apply orchestration.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change shared assistant UI or behavior: update `ui/ai-assistant/index.js`, `template.js`, `assistant.css`, and this doc together.
2. Change host-specific message/storage behavior: update the matching adapter and all producers/consumers for that namespace.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- The widget is shared by two app shells, so hardcoded app names, storage keys, or message namespaces can regress one host.
- ArcRho DFM edit approval must stay disabled in Arcode and enabled only through the ArcRho adapter.
- ArcRho-only project instance labels should remain in the ArcRho adapter rather than the shared widget fallback.
<!-- MANUAL:END -->
