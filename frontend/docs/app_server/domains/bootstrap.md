# App Server Domain: Bootstrap

## Purpose
<!-- MANUAL:BEGIN -->
Own the self-contained Bootstrap v1 contract, aggregate two-file load, revision-aware transactional save, and eager refresh after managed precedent updates. Bootstrap is the only method whose data precedent is another method: it re-fits a DFM to simulated pseudo triangles and scales the resulting reserve distribution onto a target ultimate.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.bootstrap.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/bootstrap/ladder` | `bootstrap_ladder` | `BootstrapLadderRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `bootstrap_service.percentile_ladder` |
| `POST` | `/bootstrap/load` | `load_bootstrap` | `BootstrapIdentityRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `bootstrap_service.load_bootstrap_method`, `workspace_read_client.run_workspace_read` |
| `POST` | `/bootstrap/refresh` | `refresh_bootstrap` | `BootstrapIdentityRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `bootstrap_service.refresh_bootstrap_method` |
| `POST` | `/bootstrap/save` | `save_bootstrap` | `BootstrapSaveRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `engine_hosted_save_service.run_hosted_save` |
| `POST` | `/bootstrap/save/plan` | `plan_bootstrap_save` | `BootstrapSaveRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `engine_hosted_save_service.run_hosted_save_plan` |
| `POST` | `/bootstrap/simulate` | `simulate_bootstrap` | `BootstrapRunRequest` | [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) | `bootstrap_service.simulate_bootstrap_method`, `workspace_read_client.run_workspace_read` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.bootstrap.key_files -->
- [`app_server/api/bootstrap_router.py`](../../../app_server/api/bootstrap_router.py) - Aggregate Bootstrap load/simulate/ladder/save/refresh routes.
- [`app_server/services/bootstrap_service.py`](../../../app_server/services/bootstrap_service.py) - V1 contract persistence, transactional publication, and eager dependency refresh.
- [`app_server/schemas/bootstrap.py`](../../../app_server/schemas/bootstrap.py) - Bootstrap identity, run-only simulate, finer ladder, and revision-aware save request models.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- A valid v1 load performs exactly two bounded parallel JSON reads: `methods/BST@<Name>.json` and `sidecars/<Name>.json`. The embedded DFM snapshot makes every tab openable without touching the precedent.
- Recalculation reads two sources: the precedent **DFM method JSON** (`methods/DFM@<DFM name>.json`, projected by `bootstrap_contract.dfm_snapshot_from_method`) and the target ultimate **Vector dataset** CSV named by its sidecar. The DFM read comes first because a Bootstrap inherits its origin axis and origin length from the DFM; that is the only sequential source read.
- The dependency graph is keyed by dataset name, so the DFM method is resolved to the dataset it publishes (`details tab.output dataset`, falling back to the method name) for the sidecar `Precedents`, the reverse `Dependents` edge, the cycle guard, and every Review Needed lookup. The method JSON keeps the DFM's *method* name.
- Save compares Bootstrap-owned and derived revisions separately. Submitted parameter edits (model type, residual display and smoothing settings, every simulation input including the owned seed, target ultimate, per-origin scaling methods and CVs, output flags) can rebase over a concurrent automatic source refresh, while a conflicting owned edit is rejected. Changing the DFM clears the embedded snapshot so the next recalculation must re-read it.
- Publication serializes within the reserving class, stages changed method/CSV/sidecar files, rolls back on failure, and writes the sidecar last.
- Managed source saves follow registered reverse edges through the `bootstrap_updates` wave, which runs last so a Bootstrap can consume a DFM, calculated, Result Selection, Bornhuetter Ferguson, or Cape Cod output as its target (`include_bootstrap` guard prevents recursion). Every affected Bootstrap is re-simulated even when the DFM snapshot revision is unchanged.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- `POST /bootstrap/load` is the `bootstrap_load` Server-hosted workspace read: when the Gateway advertises it, the method JSON and sidecar are read on the server host and returned verbatim; otherwise the service runs locally. See [`workspace_reads`](workspace_reads.md).
- `POST /bootstrap/simulate` is the `bootstrap_simulate` Server-hosted workspace read behind the page's Simulate. The router sends only the owned settings on screen (`owned_projection` plus the format marker), never the stored residuals and results; the service merges them onto the stored method exactly as Save does (`apply_owned_patch`, then re-reading only a source whose name changed), re-simulates from the seed, and returns the recalculated method with `sidecar.exists: false` without writing any file or taking the reserving-class lock. A Save of the same settings therefore publishes the same run. A new method (no file yet) reads both sources.
- `POST /bootstrap/ladder` serves the Results tab's full ladder at an interval finer than the stored half percent (0.1% or 0.01%). The page sends the whole method it shows, whose embedded DFM snapshot, targets and seed are everything the run needs, so `bootstrap_contract.bootstrap_percentile_ladder` re-runs it without reading project data and returns only the `scaled` and `unscaled` ladders, keyed like the stored one. That is why the route runs in the local app server rather than as a hosted read. A re-run whose means differ from the method's stored summary is refused with `422` and a prompt to simulate again, so a ladder is never shown beside another run's statistics. Nothing is written; about 1.5 seconds for 10,000 simulations.
- The only supported marker is `arcrho-bootstrap-v4`; the method file is `methods/BST@<Name>.json`.
- The target ultimate vector is read at its stored period, not its displayed one, and one stored finer than the DFM's origin length is brought to it through `precedent_cache_service.precedent_source`: an Engine-generated target is rebuilt at that period, a hand-entered one is rolled up in memory from its own CSV, and only a coarser target is refused with `422 … uses N-month origins; expected M`.
- Method JSON owns the DFM name plus an embedded snapshot of everything the bootstrap needs from it (origin and development labels, the observed cumulative triangle, the selected ratios at full precision, which ratios a simulation may re-estimate, and the DFM ultimate vector) with a `dfm_source_revision` hash; the residual grids for all five ResQ residual types; both scale-value blocks; the simulation inputs; the target inputs; timestamps; and deterministic owned/derived/publication revisions.
- **Simulated reserves are never persisted.** `results_tab` stores the seed, the simulation count, and a `simulation_summary` rich enough for every Results view without re-simulating. Its `unscaled` and `scaled` blocks each hold `mean`, `standard_error` (ResQ's standard deviation, divisor n), `minimum`, `maximum`, `ultimate_mean` and `ultimate_standard_error` (latest plus reserve), every vector with index 0 the all-origin total; `percentiles`, keyed by percent text every half percent from `"0"` through `"0.5"`, `"99.5"` to `"100"`, each the sorted sample at position floor(p·n) as ResQ's `PercentileValue`; and `histogram` (`lower`, `upper`, and 40 equal-width `counts` of the total reserve, the last bin closed). A summary saved before 2026-09-23 keeps its 5% ladder and reads its missing fields as empty until the next run. A ten-origin method file with this summary is about 145 KB. The run is bit-reproducible from the seed, so reopening a method rebuilds identical results without adding megabytes to a network-drive JSON file.
- `bootstrap_simulated_reserves` is the one way to get a bootstrap's individual simulations back (a Stochastic Consolidation's input): scaled and unscaled `reserves` by simulation and origin, their `totals`, and each simulation's `total_ranks` (1 for the smallest total, a permutation as ResQ's `TotalRank`). `summarize_bootstrap_simulations` reduces that output to exactly the stored summary.
- All calculations live in `python-api/src/arcrho_api/bootstrap_contract.py` and `python-api/src/arcrho_api/bootstrap_simulation.py`, documented in [`docs/plans/bootstrap_method_plan.md`](../../plans/bootstrap_method_plan.md); the service never computes values itself.
- The output sidecar owns Notes, Audit Log, status, `Precedents` (the DFM's output dataset and the target ultimate vector), and `Dependents`, and carries `source_kind: "bootstrap"`, `method_type: "Bootstrap"`, `method_type_code: 6`, `data_format: "Vector"`. The published vector is the scaled expected ultimate at full floating precision, with aggregated 3/6/12 variants. Every successful automatic refresh stamps the sidecar's `updated_at`/`modified_by` and appends an `Auto Refresh` audit record even when the published output is unchanged; output CSVs are republished regardless of whether the publication values change. The reserving-class `index.json` remains a minimal scalar inventory.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- A 10,000-simulation run costs roughly 1.4 seconds inside the reserving-class lock. Simulate runs outside it. Save and automatic refresh always simulate, including unchanged DFM snapshots. Automatic publication preserves green only when the meaningful method JSON and all output CSVs are unchanged; changed content requires review and existing review alerts remain until explicit Save.
- Direct out-of-band DFM or target edits do not publish a dependency event; use a managed ArcRho save or explicit repair.
- A DFM whose published output dataset is renamed breaks the reverse edge until the Bootstrap is saved again, because the graph edge is stored under the old dataset name.
- A failed dependent branch does not roll back the already-committed upstream save.
<!-- MANUAL:END -->
