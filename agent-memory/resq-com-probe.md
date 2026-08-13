---
name: resq-com-probe
description: ResQ is installed on this machine; read-only COM probes work via the arcrho_bridge venv for debugging sync issues
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a5616ae-9d5a-4766-a011-883e2b0109cc
  modified: 2026-08-04T02:29:28.960Z
---

ResQ (Willis Towers Watson) is installed on this dev machine and its COM API is directly reachable for read-only debugging: `win32com.client.Dispatch("ResQ3Automation.ResQApplication")` then `ConnectByName("JGO_CO1SQLWPV22", "", "")` (connection name from `data-engine/src/arcrho_bridge/resq_client.py`).

**Why:** Lets an agent verify what ResQ actually returns (e.g. `dfm.CellNotes` vs method-level `dfm.Notes`) instead of guessing from bridge code.

**How to apply:** Run probe scripts with `data-engine/venvs/arcrho_bridge/Scripts/python.exe` (has pywin32; plain `python` does not). Use `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` — ResQ notes contain characters like U+25E6 that crash cp1252 console printing. Keep probes read-only; never call `Save()`. Related: [[bridge-restart-after-deploy]].
