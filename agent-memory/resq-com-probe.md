---
name: resq-com-probe
description: ResQ COM is reachable only on the Dev PC; the Client PC L-H2MQ6280FVP has no ResQ install, so in-process COM macros fail there
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a5616ae-9d5a-4766-a011-883e2b0109cc
  modified: 2026-08-17T00:00:00.000Z
---

ResQ (Willis Towers Watson) is installed **only on the Dev PC**, where its COM API is directly reachable for read-only debugging: `win32com.client.Dispatch("ResQ3Automation.ResQApplication")` then `ConnectByName("JGO_CO1SQLWPV22", "", "")` (connection name from `server-components/src/arcrho_bridge/resq_client.py`). The Client PC **L-H2MQ6280FVP has no ResQ install at all** — verified 2026-08-17: no `ResQ3Automation.*` ProgID in HKLM\SOFTWARE\Classes, its WOW6432Node view, or HKCU\SOFTWARE\Classes; no vendor key, uninstall entry, install folder, or MsiInstaller event. Any in-process COM there fails with `(-2147221005, 'Invalid class string')` while `Excel.Application` dispatches fine.

**Why:** Lets an agent verify what ResQ actually returns (e.g. `dfm.CellNotes` vs method-level `dfm.Notes`) instead of guessing from bridge code — and explains why ResQ *imports* still work from the Client PC (the Bridge worker on the ResQ machine services them through the share queue) while the sync/export macros, which Dispatch in the local macro process, cannot.

**How to apply:** Run probe scripts on the Dev PC with `server-components/venvs/arcrho_bridge/Scripts/python.exe` (has pywin32; plain `python` does not). Use `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` — ResQ notes contain characters like U+25E6 that crash cp1252 console printing. Keep probes read-only; never call `Save()`. Related: [[bridge-restart-after-deploy]], [[dev-pc-and-client-pc-identity]].
