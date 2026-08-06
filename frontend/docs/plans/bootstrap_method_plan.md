# Bootstrap Method Plan

Version: v1.0
Last updated: 2026-08-05

## Summary

Add a new ArcRho method object type displayed and persisted exactly as `Bootstrap`
(the ResQ stochastic Bootstrap method).

Unlike every existing ArcRho method, a Bootstrap method's only data precedent is
another **method** — a DFM — rather than a dataset. It re-fits that DFM to
simulated "pseudo" triangles to produce a distribution of reserves, then scales
that distribution onto a target ultimate.

The Bootstrap method page uses the shared tabbed-page framework and opens as a
Project Instance iframe feature page with tabs in this order (mirroring the ResQ
editor layout):

1. `Details`
2. `Residuals` (sub-tabs `Data`, `Graph`)
3. `Simulation`
4. `Results` (sub-tabs `Unscaled Results`, `Targets`, `Scaled Results`)
5. `Output`
6. `Notes`
7. `Audit Log`

`Unscaled Results` and `Scaled Results` each carry the sub-sub-tabs `Summary`,
`Detail`, and `Ultimates Graph`.

Reference assets: the ResQ editor screenshots supplied with the request,
transcribed control-by-control in [ResQ UI Reference](#resq-ui-reference) so the
page can be built without them. If the PNGs are also wanted for visual
comparison, the repository convention is:

```text
E:\XWSpace\ResQ API Doc\assets\Bootstrap Method\Bootstrap_Tab_<Name>.png
```

matching `assets\BF Method\BF_Tab_Details.png` and
`assets\Result Selection\ResultSelection_Tab_Method.png`.

Validation reference: ResQ project `NJ_Annual_Prod_202605_Fake`, reserving class
`PRNJ - PA\PA\All States\Direct Group\COL`, method
`F 72 A - Bootstrap Net incurred with PV` over DFM `F 25 - Incurred DFM Bootstrap`.
Every deterministic formula below was verified against the live ResQ COM API for
that method to machine precision (max relative error 4e-15); the stochastic layer
was verified against ResQ's own `Simulate()` output (see [Verification](#verification)).

## Canonical Labels

- UI method type: `Bootstrap`
- JSON method type: `Bootstrap`
- Sidecar `method_type`: `Bootstrap`
- Source kind: `bootstrap`
- JSON format: `arcrho-bootstrap-method-by-tab-v1`
- Method file prefix: `BST@` (`methods/BST@<Name>.json`)
- ResQ method type code: `6` (already mapped to `Bootstrap` in `resq_migration/core.py`)
- Route prefix: `/bootstrap/...`
- Directory: `frontend/ui/method_pages/bootstrap/`
- CSS/DOM prefix: `bst`
- Shell tab type / PI windowKind: `bootstrap`; state field `bstTab`
- Tab-change message: `arcrho:bst-tab-changed`

`bs` is already taken by Berquist-Sherman (`cssPrefix: "bs"`, `BSSR@`, `BSCRA@`),
so Bootstrap uses `bst`/`BST@` throughout. Do not use `BS@`, `Boot`,
`bootstrap_method`, or `ODP` as the persisted method type label.

## Project Instance Integration

Same integration surface as Cape Cod:

- Row context menu includes `Add -> Bootstrap`.
- Eligible create source rows are vector rows with blank/`None` Method Type.
- Creation opens the page on `Details`; double-click of a `Method Type = Bootstrap`
  row opens `Results`.
- `Show as vector` remains available for the Bootstrap output vector row.
- Project Instance state snapshots preserve floating-window state and the active tab.
- Help/open JSON resolution treats Bootstrap as a method JSON under `methods/BST@<Name>.json`.
- No ResQ Sync workflow in V1.

## Inputs (1:1 with ResQ)

| ResQ control | ArcRho field | Notes |
| --- | --- | --- |
| Details / Name | `details_tab.name` | |
| Details / Output Type | `details_tab.output_type` | Dataset Type of the published vector. |
| Details / DFM | `details_tab.dfm_method` | The precedent DFM method name. The only data precedent. |
| Details / Origin Length, Development Length | `details_tab.origin_length`, `details_tab.development_length` | Read-only, inherited from the DFM. |
| Details / Bootstrap Model | `details_tab.model_type` | `mack` \| `odp_varying_scale` \| `odp_single_scale` (ResQ `BootstrapModel` 0/1/2). V1 implements the two ODP variants; `mack` is present but disabled. |
| Residuals / Single Scale Parameter | derived from `model_type` | Checked <=> `odp_single_scale`. One control, one stored value. |
| Residuals / Residual Type | `residuals_tab.residual_type` | `unscaled` \| `unscaled_bias_adjusted` \| `scaled` \| `scaled_bias_adjusted` \| `scaled_bias_adjusted_zero_average` (ResQ `ResidualType` 0-4). Display-only: the bootstrap always resamples from type 4. |
| Residuals / Show Residual Scale Values, Tile Grid and Graph | `residuals_tab.show_scale_values`, `residuals_tab.tile_grid_and_graph` | Display-only. |
| Residuals / Scale Values Smoother (Residual, Forecast) | `residuals_tab.residual_scale_smoothing`, `residuals_tab.forecast_scale_smoothing` | 0 = no smoothing. |
| Residuals / User Entry scale row | `residuals_tab.user_scale_values_residuals`, `..._forecasting` | Per development period; `null` = not entered. |
| Simulation / Pseudo Data Distribution | `simulation_tab.estimation_variance` | `none` \| `resampled` \| `normal` \| `log_normal` \| `gamma` \| `odp` (ResQ `BootstrapDistribution` 0-5). |
| Simulation / Forecast Distribution | `simulation_tab.process_variance` | Same domain. |
| Simulation / Simulations | `simulation_tab.simulation_count` | Default 10000. |
| Simulation / Random seed + New Seed | `simulation_tab.random_seed` | 32-bit integer; owned, never auto-changed on recalculation. |
| Simulation / Prevent negative cumulative data | `simulation_tab.prevent_negative_data` | |
| Simulation / Action on negative mean (Gamma or Log Normal) | `simulation_tab.negative_mean_action` | `value_0_01` \| `normal` |
| Simulation / Action on negative mean (Over-dispersed Poisson) | `simulation_tab.odp_negative_mean_action` | `odp` \| `gamma_or_log_normal` \| `negative_mean`. Enabled only when a distribution is `odp`. |
| Results / Targets / Target Ultimate | `results_tab.target_ultimate` | A Result Selection (or other) ultimate vector in the same reserving class. |
| Results / Targets / Scaling Method | `results_tab.target_scaling_methods` | Per origin: `unscaled` \| `additive` \| `multiplicative` \| `user_defined` \| `from_target` (ResQ `BootstrapScalingMethod` 0-4). |
| Results / Targets / Coefficient of Variation | `results_tab.target_cvs` | Per origin; only used by `user_defined`. |
| Output / checkboxes | `output_tab.*` | Which blocks the CSV export includes. |

## Calculation Behavior

Let `w = 1..W` index origins (oldest first) and `d = 1..N` development periods,
where `N = TotalDevelopmentPeriods = (observed columns) + DFM FutureDevelopmentPeriods`.
`L(w)` is the index of origin `w`'s latest observed column.

### 1. DFM fit (deterministic, verified exact)

```text
(1)  D[w][d]      = observed cumulative triangle (from the DFM data tab)
(2)  f[d]         = DFM selected ratio for d -> d+1, including the tail factor
(3)  S[w][L(w)]   = D[w][L(w)]                            anchor on the latest diagonal
     S[w][d]      = S[w][d+1] / f[d]      for d < L(w)    back-fit
     S[w][d+1]    = S[w][d]   * f[d]      for d >= L(w)   project
(4)  m[w][1]      = S[w][1]
     m[w][d]      = S[w][d] - S[w][d-1]                   fitted incremental
(5)  C[w][1]      = D[w][1]
     C[w][d]      = D[w][d] - D[w][d-1]                   observed incremental
```

`S` reproduces ResQ `xDFMMethod.PredictedValues` to 1.8e-16.

### 2. ODP residuals (deterministic, verified exact)

```text
(6)  u[w][d]      = (C[w][d] - m[w][d]) / sqrt(|m[w][d]|)     for observed cells
```

`|m|` matters: an incurred triangle that develops downwards has negative fitted
incrementals, and ResQ keeps the sign of the numerator while taking the root of
the magnitude. A residual that is exactly zero is excluded from every sum below
(this always removes exactly two cells of a complete triangle: the oldest
origin's last column and the newest origin's first column).

```text
(7)  n            = count of observed data cells, INCLUDING the excluded zeros
     p            = W + (observed columns) - 1
     bias         = sqrt(n / (n - p))
(8a) single scale:  phi    = SUM(u^2) / (n - p)
                    scale[d] = sqrt(phi)                       for all d
(8b) varying scale: phi[d] = ( SUM_w u[w][d]^2 / n_d ) * n / (n - p)
                    scale[d] = sqrt(phi[d])
                    where n_d = count of observed data cells in column d,
                    again INCLUDING excluded zeros
     Columns with no usable residual (the tail) take min of the previous two
     scale values.
(9)  residual type 0 (Unscaled)                  = u[w][d]
     residual type 1 (Unscaled, Bias Adjusted)   = u[w][d] * bias
     residual type 2 (Scaled)                    = u[w][d] / scale[d]
     residual type 3 (Scaled, Bias Adjusted)     = u[w][d] / scale[d] * bias
     residual_adjustment                         = mean of all type-3 residuals
     residual type 4 (…, Zero-Average)           = type 3 - residual_adjustment
```

Two subtleties are easy to get wrong and are both verified against ResQ:
`n` and `n_d` count **data cells**, not usable residuals (for F 72 A that is 55
and not 53; using 53 moves the scale parameter by 5%), and the bias adjustment is
applied *on top of* a scale that already divides by `n - p`, so the type-4
residuals have mean square 1.

`scale[d]` is what the Residuals grid shows as `Scale^0.5`, exposed as ResQ
`ScaleValues_Residuals` / `ScaleValues_Forecasting` with value types
`0 Unsmoothed`, `1 Smoothed`, `2 User Entry`, `3 Selected`. Selected = User Entry
where entered, else Smoothed, else Unsmoothed.

### 3. Simulation (stochastic)

`phi_R[d]` is the selected residual scale squared, `phi_F[d]` the selected
forecasting scale squared. For each simulation `s`:

```text
(10) pseudo incremental, for every observed cell:
       none        Q[w][d] = m[w][d]
       resampled   Q[w][d] = r * sqrt(phi_R[d] * |m[w][d]|) + m[w][d]
       normal      Q[w][d] ~ Normal(m[w][d], sqrt(phi_R[d]*|m[w][d]|))
       log normal  Q[w][d] ~ LogNormal(mean m[w][d], sd sqrt(phi_R[d]*|m[w][d]|))
       gamma       Q[w][d] ~ Gamma(shape = m[w][d]/phi_R[d], scale = phi_R[d])
     where r is a residual drawn uniformly at random from the type-4 residuals.
     Negative mean -> `negative_mean_action` (Normal, or clamp the mean to 0.01).
(11) P[w][d]    = cumulative sum of Q over observed columns
(12) f*[d]      = SUM_w P[w][d+1] / SUM_w P[w][d]  over origins observed at d+1
     Development periods whose DFM ratio is manual/curve-selected keep the DFM
     value and contribute no estimation error (this includes the tail factor).
(13) project forward from the PSEUDO latest diagonal cum[w] = P[w][L(w)]:
       mu       = cum[w] * (f*[d] - 1)
       inc      ~ the `process_variance` distribution with mean mu and
                  sd sqrt(phi_F[d+1] * |mu|)
       cum[w]  += inc ;  reserve[w] += inc
(14) reserve[s][w]  = SUM of simulated future incrementals
     ultimate[s][w] = observed latest[w] + reserve[s][w]
```

Anchoring the projection on the **pseudo** latest diagonal rather than the
observed one is what makes the newest origin's variance right: with the observed
diagonal, F 72 A's total prediction error drops from 9,304 to 6,852.

### 4. Scaling to targets (technical note 8)

For each origin `i` with unscaled simulated reserves `R[i][s]`, mean `mu[i]`,
standard deviation `sigma[i]`, target mean `mu_T[i]` and target CV `cov_T[i]`:

```text
(15) z[i][s]  = (R[i][s] - mu[i]) / sigma[i]
     additive        sigmaT[i] = sigma[i]
     multiplicative  sigmaT[i] = |sigma[i] / mu[i] * mu_T[i]|   (additive if mu[i] = 0)
     user defined    sigmaT[i] = |cov_T[i] * mu_T[i]|
     unscaled        scaled reserve = unscaled reserve
(16) Rtilde[i][s] = z[i][s] * sigmaT[i] + mu_T[i]
```

Additive scaling therefore shifts the distribution and leaves every standard
deviation untouched — visible in the ResQ screenshots, where the Scaled Results
standard deviations equal the Unscaled ones exactly.

`mu_T[i]` = `target ultimate[i] - observed latest[i]`.

## Tab Content

[ResQ UI Reference](#resq-ui-reference) is the single description of every
control, column and grid on every tab. This section records only where ArcRho
V1 intentionally differs from it.

- **Details.** `Mack` renders in the Bootstrap Model group but is disabled with a
  "not implemented yet" title.
- **Residuals / Graph.** Uses the shared canvas chart approach already behind the
  BF and Cape Cod charts rather than ResQ's plotting control. `Filter` scopes the
  visible origins and development periods.
- **Results.** V1 ships `Targets`, `Unscaled Results` and `Scaled Results`; the
  deferred sub-tabs are omitted rather than shown disabled. Within the two
  results tabs V1 ships `Summary`, `Detail` and `Ultimates Graph`.
- **Detail sub-tab.** `By Simulation` is disabled in V1, because per-simulation
  reserves are not retained after a run.
- **Footer.** ResQ's `Simulate | Apply | OK | Cancel` becomes the standard ArcRho
  `Save | Cancel` bar; `Simulate` is a toolbar action on the Simulation and
  Results tabs.
- **Cell styling.** ResQ's cyan manual-entry, green unsmoothed, and yellow
  derived fills map onto the existing ArcRho manual-entry, source, and derived
  cell styles rather than being reproduced literally.

## Persistence

Method JSON file:

```text
methods/BST@<Name>.json
```

Dataset output:

```text
datasets/<Name>@<OriginLength>.csv     (+ aggregated 3/6/12 variants)
```

Self-contained v1 method JSON grouped by `details_tab`, `residuals_tab`,
`simulation_tab`, `results_tab`, `output_tab`, `notes_tab`, `audit_log_tab` and
`method_metadata`.

`details_tab` stores the DFM name plus an embedded snapshot of everything the
bootstrap needs from it — origin labels, development labels, the observed
cumulative triangle, the selected ratios, which ratios are manual, and the DFM
ultimate vector — together with a `dfm_source_revision` hash, exactly as BF/CC
embed their dataset snapshots.

`residuals_tab` stores the derived residual grid (all five types), the scale
value rows, `residual_adjustment`, `n`, `p`, and the bias factor, all validated on
save to match the embedded DFM snapshot.

**Simulated results are not persisted.** `results_tab` stores the owned target
inputs and a compact `simulation_summary` (per origin and total: mean, standard
error, minimum, and the 0/5/.../100 percentile ladder, for unscaled and scaled),
plus the `random_seed` and `simulation_count` that produced them. The full
10,000 x W reserve array stays in memory. Reopening the page re-runs the
simulation from the stored seed, which is bit-reproducible, and the recomputed
summary is asserted against the stored one so a drift is detected rather than
silently accepted. This keeps a Bootstrap method JSON the same order of size as a
Cape Cod one on a network drive.

Revision projections follow the BF/CC concurrency model:

- `owned_projection`: details tab, DFM name, model type, residual display flags,
  smoothing parameters, user scale entries, every simulation input including the
  seed, target ultimate name, per-origin scaling methods and CVs, output flags.
- `derived_projection`: origin/development labels, the embedded DFM snapshot and
  its revision, the residual grid, the scale rows, and the simulation summary.
- `publication_projection`: identity + origin labels + `bootstrap_ultimate`.

Sidecar: `source_kind = "bootstrap"`, `method_type = "Bootstrap"`,
`method_type_code = 6`, `data_format = "Vector"`, precedents = the DFM method and
the target ultimate vector.

Dependency propagation mirrors CC: a durable change to the DFM or to the target
ultimate refreshes the method through
`calculated_dataset_service.recalculate_dependents` (new `bootstrap_updates` wave)
and marks the branch Review Needed. Because the DFM is a *method* precedent
rather than a dataset precedent, `calculated_dataset_service` gains a
method-to-method edge for this wave.

The published output vector is the **scaled** expected ultimate at full floating
precision, matching ResQ's `OutputVector`.

## ResQ Migration

- `METHOD_TYPE_BOOTSTRAP_CODE = 6`.
- `export_bootstrap` reads the ResQ `xBootstrapMethod` (`ModelType`,
  `BiasAdjustment`, `ResidualAdjustment`, `SimulationCount`, `RandomSeed`,
  `EstimationVariance`, `ProcessVariance`, `PreventNegativeData`,
  `ScaleValueSmoother_*`, `ScaleValues_*`, `TargetUltimate`,
  `TargetReserveValues`, `TargetCVs`, `TargetScalingMethods`, `DFMMethod`,
  `OutputVector`, `Notes`) and builds the owned payload; the residual grid and
  scale rows come from `recalculate_bootstrap_method(...)` against the migrated
  DFM snapshot so all producers share one calculation path.
- Vector export branch mirrors CC (`BST@` prefix, `include_bootstrap_methods`
  flag, `bootstraps_written` count, `_find_bootstrap_for_vector`, macro touch
  points).
- Migration must resolve the DFM **within the same reserving class**.
  `xResQProject.GetBootstrapMethod(name)` and `GetDFMMethod(name)` search the
  whole project and silently return a same-named method from a different
  reserving class; always go through `xReservingClass`.

## Verification

Reproduced against live ResQ COM for COL / `F 72 A`, feeding
`bootstrap_simulation` the same triangle and ratios ResQ holds:

| Quantity | Max relative error |
| --- | --- |
| Selected ratios vs `SelectedRatioValues` | 0 |
| Fitted cumulative vs `PredictedValues` | 1.8e-16 |
| Unscaled residuals vs `ResidualsByType(...,0)` | 1.5e-14 |
| Bias-adjusted residuals vs type 1 | 1.5e-14 |
| Scaled residuals vs type 2 | 1.5e-14 |
| Scaled + bias adjusted vs type 3 | 1.4e-14 |
| Zero-average residuals vs type 4 | 1.6e-14 |
| `phi` / `Scale^0.5` vs `ScaleValues_Residuals` | 1.8e-15 |
| `residual_adjustment` vs `ResidualAdjustment` | 2.8e-17 |

Both ODP models are covered: the single-scale branch against `F 72 A` itself,
the varying-scale branch against a second live ResQ bootstrap with
`ModelType = 1`.

### Development-ratio precision

`dfm_contract.canonical_number` rounds every persisted DFM number to six
decimals, which is right for displaying a ratio and wrong for chaining one. The
Bootstrap multiplies ten selected ratios together to back-fit the triangle, and
reading the stored six-decimal values instead of re-deriving them moves the
residuals by 1.3% and the scale parameter from 21.916253 to 21.916232. V1
therefore adds `dfm_contract.selected_ratio_values`, which re-derives computed
averages from the stored triangle at full precision and returns User Entry and
benchmark rows as stored, because there the six-decimal value *is* the input.
Triangle values themselves are exact at six decimals, so nothing else is lost.

Residual *grids persisted in the method JSON* still round to six decimals like
every other ArcRho statistic; that shows up as a <= 3e-5 relative difference
against ResQ on the smallest residuals and is a storage projection, not a
calculation difference.

### Stochastic layer

The stochastic layer cannot be bit-reproduced — ResQ's RNG is neither documented
nor exposed — so it is validated distributionally against ResQ's own
`Simulate()` run of 10,000 simulations (seed 735889630, captured over COM):

| Statistic | ArcRho (400k sims) | ResQ (10k sims) | z |
| --- | --- | --- | --- |
| Total expected reserve | 58,955 | 58,820 | 1.45 |
| Total prediction error | 9,172 | 9,304 | -1.96 |
| 2026 expected reserve | 66,092 | 65,949 | 1.60 |
| 2026 prediction error | 8,834 | 8,930 | -1.51 |

Every percentile of the total reserve from 5% to 95% agrees to within 3.8% of one
standard deviation (largest absolute gap 350 on a standard deviation of 9,304).
`z` uses ResQ's own sampling error at 10,000 simulations, so a value below about
3 means the two runs are indistinguishable samples of the same distribution.

Two design choices were settled empirically rather than from the technical note,
which is ambiguous on both:

- Projecting from the **pseudo** latest diagonal rather than the observed one.
  The observed diagonal gives a total prediction error of 6,852 against ResQ's
  9,304.
- Re-fitting each ratio as `SUM(pseudo cumulative at d+1) / SUM(pseudo cumulative
  at d)` rather than as the Mack-style weighted mean of pseudo link ratios, which
  biases the newest origin's expected reserve by +450.

A 10,000-simulation run takes about 1.4 seconds in pure Python, which is why the
contract can stay dependency-free.

## Deferred From V1

- The Mack bootstrap model (technical note 6). The radio ships disabled.
- `Discounting`, `Discounted Results`, `Diagnostics` and `Consolidation` tabs.
- `Cashflow Summary`, `Cashflow Detail`, `Aggregates`, `Origin Correlations`,
  `Cumulative Probability`, `Probability Density` and `Reserve Development`
  result exhibits.
- Scale value smoothing (`ScaleValueSmoother_*` is stored and round-trips, but
  `Smoothed` equals `Unsmoothed` until smoothing ships).
- Igloo export.
- ResQ/RPC sync.

## Test Plan

Items 1-5 and 12 are implemented in `python-api/tests/test_bootstrap_contract.py`
against `python-api/tests/fixtures/resq_bootstrap_f72a.json`, a read-only COM
capture of `F 72 A` including a full ResQ `Simulate()` run.

1. **Done.** Contract parity: the fixture reproduces the fitted triangle, all
   five residual types, both scale-parameter models, the residual adjustment,
   and `n`/`p` to <= 1e-9 relative error.
2. **Done.** The `ModelType = 1` fixture pins the varying-scale branch, including
   the `n_d` = data-cell-count rule and the "lower of the previous two" tail
   fallback.
3. **Done.** Statistical parity: 20k simulations against the stored ResQ summary;
   the total mean lands within 3 combined sampling standard errors and every
   5%-95% percentile within 12% of one standard deviation.
4. **Done.** Determinism: two runs with the same seed produce identical reserves;
   a different seed does not. Recalculation is idempotent under normalization.
5. **Done.** Additive/multiplicative/unscaled scaling reproduce technical note 8,
   including the "standard deviation is unchanged under additive scaling"
   invariant.
6. Create Bootstrap from an eligible Project Instance vector row; confirm tab
   order and that `Unscaled/Scaled Results` are hidden until a simulation exists.
7. Select a DFM; confirm Residuals, Simulation and Targets populate and that
   changing the DFM invalidates the stored summary.
8. Save/close/reopen restores everything from the method JSON + sidecar only, and
   the recomputed summary matches the stored one.
9. Native + aggregated output CSVs and sidecar metadata written; RS picks up the
   output vector with `method_type = "Bootstrap"`.
10. A durable DFM change triggers the `bootstrap_updates` wave and Review Needed.
11. Migration produces `BST@F 72 A - Bootstrap Net incurred with PV.json` whose
    residual grid matches live ResQ and whose published vector matches ResQ's
    scaled expected ultimates.
12. **Partly done.** The sidecar and output-variant projections are covered;
    cross-producer full-payload parity with `resq_data_migration.py` lands with
    the migration work.

## ResQ UI Reference

A control-by-control transcription of the ResQ `Edit Bootstrap Method` dialog for
`F 72 A`, captured so the ArcRho page can be built to the same layout without the
screenshots. Reproduce the **layout and control set**; render it in ArcRho styles
per `$arcrho-ui-design`, not in ResQ's Win32 chrome.

The ResQ window title is
`Edit Bootstrap Method: "<reserving class path>\<method name>"`, and every tab
shares a footer of `Simulate | Apply | OK | Cancel`. ArcRho replaces that footer
with the standard tabbed-page `Save | Cancel` bar plus a `Simulate` action on the
Simulation and Results tabs.

### Details

Right-aligned labels, single column of controls:

| Label | Control | Notes |
| --- | --- | --- |
| `Name :` | text input | `F 72 A - Bootstrap Net incurred with PV` |
| `Output Type :` | text input + `...` picker | `F 00 - Ultimate Net Loss` |
| `DFM :` | text input + `...` picker | `F 25 - Incurred DFM Bootstrap` |
| `Origin Length :` | numeric stepper, **disabled** | `12`, inherited from the DFM |
| `Development Length :` | numeric stepper, **disabled** | `12`, inherited from the DFM |

`Origin Length` and `Development Length` sit side by side on one row.

Below them a group box captioned `Bootstrap Model` holds two radio buttons
stacked vertically: `Mack`, then `Over-dispersed Poisson` (selected). The rest of
the tab is empty space.

### Residuals

Sub-tabs `Data` and `Graph`.

#### Residuals / Data

A header strip above the grid, laid out as three columns:

- Left column: `Single Scale Parameter` checkbox (checked); below it the label
  `Residual Type:` over a dropdown reading
  `Scaled, Bias Adjusted, Zero-Average`.
- Middle column: `Show Residual Scale Values` checkbox, then
  `Tile Grid and Graph` checkbox.
- Right: two group boxes side by side, `Residual Scale Values Smoother` and
  `Forecast Scale Values Smoother`, each containing a
  `Smoothing Parameter:` label, a numeric field (`0`), and a horizontal slider.
  The residual smoother is **disabled** while `Single Scale Parameter` is
  checked; the forecast smoother stays enabled.

Directly under the strip, in bold:
`Residuals adjusted by -0.000876 to make mean zero`.

The grid's first column header is `Accident Year`; development columns are
headed `(1) 5`, `(2) 17`, `(3) 29`, `(4) 41`, `(5) 53`, `(6) 65`, `(7) 77`,
`(8) 89`, `(9) 101`, `(10) 113`, `(11) 125` — the ordinal in parentheses
followed by the development age. One row per origin, `2017` through `2026`.
Residuals whose magnitude is large enough to flag are drawn in **red**; in the
reference method every value at or beyond about 1.5 is red and the rest black.
Empty cells are blank, not zero.

Below the residual rows, a `Scale^0.5 (Forecasting)` band spans the grid,
followed by four rows, each shaded differently and each carrying one value per
development column:

| Row | Fill | Editable |
| --- | --- | --- |
| `Unsmoothed` | light green | no |
| `Smoothed` | white | no |
| `User Entry` | light cyan | yes |
| `Selected` | yellow | no |

All four read `21.916` for the reference method. ArcRho's manual-entry cell style
replaces ResQ's cyan, and the standard output/derived cell styles replace the
green and yellow.

#### Residuals / Graph

Two checkboxes above the plot, `Show averages` and `Show Scale Values`, and a
`Filter` button at the top right of the plot area.

Chart title `Development Residuals (Scaled, Bias-Adjusted, Zero-Average)` — the
parenthetical tracks the selected residual type. Y axis runs `-3.0` to `3.0` in
`0.5` steps with a dashed line at zero; X axis is captioned `Development Year`
with one tick per development period (`5m`, `17m`, `29m`, ...). Points are drawn
as `x` markers, one per residual, with a right-hand legend entry `Residuals`.

### Simulation

Two group boxes side by side at the top:

- `Estimation Variance` containing an inner group `Pseudo Data Distribution`
  with six stacked radios: `None`, `Resampled`, `Normal`, `Log Normal`,
  `Gamma` (selected), `Over-dispersed Poisson`.
- `Process Variance` containing an inner group `Forecast Distribution` with the
  same six options, `Gamma` selected.

Below, one control per row:

| Label | Control |
| --- | --- |
| `Simulations :` | numeric stepper, `10000` |
| `Random seed :` | dropdown of recent seeds (`735889630`) + `New Seed` button |
| `Prevent negative cumulative data :` | checkbox, checked |

Then a group box `Action on negative mean` holding two side-by-side inner groups:

- `Gamma or Log Normal`: radios `Use value of 0.01`, `Use Normal distribution`
  (selected).
- `Over-dispersed Poisson`: radios `Use Over-dispersed Poisson`,
  `Use Gamma or Log Normal setting`, `Use negative mean` (selected). The whole
  group is **disabled** unless a distribution is set to Over-dispersed Poisson.

### Results

The sub-tab set is state-dependent, and ArcRho must match it:

- Before a simulation exists: `Targets`, `Diagnostics`, `Consolidation`.
- After a simulation: `Unscaled Results`, `Targets`, `Scaled Results`,
  `Discounting`, `Discounted Results`, `Diagnostics`, `Consolidation`.

V1 ships `Unscaled Results`, `Targets` and `Scaled Results`; the deferred tabs
are omitted rather than shown disabled.

#### Results / Targets

`Target Ultimate :` label with a full-width text input and a `...` picker,
reading `F 92 - Current Qtr Selected`.

Grid columns, in order: `Accident Year`, `Target Reserve`, `Scaling Method`,
`Coefficient of Variation (%)`, `Unscaled Expected Reserve`,
`Target - Unscaled Reserve`, `Target to Unscaled Ratio`. One row per origin plus
a bold `Total` row where `Scaling Method` and `Coefficient of Variation` read
`n/a`.

`Target Reserve` is a manual-entry column (cyan in ResQ). The three right-hand
columns are derived (yellow in ResQ) and read `0`, the negated target, and `0.0%`
until a simulation exists. `Scaling Method` is a per-row dropdown showing
`Additive` for every origin in the reference method.

#### Unscaled Results and Scaled Results

Both carry the same sub-sub-tab strip:
`Summary`, `Detail`, `Cashflow Summary`, `Cashflow Detail`, `Aggregates`,
`Origin Correlations`, `Cumulative Probability`, `Probability Density`,
`Reserve Development`, `Ultimates Graph`. V1 ships `Summary`, `Detail` and
`Ultimates Graph`.

**Summary** columns: `Accident Year`, `Latest`, `Expected Reserve`,
`Prediction Error`, `Prediction Error%`, `Expected Ultimate`, `DFM Reserve`,
`Reserve Difference`, plus a bold `Total` row. `Reserve Difference` is the
derived/yellow column. The leading `Latest` column is rendered as a frozen
header-style column.

**Detail** header controls, laid out left to right:

- A `Show:` group with radios `Reserves` (selected) and `Ultimates`.
- A radio `Statistics` (selected) paired with a dropdown reading
  `5% Percentiles`, and a radio `By Simulation`.

The grid transposes the summary: columns are the origin periods `2017` .. `2026`
followed by `Total`, and rows are `Mean`, `Standard Deviation`,
`Coefficient of Variation`, `Minimum`, then the percentile ladder `5%`, `10%`,
... at the selected step. The row header column and the first data column are
frozen.

**Ultimates Graph**: title `Ultimates by - Accident Year`, Y axis labelled with
the output dataset type (`F Net Loss`), X axis `Accident Year`, and a `Filter`
button top right. The mean is a green line with round markers labelled `Mean`;
four dashed navy percentile lines are labelled `90% Percentile`,
`75% Percentile`, `25% Percentile`, `10% Percentile`; between them the
distribution is shaded as graduated blue bands that widen for the least
developed origins.

### Output

Two group boxes stacked on the left:

- `Data`: checkboxes `Observed Triangle`, `Scale Parameters`.
- `Simulated Data`: checkboxes `Latest Simulated Diagonal`,
  `Development Factors`, `Reserves By Origin Period (Including Total)`,
  `Reserves By Origin And Development Period`, `Total Reserve Ranks`.

All seven default to checked. An `Export` button sits below the second group.

### Method list row

In the reserving-class method list, a Bootstrap method appears under its output
category (`Category : F Net Loss`) with `Bootstrap` in the Method Type column,
between its DFM and the Result Selection that consumes it:

```text
F 25 - Incurred DFM Bootstrap             DFM                ⚠
F 72 A - Bootstrap Net incurred with PV   Bootstrap          ⚠
F 72B - Bootstrap Net Incurred no PV      Bootstrap          ⚠
F 92 - Current Qtr Selected               Result Selection   ⚠
```

### Screenshots not yet captured

Two ResQ views would remove the last guesswork; neither blocks V1:

- `Results > Scaled Results > Summary`, to confirm its column set matches the
  Unscaled Summary rather than dropping `DFM Reserve`.
- `Residuals > Data` with `Show Residual Scale Values` ticked, to confirm how the
  scale rows render inline against the residual grid.

## Delivery Status

| Layer | State |
| --- | --- |
| `arcrho_api.bootstrap_simulation` (calculation engine) | Done, ResQ-verified |
| `arcrho_api.bootstrap_contract` (v1 payload, revisions, sidecar) | Done |
| `dfm_contract.selected_ratio_values` | Done |
| ResQ fixture + contract tests | Done (29 tests) |
| App-server service, router, schemas, propagation wave | Done (18 service tests) |
| Method page UI and Project Instance / shell wiring | Not started |
| ResQ migration (`export_bootstrap`, `BST@`, macro) | Not started |
| App-server docs, internal release fragment | Done |
| UI docs, user-facing release fragment | Not started |

### App-server layer notes

`build_bootstrap_output_sidecar` was rewritten to the canonical persisted
sidecar shape (`build_cape_cod_output_sidecar`'s keyword surface and key set)
because the thin `{name, kind}` projection it shipped with could not be read by
`dataset_sidecar_status_service`, the reserving-class index, or the dependency
graph.

The "method-to-method edge" is narrower than the plan implied. The dependency
graph is keyed by dataset name everywhere, so `bootstrap_service` resolves the
configured DFM **method** to the dataset it publishes
(`DFM@<name>.json` -> `details tab.output dataset`, falling back to the method
name) and registers the ordinary reverse edge against that dataset. Only the
*snapshot read* is method-to-method: it projects the DFM method JSON through
`dfm_snapshot_from_method` rather than reading a CSV. No new graph machinery was
needed in `calculated_dataset_service` beyond the `bootstrap_updates` wave, which
is fed from every earlier wave's fresh names — including DFMs whose published
ultimate did not change, because a Bootstrap embeds the DFM's triangle and
ratios rather than its output.

Two ordering facts the plan did not anticipate: a Bootstrap inherits its origin
axis and origin length from its DFM, so the DFM snapshot must be read before the
target ultimate vector (the only sequential source read); and an automatic
refresh whose only changed precedent is a DFM with an unchanged
`snapshot_revision` is skipped rather than re-simulated, because a 10,000-run
simulation costs about 1.4 s inside the reserving-class lock.
