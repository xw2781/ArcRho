# GUI Reference
"E:\XWSpace\ResQ API Doc\assets"
For UI design, need to follow current ArcRho UI rules and styles.

# API Reference
- Official Doc:
"E:\XWSpace\ResQ API Doc\reference\resq_help_manual.chm"
"E:\XWSpace\ResQ API Doc\reference\resq_help_manual_decompiled"
- User's Costum Python module used in production, many useful usage examples
"E:\XWSpace\ResQ API Doc\reference\ResQToolBox2.py"

Note: The ResQ COM API method and property names may not be intuitive sometimes, ask user to confirm details if needed.

# ResQ Data Access
- Agents are free to read project "NJ_Annual_Prod_202605_Fake" and pull all
- Use default ResQ Windows authentication to connect (empty user/password in `ConnectByName`).
- Sandboxed exec strips the Windows security context needed for SSPI, so `ConnectByName` fails with
  `SSL Provider: No credentials are available in the security package`. Run the connection script
  outside the sandbox (unsandboxed/escalated exec) so Windows integrated auth can negotiate normally.

# Methods to be added in ArcRho

Status as of 2026-09-04 — four of the five have shipped; only Bootstrap
Consolidation is still open, so this file stays an open plan.

- B&S Case Reserve Adequacy Adjustment (berquistshermancra) — **done**
- B&S Settlement Rate Adjustment (berquistshermansr) — **done**
- Cape Cod(capecodmethod) — **done** (`frontend/docs/plans/cape_cod_method_plan.md`)
- Bootstrap Consolidation (bootstrapconsolidation) — **not started**
- BootstrapMethod (bootstrapmethod) — **done** (`frontend/docs/plans/bootstrap_method_plan.md`)

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
