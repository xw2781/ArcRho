---
name: project-duplication-diagnostics
description: "How to debug an ArcRho project-duplication failure — the shared status message is redacted by contract, so read the status JSONs and the engine-local log"
metadata: 
  node_type: memory
  type: project
  originSessionId: b0ec034e-0a3d-47bf-a13b-25fdc7f5fd6e
  modified: 2026-08-10T02:10:02.740Z
---

Project-duplication failures surface to the UI as "The ArcRho Server filesystem
could not complete project duplication." That string is deliberate: any
`OSError`/`shutil.Error` is redacted in `_safe_status_error`
(`data-engine/src/arcrho_engine/project_duplication.py`) so shared status JSON
stays location-independent. The Engine exe is built `--noconsole` with no
logging, so `print()` diagnostics are lost on deployed machines.

Where to look instead:
- `E:\ArcRho Server\requests\project_duplication\status\psdup_*.json` — one file
  per attempt, with `progress.completed`/`total` and the redacted message. The
  history across attempts is the diagnosis: a *fixed* stop point means a
  structural bug, a *varying* stop point means transient I/O.
- `E:\ArcRho Server\runtime\logs\project_duplication.log` — added 2026-08-09;
  unredacted errno + traceback, plus one line per copy retry.

**Why:** without the varying-vs-fixed stop point signal I chased a plausible but
wrong MAX_PATH theory for two rounds.

**How to apply:** read the status JSON history *before* theorizing. Client PCs
reach the server over a mapped network drive (`\\NE7SASWPN02\E`), so every
duplication byte crosses SMB and transient sharing violations / session drops
are normal — that is why the copy retries. See [[arcrho-server-client-topology]].
