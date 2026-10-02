# Build New Methods

Status: complete 2026-10-01. All five ResQ methods are built and released in Arco 1.8.0.

The ResQ reference paths and connection rules now live in [agent-instructions/resq-api-reference.md](../../../agent-instructions/resq-api-reference.md).

# Methods to be added in ArcRho

- B&S Case Reserve Adequacy Adjustment (berquistshermancra) — **done**
- B&S Settlement Rate Adjustment (berquistshermansr) — **done**
- Cape Cod(capecodmethod) — **done** (`frontend/docs/plans/cape_cod_method_plan.md`)
- Bootstrap Consolidation (bootstrapconsolidation) — **done** as Stochastic Consolidation ([completed/bootstrap_and_stochastic_consolidation.md](completed/bootstrap_and_stochastic_consolidation.md)); its page reaches users with the next app release
- BootstrapMethod (bootstrapmethod) — calculation and server layer **done** (`frontend/docs/plans/bootstrap_method_plan.md`); page and ResQ import **done** in [completed/bootstrap_and_stochastic_consolidation.md](completed/bootstrap_and_stochastic_consolidation.md)

# Phase 1 - B&S MVP (delivered)

The first phase adds the two B&S methods for annual data. ArcRho should reproduce
the calculations and final output triangles from the two existing methods under:

`PRNJ - PA\PA\All States\Direct Group\COL`

Canonical method labels:

- `B&S Settlement Rate Adjustment`
- `B&S Case Reserve Adequacy Adjustment`

The MVP includes:

- annual input triangles and the required ultimate-count vector;
- the inputs, selections, and calculations that affect the final COL results;
- minimal method JSON, output CSV, and dataset sidecar files;
- normal ArcRho dependency tracking and live input previews, following the DFM pattern;
- ResQ migration and macro import support for both methods;
- canonical annual labels on required source sidecars, including migration backfill when a legacy sidecar has no labels; and
- calculation tests using the COL methods as the reference results.

Parameters or calculation views that exist in ResQ but do not affect the two
reference outputs can be deferred. Bidirectional ResQ synchronization is outside
this phase.

The migrated B&S output triangles must retain their existing ArcRho dataset
identity and be upgraded to method-owned outputs rather than duplicated.
