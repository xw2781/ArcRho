---
name: excel-com-must-suppress-alerts
description: "Driving Excel over COM from an agent must set DisplayAlerts/EnableEvents False and clear whole ranges, or a modal alert hangs the run and spams the user's screen"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7342efc7-e3cd-4383-a27b-236956f7a830
  modified: 2026-09-13T00:48:16.641Z
---

When an agent drives Excel over COM on the Client PC (the technique in [[electron-ui-screenshot-check]] has no equivalent guard), the automated instance is invisible but its modal alerts are **not**: they appear on the user's desktop and block the COM call forever. On 2026-09-12 a plan step's check workbook wrote into a cell belonging to an array formula, Excel raised "You can't change part of an array." repeatedly, and the step 6 subagent sat silent until the whole workflow had to be stopped and the orphaned `EXCEL.EXE` killed.

**Why:** an invisible `Excel.Application` still honours `DisplayAlerts`, and a blocked COM call gives the agent no error to recover from, so the run hangs rather than fails. The user sees the dialog and has no idea which process owns it.

**How to apply:** on every COM-driven Excel instance set `DisplayAlerts = False` and `EnableEvents = False` immediately after creating it, and `ScreenUpdating = False`. Never overwrite individual cells that may sit inside an existing array formula — clear the whole used range (`Cells.Clear`) or the whole array range first. Wrap the work so the instance is always `Quit` and released, even on failure, and give the script its own timeout. Check `Get-Process EXCEL` for a leftover instance before starting and after finishing.
