# data-engine Architecture Notes

## data-engine\src\arcrho_bridge

- ResQ import/export only; a separate module from the rest of the ArcRho system.
- Purpose: migration support — phased transition from ResQ to the ArcRho platform.
- Will be retired once the transition completes. Do not host permanent ArcRho features here.
- One instance per user, on the dev PC.

## data-engine\src\arcrho_engine

- Handles data transformation and processing.
- Runs ~5 instances on the dev PC (the dedicated server where the ArcRho Server folder is a local drive), enough to serve requests from the 5–6 person team efficiently.
- Planned: support for long-running jobs — for example a complete dependency-graph refresh (update all dependents of a changed dataset) or project duplication — using a durable request queue with status files the client can poll. See [docs/plans/engine_dependent_propagation_plan.md](../docs/plans/engine_dependent_propagation_plan.md).
- Planned: a lock file on the affected reserving-class or project folder so only one Engine instance updates a segment at a time and duplicate requests from different users are avoided. The lock is a lease with a max hold time: the owning instance renews it while working, and a lock left behind by a dead instance expires and can be taken over.
