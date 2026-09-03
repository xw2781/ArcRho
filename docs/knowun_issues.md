Fix all open issues listed below. Once fixed, document how you fixed each issue in docs/resolved.md and move the item out of current file.

Don't clear the section headers. Ignore empty sections and don't guess a bug.

# DSV

## Temporary View Mode

# PI

## pi-hidden-tabs-menu

# DFM

- A Bornhuetter Ferguson ultimate is rounded to a whole number while ResQ keeps full precision, so anything reading a BF vector drifts from ResQ. Found comparing `NJ_Annual_Prod_2026 Q3-Aug` with `python-api/migration/validation/dfm_ratio_side_by_side_review.py`: `PRNJ - PA\PA\NJ\Direct Group\BIx51+UMBIx51`, DFM "F 18 - BS Paid DFM", max ratio difference 0.0198 over 17 cells, every one of them in development periods 1 and 2. Chain: "C 41 - BF Reported ex CWOP" computes 63.0147 for 2026 and 57.8946 for 2025 but stores 63 and 58 -> "C 91 - Current Qtr Indicated" -> "C 92 - Current Qtr Selected" -> the ultimate claim numbers the B&S Settlement Rate Adjustment divides the closed claim counts by to get its Selected Proportion Settled -> the interpolated "Net Loss--Paid - B&S Settlement Rate Adjustment" triangle at the two earliest ages, where the paid-versus-closed-claims curve is steepest. Later development periods are unaffected because the latest diagonal is unadjusted by construction and anchors the rest of each row. Recomputing the chain with the BF ultimate left unrounded drops the largest F 18 ratio difference from 0.0198 to 0.00005, the review's own tolerance. The rounding is deliberate and covered by tests — `_calculate_vectors` in [bornhuetter_ferguson_contract.py](../python-api/src/arcrho_api/bornhuetter_ferguson_contract.py), mirrored by `roundBornhuetterFergusonWholeNumber` in [bornhuetter_ferguson_json_contract.js](../frontend/ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_json_contract.js) — and the ResQ import does not escape it, because it discards ResQ's own BF output vector and re-runs ArcRho's calculation. Same cause behind the other three flagged DFMs ("G 18 - BS Paid DFM" in the same class, and both BS Paid DFMs in `PRNJ - PA\PA\NJ\Direct Group\BIR51+UMBIR51`, where the effect is far smaller because those claim counts run in the thousands). Even unrounded a residual ~0.00005 remains: ResQ's own saved Selected Proportion Settled row is stale, inconsistent with ResQ's current ultimates by about 0.02%.

# "ArcRho Server" Root
- If some modules are still using hard-coded "E:\ArcRho Server", they need to use the value same as that in app main menu Settings -> Server Connection -> Root Path
