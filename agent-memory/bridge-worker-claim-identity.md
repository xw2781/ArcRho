---
name: bridge-worker-claim-identity
description: "A queued ResQ import/sync is run by whichever user's per-session Bridge worker claims it first; find the claimant from the status file's Windows owner, and a \"ResQ project not found\" for a project that exists means the claimant's ResQ identity could not see it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7ff5260a-75ea-466e-a8a4-32773509aa73
  modified: 2026-08-27T03:25:43.630Z
---

Bridge workers run one per signed-in user session on the Server PC (heartbeats under
`E:\ArcRho Server\runtime\instances\arcrho_bridge_worker\` are named
`bridge_worker@NE7SASWPN02@<user>@...`). Every worker watches the same request folders and
whichever removes the request file first runs it, so which user's process handles a queued
ResQ import or sync is a race. The status JSON does not record the claimant — but its NTFS
owner does: `(Get-Acl <status.json>).Owner` names the user whose worker wrote it.

On 2026-08-26 the sync preview failed twice with `ResQ project not found: NJ_Annual_Prod_202605_Fake`
while an import of the same project succeeded minutes earlier. The failing statuses were owned
by `PRCINS\JZhang` (a worker that had started that evening), the passing ones by `PRCINS\xwei`.
Until that day both queued sessions connected to ResQ with the migration module's empty
user/password, i.e. the claiming worker's Windows identity, and ResQ shows each user only the
projects they hold. The exporter's project lookup swallows the COM error and reports "not found".

**Why:** the false error is invisible from the client and from the Bridge code alone; it only
shows up when a second user's session is running a worker.

**How to apply:** fixed on 2026-08-26 by handing the shared service account from the server
`config.json` (`resq.*`, read by `resq_client.resq_connection_settings()`) into both runners.
If the message returns, first check the status file's owner and whether that user's worker runs
a Bridge older than the fix (a running worker keeps its old exe through a deploy until its
session relaunches it). See [[bridge-restart-after-deploy]] and [[bridge-heartbeat-false-negative]].
