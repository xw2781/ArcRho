# Generated formula dependencies and scoped source refresh

Status: Investigated 2026-09-05; proposed implementation, not started.

## Answer

Currently, importing the source table with dependent refresh scoped to dataset type A does **not reliably refresh B** when B is an Engine-generated formula using A. The source-refresh job regenerates existing Engine instances of explicitly selected types, then runs a dependency walk whose formula graph excludes generated types. In the ordinary A -> B case, B is neither selected for regeneration nor reached by that walk. Dependencies below B can consequently remain stale too.

An unscoped dependent refresh selects every existing Engine dataset instance in the selected reserving classes, including B, provided its regeneration succeeds. The type selection scopes regeneration, not the columns imported from the source table. This is the current workaround; no import or recalculation was performed during this investigation.

The missing DSV Details links have the same underlying classification problem. This is a contained backend change, but fixing only the displayed links or removing every `generated` guard would be incorrect. Generated formulas must continue to calculate through the Engine against source data.

## Confirmed fake-project example

Read-only inspection of `NJ_Annual_Prod_202605_Fake` on 2026-09-05:

| Role | Dataset type | Formula or direct source | Generated |
| :--- | :--- | :--- | :--- |
| A | Earned Premium | `Earned_Premium` CSV field | true |
| C | Remaining Budget Premium | `Remaining_Budget_Premium` CSV field | true |
| B | Total Earned Premium | `Earned Premium + Remaining Budget Premium` | true |

`field_mapping.json` contains A and C, but not B. `dataset_types.json` marks B calculated and generated, and expands its Source to `Earned_Premium + Remaining_Budget_Premium`.

In the default class `PRNJ - PA_\_PA_\_All States_\_Direct Group_\_COL`, the persisted sidecars confirm that A has no formula dependents and B has no precedents. B does retain method dependents, including `D 13 - Paid DFM w/ Selected LDFs`, `D 18 - BS Paid DFM`, and `D 92 - Current Qtr Selected`. The missing links therefore affect real downstream paths, not just the example formula.

These conclusions combine current repository logic with persisted project metadata. They are not a live reproduction of an import, nor a verification of the deployed Engine's source revision.

## Code evidence and ownership

- [source_table_refresh.py](../../server-components/src/arcrho_engine/source_table_refresh.py): `_engine_dataset_instances` filters `source_kind == engine` by exact selected dataset type. `_refresh_one_reserving_class` regenerates those instances and passes only the successful names to `recalculate_dependents`.
- [calculated_dataset_service.py](../../frontend/app_server/services/calculated_dataset_service.py): `_calculated_dataset_contract_from_rows`, `_direct_dependent_names`, `_dependency_map`, and `_target_dependency_map` exclude `generated` rows. `sidecar_graph_fields` uses these helpers. The recalculation target map also deliberately excludes generated types.
- [dataset_service.py](../../frontend/app_server/services/dataset_service.py): `load_dataset_sidecar` reads persisted graph fields and enriches their names for display. It does not recover missing generated-formula edges.
- [details_dependencies.js](../../frontend/ui/shared/tabs/details/details_dependencies.js): renders the returned precedent/dependent lists. There is no evidence that the chip renderer is dropping B.
- [arcrho_runtime_service.py](../../frontend/app_server/services/arcrho_runtime_service.py): applies the graph fields when publishing Engine sidecars.
- [dataset_types_service.py](../../frontend/app_server/services/dataset_types_service.py): owns Dataset Type normalization and source-expression derivation. Project Dataset Type formulas own logical type relationships; Field Mapping owns direct source-column bindings. Sidecar graph fields are derived instance relationships.
- [engine_dataset_sidecar_contract.py](../../python-api/src/arcrho_api/engine_dataset_sidecar_contract.py) owns Engine sidecar payload construction. Migration also derives graph fields in [catalog.py](../../python-api/migration/resq_migration/catalog.py), so producer parity must be covered.

## Proposed behavior

1. Discover logical formula dependencies for both generated and app-calculated types. Keep the calculation owner separate: generated types use the Engine; app-calculated types keep their existing evaluator.
2. For a source refresh scoped to A, include existing Engine instances of A and every transitively dependent generated type, including B. Respect the reserving-class selection. Empty type selection continues to mean all Engine types.
3. Discover type reachability before filtering to existing instances: an intermediate type without a persisted instance must not hide a later generated formula whose expanded source still uses A.
4. Regenerate the selected Engine instances using the existing request builder, force-refresh behavior, stored geometry, failure reporting, and cache restoration. Pass all successfully regenerated instances into the existing downstream method/app-calculated walk as one batch.
5. Show direct logical links in Details: A lists B, and B lists A and C. Transitive descendants belong in refresh expansion, not B's direct precedent list. Resolve graph names to existing instances using the canonical index and current instance naming rules.
6. Updating A does not mean B should add cached matrices from A and C. B reads the newly imported source through the Engine. This distinction matters especially for ratios and other expressions whose source aggregation differs from matrix arithmetic.

## Implementation steps

### 1. Separate formula discovery from execution eligibility

- Introduce one shared pure formula-dependency helper in the Python API contract layer, consumable by frontend services and migration. Consolidate the formula-reference extraction used by this path rather than adding another independent parser.
- Return direct precedents and reverse edges for calculated formulas regardless of `Generated`; retain the existing generated guard in app calculation eligibility.
- Cover quoted/unquoted names, mixed quoted and unquoted references, whitespace/case normalization, overlapping dataset names, transitive chains, and cycle handling. Preserve current accepted formula syntax.
- Make both graph persistence and source-refresh expansion consume this helper. Avoid broad changes to ordinary dataset-save propagation: an edit to A's cached values is not a source-table change for B.

Done when: the A/C/B fixture yields both direct edges while B still cannot enter the app-calculated evaluator.

### 2. Expand scoped Engine regeneration

- In `source_table_refresh.py`, expand requested types through the shared graph once per job and select matching existing Engine instances per class.
- Keep user-selected scope distinct from the derived execution set in reporting; do not silently redefine the saved selection.
- Regenerate B through `_regenerate_engine_dataset`, then include B as a root in the existing downstream walk. Deduplicate repeated paths and instances.
- Verify alternate period caches cannot continue serving pre-import values after regeneration; use the existing invalidation owner and add a focused correction only if the test exposes a gap.
- Preserve existing failure handling and report failed B regeneration without claiming its downstream branch refreshed. Verify that methods consuming several regenerated roots run with all successful inputs available.

Done when: A-only refresh rebuilds A, B, and generated descendants inside selected classes, then refreshes B's downstream methods; unrelated Engine types stay outside the regeneration set.

### 3. Publish and repair consistent Details graphs

- Use the shared graph in runtime and migration sidecar producers, retaining method and cell-link relationships.
- Keep `source_kind=engine` and existing calculation metadata semantics. Do not store formulas or graphs in `index.json`.
- Provide an explicit hosted graph reconciliation for existing sidecars so already-created A/B instances show the links without requiring a user to recreate datasets. Reuse the dataset-type graph reconciliation path where feasible; opening Details must not cause disk writes.
- Prove frontend/migration full Engine-sidecar payload parity for identical logical inputs, including path-alias independence. Use the canonical persisted JSON writer.
- Check Details refresh/cache invalidation after reconciliation; change frontend rendering only if evidence requires it.

Done when: both directions appear for the existing fake-project example, existing method dependents survive, and cached reads agree with freshly generated metadata.

### 4. Verify and release

- Extend [test_source_table_refresh.py](../../server-components/tests/test_source_table_refresh.py) with A-only scope, transitive generated B -> D, missing intermediate instances, multiple matching instances, class restrictions, unscoped refresh, and failed regeneration.
- Add focused graph/runtime tests near [test_calculated_dataset_runtime.py](../../frontend/tests/test_calculated_dataset_runtime.py) and [test_dataset_method_calculated_sidecar.py](../../frontend/tests/test_dataset_method_calculated_sidecar.py). Include a downstream method consuming B and an Engine ratio formula to catch accidental app evaluation.
- Add producer-parity coverage in the existing Engine sidecar/migration test area. Verify a valid current index is served without scanning sidecars or rewriting it.
- Update the dependent propagation domain documentation, relevant generated inventories if required, and an unreleased fragment when implementation lands.
- After validation, use `server-components/deploy.py` to derive and deploy affected components. A plan-only change needs no build or deploy.

## Scope and effort

Moderate, localized work: one shared graph helper, scoped refresh expansion, consistent sidecar publication/reconciliation, and focused tests. The graph guards explain the bug directly; the main complexity is preserving Engine execution and existing-project metadata parity. There is no need for a new propagation framework or a DSV redesign.

Transport follow-up found during inspection: `source_table_router.get_source_refresh_plan` intentionally executes locally, and `source_refresh_service.describe_source_refresh_plan` inspects server workspace state there. Keep client-only drive-letter translation local, move project configuration and busy-state reads through the Gateway, and remove client SMB access for that server-owned portion. Submission and status already use hosted mutation/read wrappers. This transport cleanup is adjacent work, not a prerequisite for the dependency fix.
