---
name: bridge-heartbeat-false-negative
description: "\"ArcRho Bridge became unavailable\" from the ResQ import macros can be a false negative — check the statuses folder on E: first, the Bridge often finished the request anyway"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6045f2ca-3fdd-4cbf-ab0a-483dde67893a
  modified: 2026-08-24T23:42:42.156Z
---

On 2026-08-24 the batch macro "Import ResQ Reserving Classes" reported class 2 of 17 as
"ArcRho Bridge became unavailable while the import was waiting for a result" and skipped the
other 15, yet `E:\ArcRho Server\requests\RPC bridge\resq_reserving_class_import\statuses\<id>.json`
showed `status: success` 20 s later and the class data was written to the project. The Bridge
worker heartbeat (created 15:11) was still alive hours afterwards.

**Why:** the macros (`python-api/macros/import_resq_reserving_class.py`, `sync_reserving_class_with_resq.py`)
decide the Bridge is dead from a single observation: heartbeat mtime must be within ±6 s of the
client clock, read over SMB from the Client PC once per poll, and any miss aborts the whole batch.
Idle probes from the Client PC show 0-3 s ages and 0 misses, so the miss only shows up under import
load; see [[smb-stat-metadata-alternation]] for stale stat metadata on E:. The macro's message also
claims "existing reserving-class data was left unchanged", which was false.

**How to apply:** when this message appears, compare the statuses folder and the project data
folder mtimes before assuming the Bridge failed; a fix should require several consecutive misses
(or use the `processing` status file the Bridge touches every second) before giving up, and must
not claim the data was untouched. Related: [[bridge-restart-after-deploy]].

**Fix landed 2026-08-24:** the rule now lives in `arcrho_api/bridge_liveness.py` (shared by both import
macros, the sync macro, and the hosted read `bridge_worker_liveness` in
`frontend/app_server/services/bridge_liveness_service.py`). A live heartbeat or a status file touched
within 6 s is life; only 30 s of consecutive silent looks (`BRIDGE_SILENCE_LIMIT_SEC`) abandon a wait,
and the message then says the outcome is unknown. Macros 1.4.0 / 1.3.0 / 1.2.1 are published to the
shared library; the hosted look only becomes exact once the Gateway is redeployed (until then the
transport log shows `kind_not_advertised` and the look runs over SMB with the same tolerant rule).
