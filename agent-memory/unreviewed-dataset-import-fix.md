---
name: unreviewed-dataset-import-fix
description: "2026-09-01 fixes to the ResQ import - it now carries calculated and engine-generated datasets the review table never lists, and compares every Engine-built dataset with ResQ at two decimals, warning in the macro's completion box; deployed the same day via the client-side build fallback"
metadata: 
  node_type: memory
  type: project
  originSessionId: ae4cc7b8-46c5-4a77-af41-42471db4b218
  modified: 2026-09-01T21:39:50.073Z
---

On 2026-09-01 the "Import ResQ Reserving Class" macro was found to skip every calculated and engine-generated dataset: the transfer review hides them (both sides rebuild them), the macro sends only the ticked names, and the migration narrowed the ResQ inventory to those names. The fix lives in `python-api/migration`: `catalog._is_unreviewed_dataset` is the one rule shared by the review (`sync_session.collect_resq_inventory`), the import narrowing (`_select_export_inventory`, which now takes the reserving class to read unticked datasets' types), and the commit merge (`merge.merge_preserved_arcrho_artifacts` treats such live groups as requested).

The same day the import gained an Engine-versus-ResQ check: after `write_engine_generated_export`, `_compare_engine_result_with_resq` reads the ResQ values (only then, never before the Engine result) and compares with `resq_migration.engine_parity.compare_import_values` (abs tolerance 0.005, the module the offline `validation/validate_engine_resq_parity.py` now imports its `compare_matrices`/`read_engine_csv` from). Disagreements travel as `engine_parity_warnings` (same bounded `{kind,name,message}` shape as `error_details`, redacted by the Bridge runner) and the macro (v1.7.0) shows them as a warning box that stays open; the batch macro (v1.5.0) lists them per class.

**Why:** the review was designed for sync/export, where nothing needs reconciling for rebuilt datasets, but an import is the only way those datasets ever reach a new ArcRho class; and the user wants to see where the Engine and ResQ disagree without failing the import.

**How to apply:** both changes were deployed to Bridge, Engine, and Gateway on 2026-09-01 from the Client PC (`build_exe.py` fallback, the Build Listener had been down since 2026-08-25) and the macro library was published. Classes imported through the review before that day lack their calculated/generated datasets until re-imported. See [[remote-component-deploy]], [[arcrho-dataset-types-win-over-resq]], [[deploy-staleness-is-mtime-based]].
