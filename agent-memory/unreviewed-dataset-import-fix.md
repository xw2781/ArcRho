---
name: unreviewed-dataset-import-fix
description: "2026-09-01 fix making the ResQ import carry calculated and engine-generated datasets the review table never lists; its Bridge/Engine/Gateway deploy was left pending because the tree held another session's project-duplication work"
metadata: 
  node_type: memory
  type: project
  originSessionId: ae4cc7b8-46c5-4a77-af41-42471db4b218
  modified: 2026-09-01T21:06:44.782Z
---

On 2026-09-01 the "Import ResQ Reserving Class" macro was found to skip every calculated and engine-generated dataset: the transfer review hides them (both sides rebuild them), the macro sends only the ticked names, and the migration narrowed the ResQ inventory to those names. The fix lives in `python-api/migration`: `catalog._is_unreviewed_dataset` is the one rule shared by the review (`sync_session.collect_resq_inventory`), the import narrowing (`_select_export_inventory`, which now takes the reserving class to read unticked datasets' types), and the commit merge (`merge.merge_preserved_arcrho_artifacts` treats such live groups as requested).

**Why:** the review was designed for sync/export, where nothing needs reconciling for rebuilt datasets, but an import is the only way those datasets ever reach a new ArcRho class.

**How to apply:** the Bridge runs the import from its bundled migration copy, so the fix is not live until Bridge (and, per `deploy.py`, Engine and Gateway) are redeployed. The deploy was not run on 2026-09-01 because the working tree carried another session's uncommitted project-duplication work under `frontend/app_server` and `server-components/src/arcrho_engine`; verify with `deploy.py --stale` or by diffing the deployed canonical copy before assuming it is still pending. See [[deploy-staleness-is-mtime-based]], [[remote-component-deploy]], [[arcrho-dataset-types-win-over-resq]].
