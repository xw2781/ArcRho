---
name: excel-automation-needs-gui-check
description: 2026-09-23 user rule - any task that drives Excel over COM must be watched with GUI screenshots; VBA compile/runtime error boxes ignore DisplayAlerts and hang the run
metadata:
  node_type: memory
  type: feedback
  originSessionId: 92b2b69f-cbc2-48cd-8de4-c71aa6162cc7
  modified: 2026-09-23T15:04:57.015Z
---

When a task drives Excel from a script (COM automation, Application.Run into an add-in, generated VBA modules), run a GUI check alongside it: take screenshots of the desktop with `tools/agent_screen_control/agent_screen_control.ps1` (see agent-instructions/gui-verification.md) while the script runs and after it ends, and look for a dialog before assuming the script is merely slow.

**Why:** on 2026-09-23 a test harness wrote a VBA module whose generated line was longer than VBA's 1,023-character line limit. Excel showed "Microsoft Visual Basic for Applications - Compile error: Syntax error" on the user's screen and the COM call blocked with no error returned. The user said Excel "frequently" gets this and asked that GUI tests become standard for similar tasks. `DisplayAlerts = False` does not suppress VBA compile errors, runtime error boxes, or `MsgBox` - it only silences Excel's own prompts ([[excel-com-must-suppress-alerts]]).

**How to apply:**
- Run the Excel script in the background with a timeout, and screenshot while it runs; a stalled step plus a VBA dialog means kill that script's own EXCEL.EXE by PID (never the user's Excel - list PIDs before starting).
- Never put large data in generated VBA source. Keep each line under 1,023 characters and fewer than 25 line continuations; put data on a worksheet and read it from there.
- "Save '<book>' with references to unsaved documents?" also ignores DisplayAlerts; it appeared on SaveAs of a workbook using a UDF add-in open in the same instance. Save and close the add-in, reopen it from disk, and set `Saved = True` on every other open workbook before a save.
- pywin32 dynamic dispatch quirks seen the same day: `rng.Resize(r, c)` silently returns the single cell `Item(r, c)` - build ranges from an address string instead; a VBA `Collection.Count` must be called (`Count()`); a Private VBA class returned through `Application.Run` fails with VBA error 98 (0x800a0062), so call the add-in's public routines that take and return strings or Excel objects. `tools/resq_workbooks_to_arco_review.py` is the worked example.
- Compile generated VBA before calling it (VBE `Debug > Compile` is not scriptable; instead call a trivial function in the new module first, under a short timeout, and screenshot).
