# Bootstrap and Stochastic Consolidation

Status: Broken into 15 session-sized steps on 2026-09-23; step 1 done the same day (ResQ's segment targets made realistic, the five bootstraps and the Total consolidation saved in ResQ and captured as the reference fixture, rule 3 confirmed exactly). Step 2 done the same day: ResQ's rank generation is pinned exactly (normal copula via the lower Cholesky factor of `2·sin(π·ρ/6)`, eigenvalue clipping at 1e-6 for a non-positive-definite target, and the Uniform, Gamma and Student's T variants), and its normals are known to be polar-method draws on a `1/(2³¹ − 1)` uniform grid. The uniform generator itself was not identified, so step 3 is dropped and parity with ResQ is statistical. Step 4 done the same day: a bootstrap's stored summary now carries the half-percent percentile ladder, ultimate statistics and a total-reserve histogram, it hands a consolidation its individual simulations and ranks, all five segments match ResQ within sampling error, and the summary statistics follow ResQ's own definitions exactly. Step 5 done the same day: the consolidation calculation reproduces ResQ's Total consolidation exactly when fed ResQ's segment simulations and ranks, and with Arco's own ranks its total standard deviation is 74,498 against ResQ's 74,529 (0.04 standard errors). Step 6 done the same day: a Stochastic Consolidation has its own method file, output vector and sidecar with cross-class links to its segment bootstraps, it appears in a class's index as its own method type, and it records which bootstrap revisions it consumed so a changed segment can be reported. Step 7 done the same day: the app server can load a consolidation with a per-segment freshness report, run it without writing, list the bootstraps of the project's other classes for the segment picker, and save it; the load, run and picker are hosted reads and the save a hosted save. Step 8 done the same day: importing a class from ResQ brings each Bootstrap across with ResQ's settings and seed, built from the imported DFM through the shared contract and simulated once; it matches the app server's save byte for byte and ResQ's residuals to the stored six decimals. Step 9 done the same day: importing ResQ's Total class brings its Stochastic Consolidations across with their segments, factors, correlations and seed, consolidated once when every segment bootstrap is already in Arco and otherwise written unrun with the missing segments named; the import matches the app server's save byte for byte, and a ResQ calculated class now imports its datasets as ResQ's values instead of failing in the Engine. Step 10 found that step 9's import scope treats every ResQ calculated class as ResQ-valued; decision 2 was settled the same day and step 16 (the fix) ran before step 10. Step 16 done the same day: the import now hands a class to the Engine exactly when every level of its path is a type the project's reserving-class types define, on the same whitespace-collapsed, case-folded name key the Engine resolves types with; ResQ's `Calculated` flag no longer decides anything, and in the fake project the five segments are Engine-built and only Total keeps ResQ's values. Step 10 done the same day: Arco's fake project now holds `MP+PIP` and `Total` for All States, the five `F 72 A` segment bootstraps and the Total consolidation, all imported from ResQ, and every scaled statistic is within the parity bar (see [Parity results](#parity-results)). It found and fixed an import defect: a Bootstrap's target ultimate never lined up with its origins, so every imported bootstrap ran unscaled. Step 11 done the same day: a Bootstrap opens from the project list in its own floating window, on Results by default, and `Add > Bootstrap` on a vector row starts a new one; its Details, Residuals, Simulation and Targets tabs follow the page design, a header chip shows whether the stored run still matches the inputs, and Save runs the simulation. Step 12 done the same day: the Results tab shows the range by origin with the chosen percentiles (a full half-percent ladder one toggle away, and Copy), scaled/unscaled and reserves/ultimates switches, a distribution chart and a fan chart, stale and empty states, and a Simulate button that runs a save and reports its duration, since the server has no run-without-writing route for a bootstrap. Step 13 done the same day: a Stochastic Consolidation opens from the project list on Results, and `Add > Stochastic Consolidation` on a vector row starts a new one; its Segments tab lists each included bootstrap with its own figures and every reason it cannot be combined, its Correlation tab edits a mirrored target matrix and shows the correlations a run used and achieved, Consolidate runs without saving, and Results shows the combined range with the Bootstrap page's table and charts (now shared) plus a segment breakdown with the diversification. Step 14 done the same day: the Bridge, Engine and Gateway were redeployed with this plan's work, and a hosted load of the Total consolidation answers through the Gateway. Step 15 is blocked on open decision 3: Arco's project list does not show the imported Total class, because it is not one of the project's reserving-class types, so its consolidation cannot be opened from the app. The ResQ walk and the Arco COL bootstrap walk were done and agree with step 10. Step 15 stopped on decision 3 (the Total class is missing from the project list); decision 3 and "Simulate never saves" were settled the same day, adding steps 17-19, after which step 15 runs again. Step 17 done the same day: `Total` is now a level-5 composite reserving-class type in the fake project (the `TOTAL PA` formula, saved through the Project Settings save), so Project Instance lists it under `Direct Group`; a re-import from ResQ had the Engine build all 28 of its generated datasets, its `Net Loss--Incurred` equals the sum of the five segments and ResQ's own figures, and its `F 72 A` consolidation loads `up_to_date` with every segment current. Step 18 done the same day: a bootstrap's Simulate now runs on a run-only route (a hosted read) that merges the settings on screen onto the stored method as Save does and writes nothing; the run shows unsaved and the page stays dirty until Save, which publishes the same run from the same seed. On the live COL `F 72 A` the run took 1.8 seconds, changed no file, and reproduced the stored summary exactly. Step 19 done the same day: the Bridge, Engine and Gateway were redeployed with the run-only route (payload only this plan's work); the Gateway advertises it, and a hosted Simulate of COL `F 72 A` returned the stored summary in 1.8 seconds without changing any of the class's 317 files. Step 15 done the same day: both GUIs were walked end to end. ResQ's COL bootstrap and Total consolidation, and Arco's same two methods opened from the project list, give scaled totals within the parity bar (Total mean 508,444 in both, standard deviation 75,141 in Arco against 74,529). Simulate and Consolidate run without saving, and a changed correlation marks the run stale and moves the result. The walk found that Arco's `MP+PIP` incurred DFM lacks ResQ's 1.0018 tail factor, which flattens the oldest origins' ranges, so steps 20 (the import fix) and 21 (its deploy) were appended. Step 20 is blocked on open decision 4: ResQ keeps the 1.0018 tail on a computed average row (`Volume - all`), the import reads it, and the DFM contract's recalculation resets every computed row's tail to 1.0, so the fix is a change to how Arco calculates a DFM rather than to the import.
Last updated: 2026-09-23

## Ship impact

- **Server components (Bridge, Engine, Gateway): redeploy, safe for the released app.** Every server change adds something: new consolidation routes, a new hosted read and save kind, and a ResQ import that can now bring Bootstrap and Stochastic Consolidation methods across. Nothing the released app sends or reads changes shape. The one visible effect is that, once someone re-imports a class, its Bootstrap and Consolidation rows appear in the released app's project list and open only as plain vectors until the desktop release lands.
- **Desktop app: a frontend release, after the redeploy.** The two method pages and their Project Instance wiring reach users only in the next app release, which stays the user's decision and is not a step of this plan.
- **Order:** server redeploy first (step 14), then the app release whenever the user chooses.

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | ResQ's own bootstrap and consolidation results are captured as the reference to match | [x] | 2026-09-23 | 70 min | 11 min | The five segment ranges and the total range in ResQ are now realistic, saved, and kept as the reference Arco must match. |
| 2 | We know whether ResQ's random numbers can be reproduced, and how it builds correlated rankings | [x] | 2026-09-23 | 90 min | 34 min | ResQ's way of pairing up segment simulations is now known exactly; its random numbers themselves could not be reproduced, so Arco's ranges will match ResQ's within sampling error rather than to the last digit. |
| 3 | Arco can draw the same random numbers as ResQ from the same seed (only if step 2 found how) | [ ] | | 90 min | | Dropped: ResQ's random stream could not be identified. |
| 4 | A bootstrap reports a fuller set of percentiles and hands its individual simulations to a consolidation | [x] | 2026-09-23 | 55 min | 12 min | A bootstrap now keeps every half-percent of its range, its ultimates and a histogram, and all five segments agree with ResQ within sampling error. |
| 5 | Arco can combine several segments' simulations with chosen correlations, matching ResQ | [x] | 2026-09-23 | 70 min | 7 min | Arco can now combine the five segment ranges into one total range with chosen correlations, and it lands where ResQ's does. |
| 6 | A consolidation can be saved and reopened as its own method with its own output | [x] | 2026-09-23 | 60 min | 24 min | A consolidation now has its own saved form: its segments, correlations and combined range, an output vector, and a place in the project list, and it can tell when a segment has changed. |
| 7 | A consolidation can be opened, run and saved through the server, reading bootstraps from other classes | [x] | 2026-09-23 | 75 min | 14 min | A consolidation can now be opened, run and saved, it reads its segments from their own classes, and on opening it says which segment changed since the last run. |
| 8 | Importing a class from ResQ brings its bootstrap methods across | [x] | 2026-09-23 | 70 min | 29 min | Importing a class from ResQ now brings its bootstraps across with ResQ's settings and seed, already run once, and their residuals agree with ResQ's. |
| 9 | Importing a total class from ResQ brings its consolidation across | [x] | 2026-09-23 | 65 min | 21 min | Importing the Total class from ResQ now brings its consolidations across, already run when the segment bootstraps are in Arco, and the Total's own triangles and vectors arrive with ResQ's numbers. |
| 16 | Re-importing a segment class keeps Arco calculating its own figures; only the total class keeps ResQ's (runs before step 10) | [x] | 2026-09-23 | 50 min | 9 min | Re-importing BI Total, CMPxCAT, COL, MP+PIP or PD+UMPD from ResQ now has Arco build their generated figures itself; only the Total class, which Arco's class list does not define, keeps ResQ's numbers. |
| 10 | The fake project holds all five segment bootstraps and the total consolidation, checked against ResQ | [x] | 2026-09-23 | 60 min | 20 min | Arco's fake project now has the five segment bootstraps and the total consolidation from ResQ, scaled to ResQ's targets, and every range lands within sampling error of ResQ's. |
| 11 | The bootstrap page opens from the project list, with its setup and residual tabs | [x] | 2026-09-23 | 90 min | 23 min | A bootstrap now opens from the project list in its own window, with tabs to set up the model, check its residuals and targets, and a chip that says whether the saved run is still current. |
| 12 | The bootstrap page shows its results: ranges, percentiles and charts | [x] | 2026-09-23 | 90 min | 13 min | A bootstrap's Results tab now shows its range by origin with your chosen percentiles, a distribution chart and a fan chart, switches between scaled and unscaled and between reserves and ultimates, and a Simulate button that says how long the run took. |
| 13 | The consolidation page lets you pick segments, set correlations and see the combined range | [x] | 2026-09-23 | 100 min | 21 min | A consolidation now opens from the project list in its own window: pick bootstraps from other classes, set their correlations in a mirrored matrix, press Consolidate, and read the combined range, its charts and each segment's share. |
| 14 | The server components carry the new calculations and imports | [x] | 2026-09-23 | 30 min | 9 min | The server now opens, runs and saves consolidations and imports bootstraps and consolidations from ResQ, so the new pages work against the shared workspace. |
| 17 | The fake project's Total class appears in the project list, built by Arco as the sum of the five segments (runs before step 15) | [x] | 2026-09-23 | 40 min | 8 min | The Total class now shows in the project list under Direct Group, Arco builds its figures as the sum of the five segments, and its consolidation opens as up to date. |
| 18 | Simulate on a bootstrap runs without saving, like Consolidate does (runs before step 15) | [x] | 2026-09-23 | 50 min | 10 min | Simulate on a bootstrap now shows a fresh run without saving it; the window says the run is not saved yet, and Save keeps it. |
| 19 | The server components carry the bootstrap's run-only calculation (runs before step 15) | [x] | 2026-09-23 | 25 min | 6 min | The shared server now runs a bootstrap's Simulate for the desktop app, so a run comes back quickly and saves nothing. |
| 15 | The whole flow is checked by hand in both ResQ and Arco | [x] | 2026-09-23 | 80 min | 20 min | Both apps were walked by hand: the COL bootstrap and the Total consolidation open, run and show ranges that agree with ResQ's, and a changed correlation moves the result; one segment's oldest years were found to lack ResQ's tail factor. |
| 20 | The MP+PIP bootstrap carries ResQ's tail factor, so its oldest years get their range | [ ] | | 55 min | | Blocked 2026-09-23 on open decision 4: matching ResQ's tail needs a change to how Arco calculates a DFM. |
| 21 | The server components carry the tail-factor fix | [ ] | | 25 min | | |

Overall: 18 of 20 steps done (step 3 dropped). Estimated 1,250 min, actual so far 291 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in the [plans index](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

## Goal

Arco produces reserve ranges from a bootstrap that match ResQ's for the same model — exactly if ResQ's random stream can be reproduced, otherwise within sampling error — and combines the ranges of several segments into one total range the way ResQ's Stochastic Consolidation does, with the Total class of `PRNJ - PA\PA\All States\Direct Group` and its `F 72 A - Bootstrap Consolidation Net Incurred with PV` as the reference case.

The pages carry ResQ's core features but not its layout; [Page design](#page-design) says what changes and why.

## What already exists

- **The bootstrap calculation** — [bootstrap_simulation.py](../../python-api/src/arcrho_api/bootstrap_simulation.py) and [bootstrap_contract.py](../../python-api/src/arcrho_api/bootstrap_contract.py). Every deterministic formula (fit, the five residual types, scale parameters, residual adjustment) reproduces ResQ to 1e-14, and the simulation matches ResQ's own run distributionally. The formulas, and the two choices settled empirically, are documented in [frontend/docs/plans/bootstrap_method_plan.md](../../frontend/docs/plans/bootstrap_method_plan.md), which stays the calculation reference; this plan owns everything still to deliver. The persisted format is now `arcrho-bootstrap-v4` (the v4 migration renamed it), not the `...-by-tab-v1` that older plan names.
- **The bootstrap server layer** — [bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py), [bootstrap_router.py](../../frontend/app_server/api/bootstrap_router.py), the `bootstrap_load` hosted read, the `bootstrap_method` hosted save, and the `bootstrap_updates` propagation bucket in the Engine. Domain doc: [bootstrap.md](../../frontend/docs/app_server/domains/bootstrap.md).
- **Tests** — 29 contract tests pass (they need pytest; see the python-test-runner memory). Of 17 service tests, `test_saved_method_embeds_the_dfm_snapshot_and_a_simulation_summary` fails at HEAD because it still expects six-decimal triangle values, and methods have kept full precision since 2026-09-08. Step 4 fixes it.
- **Not started:** the bootstrap page, the bootstrap ResQ import, and everything for Stochastic Consolidation (no contract, service, page, or import).

## The reference model in ResQ

Project `NJ_Annual_Prod_202605_Fake`, which agents may read and write in both ResQ and Arco.

**The consolidation**, class `PRNJ - PA\PA\All States\Direct Group\Total` (a ResQ calculated class), method `F 72 A - Bootstrap Consolidation Net Incurred with PV`, read over COM on 2026-09-23:

| Setting | Value |
| :--- | :--- |
| Base triangle type | `Net Loss--Incurred` |
| Output type | `F 00 - Ultimate Net Loss` |
| Consolidate based on | Scaled |
| Consolidate reserve cashflows | off |
| Correlation type | Specified (`ctSpecifiedCorrelation` = 2) |
| Dependency type | Normal (0); degrees of freedom 20 (used only by Student's T) |
| Random seed / simulations | 1514684455 / 10,000 |
| Included methods, all with factor 1 | `F 72 A - Bootstrap Net Incurred with PV` in `BI Total`, `CMPxCAT`, `COL`, `MP+PIP`, `PD+UMPD` (COL spells it "incurred") |
| Target rank correlations | BI Total–PD+UMPD 0.38, CMPxCAT–COL 0.34, all others 0 |
| Adjusted correlations | 0.395315 and 0.354169 |

The adjusted values are exactly `2·sin(π·ρ/6)`, the standard conversion from a target rank correlation to the linear correlation of a normal copula. The achieved rank correlations of ResQ's stored ranks are 0.392 and 0.337.

**The five segment bootstraps** all use: Over-dispersed Poisson with a single scale parameter, Gamma for both pseudo-data and forecast distributions, 10,000 simulations, prevent negative cumulative data, target `F 92 - Current Qtr Selected` (trailing space in ResQ's name) with Additive scaling for every origin, DFM `F 25 - Incurred DFM Bootstrap` over `Net Loss--Incurred`, 10 annual origins 2017–2026 and 11 development periods including one tail period. Seeds: BI Total 1110418176, CMPxCAT 603792887, COL 735889630, MP+PIP 1503843498, PD+UMPD 229197640. Each class also has an `F 72B ... no PV` twin with forecast distribution None and no target.

**ResQ does not keep simulated results unless the method is saved after simulating.** On 2026-09-23 none of the ten bootstraps had saved reserves, and pressing Consolidate in the GUI stopped with "Cannot consolidate because ...BI Total\F 72 A... has no saved scaled reserves." The consolidation ranks, however, are available without any saved reserves, so ResQ regenerates them from the seed on demand.

**Data made realistic, and results saved (step 1, 2026-09-23).** Only `F 92 - Current Qtr Selected ` changed; no triangle was touched, so every `Net Loss--Incurred` keeps its aggregation formula and no model setting moved. In each segment the Result Selection that writes `F 92` had every origin overridden by hand (BI Total, CMPxCAT, COL, MP+PIP) or selected `F 91 - Current Qtr Indicated` (PD+UMPD). `tools/resq_bootstrap_capture.py targets` cleared the overrides, added `F 25 - Incurred DFM Bootstrap` to PD+UMPD's selection, gave `F 25` weight 1 and every other dataset weight 0 for all origins, and saved. So `F 92` now equals the `F 25` DFM ultimate in every segment (full precision in the fixture's `target_ultimates`):

| Segment | `F 92` by origin 2017 → 2026, rounded |
| :--- | :--- |
| BI Total | 145,246 · 160,759 · 154,928 · 155,250 · 187,389 · 181,094 · 216,799 · 237,302 · 206,716 · 189,472 |
| CMPxCAT | 31,856 · 43,879 · 41,169 · 47,437 · 62,935 · 67,756 · 69,540 · 60,682 · 48,190 · 44,451 |
| COL | 110,677 · 129,394 · 122,939 · 123,085 · 173,289 · 195,136 · 185,380 · 160,449 · 120,635 · 122,641 |
| MP+PIP | 119,992 · 127,583 · 127,276 · 157,650 · 167,325 · 151,618 · 141,612 · 135,441 · 112,906 · 102,880 |
| PD+UMPD | 101,379 · 103,700 · 109,822 · 99,170 · 128,565 · 134,458 · 137,822 · 139,638 · 104,893 · 105,836 |

Then `run` simulated and saved the five `F 72 A` bootstraps and consolidated and saved the Total. Every segment passes the plausibility test. Scaled total reserve, as saved in ResQ:

| Segment | Mean | Std. dev. | CV | 99.5% |
| :--- | :--- | :--- | :--- | :--- |
| BI Total | 273,917 | 56,987 | 20.8% | 452,639 |
| CMPxCAT | 33,708 | 5,922 | 17.6% | 51,783 |
| COL | 58,886 | 9,304 | 15.8% | 84,353 |
| MP+PIP | 57,372 | 33,140 | 57.8% | 160,310 |
| PD+UMPD | 84,560 | 16,379 | 19.4% | 134,286 |
| Total consolidation | 508,444 | 74,529 | 14.7% | 724,130 |

MP+PIP sits close to the 60% CV bound because its older origins carry small negative DFM reserves against a large 2026 one; it passes and was left as is. COL's unscaled results are identical to the older `resq_bootstrap_f72a.json` fixture (same seed, same triangle), so that fixture stays valid.

**COM conventions** (pinned in step 1): simulation indices run 1..n, and 0 or n+1 return garbage instead of raising; `TotalRank` is a permutation of 1..n with rank 1 the smallest total; reserve summaries use origin 0 for the total; `PercentileValue` takes a fraction (0.995); a bootstrap's origin and development indices are 1-based except `DevelopmentCount`, which takes the 0-based origin; residual cells with no value read -99,000,000,000; the consolidation's method index is 1-based; `SimulatedReservesByClass` takes origins 1..n with n+1 as the total (origin 0 access-violates). A consolidation reloaded from the database keeps its ranks and consolidated reserves, but its achieved correlations and reserves by class read as zero until it is consolidated again in memory, which reproduces the saved run exactly.

**The editor** (GUI walk, 2026-09-23) has tabs Details, Included Methods, Correlation, Simulation, Results, Output, Notes, Audit Log. Details holds name, base triangle type, output type, the two read-only lengths, "Consolidate based on Scaled (recommended) / Discounted-Inflated", and "Consolidate reserve cashflows where possible". Included Methods is a grid of index, reserving class, method (with a picker), factor, and Move Up/Down. Correlation holds the four correlation options, the four dependency types, degrees of freedom, and a symmetric matrix with Target (Rank) and Adjusted sub-tabs. Simulation holds only the (read-only) simulation count and the seed with New Seed. Results is empty until Consolidate. Output lists export checkboxes.

**Arco's copy of the fake project** had BI Total, CMPxCAT, COL and PD+UMPD under `All States\Direct Group`, each with `F 25` and `F 92`, but no bootstrap methods, and neither `MP+PIP` nor `Total` for All States. Since step 10 it holds all six classes, with each segment's `F 25`, `F 92` and `F 72 A` re-imported from ResQ and `MP+PIP` and `Total` imported whole.

## How ResQ consolidates

From the ResQ manual (pages `correlations_tab.htm`, `included_methods_tab.htm`, `xBootstrapReserves_TotalReserveRank.htm`, `Bootstrap_Consolidation_Hints.htm` under `E:\XWSpace\ResQ API Doc\reference\resq_help_manual_decompiled\html`) and the probe above:

1. Every included method has already simulated `n` sets of reserves by origin; each simulation's total reserve has a rank within its method (`TotalRank(sim)`).
2. The consolidation generates an `m × n` matrix of ranks (`ConsolidationRanks(method, sim)`) from its own seed so that the rank correlation between methods approaches the adjusted target matrix under the chosen dependency structure (Cholesky of the adjusted matrix, per the manual).
3. Consolidated simulation `s` takes, from each method `c`, the simulation whose total-reserve rank is `ConsolidationRanks(c, s)`, multiplies its reserves by the method's factor, and adds them origin by origin. The whole origin vector of a simulation moves together.
4. A method whose base triangle type differs from the consolidation's is adjusted by the difference between the two latest diagonals; in the reference model every method's base equals the consolidation's, so no adjustment applies.
5. "0% correlated" means independent, "100% correlated" fully rank-correlated, "As it comes" pairs simulations in the order they were generated (not recommended).

**Rule 3 confirmed exactly (step 1).** For all 10,000 simulations, the consolidated scaled total equals the sum over segments of factor × the segment's scaled total from the simulation whose `TotalRank` equals `ConsolidationRanks(c, s)`; the worst relative difference is 4e-16. Ranks run 1..n with rank 1 the smallest total reserve, and each segment's ranks are a permutation, so there are no ties. The origin vector travels with the rank: each segment's reserves by origin in the consolidation are exactly that simulation's reserves by origin. The achieved rank correlation between two segments is the Pearson correlation of their `ConsolidationRanks` rows (0.3918 and 0.3370 against targets 0.38 and 0.34), and the achieved linear correlation is the Pearson correlation of their combined scaled totals (0.4036 and 0.3440). [test_resq_consolidation_fixture.py](../../python-api/tests/test_resq_consolidation_fixture.py) pins all of this.

**ResQ's summary statistics (step 4, 2026-09-23).** A reported standard deviation divides by n, not n − 1, and `PercentileValue(p)` is the sorted sample at 0-based position floor(p·n), capped at the maximum, with no interpolation (so 0 is the minimum and 1 the maximum). Recomputed from the captured totals this way, all 253 captured percentiles (five segments scaled and unscaled, and the consolidation) and every total standard deviation match exactly. Arco's bootstrap summary now uses the same definitions, so a consolidation fed ResQ's simulations reproduces ResQ's statistics exactly; [test_bootstrap_segment_parity.py](../../python-api/tests/test_bootstrap_segment_parity.py) pins it.

Step 1 confirms rule 3 exactly against ResQ's numbers; step 2 establishes how rule 2 generates ranks for each dependency type and how a non-positive-definite target is adjusted.

**Rule 2 established (step 2, 2026-09-23).** Probed in memory on the Total consolidation with `tools/resq_random_probe.py`, seed 1 unless stated; "exact" means every one of the 5 × 10,000 ranks matched.

1. **The adjusted matrix.** Each target off-diagonal ρ becomes `2·sin(π·ρ/6)` (exact to 1e-16), whatever the dependency type. If that matrix is not positive definite, ResQ clips its eigenvalues at 1e-6 and rescales to a unit diagonal, `C = V·max(λ, 1e-6)·Vᵀ`, then `C[i, j] / sqrt(C[i, i]·C[j, j])`. This matched a symmetric and an asymmetric non-positive-definite target to 7e-16; Higham's nearest correlation matrix differs by 0.055. A positive-definite matrix passes through unchanged.
2. **Normal.** Draw `Z`, an `m × n` matrix of standard normals, filled method by method: method 1's n draws come first, then method 2's, and so on. Compute `X = L·Z` with `L` the lower Cholesky factor of the adjusted matrix. `ConsolidationRanks(c, s)` is the rank of `X[c, s]` within row c, with rank 1 the smallest. This is exact for the reference target, the identity and two non-positive-definite targets. The normals come from the same stream, and in the same order, as a bootstrap's forecast draws with the same seed (see [Random numbers](#random-numbers)).
3. **Uniform.** The same with `Z` replaced by raw uniforms `U` from the same stream, method-major: `X = L·U`. Method 1's ranks are exactly the ranks of the stream's first 10,000 uniforms, and the achieved rank correlations (0.3758, 0.3260) match the model's expectation (0.3758, 0.3363) within sampling error.
4. **Gamma.** The same with Gamma(shape 1) marginals, `X = L·(−ln U)`, from the same uniforms. For every method whose row of `L` is a unit vector, the ranks are exactly the reverse of the Uniform ranks for the same seed. The achieved rank correlations (0.4236, 0.3860) match the model (0.4253, 0.3906).
5. **Student's T.** A multivariate t: `X = L·Z / sqrt(W/ν)`, with one chi-square `W` on ν degrees of freedom per simulation, shared by every method. With ν = 5 the upper-5% co-exceedance was 0.244 and 0.266, against the model's 0.266 and 0.244; a separate t per element gives 0.20. The draw order of `W` against `Z` was not pinned, and changing ν changes every rank, method 1's included.
6. **0% correlated** gives the identity matrix and exactly the Normal ranks with an identity target. **As it comes** gives exactly the same ranks and the same pairing as 0% in this ResQ build: each segment's contribution to consolidated simulation s is its simulation at rank `ConsolidationRanks(c, s)`, not its simulation s. **100% correlated** is the all-ones matrix through the repair in point 1 (adjusted off-diagonals 0.9999990000008), then point 2. It gives near-identical ranks across segments, not identical ones.

**Step 5 result (2026-09-23).** Fed ResQ's segment totals and ResQ's `ConsolidationRanks`, Arco's combination reproduces every one of the 10,000 consolidated totals to 1e-9, ResQ's total ranks exactly, its mean, standard deviation and captured percentiles to 1e-12, and its achieved rank and linear correlations to 1e-9. With Arco's own ranks for the reference seed and target, the achieved rank correlations are 0.381 (target 0.38) and 0.336 (target 0.34), and the total standard deviation is 74,498 against ResQ's 74,529, 0.04 combined standard errors apart; the mean is unchanged because every rank row is a permutation. The calculation takes the upper triangle of a target matrix as authoritative and mirrors it, since the page edits cells above the diagonal. The diversification view reports the sum of the segments' standalone standard deviations, 121,730, against the total's 74,498.

## Random numbers

Arco draws from Python's seeded generator, so a run is reproducible from its seed but differs draw for draw from ResQ's. A first black-box search on 2026-09-23 found no match:

- **Consolidation ranks:** ResQ's 5 × 10,000 ranks for seed 1514684455 were compared with the ranks of independent uniforms and polar-method normals from the Delphi linear congruential generator, .NET `System.Random`, and 53-bit Mersenne Twister, in both method-major and simulation-major order. No match.
- **Raw bootstrap draws:** on COL `F 72B`, held only in the probe's memory and never saved, estimation variance None and forecast distribution Normal leave each simulated cell as `mean + sd·Z`, so the standard-normal draws `Z` can be backed out exactly (scale 21.916, means from the per-simulation factors ResQ reports, cumulative starting at the latest simulated diagonal). ResQ is deterministic per seed (seed 1 twice gave identical cells). Searching the first 20,000 outputs of seven generators (Delphi LCG, .NET, Mersenne Twister 53- and 32-bit, MINSTD 16807 and 48271, Wichmann–Hill) under inverse-CDF, Box–Muller and polar transforms found no draw that matches.

ResQ's automation library is a single native binary (`ResQ3Automation.dll` 5.8.0, WTW); the search stays black-box — inputs against outputs — and does not inspect the binary. Step 2 continues it with a time box and a fixed stopping rule; exact parity is a bonus, and statistical parity is the acceptance bar either way.

**Step 2 result (2026-09-23): the draw pipeline is known, the uniform generator is not.** The first search's backed-out draws were wrong, not ResQ's generator. On COM, `DevelopmentFactors(d, s)` returns cumulative age-to-ultimate factors, not age-to-age factors. With estimation None and a Normal forecast, each future incremental is `m + φ·sqrt(|m|)·Z`, where `m` is the deterministic chain-ladder incremental from the latest diagonal (not recursive) and φ is `ScaleValues_Forecasting`. Backed out that way, the draws are standard normal and independent (2,000 simulations, mean 0.002, sd 1.001). What is pinned:

- **Normals.** They come from Marsaglia's polar method, and both outputs of an accepted pair are used: the one built from the first uniform comes out first, the other is kept for the next draw. The kept value carries into the next simulation. A pair is rejected when `s = v1² + v2² ≥ 1`, and its two uniforms are skipped.
- **Draw order in a bootstrap.** One draw per future cell, oldest origin first and development ascending within an origin. The tail column draws nothing. Simulation 1's draws do not depend on the simulation count, and each seed gives the same stream every time.
- **Uniforms.** Each uniform is `k / (2³¹ − 1)` for a 31-bit integer k, recovered exactly from accepted pairs, and `v = 2u − 1`. The first uniform for seed s is `((1265966691 · s) mod 2³²) >> 1` exactly. This held for 13 seeds read exactly (2 to 16, 100, 1,000, 65,536, 2³¹ − 2) and was consistent with 9 more read only approximately, including 1514684455. Later uniforms are piecewise linear in the seed. Over seeds 1 to 40, one step of seed moves the second uniform by one of three amounts (24,486,009, 24,486,898 or 24,489,455, give or take 1), and later positions by a few more amounts each. One of those amounts is always seed 1's own value at that position.
- **The consolidation shares the generator.** For a given seed its uniform stream starts at the same point as a bootstrap's, so ranks built from ResQ's normals are exact (see rule 2 under [how ResQ consolidates](#how-resq-consolidates)). A contiguous 10,000-uniform stretch for seed 1 was rebuilt from the Uniform consolidation's method-1 ranks together with the bootstrap's accepted pairs: 3,899 of 5,000 pairs exact, 1,101 rejected, which is the expected 21.5% rejection rate.
- **Generators ruled out**, by within-stream tests that hold for any seed: every LCG and MLCG modulo 2³¹ − 1 and every 32-bit LCG (mapped to 31 bits by `>> 1`, mask, or `Random(MaxInt)`-style scaling); shuffled MLCGs (Numerical Recipes `ran1`, `RtlRandom`); order-2 MRGs modulo 2³¹ − 1 and L'Ecuyer's 1993 MRG; lagged-Fibonacci and subtractive generators with lags under 700 (`.NET System.Random`, glibc `random()`); MT19937 through its twist recurrence; xorshift32; and L'Ecuyer's 1988 combined generator. Seeded membership searches also ruled out MT19937, Java's `Random` and `.NET`. The lattice alone rules out every generator whose uniforms sit on a 2⁻³², 2⁻⁵³, 1e-9 or `1/2147483563` grid (MRG32k3a, Numerical Recipes `ran2` and `ran3`, and xorshift, xoroshiro, KISS or MWC scaled the usual way), and the polar finding makes the inverse-CDF, Box–Muller and Ziggurat transforms moot.

The search stopped at about 35 minutes of the 90-minute box. Every listed family had been ruled out, and what is left needs a structural idea rather than more enumeration, so step 3 is dropped. Arco keeps its own seeded generator; parity with ResQ is statistical. The rank algorithm is known exactly, so Arco's consolidation matches ResQ exactly whenever it is fed ResQ's ranks or normals. A later attempt should start from the first-uniform formula and the piecewise-linear dependence on the seed. Together they point to a small state seeded by a 32-bit multiply, combined with a second component that has its own modulus or wrap. The probe's `draws` mode, and `ranks` with dependency Uniform and an identity target, give that data for any seed in seconds.

## Decisions

These are settled; a step that finds one wrong stops and records it under Open decisions.

- **The consolidation lists its segments explicitly.** Arco has no calculated reserving class, and this plan does not add one. A consolidation lives in any reserving class (the Total class here, imported as an ordinary class) and names each included bootstrap by reserving-class path and method name. It never reads the host class's datasets.
- **Only bootstraps can be included in V1.** ResQ also allows Practical Stochastic, MCMC, Stochastic Results, Stochastic Result Selection and nested consolidations; Arco has none of those methods.
- **Base triangle type is recorded, not used for adjustment, in V1.** An included bootstrap whose DFM input type differs from the consolidation's base type is refused with a message naming it. The reference model never needs the adjustment.
- **Consolidate based on Scaled only.** Discounting is not implemented for the bootstrap, so the Discounted option and the cashflow consolidation are left out.
- **Simulations are regenerated, never stored.** A bootstrap already rebuilds its simulations from its seed; a consolidation does the same for each included bootstrap when it runs, then applies its own ranks. Both methods persist a summary rich enough for every view on their Results tab, so opening a page never re-simulates.
- **Cross-class freshness is checked on open, not propagated.** A consolidation stores the revision of every bootstrap it consumed. When one has changed, the page says which and offers Consolidate; the save walk does not cross reserving classes in V1. Eager cross-class propagation is deferred.
- **Parity bar.** Deterministic quantities match ResQ to 1e-9 relative. The consolidation arithmetic (rule 3) matches ResQ exactly when fed ResQ's own simulations and ranks. Simulated statistics (mean, standard deviation, 5–95% percentiles) match within three standard errors of ResQ's own 10,000-run sampling error; with a reproduced random stream (step 3) they match exactly.
- **Canonical labels for the new method.** UI and JSON method type `Stochastic Consolidation` (already ResQ's name in `resq_migration/core.py`, code 7); source kind `stochastic_consolidation`; JSON format `arcrho-stochastic-consolidation-v4`; method file `methods/SCON@<Name>.json`; route prefix `/stochastic-consolidation/...`; page folder `frontend/ui/method_pages/stochastic_consolidation/`; CSS/DOM prefix `scon`; shell tab type and window kind `stochastic_consolidation`; tab state field `sconTab`. `SC` and `CON` are too easily confused with other prefixes, hence `SCON@`.
- **The model stays as built; the data is made realistic** (decision 1, settled 2026-09-23; the user allows the DFM input triangles and the ultimate vectors of `NJ_Annual_Prod_202605_Fake` to be changed freely so the model gives realistic results). Step 1 found that `F 92 - Current Qtr Selected ` sits at about 0.42-0.50x of the latest incurred diagonal in every segment, so every scaled reserve came out large and negative, while the unscaled runs were plausible (total mean / sd: BI Total 275,741 / 56,987; CMPxCAT 33,885 / 5,922; COL 58,820 / 9,304; MP+PIP 57,911 / 33,140; PD+UMPD 84,793 / 16,379). So each segment's `F 72 A` keeps its target `F 92` and Additive scaling, and the data changes instead, in this order: (1) make `F 92` realistic for the segment's triangle, preferably by changing its Result Selection so each origin selects a method consistent with the incurred development (for example the incurred DFM), otherwise by writing the values directly; (2) only if a segment's range is still implausible, replace its `Net Loss--Incurred` triangle with realistic entered values (which removes that triangle's aggregation formula). Realistic means the plausibility test in step 1 passes and each origin's target reserve is within half to double of the DFM reserve. Every change is made in ResQ, recorded in the reference-model section with the numbers written, and reproduced in Arco by step 10 (through the import, or by writing the same values).

- **Simulate never saves** (settled 2026-09-23). A bootstrap's Simulate runs without writing, like a consolidation's Consolidate, and Save persists the run on screen. Step 12 made Simulate send a save because the server had no run-only route; step 18 adds it.

## Page design

ResQ's editors put inputs and outputs side by side in one strip of tabs, hide the targets (an input) under Results, keep a Simulation tab that holds one control, and show results only as wide grids. Arco keeps every core feature and fixes those problems. Follow `$arcrho-ui-design` and the Cape Cod page for every visual rule; what follows is the structure.

**Common to both pages**

- A header bar carries the method name, a state chip (`Up to date`, `Inputs changed — run again`, `Not run yet`, or for a consolidation `A segment changed`), the primary action (`Simulate` or `Consolidate`), and Save/Cancel. The run shows progress and, when done, its duration and simulation count.
- Setup tabs come first, results after, notes and audit last. Results tabs show a clear empty state with the run button until a run exists, instead of disappearing.
- Every results view has a `Scaled / Unscaled` switch where both exist and a `Reserves / Ultimates` switch, as segmented controls in the tab toolbar, not radio groups inside the grid area.
- Percentiles are chosen once (default 50, 75, 90, 95, 99, 99.5) and used by every table and chart; a full 0–100% ladder is one toggle away.
- Numbers use the project's number formats; derived columns and manual-entry cells use the existing Arco cell styles rather than ResQ's cyan, green and yellow fills.

**Bootstrap page** — tabs `Details`, `Residuals`, `Simulation`, `Targets`, `Results`, `Notes`, `Audit Log`.

- `Details`: name, output type, DFM picker (the only data input), the inherited origin and development lengths read-only, and the model as a segmented control (ODP single scale / ODP varying scale; Mack shown disabled with a "not available yet" tooltip). The single-scale checkbox ResQ duplicates on the Residuals tab is the same setting and appears only here.
- `Residuals`: one toolbar with residual type, the scale-value smoothers and "show scale values"; below it the residual grid and the residual scatter by development period side by side on wide windows, stacked when narrow (this is ResQ's "Tile grid and graph", made the default). Large residuals are flagged with the project's warning colour, and the "residuals adjusted by … to make mean zero" line sits under the grid as a caption.
- `Simulation`: simulations, seed with New Seed, pseudo-data and forecast distributions as two dropdowns, prevent-negative, and the two negative-mean choices, the ODP one disabled unless a distribution is ODP.
- `Targets`: the target ultimate picker and the per-origin grid (target reserve, scaling method, CV used only by user-defined scaling, unscaled mean, difference, ratio), with a total row. ResQ puts this under Results; it is an input, so it sits with the setup tabs.
- `Results`: a summary table by origin with a total (latest, mean reserve, standard deviation, CV, the chosen percentiles, mean ultimate, DFM reserve, difference), then a chart panel: the distribution of the total reserve with the chosen percentiles marked, and the ultimates by origin as a fan chart (mean line, shaded percentile bands). Copy-to-clipboard on the table. ResQ's Detail grid (statistics by origin, transposed) becomes the full-ladder toggle of the same table.

**Consolidation page** — tabs `Details`, `Segments`, `Correlation`, `Results`, `Notes`, `Audit Log`.

- `Details`: name, output type, base triangle type, the inherited lengths read-only, simulations (read-only, taken from the segments, which must agree) and the seed with New Seed. ResQ's one-control Simulation tab is folded in here.
- `Segments`: one row per included bootstrap — reserving class, method (picker), factor, and, once available, each segment's own mean reserve, standard deviation and CV so the user sees what is being combined. Reordering by drag or Move up/down; add and remove rows. A row whose bootstrap has no run, a different simulation count, or a mismatched base type shows the reason inline.
- `Correlation`: the four options as a segmented control (Independent, Fully correlated, Specified, As generated), the dependency structure dropdown with degrees of freedom beside it only for Student's T, and the matrix. Editing a cell above the diagonal mirrors it below; values outside -1..1 are refused inline. A `Target / Used` switch shows the adjusted matrix actually used, and after a run an `Achieved` view shows rank and linear correlations.
- `Results`: the same summary table and charts as the bootstrap page for the total, plus a segment breakdown (each segment's mean, standard deviation and CV standalone, its share of the total mean, and the total's standard deviation against the sum of the standalone ones, i.e. the diversification the correlations give).

Deferred from both pages: discounting, cashflow views, Igloo and CSV export, the probability-density and cumulative-probability exhibits beyond the distribution chart, reserve development, and the Mack model.

## Open decisions

A step that meets one records it here and stops.

Decisions 1, 2 and 3 were settled on 2026-09-23. Decision 4 is open and blocks step 20.

**Decision 4 (open, found by step 20 on 2026-09-23): may a computed average row carry its own tail factor?** Matching ResQ's `MP+PIP` `F 25` needs a change to how Arco calculates a DFM, which step 20's guard forbids it to make alone.

- **Where ResQ's 1.0018 comes from.** Read over COM (named getters only, nothing saved): `F 25`'s tail column selects average row 1, `Volume - all`, an ordinary computed volume average (`AverageType` 0), and that row's `CustomAverages(1).TailFactor` is 1.0018. `SelectedTailFactor` is 1 (Initial Selection), whose tail `CurveValues(1, 0)` is the same 1.0018. It is not a curve or a user entry. Every other row's tail is 1.0 except the `Aug 2024` prior-analysis row (1.00031).
- **The import already reads it.** The ResQ import reads each row's `TailFactor` into the tail column, so the payload it builds carries 1.0018 on `Volume - all`.
- **The DFM contract then drops it.** The import finishes with the contract's recalculation, which sets the tail of every computed average row to 1.0 by design ("A computed average row has none and stays at 1.0", `_calculate_formula_values` in [dfm_contract.py](../../python-api/src/arcrho_api/dfm_contract.py#L1532-L1551)). The DFM page does the same (`summaryRowOwnsTail` in [dfm_state.js](../../frontend/ui/method_pages/dfm/dfm_state.js#L679-L694)): only User Entry and benchmark rows own a tail. Recalculating the stored `F 25` with 1.0018 written into that row gives back 1.0, and a 2017 ultimate of 119,776.77 against ResQ's 119,992.37, a ratio of exactly 1.0018 (reserve 0 against about 215).
- **No import-only fix is faithful.** The recalculation overwrites whatever the import writes. The only way round it inside the import would be to invent a user curve column holding 1.0018 and select it for the tail. That misstates ResQ's method, and a later save or export would carry the invented column.
- **Related harm.** Exporting this class back to ResQ writes each Arco row's tail over ResQ's `TailFactor`, so it would overwrite ResQ's 1.0018 with 1.0.
- **What a change would move.** A read-only scan of every stored DFM under `E:\ArcRho Server\projects` found 4,333 method files. None of the 3,877 in the current shape holds a computed row with a tail other than 1.0, because the recalculation has always forced it. The other 456 are in an older shape the scan did not parse. So keeping a stored tail on computed rows changes no stored result until a class is re-imported from ResQ or someone enters a tail by hand.

Options:

- **A (recommended): every average row owns its tail.** The contract and the DFM page keep the stored "- Ult" value of any row, computed rows included, with 1.0 when none is stored. Nothing else about averages changes. The Ratios tab's tail cell on a computed row becomes editable, as in ResQ. Before shipping, re-run the scan with the 456 older-shape files parsed; if any would move, ship with a republish of those methods. This is a new step (contract, page and tests together), after which step 20 re-imports `MP+PIP` and checks the by-origin parity. Step 21's deploy then carries it.
- **B: keep 1.0 for computed rows and accept the gap.** `MP+PIP`'s oldest two origins keep a flat range in Arco. The totals already sit within the parity bar. Step 20 would only add the by-origin comparison to the parity report and record the known gap.
- **C: an import workaround.** A synthetic tail column on the Curves tab, as described above. Not recommended.

**Decision 3 (settled 2026-09-23 by the orchestrating session): how the Total class appears in Project Instance.** Settled on a variant of B that needs no new code: Arco already models a total as a composite reserving-class type (the fake project's `TOTAL PA` is `BI Total + "PD+UMPD" + "MP+PIP" + CMPxCAT + COL`, exactly the five segments). So `Total` is added at level 5 with that same formula, through the Project Settings save path rather than a hand edit. It then shows in the tree like any class, and by decision 2 the Engine builds its datasets from source rows as the sum of the segments, which is what ResQ's calculated class does. A real project gets a total class the same way. Option A (showing folders that are not types) is not taken. Step 17 does it. Found by step 15, which recorded what follows.

_Original question:_ how a class that is not one of the project's reserving-class types appears in Project Instance. Step 15's Arco walk cannot open the Total consolidation from the project list, because the Total class does not appear there. Project Instance builds its class tree, and the class picker on the path bar, only from the project's reserving-class types, and `Total` is deliberately not one of them (decision 2 and step 16 rely on that, so Total keeps ResQ's figures). The class folder and both consolidations exist on disk (`PRNJ - PA\PA\All States\Direct Group\Total`, `SCON@F 72 A ...` and `SCON@F 72B ...`), but nothing in the app reaches them, and the walk tool cannot type a path. Options:

- **A (recommended): the tree also shows a class folder that exists on disk but is not a type path**, marked as an imported class, under the deepest level of its path that the tree already shows. The types still decide what the Engine builds (decision 2 is unchanged), and any class that ResQ imports stays reachable. The change is to the tree children service and its cache, plus a test, and it is its own new step before step 15 resumes.
- **B: add `Total` to the fake project's reserving-class types.** It is quick, but by decision 2 a re-import would then hand Total to the Engine, which would need Arco's own aggregation for Total's datasets. It also fixes only this project.
- **C: open a method by its path from somewhere else** (a search box or a typed path). It needs keyboard input, which the walk tool does not have, so step 15 could not use it either.

What step 15 had done before it stopped (nothing was saved in either app):

- **ResQ, COL `F 72 A`**, saved scaled results: mean 58,886, standard deviation 9,304, CV 15.80%, 99.5% 84,353.
- **ResQ, Total `F 72 A`**, after Consolidate in memory (then closed with Cancel): mean 508,444, standard deviation 74,529, CV 14.66%, 99.5% 724,130. This is identical to the saved run, so Consolidate reproduces it from the seed.
- **Arco, COL `F 72 A`**, opened from the project list on Results with `Up to date` and seed 735889630: mean 58,886, standard deviation 9,277, CV 15.8%, 99.5% 84,657. This is the same as step 10's table and within the parity bar. Details, Residuals, Simulation, Targets, Notes and Audit Log all render. Simulate was not pressed, because on the Bootstrap page it saves (step 12) and the walk must not save.

**Decision 2 (settled 2026-09-23 by the orchestrating session): which classes the import may hand to the Engine.** Step 10 found that step 9's scope rule skips the Engine for every class whose ResQ `Calculated` flag is true, and ResQ reports that for nearly every class in the fake project (`BI Total`, `COL`, `MP+PIP`, `Total`, and others), so re-importing a segment class would bring its generated datasets across as ResQ's values and break the Generated Dataset Import Parity rule. Settled on the recommended rule, which follows the standing principle that Arco's own configuration decides and ResQ's flags never do: **the import hands a class to the Engine exactly when every level of its path is a type the project's `reserving_class_types.json` knows**, resolved the way the Engine's `ReservingClassCatalog.resolve_type` resolves it. ResQ's `Calculated` flag no longer decides anything. No fallback on an Engine error is added. Step 16 implements it.

## Plan

Steps run in order. Steps 11–13 do not depend on steps 8–10 and could run beside them, but they share the Project Instance files with each other, so the workflow runs everything in sequence.

### Step 1 — Capture ResQ's reference results

**Goal.** Have ResQ simulate and save the five `F 72 A` segment bootstraps, consolidate and save the Total `F 72 A` consolidation, and capture everything later steps compare against into test fixtures, through the ResQ API only.

**Read first.** This plan's [reference model](#the-reference-model-in-resq) and [how ResQ consolidates](#how-resq-consolidates); [agent-instructions/resq-api-reference.md](../../agent-instructions/resq-api-reference.md); memories `resq-com-probe`, `resq-com-probe-dont-call-blindly`; [tools/resq_stored_length_probe.py](../../tools/resq_stored_length_probe.py) for the connection and write pattern; [python-api/tests/fixtures/resq_bootstrap_f72a.json](../../python-api/tests/fixtures/resq_bootstrap_f72a.json) for the existing fixture shape. Early binding (`gencache.EnsureDispatch`), `py -3.10`, run outside the sandbox. The getter for a consolidation is spelled `GetBootStrapConsolidation`, for a bootstrap `GetBootStrapMethod`.

**Do.**
- [x] Add `tools/resq_bootstrap_capture.py`, a reusable script with two modes: `run` (Simulate and Save each named bootstrap, then Consolidate and Save the consolidation) and `capture` (read only). Mutating calls are limited to `Simulate`, `Consolidate`, `Save`, and in the realistic-data case the triangle writes below.
- [x] Before simulating, make each segment's data realistic per the decision "The model stays as built; the data is made realistic": keep target `F 92` and Additive scaling, fix `F 92` first and a triangle only if still needed, save those changes in ResQ, and record what was changed (with the values) in the reference-model section so step 10 can reproduce it in Arco.
- [x] Capture per segment: the settings listed in the reference-model table, the observed triangle, the DFM's selected ratios, fitted values, residuals, scale values, the unscaled and scaled `Mean`, `StandardError` and `PercentileValue` (5% steps plus 99 and 99.5) by origin and total, the target reserves, `TotalRank(s)` for every simulation, and `SimulatedValue(0, s)` (the total) for every simulation, plus `SimulatedValue(o, s)` by origin for the first 500 simulations.
- [x] Capture for the consolidation: settings, target, adjusted and achieved matrices, `ConsolidationRanks(c, s)` for all simulations, the consolidated scaled total per simulation, the consolidated summary by origin and total, and `SimulatedReservesByClass` for the first 500 simulations.
- [x] Plausibility test per segment, after the data changes and before accepting it: the total mean scaled reserve is positive, the total CV lies between 2% and 60%, each origin's target reserve is within half to double of the DFM reserve, and the run raises no error. A segment that still fails gets the next change the decision lists; record the numbers in the fixture so step 10 writes the same data into Arco.
- [x] Write `python-api/tests/fixtures/resq_bootstrap_consolidation_total.json.gz` (gzip keeps the per-simulation arrays near 1 MB; it came out at 1.8 MB) and extend the existing F 72 A fixture only if a field is missing.
- [x] Check rule 3 of [how ResQ consolidates](#how-resq-consolidates) against the capture in a throwaway script: for every simulation, the consolidated total equals the sum over segments of the segment total at the rank ResQ assigned. Record the exact rule (rank direction, ties) in that section. If it does not hold, record what does.

**Tests.** A small test in `python-api/tests/test_resq_consolidation_fixture.py` that loads the fixture and asserts rule 3 on all 10,000 simulations to 1e-9 relative, so the rule is pinned before any Arco code exists.

**Done when.** ResQ holds saved results for the five bootstraps and the consolidation; the fixture is committed; the rule-3 test passes; the tool is committed with a short module docstring saying what it writes.

**Estimate.** Estimate: code edit 40 min, test/validation 30 min, total 70 min. Actual: code edit 9 min, test/validation 2 min, total 11 min; far under because the earlier attempts had already mapped the COM calls and every ResQ run takes under a second.

### Step 2 — Research ResQ's random stream and rank generation

**Goal.** Establish, black-box, whether ResQ's draws can be reproduced from its seed, and how its consolidation ranks are generated for every correlation option and dependency structure. Time box: 90 minutes. The step ends with its findings written into this plan whichever way it goes.

**Read first.** [Random numbers](#random-numbers) and [how ResQ consolidates](#how-resq-consolidates); step 1's tool. Do not disassemble or inspect ResQ's binaries; compare inputs with outputs only.

**Do.**
- [x] Add `tools/resq_random_probe.py`. All ResQ changes are in-memory on a loaded method and never saved; say so in its docstring.
- [x] Raw normal draws: on COL `F 72B` with estimation None and forecast Normal, collect the backed-out `Z` for several seeds (0, 1, 2, 12345, 2^31-1) and small simulation counts (1, 2, 5), and pin down the draw order within a simulation (which cell draws first) by comparing a 1-simulation run with a 2-simulation run. Done for seeds 0, 1, 2, 12345 and 2³¹ − 1 at 1, 2 and 5 simulations, and for seed 1 at 2,000 and 6,000. The first search's draws were backed out with the wrong factors, because COM's `DevelopmentFactors` are age-to-ultimate.
- [x] Test generators beyond the seven already ruled out: Mersenne Twister seeded by `init_by_array`, xorshift/xoroshiro families, L'Ecuyer MRG32k3a, Park–Miller with Schrage, Numerical Recipes `ran1`/`ran2`/`ran3`, Marsaglia's KISS and MWC, Intel MKL-style `MCG31`, each with the seed used directly and hashed through the generator's own seeding; normals by inverse CDF (Acklam and Wichura), Box–Muller (both outputs), polar (one and both outputs), and Ziggurat. Stop at the first exact match. The transform is the polar method with both outputs, and the uniforms lie on a `1/(2³¹ − 1)` grid, which rules out several families outright. No generator matched; [Random numbers](#random-numbers) lists what was tested.
- [ ] (Not reached: the uniform generator was not identified.) If the normal stream is identified, pin the uniform draw used by Resampled (residual index), and the Gamma and Log-Normal samplers (Marsaglia–Tsang, Cheng, Ahrens–Dieter) with estimation Resampled/Gamma and forecast None, one feature at a time.
- [x] Rank generation, independently of the above: on the Total consolidation, in memory, set each correlation type, each dependency type (with 5 and 20 degrees of freedom for Student's T), and a target matrix that is not positive definite; read `MethodCorrelations_Adjusted` and all `ConsolidationRanks`. From these, record: how 0% and 100% and As it comes assign ranks; whether Normal ranks behave as a Gaussian copula of the adjusted matrix (achieved rank correlations and tail co-movement across 5 seeds); what Uniform and Gamma mean (rank correlation achieved against target, and tail dependence in the upper 5%); and how a non-positive-definite matrix is repaired (compare with eigenvalue clipping then unit-diagonal rescaling, and with Higham's nearest correlation matrix). Pinned exactly except Student's T, whose draw order is open; see rule 2 under [how ResQ consolidates](#how-resq-consolidates).
- [x] Write the findings into [Random numbers](#random-numbers) and [How ResQ consolidates](#how-resq-consolidates). For anything not determined inside the time box, write the fallback step 5 implements: Uniform = independent uniform marginals combined through the Cholesky factor then ranked; Gamma = the same with Gamma(shape 1) marginals; non-positive-definite repair = eigenvalue clipping at 1e-8 then unit-diagonal rescaling. The probe replaced every fallback with ResQ's actual rule (the clip is at 1e-6, not 1e-8), except Student's T: step 5 uses a multivariate t with one chi-square per simulation shared by all methods.
- [x] Set step 3's row to "Dropped: ResQ's random stream could not be identified" if no exact generator was found.

**Tests.** None beyond the probe; this is a research step. If the generator was found, commit a tiny fixture of the first 20 draws for two seeds under `python-api/tests/fixtures/resq_random_stream.json` for step 3.

**Done when.** The two plan sections state the findings or the fallbacks, and step 3 is either ready with a precise specification or dropped.

**Estimate.** Estimate: code edit 50 min, test/validation 40 min, total 90 min. Actual: code edit 22 min, test/validation 12 min, total 34 min. Well under the estimate because every ResQ probe runs in seconds. The hunt also stopped early, once the listed families were ruled out and only a structural idea could make further progress.

### Step 3 — Reproduce ResQ's random stream (only if step 2 found it)

**Goal.** A bootstrap and a consolidation can draw from a ResQ-compatible random stream, so the same seed gives ResQ's numbers exactly.

**Read first.** Step 2's findings in [Random numbers](#random-numbers); [bootstrap_simulation.py](../../python-api/src/arcrho_api/bootstrap_simulation.py) lines 478–710 (samplers, `_poisson`, `simulate_bootstrap`).

**Do.**
- [ ] Add the generator and the samplers step 2 identified as one module, `python-api/src/arcrho_api/resq_random.py`, and route every draw in `simulate_bootstrap` through it in the order step 2 recorded.
- [ ] Make it the only stream (no option): ResQ compatibility is the goal and a second stream would be a second source of truth. Existing seeds keep working; stored summaries change and are regenerated on the next run.

**Tests.** `test_resq_random.py` pins the fixture draws; `test_bootstrap_contract.py` gains an exact-equality test of the COL `F 72 A` summary against step 1's fixture.

**Done when.** COL `F 72 A` reproduces ResQ's scaled mean and every captured percentile to 1e-9 relative.

**Estimate.** Estimate: code edit 55 min, test/validation 35 min, total 90 min.

### Step 4 — Bootstrap: fuller summary and per-simulation output

**Goal.** A bootstrap's stored summary serves every Results view without re-simulating, and the bootstrap can hand a consolidation its simulated reserves by origin and its total-reserve ranks.

**Read first.** [bootstrap_contract.py](../../python-api/src/arcrho_api/bootstrap_contract.py) lines 355–465 (`run_bootstrap_simulation`, summary normalisation); [bootstrap_simulation.py](../../python-api/src/arcrho_api/bootstrap_simulation.py) lines 438–470 and 725–833; [frontend/tests/test_bootstrap_service.py](../../frontend/tests/test_bootstrap_service.py) around line 336; the [page design](#page-design) Results description; [test_resq_consolidation_fixture.py](../../python-api/tests/test_resq_consolidation_fixture.py) for how step 1's fixture is laid out (each segment carries its settings, triangle, selected ratios, targets and all 10,000 totals).

**Do.**
- [x] Extend the summary: percentiles at 0.5% steps from 0 to 100 (plus exactly 99.5), mean and standard deviation of ultimates, and a 40-bin histogram of the total reserve, scaled and unscaled.
- [x] Add one public function that returns the per-simulation scaled (and unscaled) reserves by origin with totals, and the total-reserve rank of every simulation, from a stored method payload. The consolidation calls this; nothing else re-implements it.
- [x] Fix the stale six-decimal expectation in the service test.
- [x] Update the Bootstrap persisted-JSON description in [bootstrap.md](../../frontend/docs/app_server/domains/bootstrap.md).

**Tests.** Contract tests for the new summary fields and for the per-simulation function (totals equal the sum of origins; ranks are a permutation; a stored summary equals one recomputed from the per-simulation output). A statistical parity test for all five segments against step 1's fixture at the [parity bar](#decisions). The service suite passes in full.

**Done when.** All bootstrap contract and service tests pass, and the five-segment parity test passes.

**Estimate.** Estimate: code edit 35 min, test/validation 20 min, total 55 min. Actual: code edit 8 min, test/validation 4 min, total 12 min (under half: step 1's fixture already held every input the parity test needed, and each suite ran in seconds).

### Step 5 — Consolidation calculation

**Goal.** A pure calculation module combines several bootstraps' simulations into consolidated reserves, reproducing ResQ exactly when given ResQ's simulations and ranks.

**Read first.** [How ResQ consolidates](#how-resq-consolidates) and [Random numbers](#random-numbers) as steps 1–2 left them; step 4's per-simulation function; `bootstrap_simulation.py` for code style (dependency-free Python); [test_resq_consolidation_fixture.py](../../python-api/tests/test_resq_consolidation_fixture.py) and [test_bootstrap_segment_parity.py](../../python-api/tests/test_bootstrap_segment_parity.py) for the fixture's layout and the helpers that turn a fixture segment into a bootstrap payload.

**Do.**
- [x] Add `python-api/src/arcrho_api/stochastic_consolidation_simulation.py`: target-to-adjusted conversion (`2·sin(πρ/6)` for Normal, and whatever step 2 recorded for the other structures), positive-definite repair, Cholesky, rank generation for the four correlation options and four dependency structures, the rule-3 combination with factors, the consolidated summary (same shape as step 4's), achieved rank and linear correlations between segments, and per-segment standalone statistics for the diversification view.
- [x] Seeded and deterministic; uses step 3's stream if step 3 landed (it did not, so Arco's own seeded generator).

**Tests.** `python-api/tests/test_stochastic_consolidation_simulation.py`: rule 3 reproduces ResQ's consolidated totals exactly from step 1's fixture; Arco's own ranks for the reference seed and matrix achieve the target rank correlations within sampling error; 0% gives achieved correlations near 0 and 100% gives 1; Student's T with low degrees of freedom shows more upper-tail co-movement than Normal; a non-positive-definite target is repaired as specified; the consolidated mean equals the sum of segment means times factors for every correlation option.

**Done when.** The new tests pass, and Arco's consolidated total standard deviation for the reference model (from ResQ's segment simulations plus Arco's ranks) is within three standard errors of ResQ's.

**Estimate.** Estimate: code edit 45 min, test/validation 25 min, total 70 min. Actual: code edit 5 min, test/validation 2 min, total 7 min (under half: step 2 had pinned every rule, so the module was a direct transcription, and the whole suite runs in two seconds).

### Step 6 — Consolidation persisted contract

**Goal.** A Stochastic Consolidation has its own method JSON, output vector and sidecar, following the same contract patterns as the bootstrap, and appears correctly in a reserving class's index.

**Read first.** `$arcrho-json-contract` skill; [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md) sections Persisted JSON Producer Parity and Persisted JSON Text Format; [bootstrap_contract.py](../../python-api/src/arcrho_api/bootstrap_contract.py) lines 464–1075 as the pattern; [dataset_index_contract.py](../../python-api/src/arcrho_api/dataset_index_contract.py) for method-type registration; `sidecar_core_contract.py` for the reserved cross-class link fields; the app server's own method-type lists in [dataset_sidecar_status_service.py](../../frontend/app_server/services/dataset_sidecar_status_service.py) (top), [dataset_instance_index_service.py](../../frontend/app_server/services/dataset_instance_index_service.py) (top and `_method_entry_from_payload`) and `_METHOD_CALCULATED_TYPES` in [dataset_service.py](../../frontend/app_server/services/dataset_service.py), with their tests `test_dataset_index_cross_component_contract.py` and `test_dataset_method_calculated_sidecar.py`; the fixture helpers in [test_bootstrap_segment_parity.py](../../python-api/tests/test_bootstrap_segment_parity.py).

**Do.**
- [x] Add `python-api/src/arcrho_api/stochastic_consolidation_contract.py` with the [canonical labels](#decisions): normalisation, `details`, `segments` (reserving class path, method name, factor, the consumed bootstrap's revision), `correlation` (option, dependency structure, degrees of freedom, target matrix, used matrix), `results` (seed, simulation count, summary, achieved matrices, segment statistics), notes/audit; owned/derived/publication projections and revisions; the output vector (consolidated mean ultimate by origin: sum of each segment's latest times factor, plus the consolidated mean reserve) and its aggregated variants; the output sidecar with cross-class precedents in the reserved link fields.
- [x] Register `Stochastic Consolidation` as a method type wherever the index contract and the method-type label list need it, with the parity coverage the guidelines require.

**Step 6 result (2026-09-23).** The method JSON has `details_tab` (name, output and base triangle types, lengths, the seed as an owned input, and the simulation count taken from the segments), `segments_tab.segments` (class path, method name, factor, consumed `bootstrap_revision`), `correlation_tab` (option, dependency type, degrees of freedom, the target matrix stored full and mirrored from its upper triangle, and the adjusted matrix actually used), `results_tab` (`input_revision`, origin labels, combined latest diagonal, summary, `consolidation_ultimate`) and `method_metadata`. Notes and the audit log live in the output sidecar, as for every method. What step 7 needs to know:
- **One run function.** `consolidate_stochastic_method(payload, segment_inputs)` takes each segment's stored bootstrap payload and, optionally, the input type of the DFM it bootstraps (the DFM's `details_tab.input_triangle`; the bootstrap does not record it). It refuses a mismatched base type, simulation count or method name, naming the segment as `class / method`. It re-simulates every segment and stores the summary and output.
- **Freshness.** A segment's recorded revision covers the bootstrap's simulation settings, model and derived state, but not display-only toggles. `stale_segments` reports each segment as `changed`, `missing` or `not_consolidated`. `input_revision` is the fingerprint of the run's own inputs at the last consolidation, so "inputs changed, run again" is `run_input_revision(method) != results_tab.input_revision`.
- **Cross-class precedents.** The output sidecar lists each segment as `{dataset_name, method_type: "Bootstrap", reserving_class}`, and drops `reserving_class` for a segment in the host's own class. Shared dependency entries used to be deduplicated by name alone, which would have collapsed the five same-named `F 72 A` segments into one. They are now deduplicated by name, class and project. Every same-class entry behaves as before.
- **Not changed.** The ResQ migration keeps its own `Stochastic Consolidation` label. Its support bundle ships with the macro library and runs against the installed app's older `arcrho_api`, so it must not import the new constant.

**Tests.** `python-api/tests/test_stochastic_consolidation_contract.py`: normalisation round trip, revisions stable under reformatting, a mismatched base type or simulation count refused with the method named, sidecar and index projections, and the full-payload index parity test.

**Done when.** The new tests and the existing index parity tests pass.

**Estimate.** Estimate: code edit 40 min, test/validation 20 min, total 60 min. Actual: code edit 8 min, test/validation 16 min, total 24 min (under half: the bootstrap contract was a direct pattern and step 1's fixture supplied realistic segments; most of the validation time was a whole python-api suite run that outlasted its 10-minute limit, so targeted suites were run instead).

### Step 7 — Consolidation server service

**Goal.** The app server can load, consolidate, and save a Stochastic Consolidation, reading the included bootstraps from their own reserving classes, with the load and save hosted like every other method.

**Read first.** [bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py) (whole file, as the pattern), [bootstrap_router.py](../../frontend/app_server/api/bootstrap_router.py), [schemas/bootstrap.py](../../frontend/app_server/schemas/bootstrap.py), [arcrho_workspace_read_contract.py](../../python-api/src/arcrho_workspace_read_contract.py), [arcrho_engine_save_contract.py](../../python-api/src/arcrho_engine_save_contract.py); memories `adding-a-hosted-workspace-read`, `adding-a-hosted-save-kind`, `propagation-hold-and-test-isolation`; [test_bootstrap_service.py](../../frontend/tests/test_bootstrap_service.py) and `frontend/tests/dependent_propagation_workspace_stub.py` as the test pattern; `BACKEND_DOMAIN_META` and `backend_manual` in [docs_index_builder.py](../../frontend/tools/docs_index_builder.py) for the new domain doc; `HTTP_SAVE_KINDS` lives in `arcrho_hosted_save_http_contract.py`.

**Do.**
- [x] `stochastic_consolidation_service.py`, router and schemas: `load` (method JSON and sidecar, plus a freshness check comparing each segment's stored revision with the bootstrap's current one, reported per segment), `consolidate` (re-run each segment's simulation through step 4's function, then step 5; returns results without writing), `save` and `save/plan` (hosted, revision-aware, publishing method, CSVs and sidecar last), and a `segments/candidates` read that lists bootstraps in other classes of the project for the picker.
- [x] Register the hosted read and save kinds; add the route to the generated route docs; add the domain doc `frontend/docs/app_server/domains/stochastic_consolidation.md`.
- [x] Say in the domain doc that cross-class propagation is deferred and freshness is checked on open.

**Step 7 result (2026-09-23).** Routes under `/stochastic-consolidation/`: `load`, `consolidate`, `segments/candidates`, `save/plan`, `save`, all POST. The first three are hosted reads (`stochastic_consolidation_load`, `_consolidate`, `_candidates`) and the save is the `stochastic_consolidation_method` hosted save. What step 13 needs to know:
- **Segment rows.** Load, consolidate and save return `segments`, one row per included bootstrap: class, method, factor, `status` (`current`, `changed`, `missing`, `not_consolidated`), the bootstrap's simulation count, seed, base triangle type (its DFM's input triangle), standalone scaled mean, standard deviation and CV, `has_run`, and `problems` (`missing`, `no_run`, `simulation_count_mismatch`, `base_type_mismatch`). Candidates rows carry the same figures. `run_state` is `up_to_date`, `not_run`, `inputs_changed` or `segment_changed`, which maps onto the header chip.
- **Consolidate writes nothing.** The route drops `results_tab` from the request; a missing segment is 404 and a mismatched base type or simulation count 422, both naming `class / method`.
- **Save consolidates when it must.** It re-runs whenever there is no stored run, the run's settings changed, or a segment is not current; a notes-only save keeps the stored run (`consolidated: false`). A first save takes only the owned settings from the page. A save with a missing segment is refused.
- **No reverse edges.** The sidecar lists each segment with its class, but no bootstrap sidecar gains a `dependents` entry, so deleting a bootstrap is not blocked; the load reports it `missing`.
- The picker lists only the other classes' bootstraps, as the step says; a bootstrap in the host class cannot be picked.
- Running the docs builder with `--write` also refreshed four generated docs that were already stale at HEAD.

**Tests.** `frontend/tests/test_stochastic_consolidation_service.py` using the workspace stub: load of a saved method, consolidate over two synthetic bootstraps in two classes, save/reopen round trip, a changed segment reported stale, the candidates list, transport selection for the new read and save kinds.

**Done when.** The new service tests pass along with the bootstrap service tests, and `python frontend/tools/docs_index_builder.py --check` is clean.

**Estimate.** Estimate: code edit 50 min, test/validation 25 min, total 75 min. Actual: code edit 10 min, test/validation 4 min, total 14 min (under half: the bootstrap service was a direct pattern and step 6's contract already held every rule; the whole new suite runs in six seconds).

### Step 8 — Import bootstraps from ResQ

**Goal.** Importing a reserving class from ResQ brings each Bootstrap method across as an Arco bootstrap built through the shared contract, carrying ResQ's settings and seed.

**Read first.** [extractors.py](../../python-api/migration/resq_migration/extractors.py) around `export_cape_cod` (line ~2576) through `_find_cape_cod_for_vector` (~2798) and `_find_unique_method_by_output` (~1147); [bootstrap_contract.py](../../python-api/src/arcrho_api/bootstrap_contract.py) `normalize_bootstrap_method` and `recalculate_bootstrap_method`, and [bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py) `save_bootstrap_method` and `_publish` (the save the import must equal); [resq_data_migration.py](../../python-api/migration/resq_data_migration.py) around `_cc_export_names` (~653), `export_vectors_for_rc` (~1396–1640) and `_selected_exports` (~1796); [sync_session.py](../../python-api/migration/resq_migration/sync_session.py) lines 73–83 and 395–433; the bootstrap plan's [ResQ Migration](../../frontend/docs/plans/bootstrap_method_plan.md#resq-migration) section; memory `macro-must-not-depend-on-app-arcrho-api`.

**Do.**
- [x] `export_bootstrap`, `_find_bootstrap_for_vector` (via `reserving_class.BootStrapMethods()` or `GetBootStrapMethod`, always through the class, never the project), and the vector-loop branch for method type 6, riding the existing methods flag with its own written count. The DFM snapshot is built from the migrated Arco DFM, so every producer shares one calculation; the imported bootstrap is simulated once on import so its summary exists.
- [x] Recognise method type 7 in the sync session as `Stochastic Consolidation` (label only; step 9 imports it).
- [x] Update [python-api/docs/resq_reserving_class_export.md](../../python-api/docs/resq_reserving_class_export.md) where it lists what is left out.

**Tests.** Migration tests with a fake COM bootstrap built from step 1's fixture: the written `BST@` payload equals the one the app server would save for the same inputs (full-payload parity), ResQ's seed and settings round-trip, and the residuals match ResQ's.

**Done when.** The migration tests pass, and a local run of the import for COL (Server PC, outside the sandbox) writes `BST@F 72 A - Bootstrap Net incurred with PV.json` whose residual grid matches ResQ.

**Result (2026-09-23).** A Bootstrap's output vector is deferred to the end of the vector loop, because it is built from the Arco DFM method file the same loop writes; the target ultimate is read from ResQ's own `TargetUltimate` vector. ResQ's type library spells two members differently from its help pages: `UseNormalOnNegMean` and `ODP_NegativeMeanOption` (0 ODP, 1 Gamma/LogNormal, 2 negative mean; the reference bootstraps hold 2). `ScaleValues_*(d, svtUserEntry)` answers the unsmoothed value when nothing was typed, so a user scale entry imports only where `SelectedScaleValues_*(d)` is User Entry (2). A Bootstrap-coded vector whose method is not imported becomes a plain dataset, as BF and Cape Cod already did. Parity work found that the contract cut a first save's per-origin scaling methods and CVs and its user scale entries to the empty axis of a method with no DFM snapshot yet; it now keeps them whole until the snapshot arrives, so a first save from the page and an import both keep them. The import now writes byte-for-byte the method file and output CSV the app server saves for the same inputs. The scratch import of COL (written under `temp/`, not into the project) reproduced ResQ's 265 residual cells of `F 72 A` and `F 72B` to within the six-decimal rounding of the stored file (worst 5e-7), and `F 72 A`'s scaled mean reserve is 58,877 against ResQ's 58,886 (standard deviation 9,277 against 9,304).

**Estimate.** Estimate: code edit 40 min, test/validation 30 min, total 70 min. Actual: code edit 18 min, test/validation 11 min, total 29 min; under half because the Cape Cod import was a close template and the scratch import ran in seconds.

### Step 9 — Import consolidations and the total class from ResQ

**Goal.** Importing ResQ's Total class brings its Stochastic Consolidation across, with its segments pointing at the imported bootstraps in their own classes.

**Read first.** Step 8's changes; [resq_data_migration.py](../../python-api/migration/resq_data_migration.py) `import_reserving_class_from_resq` (~1888–1931); [import_resq_reserving_classes.py](../../python-api/macros/import_resq_reserving_classes.py) (class list); memories `resq-com-probe` (a calculated class and its formulas), `offline-dependent-walk-replay`; [stochastic_consolidation_contract.py](../../python-api/src/arcrho_api/stochastic_consolidation_contract.py) `apply_owned_patch` and `consolidate_stochastic_method`, and [stochastic_consolidation_service.py](../../frontend/app_server/services/stochastic_consolidation_service.py) `_read_bootstrap` and `save_stochastic_consolidation_method` (the save the import must equal); [catalog.py](../../python-api/migration/resq_migration/catalog.py) `_is_engine_generated_instance` and `refresh_sidecar_graphs_for_rc`.

**Do.**
- [x] `export_stochastic_consolidation` and its finder via `GetBootStrapConsolidation`, mapping included methods to (class path, method name, factor), correlation settings, the target matrix and the seed. The consolidation is consolidated once on import when every segment bootstrap exists in Arco; otherwise it is written unrun and its import message names the missing segments.
- [x] Make sure a ResQ calculated class imports as an ordinary Arco class: its datasets arrive as values; nothing tries to parse cross-class formulas.

**Tests.** Migration test with a fake COM consolidation from step 1's fixture: payload parity with the service's save for the same inputs; missing-segment message.

**Done when.** Tests pass.

**Result (2026-09-23).** On COM, `IncludedMethods(i)` answers the bootstrap's output vector, not the method: its `Name` is the Arco bootstrap's name and `ReservingClass.Path` the full class path the segment is keyed by. ResQ's correlation and dependency codes follow Arco's label order. The import puts ResQ's owned settings onto an empty method exactly as the app server's first save does, reads each segment bootstrap (and its DFM's input triangle) from its own class folder, and consolidates once; the cross-producer test shows it writes the save's method file and CSV byte for byte, and an imported consolidation reopens `up_to_date`. When a segment is not in Arco yet (or a base type or simulation count disagrees), the method is written unrun with ResQ's origin labels and blank values, the class import reports it under `consolidation_warnings`, and the page offers Consolidate. A scratch import of the Total class (under `temp/`, not the project) found the real calculated-class problem: every Engine-generated dataset failed with "Unknown reserving-class type [Total]", because the Engine has no source rows for a ResQ calculated class. The import now reads ResQ's `Calculated` flag and, for such a class, hands nothing to the Engine: all 31 datasets arrived as ResQ's values (28 input, the DFM and the two consolidations), and ResQ's cross-class formulas are ignored as before. The within-class graph refresh now skips cross-class precedent entries, so a same-named dataset in the host class never gains the consolidation as a dependent. Total holds two consolidations, `F 72 A ... with PV` and `F 72B ... no PV` (seed 1107772031, same target), over the `F 72 A` and `F 72B` bootstraps of the five segments. So step 10 imports the Total class after the segment bootstraps, or re-imports it at the end, or its consolidations arrive unrun.

**Estimate.** Estimate: code edit 40 min, test/validation 25 min, total 65 min. Actual: code edit 13 min, test/validation 8 min, total 21 min; under half because the step-8 bootstrap import and the step-7 service were close templates and the scratch import ran in seconds.

### Step 16 — Hand a class to the Engine only when Arco knows its type (runs between steps 9 and 10)

**Goal.** A ResQ import builds a class's generated datasets through the Engine whenever Arco's reserving-class types know every level of its path, and keeps ResQ's values only for a class they do not know (the fake project's `All States\Direct Group\Total`), per decision 2.

**Read first.** Decision 2 under [Open decisions](#open-decisions); step 9's commit `3d516f4a` (the `resq_class_scope` / `engine_builds_class` scope and `_resq_class_is_calculated` in `python-api/migration`); [data_processing_rules.py](../../server-components/src/arcrho_engine/data_processing_rules.py) lines 146-200 (`ReservingClassCatalog.resolve_type`) and 345-445 (`build_reserving_class_catalog`); `python-api/src/arcrho_api/source_table_contract.py` around line 214 for how `reserving_class_types` is already read; the Single Source of Truth rule in [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md); memory `arcrho-dataset-types-win-over-resq`; [build_exe.py](../../server-components/src/arcrho_engine/build_exe.py) (the standalone canonical modules the frozen Engine hidden-imports) and the "Mirror of arcrho_api" notes in [data_processing.py](../../server-components/src/arcrho_engine/data_processing.py), which say why the Engine's calculation path does not import `arcrho_api`.

**Do.**
- [x] Put the one rule "is every level of this class path a known reserving-class type" in `arcrho_api` (the Bridge cannot import `arcrho_engine`), built from `reserving_class_types.json` with the same name canonicalisation the Engine uses, and make the Engine's catalog lookup use that same canonicalisation rather than a copy, so the two cannot drift.
- [x] Replace the `Calculated`-flag decision in the import scope with that rule; delete `_resq_class_is_calculated` and anything else that only served it. The class is resolved once per class import, before any dataset is exported.
- [x] Update the domain and migration docs that described the calculated-class behaviour.

**Tests.** Migration tests: a class whose path levels are all known types hands its generated datasets to the Engine even when ResQ reports `Calculated = True`; the Total class (unknown last level) keeps ResQ's values; a class with an unknown intermediate level keeps ResQ's values. A test that the Engine catalog and the new rule agree on the fake project's `reserving_class_types.json` (canonicalisation parity, including doubled spaces). Existing step 8 and 9 migration tests still pass.

**Done when.** Tests pass, and a dry run of the scope rule against the fake project's `reserving_class_types.json` reports Engine-built for BI Total, CMPxCAT, COL, MP+PIP and PD+UMPD and ResQ-valued for Total.

**Result (2026-09-23).** The rule lives in the standalone module `python-api/src/arcrho_reserving_class_type_contract.py`, not inside the `arcrho_api` package: the frozen Engine's calculation path never imports `arcrho_api` (a frozen `arcrho_api` would shadow the bundled canonical copy the propagation runtime loads), and the repo's other shared Engine contracts (`arcrho_engine_job_lease`, `arcrho_*_contract`) are standalone modules for that reason; the Engine build now names it as a hidden import. It owns the type-name key (outer space dropped, inner runs of space collapsed, case ignored) and the path rule, which pairs the path's parts with the Reserving Class levels of `field_mapping.json` exactly as the Engine's `resolve_request_path` does (blank parts skipped, a deeper path unknown). The Engine's catalog now keys and resolves type names on that key, so a doubled-space spelling now resolves in the Engine where it used to fail with "Unknown reserving-class type". The import asks it once per class (`engine_knows_reserving_class`, reading the project's two JSON files) before any dataset is exported. The dry run against the fake project gives Engine-built for BI Total, CMPxCAT, COL, MP+PIP and PD+UMPD and ResQ-valued for Total. The three failures in `test_resq_data_migration_engine`, one in `test_resq_data_migration_graph` and one in frontend `test_data_processing_rules_jobs` fail identically at HEAD.

**Estimate.** Estimate: code edit 30 min, test/validation 20 min, total 50 min. Actual: code edit 6 min, test/validation 3 min, total 9 min; well under half because the Engine's catalog and the repo's standalone-contract pattern were close templates and every suite runs in seconds.

### Step 10 — Populate the fake project and compare with ResQ

**Goal.** Arco's fake project holds `MP+PIP` and `Total` for `All States\Direct Group`, the five segment bootstraps and the Total consolidation, and a written comparison shows how their results line up with ResQ's.

**Read first.** Steps 8–9; memories `migration-script-local-run`, `propagation-hold-and-test-isolation`, `agent-share-listing-blocked-use-python`; [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md) Agent Project Data Access; [test_bootstrap_segment_parity.py](../../python-api/tests/test_bootstrap_segment_parity.py) for the standard-error formulas; `import_reserving_class_from_resq` in [resq_data_migration.py](../../python-api/migration/resq_data_migration.py) (called directly, with `selected_names` and `cleanup_target=False` for a partial re-import).

**Do.**
- [x] On the Server PC, outside the sandbox, run the import locally (not through the Bridge, which does not have the new code until step 14) for `MP+PIP` and `Total`, then for the four existing segment classes limited to the `F 72 A` bootstraps (and every data change step 1 recorded in the reference-model section, so Arco's `F 92` and triangles match ResQ's). Keep a byte copy of each class folder first.
- [x] Write `tools/bootstrap_parity_report.py`, which reads Arco's stored summaries and step 1's fixture and prints, per segment and for the total: mean, standard deviation, CV, 75/90/95/99/99.5 percentiles, the difference, and the difference in ResQ standard errors.
- [x] Record the table and its verdict against the [parity bar](#decisions) in a new "Parity results" section at the end of this plan.

**Tests.** The parity report itself; no new unit tests.

**Done when.** Every segment and the total are within the parity bar, or the plan's Parity results section names the one that is not and why.

**Result (2026-09-23).** The import ran by calling `import_reserving_class_from_resq` directly against the live project: `MP+PIP` and `Total` whole, and the four existing segments with `selected_names` limited to `F 25 - Incurred DFM Bootstrap`, `F 92 - Current Qtr Selected` and the `F 72 A` bootstrap and `cleanup_target=False` (the review never offers Engine-generated datasets, so the Engine rebuilt those too). The segment triangles already equalled ResQ's to 6e-11; `F 25` came across at full precision instead of the older six-decimal factors, and `F 92` now equals `F 25` as step 1 set it in ResQ. The first comparison found every imported bootstrap unscaled: the import read the target ultimate's origin labels through `OriginLabel`, which ResQ's `IVector` does not have, so the labels fell back to "1".."10", no origin matched the DFM's "2017".."2026", and every target value was blank. The fake COM target in the step-8 test exposed `OriginLabel`, so the test could not see it (and step 8's "scaled mean 58,877" for COL was in fact the unscaled mean). The target snapshot now reads `PeriodLabel` and `ValuesByIndex`, the vector interface's own getters, and the fake target is shaped like `IVector`. After re-importing the five bootstraps and then `Total`, every scaled mean equals ResQ's exactly and every statistic is within the bar; the consolidation's recorded segment revisions equal the current bootstraps'. Known and left in place: `MP+PIP`'s `F 25` loses ResQ's 1.0018 tail on its Volume-all row, because Arco's DFM recomputes a calculated average row's tail as 1.0 (the unscaled mean moves; the scaled results do not); the post-import dependent refresh marks every freshly imported `F 92` and `F 72 A` Review Needed, as any import does for a method its public-API walk cannot refresh; `MP+PIP` reports two BF methods ResQ holds with a broken Perc Developed input and the claim-count "CWP Excess" triangles differ from ResQ at two decimals, both pre-existing; `Total`'s `F 72B` consolidation is written unrun, since only `MP+PIP` has its `F 72B` bootstrap in Arco; `Total`'s `F 23` DFM is Review Needed after the import ("development-label geometry changed").

**Estimate.** Estimate: code edit 20 min, test/validation 40 min, total 60 min. Actual: code edit 11 min, test/validation 9 min, total 20 min; under half because every import ran in under 30 seconds, and the unscaled-target defect it found took about 8 minutes to fix.

### Step 11 — Bootstrap page: shell wiring, setup and residual tabs

**Goal.** A Bootstrap opens from the project list as a floating window with Details, Residuals, Simulation and Targets tabs, and can be created from a vector row and saved.

**Read first.** [Page design](#page-design); `$arcrho-ui-design` skill and its references for layout, controls and tables; the persisted method's owned fields in `normalize_bootstrap_method` and `apply_owned_patch` ([bootstrap_contract.py](../../python-api/src/arcrho_api/bootstrap_contract.py)) and the load/save response in `_method_response` ([bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py)); [frontend/FRONTEND_AGENT_GUIDELINES.md](../../frontend/FRONTEND_AGENT_GUIDELINES.md); the Cape Cod page (`frontend/ui/method_pages/cape_cod/`: html, `cape_cod_main.js`, `cape_cod_method_api.js`, css); the Cape Cod touch points: `frontend/ui/shared/tabs/window_tab_catalog.js`, `project_instance.html` (~155), `project_instance_dataset_table.js` (~1291–1560, 2479–2611, 3138), `project_instance_windows.js` (~48, 159, 486, 709, 780–796, 980, 1301, 1527–1577), `project_instance_messages.js` (~36–46, 332, 373–388, 632–635, 854–878, 1578), `frontend/ui/shell/iframe_host.js` (~166), `tab_actions.js` (~254), `shell_hotkeys.js` (~84), `shell_state.js` (~93–175), `tab-type-icons/tab_type_icons.css` (~60) and the SVG rules in [agent-instructions/svg-icon-management.md](../../agent-instructions/svg-icon-management.md); `frontend/tests/color_theme.test.mjs` pins; memories `arcrho-dev-ui-cache-restart`, `theme-css-version-pins`, `electron-ui-screenshot-check`.

**Do.**
- [x] `frontend/ui/method_pages/bootstrap/` with the page shell, the method API wrapper (load, save/plan, save, refresh), and the four setup tabs as designed.
- [x] Every Project Instance and shell touch point Cape Cod has, for `bootstrap` / `BST@` / `bstTab`, including `Add -> Bootstrap` on eligible vector rows and double-click opening Results. The shell touch points were left out: Cape Cod keeps its shell tab type only so an old standalone tab still restores, and no Bootstrap tab has ever existed.
- [x] UI doc `frontend/docs/ui/bootstrap.md`; a user-facing release fragment.

**Tests.** `frontend/tests/bootstrap_frontend.test.mjs` (tab catalog entry, window kind, open-JSON name, residual flagging threshold, symmetric settings serialisation); colour-theme pins; the Node suite with the known baseline failures only.

**Done when.** Tests pass, and an Electron screenshot check of the page with a mocked COL `F 72 A` payload shows all four setup tabs laid out per the design.

**Result (2026-09-23).** The Server PC has no bundled Electron, so the check used headless Chrome against a small local server that serves `frontend/ui` and answers `/bootstrap/load` with the fake project's real COL `F 72 A` method; the Details, Residuals (with and without scale values), Simulation, Targets and Results tabs, an open dropdown, a changed scaling method and a new method's empty states all rendered as designed. Save is the only way to run a simulation, because the server re-simulates on every save and has no run-without-writing route for a bootstrap; the header therefore carries no Simulate button yet, and Results shows only the scaled total's mean, standard deviation, CV and 99.5% until step 12. A residual is flagged at 1.5 times the root mean square of its grid, which reproduces ResQ's red cells on the reference method (10 flagged). The Node suite has the same 23 failures as HEAD before the change.

**Estimate.** Estimate: code edit 65 min, test/validation 25 min, total 90 min. Actual: code edit 14 min, test/validation 9 min, total 23 min; about a quarter of the estimate because the Cape Cod page and its Project Instance wiring could be followed almost line for line.

### Step 12 — Bootstrap page: results

**Goal.** The Results tab shows the reserve range: summary table with the chosen percentiles, scaled/unscaled and reserves/ultimates switches, the distribution chart, the ultimates fan chart, and the run state in the header.

**Read first.** [Page design](#page-design); step 11's page; step 4's summary shape; `frontend/ui/method_pages/cape_cod/cape_cod_ratios_chart.js` and `frontend/ui/shared/components/chart_legend/` for chart conventions; `$arcrho-ui-design` references for tables and states.

**Do.**
- [x] Results tab, percentile chooser (shared by table and charts), full-ladder toggle, copy-to-clipboard, empty and stale states, Simulate with progress and duration.
- [x] `bootstrap_distribution_chart.js` and `bootstrap_fan_chart.js` following the per-page canvas chart pattern.
- [x] Update the UI doc and the release fragment.

**Tests.** Node tests for percentile selection, the fan-chart band computation from the stored summary, and state-chip transitions; Node suite baseline.

**Done when.** Tests pass, and a screenshot check with the real COL summary shows the table and both charts.

**Result (2026-09-23).** Every Results view reads the stored summary only; the page model builds the rows by origin and total, the table columns, the full ladder (ResQ's Detail grid, statistics down the side), the clipboard text, the fan bands (one per symmetric pair of the chosen percentiles) and the distribution markers, and the two chart modules only draw them. An ultimate is the latest plus the reserve, so the ultimates view moves every reserve figure, percentiles included, by the latest. A CV is left blank for a zero or negative mean, which the reference method's older origins have. Simulate sends the same save request as Save, because the server has no run-without-writing route for a bootstrap; it words the progress card for the run, times it in the page, and stays available on a clean page. The percentile choices and switches are page state and are not persisted. The check used headless Chrome against a local server that answers `/bootstrap/load` with the fake project's real COL `F 72 A` method: the default view, ultimates with other percentiles, the full ladder with the stale notice, a new method's empty state and an 800px-wide window all rendered as designed. The Node suite has the same 23 failures as HEAD before the change.

**Estimate.** Estimate: code edit 65 min, test/validation 25 min, total 90 min. Actual: code edit 9 min, test/validation 4 min, total 13 min; under a sixth of the estimate because step 11's page, its chart and the stored summary shape were already in place, so the step was mostly new view-model functions.

### Step 13 — Consolidation page

**Goal.** A Stochastic Consolidation can be created from a vector row, its segments picked across classes, correlations entered, consolidated, and its combined range and segment breakdown read.

**Read first.** [Page design](#page-design); steps 11–12's pages and touch-point list; step 7's routes, and the load/run response in `_method_response` and `_segment_rows` ([stochastic_consolidation_service.py](../../frontend/app_server/services/stochastic_consolidation_service.py)) with the owned fields in `normalize_stochastic_consolidation_method` and `owned_projection` ([stochastic_consolidation_contract.py](../../python-api/src/arcrho_api/stochastic_consolidation_contract.py)).

**Do.**
- [x] `frontend/ui/method_pages/stochastic_consolidation/` with Details, Segments, Correlation, Results, Notes and Audit Log as designed, reusing step 12's table and chart modules (move them to `frontend/ui/shared/` in this step rather than copying them).
- [x] Every Project Instance and shell touch point for `stochastic_consolidation` / `SCON@` / `sconTab`; `Add -> Stochastic Consolidation`. As for Bootstrap, there is no shell tab type: standalone method tabs are legacy.
- [x] UI doc `frontend/docs/ui/stochastic_consolidation.md`; release fragment.

**Tests.** `frontend/tests/stochastic_consolidation_frontend.test.mjs` (matrix mirroring and bounds, option switching, stale-segment state, serialisation); colour-theme pins; Node suite baseline.

**Done when.** Tests pass, and a screenshot check with the Total consolidation's stored payload shows each tab per the design.

**Result (2026-09-23).** The Results views, the table markup and the two charts moved to `frontend/ui/shared/components/reserve_range/`; the Bootstrap page model re-exports the views under their old names, so its page and tests are unchanged, and a method without a DFM figure (a consolidation) drops the DFM columns and the fan chart's DFM line. The consolidation page never computes a derived value: Consolidate posts the settings on screen to the run-without-writing route and shows the result unsaved, and Save lets the server consolidate again when the stored run is stale. The run chip compares the settings that change a run (base type, seed, segments and factors, correlation settings) with those the run on screen was made from, so a name or notes edit does not make it stale. The segment checks mirror the server's (missing, no run, simulation count, base type) and add a duplicate check, so a row added from the picker shows its problem before any run. The Used matrix shows the stored adjusted matrix while the settings match the run, otherwise `2·sin(π·ρ/6)` of the settings on screen with a note when the matrix is not positive definite (the page does not reproduce the eigenvalue repair). The screenshot check used headless Chrome against a local server answering the load and candidate routes with the fake project's real Total `F 72 A` (up to date) and `F 72B` (four segments missing, not run) responses: every tab, the Add Segment picker, a refused 1.4, a non-positive-definite Used view, the Achieved matrices, the dependency menu, ultimates with other percentiles and an 800px-wide window all rendered as designed, and the Bootstrap Results tab still renders with its DFM columns. The Node suite has the same 23 failures as HEAD before the change.

**Estimate.** Estimate: code edit 75 min, test/validation 25 min, total 100 min. Actual: code edit 14 min, test/validation 7 min, total 21 min; about a fifth of the estimate because steps 11–12's page, its Project Instance wiring and its Results views could be followed or moved almost unchanged.

### Step 14 — Deploy the server components

**Goal.** The Bridge, Engine and Gateway carry the new calculations, hosted reads and saves, and imports.

**Read first.** [Component Deployment Authorization](../../agent-instructions/component-deployment-authorization.md); [Ship impact](#ship-impact); memories `remote-component-deploy`, `deploy-staleness-is-mtime-based`, `bridge-restart-after-deploy`, `hosted-save-fix-needs-engine-deploy`.

**Do.**
- [x] Check the build listener's heartbeat names the buildbot clone; run `python server-components/deploy.py --stale`, then `python server-components/deploy.py`. If the payload lists files that are not this plan's work, stop and record it under Open decisions.
- [x] Verify each component's deployed copy of the new modules against the tree, and that the Bridge came back.

**Tests.** The deploy's own checks.

**Done when.** All three components report fresh and a hosted `stochastic_consolidation` load of the Total method returns through the Gateway.

**Result (2026-09-23).** The listener heartbeat named `E:\XWSpace\Repos\ArcRho-buildbot`. `--stale` listed bridge, engine, gateway and credential; the deploy named the first three (`deploy.py bridge engine gateway`, request `build-260923-170534-570-xwei`, exit 0, about 3 minutes), because the Credential service imports none of the changed modules and is stale only through the shared `python-api/src` root. The working-tree payload was 23 files against base `13c1092e`, every one this plan's work. Building on that base also shipped two already-committed, not-yet-deployed changes from other work, both additive: the Excel pickers' `latest_project` field (`dd95aafe`) and the ResQ transfer review's "Created in ResQ" label (`543034c5`). Afterwards `--stale` reports bridge, engine and gateway `Updated` (credential still stale); every changed module in the Engine's and Gateway's canonical copies and the Bridge's importer copy matches the tree byte for byte apart from line endings; fresh heartbeats came back for the Bridge and its worker, five Engines and the Gateway within a minute; the Gateway's health check answers `ok`, it advertises the three consolidation read kinds, and a signed `stochastic_consolidation_load` of the Total `F 72 A` ran on `E:\ArcRho Server` and returned `up_to_date` with all five segments `current`.

**Estimate.** Estimate: code edit 5 min, test/validation 25 min, total 30 min. Actual: code edit 5 min, test/validation 4 min, total 9 min; under a third of the estimate because the warm build slots made the three-component deploy take about 3 minutes.

### Step 17 — Make Total an Arco composite class (runs before step 15)

**Goal.** The fake project's `PRNJ - PA\PA\All States\Direct Group\Total` class appears in Project Instance and its datasets are built by the Engine as the sum of the five segments, per decision 3; its consolidations are current.

**Read first.** Decisions 2 and 3 under [Open decisions](#open-decisions); step 16's `arcrho_reserving_class_type_contract.py`; the Project Settings reserving-class types save path (find it from `frontend/ui/project_settings` and its app-server route; it is the canonical writer of `reserving_class_types.json`): the `POST /reserving_class_types` route `save_reserving_class_types` in [reserving_class_router.py](../../frontend/app_server/api/reserving_class_router.py), over `refresh_reserving_class_types_json` in [reserving_class_service.py](../../frontend/app_server/services/reserving_class_service.py), with no follow-on job; the Project Instance tree reads `get_reserving_class_path_tree_children` in the same service; memories `rules-save-refreshes-affected-datasets`, `adding-a-project-level-engine-job`, `propagation-hold-and-test-isolation`, `offline-dependent-walk-replay`.

**Do.**
- [x] Byte-copy the fake project's `reserving_class_types.json` and the Total class folder under `temp/`.
- [x] Add a level-5 type `Total` with the formula and source of the existing `TOTAL PA` row, through the Project Settings save path (calling its service function from a script is fine), so the canonical writer produces the file and any follow-on job runs. Do not hand-edit the JSON.
- [x] Re-import the Total class from ResQ from the working tree (outside the sandbox), so its generated datasets are Engine-built; confirm the two consolidations are written and `F 72 A` is consolidated with its segment revisions current. Compare the Total's `Net Loss--Incurred` latest diagonal with the sum of the five segments' and with ResQ's.
- [x] Remove the two leftover `.arcrho-resq-import-staging` folders under the fake project's data folder if they are leftovers of this plan's imports (check their timestamps and contents first; leave them and say why if not).
- [x] Confirm through the Project Instance tree service (the function the tree reads) that Total is listed under `Direct Group`.
- [x] Record the Total result in Parity results.

**Tests.** No new unit tests unless a code change turns out to be needed; if one does, it gets its test in this step.

**Done when.** The tree service lists Total, its datasets are Engine-built and equal the sum of the segments, and the Total `F 72 A` consolidation loads `up_to_date`.

**Result (2026-09-23).** No code change was needed. The Project Settings save route, called from a script with the 108 existing rows plus `Total` at level 5 with `TOTAL PA`'s formula, wrote 109 rows (every other row unchanged, and `Source` resolved to the same atomic expression as `TOTAL PA`) and logged the save to the project audit log; that route runs no follow-on job. Before the save the tree service's `Direct Group` children had no `Total`; after it they list `Total` beside `TOTAL PA`, because the tree cache keys on the types file's modification time. The step-16 rule now answers Engine-built for the Total path, and the re-import (36 seconds, no errors) had the Engine build all 28 generated datasets at annual granularity in place of ResQ's monthly values, wrote the `F 23` DFM and both consolidations, and consolidated `F 72 A` again from the same seed: it loads `up_to_date` with all five segments `current`, and the parity report gives the same Total figures as step 10. `F 72B` stays `not_run`, since only `MP+PIP` has its `F 72B` bootstrap. The Engine's `Net Loss--Incurred` latest diagonal equals the sum of the five segments' and ResQ's own figures (rolled up from the monthly values the class held before) to 1e-10 in every origin; see [Parity results](#parity-results). Known and left in place: the import's parity check reports seven datasets that differ from ResQ at two decimals. Two are the `Claim Counts--CWP Excess` triangles (pre-existing; `MP+PIP` shows the same). The other five are `Earned Exposure` and `Total Earned Exposure` (all ten origins; Arco 5,358,547 against ResQ 2,924,062 in the first) and `Remaining Budget Premium`, `Remaining Budget Exposure` and `Total Earned Premium` (the latest origin only), because Arco sums the five segments while ResQ's calculated class does not build its exposure and budget figures that way. The import's public-API walk marked five Engine datasets Review Needed (`Claim Counts--Reported ex CWOP`, `Net Loss--Paid`, `Net Loss--OS`, `Total Earned Premium`, `Total Earned Exposure`), as step 10 saw in the segment classes. The only `.arcrho-resq-import-staging` folder under the project's data folder holds three subfolders created on 2026-07-26 (two copies of a July `COL` import and an empty one) with an index from 2026-08-21, so they are not this plan's leftovers and were left in place.

**Estimate.** Estimate: code edit 15 min, test/validation 25 min, total 40 min. Actual: code edit 4 min, test/validation 4 min, total 8 min; a fifth of the estimate because no code change was needed and the save, the import and every check ran in seconds.

### Step 18 — Bootstrap Simulate runs without saving (runs before step 15)

**Goal.** A bootstrap's Simulate returns a fresh run for the settings on screen without writing anything, like a consolidation's Consolidate; Save persists it.

**Read first.** The decision "Simulate never saves"; [bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py) and [bootstrap_router.py](../../frontend/app_server/api/bootstrap_router.py); step 7's consolidation `consolidate` route and its hosted read registration as the pattern; step 12's Simulate wiring in `frontend/ui/method_pages/bootstrap/`; memory `adding-a-hosted-workspace-read`.

**Do.**
- [x] A `bootstrap/simulate` route and service function that take the owned settings on screen, read the DFM and target as a save does, and return the recalculated method payload without writing; register it as a hosted read kind like the consolidation's run.
- [x] Simulate on the page calls it, shows the run unsaved, and leaves the page dirty until Save; Save keeps working as today. Remove the save-as-simulate wiring.
- [x] Update the bootstrap domain doc, the UI doc, and the release fragment.

**Tests.** Service test: simulate writes nothing and returns the same summary a save would for the same settings and seed; transport selection for the new read kind. Node test for the page's Simulate state (dirty after a run, chip transitions).

**Done when.** Tests pass and the bootstrap test files and the Node suite show no new failures.

**Result (2026-09-23).** `POST /bootstrap/simulate` is the `bootstrap_simulate` hosted read over `simulate_bootstrap_method`. The router sends only the owned settings (`owned_projection` plus the format marker), so the stored residuals and summary never travel and the request stays well under the read size limit. The service shares Save's merge and run (`apply_owned_patch`, then re-reading only a source whose name changed, through the new `_run_merged` that Save now also calls), takes no reserving-class lock, and returns the method with `sidecar.exists: false`. On the page, Simulate calls it, keeps the settings on screen, marks the run "not saved yet" and keeps the page dirty; the state chip now compares a snapshot of the settings that change a run with the one the run on screen came from, as the consolidation page does, so a rename leaves it `Up to date`. Save is unchanged on the server; on the page its progress card says it runs the model only when no run on screen matches. Three service tests (a new method's run writes nothing and equals the save's summary and publication revision; an edited seed and scaling merge like Save and the resave reproduces the run; a missing DFM or unknown format on disk is refused) and two transport tests (registered with the service signature; the route picks the hosted read and strips derived fields) were added; the Node tests pin the chip transitions, which settings move the run snapshot, and that Simulate never calls Save. A direct call against the live COL `F 72 A` took 1.8 seconds, changed none of the class's 189 method and dataset files, and returned the stored summary exactly (scaled mean 58,886, standard deviation 9,277). The bootstrap, consolidation, workspace-read and Gateway read tests pass; the Node suite has the same 23 failures as HEAD.

**Estimate.** Estimate: code edit 30 min, test/validation 20 min, total 50 min. Actual: code edit 8 min, test/validation 2 min, total 10 min; a fifth of the estimate because the consolidation's run-only route and chip were a direct pattern to follow.

### Step 19 — Deploy the bootstrap run route (runs before step 15)

**Goal.** The Engine and Gateway carry step 18's run-only route, so the page can use it through the hosted transport.

**Read first.** Step 14 and the documents it lists.

**Do.**
- [x] Same procedure as step 14: listener heartbeat, `--stale`, `deploy.py`, and check the payload is only this plan's work.
- [x] Verify the Gateway advertises the new read kind and a hosted simulate of COL `F 72 A` returns without writing (file modification times unchanged).

**Tests.** The deploy's own checks.

**Done when.** The components report fresh and the hosted simulate call works.

**Result (2026-09-23).** The listener heartbeat named `E:\XWSpace\Repos\ArcRho-buildbot` and was fresh. `--stale` listed bridge, engine, gateway and credential; as in step 14 the deploy named the first three (`deploy.py bridge engine gateway`, exit 0, about 3 minutes; the Gateway swap retried one busy rename). The tree was clean, so the payload was the commits since base `13c1092e`: 26 files under the component roots, all from this plan's commits. Afterwards `--stale` reports bridge, engine and gateway `Updated` (credential still stale, as before); the 20 changed `frontend/app_server` and `python-api/src` files in the Engine's and Gateway's canonical copies match the tree apart from line endings; the Bridge and its worker, five Engines and the Gateway all came back with fresh heartbeats. The Gateway's capabilities advertise `bootstrap_simulate`, and a signed hosted load then simulate of COL `F 72 A` (Gateway required, no local fallback) returned in 1.8 seconds with `sidecar.exists: false` and the stored scaled mean 58,886 exactly, and none of the class's 317 files changed size or modification time.

**Estimate.** Estimate: code edit 5 min, test/validation 20 min, total 25 min. Actual: code edit 1 min, test/validation 5 min, total 6 min; about a quarter of the estimate because the warm build slots made the deploy take about 3 minutes.

### Step 15 — End-to-end check in both GUIs

**Goal.** A person's path works in both apps, and the numbers agree: in ResQ, open the Total consolidation, consolidate, and read its results; in Arco, open the same consolidation and a segment bootstrap from the project list, run them, and read results that agree with ResQ within the parity bar.

**Read first.** [agent-instructions/gui-verification.md](../../agent-instructions/gui-verification.md) and the screen-control README; memories `arcrho-launch-electron-detached`, `desktop-input-control-works`, `arcrho-dev-ui-cache-restart`; step 10's Parity results.

**Do.**
- [x] ResQ GUI: open COL `F 72 A` → Results (scaled summary), then Total `F 72 A` consolidation → Consolidate → Results; screenshot each and note total mean, standard deviation and 99.5%. Close editors with Cancel.
- [x] Arco GUI (dev app on this machine): open COL `F 72 A` from the project list, check each tab renders, Simulate, read Results; open the Total consolidation, check Segments and Correlation, Consolidate, read Results; change one correlation, confirm the state chip and the result move, then Cancel without saving. Saving in the fake project is allowed where a check needs it (for example to confirm Save persists a bootstrap run).
- [x] Record both sets of numbers side by side and the verdict in the Parity results section; list any defect found as a new step appended after this one rather than fixing it here.
- [x] Delete the screenshots under `temp\`.

**Tests.** The GUI walk.

**Done when.** Both walks complete, the numbers are recorded, and no blocking defect remains open.

**Result (2026-09-23).** Both walks completed; the numbers are side by side in [Parity results](#parity-results) and agree within the parity bar.

- **ResQ.** COL `F 72 A` → Results → Scaled Results showed mean 58,886, standard deviation 9,304, CV 15.80%, 99.5% 84,353 (the 0.1% ladder in the Detail grid). Total `F 72 A` → Consolidate → Results showed 508,444, 74,529, 14.66%, 99.5% 724,130, the saved run exactly. Both editors were closed with Cancel, ResQ was left on the Total class and minimised as it was found.
- **Arco, bootstrap.** COL `F 72 A` opened from the project list on Results, `Up to date`; Details, Residuals, Simulation, Targets, Notes and Audit Log all render. Simulate ran in 1.8 s, marked the run "not saved yet" and the window dirty, showed the same figures (58,886, 9,277, 15.8%, 84,657) and changed none of the class's 317 files. Save then kept the run (three files rewritten: the method, its sidecar and the class index) behind the usual review warning for the unreviewed `F 92`, and the list row turned current.
- **Arco, consolidation.** The Total class now appears under `Direct Group`, and its `F 72 A` opened `Up to date` after that COL save. Details, Segments (five rows, each `Ready` with its own figures), Correlation (0.38 and 0.34 in the mirrored target matrix), Notes and Audit Log render. Consolidate ran without saving in 8.6 s and gave 508,444, 75,141, 14.8%, 725,738. Switching the correlation to Independent turned the chip to `Inputs changed — run again`; Consolidate then gave 69,751 and 708,725 with the mean unchanged. Cancel asked to discard, and none of the Total class's 67 files changed. The app was quit, as it was not running before.
- **Defect found (step 20).** The consolidation's oldest origin shows standard deviation 0 in Arco against ResQ's 701, and 2018 shows 807 against 1,037. Both come from `MP+PIP`: Arco's `F 25 - Incurred DFM Bootstrap` in that class has a tail factor of 1.0 where ResQ's has 1.0018, so its 2017 DFM reserve is 0 against ResQ's 215. Its bootstrap's 2017 range is then flat (0 against 701), and 2018 is 618 against 911. The scaled means still match, because the Additive target shifts them onto `F 92`, and the totals stay within the bar. Every other segment's tail is 1.0 in both apps. Steps 20 and 21 fix it.
- **Not possible with the walk tool.** Typing a number into a correlation cell needs the keyboard, which the tool does not have. The correlation change was made with the Independent option instead.

**Estimate.** Estimate: code edit 15 min, test/validation 65 min, total 80 min. Actual: code edit 6 min, test/validation 14 min, total 20 min; about a quarter of the estimate because the first attempt had already found the way through both apps and every run took seconds.

### Step 20 — The MP+PIP bootstrap carries ResQ's tail factor (appended after step 15)

**Goal.** Arco's copy of `MP+PIP`'s `F 25 - Incurred DFM Bootstrap` carries ResQ's tail factor (1.0018), so the `F 72 A` bootstrap built on it gives the oldest origins a range that matches ResQ's, and the Total consolidation's by-origin figures follow.

**Read first.** Step 15's result; the `resq-dfm-curves-com-api` and `resq-com-probe` memories (the Ratios-tab tail is the selected average row's `TailFactor`, the Curves-tab tail is `SelectedTailFactor`); the DFM part of the ResQ import under `python-api/migration/resq_migration/` (find where the selected ratios and the tail are written); `python-api/tests/fixtures/dfm_curves_resq_c12.json` and its test as the fixture pattern; the step 8 bootstrap import, which snapshots the DFM's selected ratios.

**Do.**
- [x] Read ResQ's `MP+PIP` `F 25` over COM on the Server PC (named getters only) and pin where 1.0018 comes from: the Ratios-tab tail, a curve, or a user entry. It is the Ratios-tab tail of the computed `Volume - all` row, which the DFM contract resets to 1.0; see open decision 4.
- [ ] Fix the import so Arco's DFM selects the same tail; a hand edit of the method file is not the fix.
- [ ] Re-import `MP+PIP` from the working tree (outside the sandbox), then check that the DFM's tail and 2017 reserve (about 215) match ResQ, and that the bootstrap's 2017 and 2018 standard deviations are within the bar of ResQ's 701 and 911. Then check the Total `F 72 A` loads with `MP+PIP` changed and matches ResQ by origin after Consolidate and Save.
- [ ] Extend `tools/bootstrap_parity_report.py`, or the Parity results, to compare by origin as well as in total, so a gap like this one shows up.

**Tests.** An import test pinning the tail against a small captured fixture; the DFM, bootstrap and consolidation import tests pass.

**Done when.** The re-imported `MP+PIP` DFM equals ResQ's `F 25` to 1e-9 in every origin, and every by-origin standard deviation of `MP+PIP` and of the Total consolidation is within the parity bar.

**Estimate.** Estimate: code edit 30 min, test/validation 25 min, total 55 min.

### Step 21 — Deploy the tail-factor fix (appended after step 20)

**Goal.** The Bridge, Engine and Gateway carry step 20's import fix.

**Read first.** Step 14 and the documents it lists.

**Do.**
- [ ] Same procedure as step 19: listener heartbeat, `--stale`, `deploy.py`, and check the payload is only this plan's work.
- [ ] Verify each component's deployed copy of the changed import modules matches the tree.

**Tests.** The deploy's own checks.

**Done when.** The components report fresh, with the fix in their deployed copies.

**Estimate.** Estimate: code edit 5 min, test/validation 20 min, total 25 min.

## Rough size

15 steps, estimated at 1,095 minutes of agent time: 640 minutes of code editing and 455 minutes of test and validation runs. Step 3 (90 minutes: 55 editing, 35 validation) was dropped when step 2 could not identify ResQ's random stream. That leaves 14 steps and 1,005 minutes: 585 minutes of editing and 420 of validation. Step 16 (50 minutes: 30 editing, 20 validation) was added when step 10 found the import's calculated-class scope too wide, bringing the live total to 15 steps and 1,055 minutes: 615 of editing and 440 of validation. Steps 17-19 (115 minutes: 50 editing, 65 validation) were added when step 15 found the Total class missing from the project list and Simulate saving, bringing it to 18 steps and 1,170 minutes: 665 of editing and 505 of validation. Steps 20-21 (80 minutes: 35 editing, 45 validation) were added when step 15 found `MP+PIP`'s DFM missing ResQ's tail factor, bringing it to 20 steps and 1,250 minutes: 700 of editing and 550 of validation.

## Parity results

Filled in by steps 10, 15 and 17.

**Step 15 (2026-09-23), read off both GUIs.** Scaled total reserve. ResQ's consolidation figures are after pressing Consolidate in memory; Arco's are a run-only Simulate or Consolidate.

| Method | App | Mean | Std. dev. | CV | 99% | 99.5% |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| COL `F 72 A` | ResQ | 58,886 | 9,304 | 15.80% | 81,571 | 84,353 |
| COL `F 72 A` | Arco | 58,886 | 9,277 | 15.8% | 82,103 | 84,657 |
| Total `F 72 A` | ResQ | 508,444 | 74,529 | 14.66% | 703,326 | 724,130 |
| Total `F 72 A` | Arco | 508,444 | 75,141 | 14.8% | 701,724 | 725,738 |
| Total, correlation set to Independent | Arco | 508,444 | 69,751 | 13.7% | 687,473 | 708,725 |

**Verdict: the GUIs agree with each other and with step 10's table, within the parity bar.** Setting the correlation to Independent lowers the standard deviation by about 5,400, as expected. By origin, the Total's 2017 and 2018 standard deviations (Arco 0 and 807, ResQ 701 and 1,037) are outside the bar. The cause is `MP+PIP`'s missing tail factor (step 15's result), and step 20 fixes it.

**Step 17 (2026-09-23).** With `Total` a composite type, the Engine builds the Total class's `Net Loss--Incurred` from source rows. Its latest diagonal, origins 1-10: 508,936; 564,825; 556,190; 584,184; 722,768; 736,241; 758,337; 713,395; 514,419; 138,300 (total 5,797,596). It equals the sum of the five segments' and ResQ's Total to within 1.2e-10 in every origin. The re-imported Total `F 72 A` consolidation gives the same figures as the step 10 table below.

**Step 10 (2026-09-23).** Scaled total reserve of Arco's imported methods against ResQ's saved run, from `py -3.10 tools/bootstrap_parity_report.py`. z is Arco minus ResQ in ResQ standard errors, taken from ResQ's own 10,000 captured totals (mean: sd/√n; standard deviation: fourth moment; percentiles: order statistics; CV: delta method). Arco's run carries the same sampling error, so the bar of three combined standard errors is |z| ≤ 4.24.

| Segment | Mean | Std. dev. (z) | CV (z) | 75% (z) | 90% (z) | 95% (z) | 99% (z) | 99.5% (z) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| BI Total | 273,917 = ResQ | 57,651 / 56,987 (+1.46) | 21.05% / 20.80% (+1.41) | 308,942 / 309,093 (−0.20) | 351,582 / 347,820 (+3.60) | 375,977 / 375,248 (+0.44) | 427,172 / 432,107 (−1.57) | 446,758 / 452,639 (−1.63) |
| CMPxCAT | 33,708 = ResQ | 5,856 / 5,922 (−1.38) | 17.37% / 17.57% (−1.35) | 37,387 / 37,379 (+0.08) | 41,396 / 41,485 (−0.78) | 43,831 / 44,177 (−2.07) | 49,321 / 49,402 (−0.21) | 51,653 / 51,783 (−0.18) |
| COL | 58,886 = ResQ | 9,277 / 9,304 (−0.40) | 15.75% / 15.80% (−0.39) | 65,010 / 64,885 (+0.95) | 70,804 / 70,915 (−0.55) | 74,525 / 74,785 (−1.36) | 82,103 / 81,571 (+1.67) | 84,657 / 84,353 (+0.51) |
| MP+PIP | 57,372 = ResQ | 33,079 / 33,140 (−0.23) | 57.66% / 57.76% (−0.19) | 77,330 / 77,441 (−0.24) | 100,935 / 100,596 (+0.44) | 115,980 / 116,080 (−0.09) | 145,592 / 148,410 (−2.06) | 158,056 / 160,310 (−1.04) |
| PD+UMPD | 84,560 = ResQ | 16,608 / 16,379 (+1.86) | 19.64% / 19.37% (+1.80) | 94,935 / 94,860 (+0.33) | 106,427 / 105,914 (+1.63) | 113,633 / 113,160 (+0.99) | 127,989 / 127,495 (+0.82) | 133,194 / 134,286 (−1.72) |
| Total consolidation | 508,444 = ResQ | 75,141 / 74,529 (+1.12) | 14.78% / 14.66% (+1.10) | 556,654 / 555,066 (+1.15) | 606,558 / 607,393 (−0.62) | 638,722 / 640,807 (−1.00) | 701,724 / 703,326 (−0.38) | 725,738 / 724,130 (+0.37) |

Cells read Arco / ResQ. **Verdict: every segment and the total are within the parity bar.** The scaled means are deterministic under Additive scaling and equal ResQ's to the unit. The largest gap is BI Total's 90th percentile at 3.60 ResQ standard errors, 2.5 combined. The consolidation's standard deviation is 75,141 against ResQ's 74,529, and its diversification benefit (the sum of the standalone standard deviations less the total's) is about 47,000.
