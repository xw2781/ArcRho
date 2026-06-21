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
- [`ui/ai-assistant/arcrho.js`](../../ui/ai-assistant/arcrho.js) - ArcRho host adapter for arcrho messages, storage keys, and DFM edit approval.
- [`ui/ai-assistant/arcode.js`](../../ui/ai-assistant/arcode.js) - Arcode host adapter for arcode notebook context messages and storage keys.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Hosts configure the widget through `ui/ai-assistant/arcrho.js` or `ui/ai-assistant/arcode.js`.
- Uses Electron preload `codexAssistant*` APIs without changing IPC names.
- Exchanges assistant context/update messages with active iframes using host-specific namespaces.
- Shows a slash-triggered Skills menu in the composer. The SQL Format Validation skill reads active Arcode SQL editor context or selected SQL lines, prepares deterministic MSSQL formatting, optionally runs an AI review as a normal ArcBot chat turn with a visible user prompt and progress animation, groups AI findings into syntax/formatting and performance/optimization sections, asks AI findings to start with original SQL line numbers, includes a single clickable SQL coding standards reference in the review response, and sends a host-namespaced `assistant-replace-text` message only after the user accepts the draggable and resizable syntax-highlighted unified review diff. Activating the ArcBot chat panel raises it above the SQL review window.
- ArcRho supplies host-specific App Context tooltip rows for project-instance DFM windows, including project, path, method name, and DFM tab when available.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses host-specific storage prefixes so ArcRho keeps `arcrho_ai_assistant_*` keys and Arcode keeps `arcode_ai_assistant_*` keys.
- Persists chat/session data through the existing Electron assistant host APIs.
- Creates the assistant DOM once per host page at runtime.
- Keeps SQL skill diff/review state in memory only; applying the proposed SQL relies on the active editor's normal dirty/autosave behavior.
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
