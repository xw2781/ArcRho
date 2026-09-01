---
name: pointer-capture-drag-fix
description: "Fast-drag \"loses control\" bug in floating-window drag/resize handlers, and the pointer-capture fix; confirmed working and now codified as L16 in the arcrho-ui-design codex skill"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40c07696-7631-49cf-8916-238929067f49
  modified: 2026-08-23T19:33:33.689Z
---

Use Pointer Events with `element.setPointerCapture(e.pointerId)` for any custom drag or resize handle, not `mousedown`/`mousemove`/`mouseup` listeners attached to `document`. Attach `pointermove`/`pointerup`/`pointercancel` directly on the handle element after capturing.

**Why:** the mousemove-on-document pattern loses the drag when the user moves the pointer fast — confirmed by the user as a real, frequently-observed bug (2026-08-23), and the pointer-capture rewrite of the reserving-class-picker resize handles ([reserving_class_picker.js](frontend/ui/shared/components/pickers/reserving_class_picker.js)) was confirmed by the user as a good fix. It was not written down anywhere at first (checked `AGENT_GUIDELINES.md`, `docs/general_prompts.md`, `frontend/docs/ui/*.md`, the contract docs), so it is now codified as rule L16 in [.claude/skills/arcrho-ui-design/references/layout-and-shell.md](.claude/skills/arcrho-ui-design/references/layout-and-shell.md) ("Pointer capture for drag and resize handles"), at the user's request (2026-08-23) — that skill folder, not `frontend/docs`, is where this project's durable UI design/implementation rules live.

The automation message box and progress window (`enableDialogDrag` in [frontend/ui/shell/ui_automation.js](frontend/ui/shell/ui_automation.js)) were the same bug in a window-listener disguise and were rewritten to pointer capture on 2026-09-01; L16 was strengthened the same day into a hard rule with five bullets (capture on the handle, never track on document or window, match the pointerId, one shared stop path, applies to every movable surface).

**How to apply:** the mousemove-on-document pattern is still used throughout the codebase's other floating-window drag/resize helpers (e.g. `makeFloatingWindowDraggable` in reserving_class_picker.js, `frontend/ui/shell/tab_strip.js`, `frontend/ui/shell/floating_tabs.js`, `frontend/ui/macro/macro_window.js`, and likely more) — treat these as carrying the same latent bug. When touching any of them, or when asked to fix "losing the drag"/"pointer control" issues, apply the same pointer-capture rewrite rather than treating it as a one-off. If asked to add or update durable ArcRho UI guidance, edit the `.claude/skills/arcrho-ui-design/references/*.md` files (L=layout-and-shell, C=controls-and-states, T=tables-and-scrollbars, V=visual-foundations), not a frontend/docs file.
