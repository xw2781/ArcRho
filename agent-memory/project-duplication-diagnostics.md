---
name: project-duplication-diagnostics
description: "How to debug an ArcRho project-duplication failure — the shared status message is redacted by contract, so read the status JSONs and the engine-local log"
metadata: 
  node_type: memory
  type: project
  originSessionId: b0ec034e-0a3d-47bf-a13b-25fdc7f5fd6e
  modified: 2026-09-27T21:20:28.046Z
---

Project-duplication failures surface to the UI as "The ArcRho Server filesystem
could not complete project duplication." That string is deliberate: any
`OSError`/`shutil.Error` is redacted in `_safe_status_error`
(`server-components/src/arcrho_engine/project_duplication.py`) so shared status JSON
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

Two known causes seen 2026-09-27 (source NJ_Annual_Prod_2026 Q3-Aug):
- "source project changed during duplication": the app rewrote
  `users/<user>/preferences.json` inside the source project mid-copy; the
  before/after manifest covers `users/`.
- Redacted "filesystem could not complete": a *progress* status write lost its
  `os.replace` retries (~1.1 s) to the app polling the status file every 750 ms,
  and any progress-write failure aborts the whole copy.

**How to apply:** read the status JSON history *before* theorizing. Client PCs
reach the server over a mapped network drive (`\\NE7SASWPN02\E`), so every
duplication byte crosses SMB and transient sharing violations / session drops
are normal — that is why the copy retries. See [[arcrho-server-client-topology]].
