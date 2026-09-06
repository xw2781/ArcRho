# App Server Domain: Bootstrap

## Purpose
<!-- MANUAL:BEGIN -->
Own the self-contained Bootstrap v1 contract, aggregate two-file load, revision-aware transactional save, and eager refresh after managed precedent updates. Bootstrap is the only method whose data precedent is another method: it re-fits a DFM to simulated pseudo triangles and scales the resulting reserve distribution onto a target ultimate.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.bootstrap.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/bootstrap/load` | `load_bootstrap` | `BootstrapIdentityRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `bootstrap_service.load_bootstrap_method`, `workspace_read_client.run_workspace_read` |
| `POST` | `/bootstrap/refresh` | `refresh_bootstrap` | `BootstrapIdentityRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `bootstrap_service.refresh_bootstrap_method` |
| `POST` | `/bootstrap/save` | `save_bootstrap` | `BootstrapSaveRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `engine_hosted_save_service.run_hosted_save` |
| `POST` | `/bootstrap/save/plan` | `plan_bootstrap_save` | `BootstrapSaveRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `engine_hosted_save_service.run_hosted_save_plan` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.bootstrap.key_files -->
- [`app_server/api/bootstrap_router.py`](../../../app_server/api/bootstrap_router.py) - Aggregate Bootstrap load/save/refresh routes.
- [`app_server/services/bootstrap_service.py`](../../../app_server/services/bootstrap_service.py) - V1 contract persistence, transactional publication, and eager dependency refresh.
- [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) - Bootstrap identity and revision-aware save request models.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- A valid v1 load performs exactly two bounded parallel JSON reads: `methods/BST@<Name>.json` and `sidecars/<Name>.json`. The embedded DFM snapshot makes every tab openable without touching the precedent.
- Recalculation reads two sources: the precedent **DFM method JSON** (`methods/DFM@<DFM name>.json`, projected by `bootstrap_contract.dfm_snapshot_from_method`) and the target ultimate **Vector dataset** CSV named by its sidecar. The DFM read comes first because a Bootstrap inherits its origin axis and origin length from the DFM; that is the only sequential source read.
- The dependency graph is keyed by dataset name, so the DFM method is resolved to the dataset it publishes (`details tab.output dataset`, falling back to the method name) for the sidecar `Precedents`, the reverse `Dependents` edge, the cycle guard, and every Review Needed lookup. The method JSON keeps the DFM's *method* name.
- Save compares Bootstrap-owned and derived revisions separately. Submitted parameter edits (model type, residual display and smoothing settings, every simulation input including the owned seed, target ultimate, per-origin scaling methods and CVs, output flags) can rebase over a concurrent automatic source refresh, while a conflicting owned edit is rejected. Changing the DFM clears the embedded snapshot so the next recalculation must re-read it.
- Publication serializes within the reserving class, stages changed method/CSV/sidecar files, rolls back on failure, and writes the sidecar last.
- Managed source saves follow registered reverse edges through the `bootstrap_updates` wave, which runs last so a Bootstrap can consume a DFM, calculated, Result Selection, Bornhuetter Ferguson, or Cape Cod output as its target (`include_bootstrap` guard prevents recursion). A DFM refresh whose snapshot revision is unchanged is skipped rather than re-simulated.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- `POST /bootstrap/load` is the `bootstrap_load` Server-hosted workspace read: when the Gateway advertises it, the method JSON and sidecar are read on the server host and returned verbatim; otherwise the service runs locally. See [`workspace_reads`](workspace_reads.md).
- The only supported marker is `arcrho-bootstrap-method-by-tab-v1`; the method file is `methods/BST@<Name>.json`.
- The target ultimate vector is read at its stored period, not its displayed one, and one stored finer than the DFM's origin length is brought to it through `precedent_cache_service.precedent_source`: an Engine-generated target is rebuilt at that period, a hand-entered one is rolled up in memory from its own CSV, and only a coarser target is refused with `422 … uses N-month origins; expected M`.
- Method JSON owns the DFM name plus an embedded snapshot of everything the bootstrap needs from it (origin and development labels, the observed cumulative triangle, the selected ratios at full precision, which ratios a simulation may re-estimate, and the DFM ultimate vector) with a `dfm_source_revision` hash; the residual grids for all five ResQ residual types; both scale-value blocks; the simulation inputs; the target inputs; timestamps; and deterministic owned/derived/publication revisions.
- **Simulated reserves are never persisted.** `results_tab` stores the seed, the simulation count, and a compact `simulation_summary` (mean, standard error, minimum, maximum, and the 0/5/.../100 percentile ladder, unscaled and scaled, with index 0 holding the all-origin total). The run is bit-reproducible from the seed, so reopening a method rebuilds identical results without adding megabytes to a network-drive JSON file.
- All calculations live in `python-api/src/arcrho_api/bootstrap_contract.py` and `python-api/src/arcrho_api/bootstrap_simulation.py`, documented in [`docs/plans/bootstrap_method_plan.md`](../../plans/bootstrap_method_plan.md); the service never computes values itself.
- The output sidecar owns Notes, Audit Log, status, `Precedents` (the DFM's output dataset and the target ultimate vector), and `Dependents`, and carries `source_kind: "bootstrap"`, `method_type: "Bootstrap"`, `method_type_code: 6`, `data_format: "Vector"`. The published vector is the scaled expected ultimate at full floating precision, with aggregated 3/6/12 variants. An automatic refresh that rewrites the method stamps the sidecar's `updated_at`/`modified_by` and appends an `Auto Refresh` audit record even when the published output is unchanged; output CSVs are rewritten only when the publication changes. The reserving-class `index.json` remains a minimal scalar inventory.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- A 10,000-simulation run costs roughly 1.4 seconds inside the reserving-class lock. Save always simulates; automatic refresh skips the run when the DFM snapshot revision is unchanged and only the DFM changed.
- Direct out-of-band DFM or target edits do not publish a dependency event; use a managed ArcRho save or explicit repair.
- A DFM whose published output dataset is renamed breaks the reverse edge until the Bootstrap is saved again, because the graph edge is stored under the old dataset name.
- A failed dependent branch does not roll back the already-committed upstream save.
<!-- MANUAL:END -->
