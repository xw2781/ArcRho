---
name: propagation-status-smb-cache-lag
description: "A queued propagation job makes the client poll its status over SMB, where Windows' default 10s file/directory cache hides a terminal status already written - diagnosed 2026-08-16, fixed by deciding inline execution in enqueue_save_propagation"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4594cfec-63da-4dd1-a02e-09af167778f5
  modified: 2026-08-17T01:04:32.346Z
---

Symptom (2026-08-16): a Berquist Sherman SR save took ~19 s on a Client PC while the CRA
save took ~4 s. The Engine-side work was never the cause.

**Measured truth**, once `runtime/logs/dependent_propagation.log` existed:

```
00:49:10.688 claimed after 0.49s queued
00:49:11.004 stage dfm took 0.27s -> result_selection
00:49:11.534 error after 0.84s held      <- terminal status on disk
00:49:25.569 client finally reacts       <- 14 s later
```

The whole job was **1.33 s**. The lag was entirely client-side *after* the terminal status
was written.

**Cause:** `_save_dataset_sidecar_impl` called `enqueue_save_propagation`, which — unlike
`enqueue_marked_save_propagation` — never consulted the `inline_engine_propagation`
ContextVar. So even inside an Engine-hosted save holding the reserving-class lease, the walk
became a queued job, and the client polled `/dependent_propagation/.../status/<id>` every
750 ms. That poll reads the status JSON off the mapped drive, and this machine's
`LanmanWorkstation\Parameters` cache lifetimes are all unset = Windows defaults
(FileInfoCacheLifetime 10 s, DirectoryCacheLifetime 10 s, FileNotFoundCacheLifetime 5 s), so
the redirector kept serving the stale copy. `helpers._bust_network_lookup_cache` exists for
exactly this problem but the status read never used it.

**Fix:** the inline decision moved into `enqueue_save_propagation` (one decision point for
every save path); `enqueue_marked_save_propagation` now checks the flag only to skip marking
the inline walk would redo. B&S saves then carry `status: "completed"` and never poll.

**Wrong turns worth not repeating:** the queue-claim path (`acquire_reserving_class_lease`
returns None with no wait, re-driven by the Engine's 5 s rescan) looks like it should
quantize delays into 5 s steps — it does not explain observed lag, and the CRA-vs-SR split
disproved it. Diagnose with the propagation log first, then client `client_read_latency.jsonl`
timestamps, then file mtimes under the reserving class — not from the code's shape.

Related: [[dfm-save-propagation-profile]], [[engine-calculation-gateway-transport]],
[[pi-path-load-smb-cost]].
