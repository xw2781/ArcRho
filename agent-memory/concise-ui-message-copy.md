---
name: concise-ui-message-copy
description: "Message boxes, prompts, and status lines get short copy - say only what the buttons and the list below do not already say"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1d7ba9e8-897b-4d7e-ac24-9b2d6353014f
  modified: 2026-09-19T00:07:02.878Z
---

2026-09-18: the user cut two ArcRho dialogs down and asked that every message box
of this kind stay short from now on. Rules the edits followed:

- **Two short lines at most** in the body. The Refresh-links preview went from a
  four-sentence paragraph to "Accept to load the new workbook values and save.
  Dependents are recalculated by the save."
- **Never restate the buttons.** The DSV "Linked Excel File Updated" prompt lost
  "Keep the stored values, or refresh from Excel" because `Refresh from Excel`
  and `Keep Current Values` are the two buttons right below it.
- **Never restate the list.** Per-item counts and provenance (how many cells
  changed, which workbook each object reads) were dropped from the link rows;
  the names alone are the content, and the detail lives in the table or the
  status line.
- **Keep the one fact the user cannot see**, such as "Refreshed values stay
  unsaved until you select Save."
- **Lists stay hyperlinks** - `showPageMessageBox({ links })` with an
  `onLinkClick` that opens each object - so a notice is also a way to walk
  through what changed.

**Why:** these boxes interrupt work, and a slab of prose is skipped rather than
read. **How to apply:** when writing or editing any ArcRho dialog, prompt, or
status message, cut every clause the buttons, the linked list, or the table
already carry, then stop. See [[arcrho-dev-ui-cache-restart]] for the `?v=` bump
a copy edit still needs.
