---
name: vba-declarations-above-first-procedure
description: "a Public Const or Dim placed after the first procedure of a VBA module is a compile error VBA reports as 'Variable not defined' at the first use; the verify script now compiles the whole project, and the build's macro probe alone never caught it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 58b217f2-6805-45c3-8fcc-004735ce376c
  modified: 2026-09-21T20:42:47.202Z
---

On 2026-09-21 the first build of the post-rename Excel add-in source (4.0.1) raised "Compile error: Variable not defined" on every Arco formula. Cause: `SETTINGS_SHEET_NAME` and `LEGACY_SETTINGS_SHEET_NAME` were declared at Core.bas line 246, next to `SettingsSheet`, below other procedures. VBA's declarations section ends at the first procedure (`CodeModule.CountOfDeclarationLines` said 36), so the real error is "Only comments may appear after End Sub, End Function, or End Property" and users see "Variable not defined" where the constant is used.

**Why:** VBA with Compile On Demand compiles procedure by procedure, so `verify_built_addin.py`'s macro probe (which only read `ARCRHO_VERSION`) passed. The 4.0.0 rename commit of 2026-09-18 was never built or released: the live add-in was 3.0.1 until 4.0.1 went out, so the error had never been seen.

**How to apply:**
- Keep every module-level `Const`, `Dim`, `Declare`, `Type`, `Enum` above the first `Sub`/`Function`/`Property` in `.bas`, `.cls`, `.frm` files.
- `verify_built_addin.py` now runs the VBE's Compile command (control id 578) over the whole project with a watcher that reads and closes the compile-error dialog, and asserts the command greyed out afterwards. Run it on the built beta before every release; a FAIL names module and line.
- A hidden probe Excel that hits a VBA compile error shows a modal dialog on the user's screen and the script hangs; the watcher pattern in that script is the way to run such probes.

Related: [[excel-addin-build-needs-server-clone]], [[excel-com-must-suppress-alerts]].
