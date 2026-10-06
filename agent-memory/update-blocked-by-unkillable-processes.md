---
name: update-blocked-by-unkillable-processes
description: "2026-10-06 1.8.0->2.0.0 update - setup's \"still running\" dialog listed Arco PIDs that even Task Manager could not end; they were stuck in Windows teardown (CrowdStrike host) and cleared after ~5 min"
metadata:
  node_type: memory
  type: project
  originSessionId: 827b168b-ca2a-4425-baee-3c9ae817e04a
  modified: 2026-10-06T17:26:14.478Z
---

On the Client PC (L-H2MQ6280FVP, CrowdStrike Falcon + Defender) the app-started 2.0.0 setup showed
"Arco Workspace is still running and could not be closed" with five `Arco Workspace.exe` PIDs. The app
had shut down normally (server log ends with `/app/shutdown`, setup spawned at 13:20:55), but the
processes would not die from `Stop-Process -Force` or Task Manager. The last one reported
`HasExited=True`, 0 handles, one thread, no ExecutablePath: a kernel-side teardown hang, not app code.
All were gone by ~13:25 on their own; Retry then works.

**Why:** a process that cannot be terminated from Task Manager is held in the kernel (security sensor or
driver), so no app or installer change can kill it faster; only waiting or a reboot helps.

**How to apply:** when this dialog recurs, check `Get-Process -Id <pid>` for HasExited/Handles=0 before
blaming the update path in [[installer-close-processes-and-one-click-update]]. A possible improvement is
for the close script to keep waiting (minutes, with a status line) instead of showing Retry after 18 s.
