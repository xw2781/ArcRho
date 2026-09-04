---
name: resq-dfm-curves-com-api
description: "ResQ DFM Curves tab and tail factor COM facts probed live 2026-09-03 (TailFactor lives on CustomAverages(i), CurveValues(col,0) is a tail, SelectedTailFactor drives the tail, log-regression fit rules reproduced exactly)"
metadata: 
  node_type: memory
  type: project
  originSessionId: dd9a0016-daa7-4ab9-8ad1-13933b77fa01
  modified: 2026-09-04T02:02:29.751Z
---

Probed on the Server PC against `NJ_Annual_Prod_202605_Fake` / `PRNJ - PA\PA\NJ\Direct Group\MP+PIP` / `C 12 - CWP DFM w/ Selected LDFs` on 2026-09-03 (gencache early binding, nothing saved). These are the rules `arcrho_api/dfm_curves.py`, `frontend/ui/method_pages/dfm/dfm_curve_fit.js`, the import (`resq_migration/dfm.py`) and the export macro rely on; the fixture `python-api/tests/fixtures/dfm_curves_resq_c12.json` pins the numbers.

**Ratios tab tail column ("113 - Ult").** Each average row's value there is `dfm.CustomAverages(i).TailFactor` (settable; row 10 "User Entry" held 1.0005, row 13 "Aug 2024" 1.00173, every other row 1.0). `AverageRatioValues(i, N)` at that column returns unallocated memory (0.0, 1e-311) for most rows, so never read the tail from it. `SetSelectedRatios(DevIndex=N, …)` selects the tail row and moves `SelectedRatioValues(N)`; `SetUserRatios` at column N does nothing useful.

**Curves tab columns** are `DFMCurveType` ordinals: 1 Initial Selection (`cctValue`), 2-5 Exponential Decay / Inverse Power / Power / Weibull (`cctCurve`), 6+ user columns (`CurveColumnType` 3 user entry, 4 prior analysis, 5 pattern, 6 benchmark; `CurveUserValueColCount` settable; `SetCurveColumnDescription(col, text)`). `CurveValues(col, i)`: `i = 0` is the column's tail factor, `1..n` the periods, `n+1..` the future periods; `SetCurveValues(col, i, v)` writes a user column (`i = 0` its tail). `SelectedEstimates(i)` / `SetSelectedEstimates(i, col)` per period; the tail's selection is the separate `SelectedTailFactor` property (`SetSelectedEstimates(n+1, …)` changes the stored number but not the value); `SelectedTailCurve` is the Tail Pattern X. `SelectWholeTailCurve(col)` sets all of them. `FittingMethod` 0 log regression / 1 least squares, `LeastSquareWeights`, `FreeFitC`, `FutureDevelopmentPeriods`, `IncludedRatios(i)` / `SetIncludedRatios(i, bool)`, `CurveFitA/B(col)`, `CurveFitC` (inverse power only), `CurveFitRSquared(col)`, `FitResult(col)` (0 unfitted, 1 OK, 2 limit, 3 fail, 4 warning), `CurveExclusionType(i)` (3 = not excluded, 4 = no data).

**Fit rules reproduced to 1e-9.** Linear regression in log space with `t = 1` for the first period, R² = SXY²/(SXX·SYY) of that regression: Exponential Decay `ln(r-1)` on `t`; Inverse Power `ln(r-1)` on `ln(t+c)`, `c` from `(-0.5, 0, 1, 3, 5)` by best R² (C 12 picks 0), or a golden-section search over `c > -1` with Free Fit C (C 12 with periods 5 and 7 excluded: c = -0.2597); Power `ln(ln r)` on `t` with `a = exp(exp(b0))`, `b = exp(b1)`; Weibull `ln(-ln(1-1/r))` on `ln t`. A curve's tail = product of its fitted values over the `FutureDevelopmentPeriods` future periods (FDP 3 gave Exp 1.000199 = 1.0001378 × 1.0000459 × 1.0000153). A non-fitted column runs its whole tail off in the first future period. Least squares (Levenberg-Marquardt, iteration limit) is not reproduced; ArcRho keeps the setting and shows a notice.

**Why:** the user's priority was making ArcRho produce the 1.0005 tail; the value was being forced to 1.0 by both the contract and the frontend, and the export was overwriting ResQ's tail with that 1.0.

**How to apply:** read tails from `TailFactor`, write the tail selection through `SelectedTailFactor`, keep `python-api/tests/fixtures/dfm_curves_resq_c12.json` as the parity source for both languages. Related: [[resq-custom-average-api]], [[resq-com-probe]], [[resq-com-probe-dont-call-blindly]].
