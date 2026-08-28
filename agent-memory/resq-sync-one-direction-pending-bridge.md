---
name: resq-sync-one-direction-pending-bridge
description: "Sync Reserving Class with ResQ 1.4.0 (one-way, RC-level direction, contract v2) was published 2026-08-27 but the Bridge was not redeployed because the tree held other uncommitted work"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6846974d-4479-496e-a790-47b8bef33f83
  modified: 2026-08-28T01:31:39.403Z
---

On 2026-08-27 the Sync Reserving Class with ResQ macro went to 1.4.0 (published to the shared library and Documents\ArcRho\macros): the whole reserving class is pushed one way, chosen from each side's latest timestamp, rows whose own timestamps disagree are marked Review but stay ticked, and the sync Bridge contract went to version 2. The Bridge (which bundles resq_migration/sync.py and sync_session.py) was left un-deployed because a working-tree deploy would also have shipped the tree's other uncommitted edits (resq_data_migration.py, engine.py, extractors.py, resq_import_runner.py from the resq-import-user-name work).

**Why:** AGENT_GUIDELINES says to stop and ask rather than deploy someone else's half-finished edits; the contract bump means the new macro and an old Bridge refuse each other with an "Unsupported ContractVersion" error instead of silently applying the old per-row directions.

**How to apply:** if a user reports "Unsupported ContractVersion" from the sync macro, the Bridge is still the old build; run `python server-components/deploy.py bridge` (after confirming the payload list is theirs) and the error goes away. Once the Bridge is deployed, delete this memory. See [[remote-component-deploy]] and [[shared-macro-library-deploy]].
