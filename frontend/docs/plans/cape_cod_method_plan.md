# Cape Cod Method Plan

Version: v1.0
Last updated: 2026-08-04

## Summary

Add a new ArcRho method object type displayed and persisted exactly as `Cape Cod` (the ResQ Generalised Cape Cod method).

The Cape Cod method page uses the shared tabbed-page framework and opens as a Project Instance iframe feature page with tabs in this order (mirroring the ResQ editor layout):

1. `Details`
2. `Method`
3. `Ultimates`
4. `Ratios`
5. `Notes`
6. `Audit Log`

ResQ's `Single Origin` and `All Origin` graph tabs are deferred; `Ratios` is the primary graphical exhibit.

Reference assets:

```text
E:\XWSpace\ResQ API Doc\assets\Cape Cod Method\ResQ UI Screenshot.xlsx
```

Validation reference: ResQ project `NJ_Annual_Prod_202605_Fake`, reserving class
`PRNJ - PA\PA\All States\Direct Group\COL`, method `D 53 - Cape Cod Gross Loss Incurred`.
Every formula below was verified against the ResQ COM API output of that method to
relative error <= 4e-15.

## Canonical Labels

- UI method type: `Cape Cod`
- JSON method type: `Cape Cod`
- Sidecar `method_type`: `Cape Cod`
- Source kind: `cape_cod`
- JSON format: `arcrho-cape-cod-method-by-tab-v1`
- Method file prefix: `CC@` (`methods/CC@<Name>.json`)
- ResQ method type code: `3`
- Route prefix: `/cape-cod/...`
- Directory: `frontend/ui/method_pages/cape_cod/`
- CSS/DOM prefix: `cc`
- Shell tab type / PI windowKind: `cape_cod`; state field `ccTab`
- Tab-change message: `arcrho:cc-tab-changed`

Do not use `CapeCod`, `Cape-Cod`, `Generalised Cape Cod`, or `CC Method` as the persisted method type label.

## Project Instance Integration

Same integration surface as Bornhuetter Ferguson:

- Row context menu includes `Add -> Cape Cod`.
- Eligible create source rows are vector rows with blank/`None` Method Type.
- Creation opens the page on `Details`; double-click of a `Method Type = Cape Cod` row opens `Method`.
- `Show as vector` remains available for the Cape Cod output vector row.
- Project Instance state snapshots preserve floating-window state and the active tab.
- Help/open JSON resolution treats Cape Cod as a method JSON under `methods/CC@<Name>.json`.
- No ResQ Sync workflow in V1.

## Inputs (1:1 with ResQ)

| ResQ control | ArcRho field | Notes |
| --- | --- | --- |
| Latest (+ Type dropdown) | `method_tab.latest_dataset` | One actual Triangle dataset. Latest values are the triangle's leading diagonal. ResQ `LatestType=dfTriangle(0)`. The vector-latest variant is not offered in V1. |
| Exposure | `method_tab.exposure_dataset` | One Vector dataset (for example earned premium/exposure). |
| Prior Ultimate (+ Type dropdown) | `method_tab.prior_ultimate_dataset`, `method_tab.prior_ultimate_mode` | `latest_ultimates` (ResQ `Latest / Ultimates`, `PercentageDevelopedType=0`): a prior ultimate Vector (typically a DFM output); percentage developed is `Latest / Prior Ultimate`. `pattern` (ResQ `pdPattern`): the selected vector holds percentage-developed values directly. |
| Trend Rate % + `Fit` + `Auto Fit` | `method_tab.trend_rate`, `method_tab.auto_trend_fit` | `trend_rate` is stored as a decimal (0.0575468...), displayed as a percentage. |
| Decay Factor | `method_tab.decay_factor` | 0.0 = development-factor results, 1.0 = simple Cape Cod. |
| Scaling | `method_tab.scaling_type` | `percentage` \| `unscaled` \| `auto_scaled` (ResQ codes 0/1/2). Display-only ratio scaling. |
| Decimal Places | `details_tab.statistic_decimal_places` | Factor/ratio display precision (0-8, default 2). |
| Alternative Ultimate Calculation | `method_tab.alternative_ultimate_calculation` | See Output below. |
| Trend Factor column overrides | `method_tab.trend_factor_overrides` | Per-origin manual override (`null` = automatic). Cleared whenever the trend rate changes or a fit runs, matching ResQ. |
| Origin Length + Max (Details) | `details_tab.origin_length` | Same semantics as BF. |

Manual per-cell Exposure and Percentage Developed overrides (ResQ `ManualExposure` / `ManualPattern`) are deferred from V1.

## Calculation Behavior

Let `i = 0..n-1` index origins (oldest first), `r = trend_rate`, `decay = decay_factor`.
All vectors align to `method_tab.origin_labels`.

```text
(1)  Latest[i]              = leading diagonal of the Latest triangle
(2)  Exposure[i]            = exposure vector value
(3)  TrendFactor[i]         = override if set, else (1 + r)^(n - 1 - i)
(4)  TrendedLatest[i]       = Latest[i] * TrendFactor[i]
(5)  PctDeveloped[i]        = Latest[i] / PriorUltimate[i]      (latest_ultimates mode)
                            = PatternValue[i]                    (pattern mode)
(6)  DevelopmentFactor[i]   = 1 / PctDeveloped[i]
(7)  DevelopedExposure[i]   = Exposure[i] * PctDeveloped[i]
(8)  FutureExposure[i]      = Exposure[i] - DevelopedExposure[i]
(9)  TrendedDevelopedRatio[i] = TrendedLatest[i] / DevelopedExposure[i]
(10) ExpectedUltimateRatio[i] =
       SUM_j(DevelopedExposure[j] * decay^|i-j| * TrendedDevelopedRatio[j])
     / SUM_j(DevelopedExposure[j] * decay^|i-j|)
(11) DetrendedExpectedRatio[i] = ExpectedUltimateRatio[i] / TrendFactor[i]
(12) FutureLatest[i]        = FutureExposure[i] * DetrendedExpectedRatio[i]
(13) Ultimate[i]            = DetrendedExpectedRatio[i] * Exposure[i]
                                 when alternative_ultimate_calculation
                                 and Latest[i] <> 0 and PctDeveloped[i] = 0
                            = Latest[i] + FutureLatest[i]        otherwise
(14) UltimateRatio[i]       = Ultimate[i] / Exposure[i]
```

Blank propagation: a row's derived cells are blank when a required input for that
step is blank or a divisor is zero. Rows with blank `DevelopedExposure` or blank
`TrendedDevelopedRatio` are excluded from the sums in (10). Percentage developed
may exceed 1 and future exposure may be negative; no clamping is applied
(verified against ResQ).

The published output vector is `Ultimate` at full floating precision (no
rounding; ResQ publishes unrounded values).

### Trend rate fit (`Fit` button and Auto Fit)

Verified against ResQ `FitTrendRate` to 4e-15:

```text
TDR0[i]  = Latest[i] / DevelopedExposure[i]        (trend factors reset to 1)
Y[i]     = ln(TDR0[i]),  X[i] = i,  W[i] = DevelopedExposure[i]
slope b  = SXY / SXX with
           W   = SUM(W[i]);  XW = SUM(X*W);  YW = SUM(Y*W)
           SXX = SUM(X*X*W) - XW*XW/W
           SXY = SUM(X*Y*W) - XW*YW/W
trend_rate = exp(b) - 1
```

Rows with non-positive or blank `TDR0` are excluded. Fewer than two usable rows
=> `trend_rate = 0`. Running a fit (or changing the trend rate) clears every
trend factor override, matching ResQ. When `auto_trend_fit` is true, every
recalculation refits the trend rate before computing (3)-(14).

### Ultimates tab (diagnostic triangle)

The Ultimates tab shows, for every historical cell of the Latest triangle, the
Cape Cod ultimate as it would have been estimated on that cell's calendar
diagonal. Verified cell-exact (2e-16) against ResQ `UltimateTriangleValues` at
every stored data point:

- Cells on the same calendar diagonal form one as-if evaluation.
- Included origins: those with at least one observed cell on or before that diagonal.
- Latest for origin `j` = the triangle cell of origin `j` on that diagonal.
- Percentage developed for a cell in development column `k` = the current
  Method-tab `PctDeveloped` of the origin whose leading diagonal sits in
  column `k` (in a regular triangle both share the same development age).
- Exposure, decay factor, and trend rate are the current Method-tab values;
  trend factors are re-based to the newest included origin:
  `TF[j] = (1 + r)^(newest_included - j)`.
- Expected/detrended ratios and ultimates then follow (7)-(13) restricted to the
  included origins.

ResQ additionally interpolates display columns between stored diagonals with an
undocumented spline; ArcRho shows the triangle at the dataset's real development
granularity only, so every displayed cell is exactly reproducible from stored
data. The triangle is derived state: computed on load/refresh, never persisted.

### Ratios tab

Line chart by origin of the six Method-tab ratio series, matching the ResQ
Ratios graph:

- Latest / Exposure
- Trended Latest / Exposure
- Trended Developed Ratio
- Expected Ultimate Ratio
- Detrended Expected Ratio
- Cape Cod Ultimate Ratio

Rendered with the shared canvas chart approach used by the BF chart; gaps for
blank values; hover shows series/origin/value; honors the decimal-places and
scaling settings.

## Method Table

| Column | Behavior |
| --- | --- |
| Origin | Origin label. |
| Latest | Latest triangle diagonal value. |
| Exposure | Exposure vector value. |
| Trend Factor | Editable; automatic `(1+r)^(n-1-i)` or manual override (override cells use the standard manual-entry style). |
| Trended [Latest] | (4). |
| Percentage Developed | (5), percent format. |
| Development Factor | (6). |
| Developed [Exposure] | (7). |
| Future [Exposure] | (8). |
| Trended Developed Ratio | (9), ratio format. |
| Expected Ultimate Ratio | (10), ratio format. |
| Detrended Expected Ratio | (11), ratio format. |
| Future [Latest] | (12). |
| Cape Cod Ultimate | (13), highlighted as the output column. |
| Cape Cod Ultimate Ratio | (14), ratio format. |

`[Latest]`/`[Exposure]` column captions embed the selected dataset names, as in
ResQ ("Trended Gross Loss--Incurred", "Developed Total Earned Exposure"). A
Total row aggregates: sums for value columns; ratio totals are the
exposure-weighted equivalents shown by ResQ (total trended developed ratio =
total trended latest / total developed exposure, total ultimate ratio = total
ultimate / total exposure, total detrended expected ratio = total future latest
/ total future exposure ... matching the ResQ totals row). Ratio columns honor
`scaling_type` and `statistic_decimal_places`.

The toolbar above the grid holds: Trend Rate % input + `Fit` + `Auto Fit`,
Decay Factor, Scaling, Decimal Places, and Alternative Ultimate Calculation
(enabled only when some origin has non-zero Latest with zero Percentage
Developed), laid out like the ResQ header but with ArcRho controls.

## Persistence

Method JSON file:

```text
methods/CC@<Name>.json
```

Dataset output:

```text
datasets/<Name>@<OriginLength>.csv     (+ aggregated 3/6/12 variants)
```

Self-contained v1 method JSON grouped by `details_tab`, `method_tab`,
`ultimates_tab`, `ratios_tab`, `audit_log_tab`, and `method_metadata`
(`ultimates_tab`/`ratios_tab`/`audit_log_tab` are empty structural groups;
notes are owned by the output dataset sidecar).

`method_tab` stores:

- Source names, embedded value snapshots, and `*_source_revision` hashes for
  Latest, Exposure, and Prior Ultimate (`prior_ultimate_mode` included).
- Owned parameters: `trend_rate`, `auto_trend_fit`, `decay_factor`,
  `scaling_type`, `alternative_ultimate_calculation`, `trend_factor_overrides`.
- `origin_labels` plus every derived column (3)-(14), validated on save to match
  the embedded snapshots exactly (same producer-parity model as BF).

Revision projections follow the BF concurrency model:

- `owned_projection`: details tab, source names + mode, display flags, decay,
  scaling, alternative calc, auto fit, trend factor overrides, and `trend_rate`
  only when `auto_trend_fit` is false.
- `derived_projection`: origin labels, embedded source values + revisions, the
  effective `trend_rate` when auto-fitted, and all calculated columns.
- `publication_projection`: identity + origin labels + `cape_cod_ultimate`.

Sidecar: `source_kind = "cape_cod"`, `method_type = "Cape Cod"`,
`method_type_code = 3`, `data_format = "Vector"`, precedents = Latest,
Exposure, Prior Ultimate.

Dependency propagation mirrors BF: a durable change to any precedent refreshes
the method through `calculated_dataset_service.recalculate_dependents` (new
`cape_cod_updates` wave alongside BF), re-publishes outputs, and marks the
branch Review Needed.

## ResQ Migration

- `METHOD_TYPE_CAPE_COD_CODE = 3` (already mapped to `Cape Cod` in
  `resq_migration/core.py`).
- `export_cape_cod` reads the ResQ `xCapeCodMethod` (TrendRate, AutoTrendFit,
  DecayFactor, AltUltimateCalc, ScalingType, DecimalPlaces, Latest, Exposure,
  PercentageDeveloped + type, ManualTrendFactor flags, OriginLength) and builds
  the owned payload; derived columns come from
  `recalculate_cape_cod_method(...)` with the migrated source snapshots so all
  producers share one calculation path.
- Vector export branch mirrors BF (`CC@` prefix, `include_cc_methods` flag,
  `ccs_written` count, `_find_cape_cod_for_vector`, macro touch points).

## Deferred From V1

- `Single Origin` / `All Origin` graph tabs.
- Vector-latest input type (`LatestType = dfVector`).
- Manual Exposure / Percentage Developed cell overrides.
- ResQ/RPC sync.
- ResQ's spline-interpolated display columns between stored diagonals on the
  Ultimates tab.

## Test Plan

1. Contract parity: fixture captured from ResQ `D 53 - Cape Cod Gross Loss
   Incurred` (COM dump) must reproduce every Method-tab column, the fitted
   trend rate, the ultimates, and every stored-data Ultimates-triangle cell to
   <= 1e-9 relative error.
2. Create Cape Cod from an eligible Project Instance vector row; confirm tab
   order `Details, Method, Ultimates, Ratios, Notes, Audit Log`.
3. Select Latest triangle, Exposure vector, Prior Ultimate vector; confirm grid
   columns and totals match the ResQ layout.
4. Fit/Auto-Fit trend rate; verify fitted value and that manual trend-factor
   overrides reset on refit; edit a trend factor manually and verify (4)-(14)
   recompute.
5. Toggle Alternative Ultimate Calculation enablement rule.
6. Verify scaling (`percentage`/`unscaled`/`auto_scaled`) and decimal places
   only affect display.
7. Ultimates tab equals the as-if evaluation for every stored data cell.
8. Ratios tab plots the six series with gaps and hover values.
9. Save/close/reopen restores everything from the method JSON + sidecar only.
10. Native + aggregated output CSVs and sidecar metadata written; RS picks up
    the output vector with `method_type = "Cape Cod"`.
11. Durable precedent change triggers the Cape Cod refresh wave and Review
    Needed status.
12. Migration produces `CC@D 53 - Cape Cod Gross Loss Incurred.json` whose
    published vector matches the live ResQ `Ultimates` values.
