# Bootstrap and Stochastic Consolidation

Status: Broken into 15 session-sized steps on 2026-09-23; step 1 done the same day (ResQ's segment targets made realistic, the five bootstraps and the Total consolidation saved in ResQ and captured as the reference fixture, rule 3 confirmed exactly). Step 2 done the same day: ResQ's rank generation is pinned exactly (normal copula via the lower Cholesky factor of `2·sin(π·ρ/6)`, eigenvalue clipping at 1e-6 for a non-positive-definite target, and the Uniform, Gamma and Student's T variants), and its normals are known to be polar-method draws on a `1/(2³¹ − 1)` uniform grid. The uniform generator itself was not identified, so step 3 is dropped and parity with ResQ is statistical. Step 4 done the same day: a bootstrap's stored summary now carries the half-percent percentile ladder, ultimate statistics and a total-reserve histogram, it hands a consolidation its individual simulations and ranks, all five segments match ResQ within sampling error, and the summary statistics follow ResQ's own definitions exactly. Step 5 is next.
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
| 5 | Arco can combine several segments' simulations with chosen correlations, matching ResQ | [ ] | | 70 min | | |
| 6 | A consolidation can be saved and reopened as its own method with its own output | [ ] | | 60 min | | |
| 7 | A consolidation can be opened, run and saved through the server, reading bootstraps from other classes | [ ] | | 75 min | | |
| 8 | Importing a class from ResQ brings its bootstrap methods across | [ ] | | 70 min | | |
| 9 | Importing a total class from ResQ brings its consolidation across | [ ] | | 65 min | | |
| 10 | The fake project holds all five segment bootstraps and the total consolidation, checked against ResQ | [ ] | | 60 min | | |
| 11 | The bootstrap page opens from the project list, with its setup and residual tabs | [ ] | | 90 min | | |
| 12 | The bootstrap page shows its results: ranges, percentiles and charts | [ ] | | 90 min | | |
| 13 | The consolidation page lets you pick segments, set correlations and see the combined range | [ ] | | 100 min | | |
| 14 | The server components carry the new calculations and imports | [ ] | | 30 min | | |
| 15 | The whole flow is checked by hand in both ResQ and Arco | [ ] | | 80 min | | |

Overall: 3 of 14 steps done (step 3 dropped). Estimated 1,005 min, actual so far 57 min.

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

**Arco's copy of the fake project** has BI Total, CMPxCAT, COL and PD+UMPD under `All States\Direct Group`, each with `F 25` and `F 92`, but no bootstrap methods, and it has neither `MP+PIP` nor `Total` for All States.

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

None open. Decision 1 below was settled on 2026-09-23.

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

**Read first.** [How ResQ consolidates](#how-resq-consolidates) and [Random numbers](#random-numbers) as steps 1–2 left them; step 4's per-simulation function; `bootstrap_simulation.py` for code style (dependency-free Python).

**Do.**
- [ ] Add `python-api/src/arcrho_api/stochastic_consolidation_simulation.py`: target-to-adjusted conversion (`2·sin(πρ/6)` for Normal, and whatever step 2 recorded for the other structures), positive-definite repair, Cholesky, rank generation for the four correlation options and four dependency structures, the rule-3 combination with factors, the consolidated summary (same shape as step 4's), achieved rank and linear correlations between segments, and per-segment standalone statistics for the diversification view.
- [ ] Seeded and deterministic; uses step 3's stream if step 3 landed.

**Tests.** `python-api/tests/test_stochastic_consolidation_simulation.py`: rule 3 reproduces ResQ's consolidated totals exactly from step 1's fixture; Arco's own ranks for the reference seed and matrix achieve the target rank correlations within sampling error; 0% gives achieved correlations near 0 and 100% gives 1; Student's T with low degrees of freedom shows more upper-tail co-movement than Normal; a non-positive-definite target is repaired as specified; the consolidated mean equals the sum of segment means times factors for every correlation option.

**Done when.** The new tests pass, and Arco's consolidated total standard deviation for the reference model (from ResQ's segment simulations plus Arco's ranks) is within three standard errors of ResQ's.

**Estimate.** Estimate: code edit 45 min, test/validation 25 min, total 70 min.

### Step 6 — Consolidation persisted contract

**Goal.** A Stochastic Consolidation has its own method JSON, output vector and sidecar, following the same contract patterns as the bootstrap, and appears correctly in a reserving class's index.

**Read first.** `$arcrho-json-contract` skill; [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md) sections Persisted JSON Producer Parity and Persisted JSON Text Format; [bootstrap_contract.py](../../python-api/src/arcrho_api/bootstrap_contract.py) lines 464–1075 as the pattern; [dataset_index_contract.py](../../python-api/src/arcrho_api/dataset_index_contract.py) for method-type registration; `sidecar_core_contract.py` for the reserved cross-class link fields.

**Do.**
- [ ] Add `python-api/src/arcrho_api/stochastic_consolidation_contract.py` with the [canonical labels](#decisions): normalisation, `details`, `segments` (reserving class path, method name, factor, the consumed bootstrap's revision), `correlation` (option, dependency structure, degrees of freedom, target matrix, used matrix), `results` (seed, simulation count, summary, achieved matrices, segment statistics), notes/audit; owned/derived/publication projections and revisions; the output vector (consolidated mean ultimate by origin: sum of each segment's latest times factor, plus the consolidated mean reserve) and its aggregated variants; the output sidecar with cross-class precedents in the reserved link fields.
- [ ] Register `Stochastic Consolidation` as a method type wherever the index contract and the method-type label list need it, with the parity coverage the guidelines require.

**Tests.** `python-api/tests/test_stochastic_consolidation_contract.py`: normalisation round trip, revisions stable under reformatting, a mismatched base type or simulation count refused with the method named, sidecar and index projections, and the full-payload index parity test.

**Done when.** The new tests and the existing index parity tests pass.

**Estimate.** Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 7 — Consolidation server service

**Goal.** The app server can load, consolidate, and save a Stochastic Consolidation, reading the included bootstraps from their own reserving classes, with the load and save hosted like every other method.

**Read first.** [bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py) (whole file, as the pattern), [bootstrap_router.py](../../frontend/app_server/api/bootstrap_router.py), [schemas/bootstrap.py](../../frontend/app_server/schemas/bootstrap.py), [arcrho_workspace_read_contract.py](../../python-api/src/arcrho_workspace_read_contract.py), [arcrho_engine_save_contract.py](../../python-api/src/arcrho_engine_save_contract.py); memories `adding-a-hosted-workspace-read`, `adding-a-hosted-save-kind`, `propagation-hold-and-test-isolation`.

**Do.**
- [ ] `stochastic_consolidation_service.py`, router and schemas: `load` (method JSON and sidecar, plus a freshness check comparing each segment's stored revision with the bootstrap's current one, reported per segment), `consolidate` (re-run each segment's simulation through step 4's function, then step 5; returns results without writing), `save` and `save/plan` (hosted, revision-aware, publishing method, CSVs and sidecar last), and a `segments/candidates` read that lists bootstraps in other classes of the project for the picker.
- [ ] Register the hosted read and save kinds; add the route to the generated route docs; add the domain doc `frontend/docs/app_server/domains/stochastic_consolidation.md`.
- [ ] Say in the domain doc that cross-class propagation is deferred and freshness is checked on open.

**Tests.** `frontend/tests/test_stochastic_consolidation_service.py` using the workspace stub: load of a saved method, consolidate over two synthetic bootstraps in two classes, save/reopen round trip, a changed segment reported stale, the candidates list, transport selection for the new read and save kinds.

**Done when.** The new service tests pass along with the bootstrap service tests, and `python frontend/tools/docs_index_builder.py --check` is clean.

**Estimate.** Estimate: code edit 50 min, test/validation 25 min, total 75 min.

### Step 8 — Import bootstraps from ResQ

**Goal.** Importing a reserving class from ResQ brings each Bootstrap method across as an Arco bootstrap built through the shared contract, carrying ResQ's settings and seed.

**Read first.** [extractors.py](../../python-api/migration/resq_migration/extractors.py) around `export_cape_cod` (line ~2576) through `_find_cape_cod_for_vector` (~2798) and `_find_unique_method_by_output` (~1147); [resq_data_migration.py](../../python-api/migration/resq_data_migration.py) around `_cc_export_names` (~653), `export_vectors_for_rc` (~1396–1640) and `_selected_exports` (~1796); [sync_session.py](../../python-api/migration/resq_migration/sync_session.py) lines 73–83 and 395–433; the bootstrap plan's [ResQ Migration](../../frontend/docs/plans/bootstrap_method_plan.md#resq-migration) section; memory `macro-must-not-depend-on-app-arcrho-api`.

**Do.**
- [ ] `export_bootstrap`, `_find_bootstrap_for_vector` (via `reserving_class.BootStrapMethods()` or `GetBootStrapMethod`, always through the class, never the project), and the vector-loop branch for method type 6, riding the existing methods flag with its own written count. The DFM snapshot is built from the migrated Arco DFM, so every producer shares one calculation; the imported bootstrap is simulated once on import so its summary exists.
- [ ] Recognise method type 7 in the sync session as `Stochastic Consolidation` (label only; step 9 imports it).
- [ ] Update [python-api/docs/resq_reserving_class_export.md](../../python-api/docs/resq_reserving_class_export.md) where it lists what is left out.

**Tests.** Migration tests with a fake COM bootstrap built from step 1's fixture: the written `BST@` payload equals the one the app server would save for the same inputs (full-payload parity), ResQ's seed and settings round-trip, and the residuals match ResQ's.

**Done when.** The migration tests pass, and a local run of the import for COL (Server PC, outside the sandbox) writes `BST@F 72 A - Bootstrap Net incurred with PV.json` whose residual grid matches ResQ.

**Estimate.** Estimate: code edit 40 min, test/validation 30 min, total 70 min. Actual: code edit 9 min, test/validation 2 min, total 11 min; far under because the earlier attempts had already mapped the COM calls and every ResQ run takes under a second.

### Step 9 — Import consolidations and the total class from ResQ

**Goal.** Importing ResQ's Total class brings its Stochastic Consolidation across, with its segments pointing at the imported bootstraps in their own classes.

**Read first.** Step 8's changes; [resq_data_migration.py](../../python-api/migration/resq_data_migration.py) `import_reserving_class_from_resq` (~1888–1931); [import_resq_reserving_classes.py](../../python-api/macros/import_resq_reserving_classes.py) (class list); memories `resq-com-probe` (a calculated class and its formulas), `offline-dependent-walk-replay`.

**Do.**
- [ ] `export_stochastic_consolidation` and its finder via `GetBootStrapConsolidation`, mapping included methods to (class path, method name, factor), correlation settings, the target matrix and the seed. The consolidation is consolidated once on import when every segment bootstrap exists in Arco; otherwise it is written unrun and its import message names the missing segments.
- [ ] Make sure a ResQ calculated class imports as an ordinary Arco class: its datasets arrive as values; nothing tries to parse cross-class formulas.

**Tests.** Migration test with a fake COM consolidation from step 1's fixture: payload parity with the service's save for the same inputs; missing-segment message.

**Done when.** Tests pass.

**Estimate.** Estimate: code edit 40 min, test/validation 25 min, total 65 min.

### Step 10 — Populate the fake project and compare with ResQ

**Goal.** Arco's fake project holds `MP+PIP` and `Total` for `All States\Direct Group`, the five segment bootstraps and the Total consolidation, and a written comparison shows how their results line up with ResQ's.

**Read first.** Steps 8–9; memories `migration-script-local-run`, `propagation-hold-and-test-isolation`, `agent-share-listing-blocked-use-python`; [AGENT_GUIDELINES.md](../../AGENT_GUIDELINES.md) Agent Project Data Access.

**Do.**
- [ ] On the Server PC, outside the sandbox, run the import locally (not through the Bridge, which does not have the new code until step 14) for `MP+PIP` and `Total`, then for the four existing segment classes limited to the `F 72 A` bootstraps (and every data change step 1 recorded in the reference-model section, so Arco's `F 92` and triangles match ResQ's). Keep a byte copy of each class folder first.
- [ ] Write `tools/bootstrap_parity_report.py`, which reads Arco's stored summaries and step 1's fixture and prints, per segment and for the total: mean, standard deviation, CV, 75/90/95/99/99.5 percentiles, the difference, and the difference in ResQ standard errors.
- [ ] Record the table and its verdict against the [parity bar](#decisions) in a new "Parity results" section at the end of this plan.

**Tests.** The parity report itself; no new unit tests.

**Done when.** Every segment and the total are within the parity bar, or the plan's Parity results section names the one that is not and why.

**Estimate.** Estimate: code edit 20 min, test/validation 40 min, total 60 min.

### Step 11 — Bootstrap page: shell wiring, setup and residual tabs

**Goal.** A Bootstrap opens from the project list as a floating window with Details, Residuals, Simulation and Targets tabs, and can be created from a vector row and saved.

**Read first.** [Page design](#page-design); `$arcrho-ui-design` skill and its references for layout, controls and tables; [frontend/FRONTEND_AGENT_GUIDELINES.md](../../frontend/FRONTEND_AGENT_GUIDELINES.md); the Cape Cod page (`frontend/ui/method_pages/cape_cod/`: html, `cape_cod_main.js`, `cape_cod_method_api.js`, css); the Cape Cod touch points: `frontend/ui/shared/tabs/window_tab_catalog.js`, `project_instance.html` (~155), `project_instance_dataset_table.js` (~1291–1560, 2479–2611, 3138), `project_instance_windows.js` (~48, 159, 486, 709, 780–796, 980, 1301, 1527–1577), `project_instance_messages.js` (~36–46, 332, 373–388, 632–635, 854–878, 1578), `frontend/ui/shell/iframe_host.js` (~166), `tab_actions.js` (~254), `shell_hotkeys.js` (~84), `shell_state.js` (~93–175), `tab-type-icons/tab_type_icons.css` (~60) and the SVG rules in [agent-instructions/svg-icon-management.md](../../agent-instructions/svg-icon-management.md); `frontend/tests/color_theme.test.mjs` pins; memories `arcrho-dev-ui-cache-restart`, `theme-css-version-pins`, `electron-ui-screenshot-check`.

**Do.**
- [ ] `frontend/ui/method_pages/bootstrap/` with the page shell, the method API wrapper (load, save/plan, save, refresh), and the four setup tabs as designed.
- [ ] Every Project Instance and shell touch point Cape Cod has, for `bootstrap` / `BST@` / `bstTab`, including `Add -> Bootstrap` on eligible vector rows and double-click opening Results.
- [ ] UI doc `frontend/docs/ui/bootstrap.md`; a user-facing release fragment.

**Tests.** `frontend/tests/bootstrap_frontend.test.mjs` (tab catalog entry, window kind, open-JSON name, residual flagging threshold, symmetric settings serialisation); colour-theme pins; the Node suite with the known baseline failures only.

**Done when.** Tests pass, and an Electron screenshot check of the page with a mocked COL `F 72 A` payload shows all four setup tabs laid out per the design.

**Estimate.** Estimate: code edit 65 min, test/validation 25 min, total 90 min.

### Step 12 — Bootstrap page: results

**Goal.** The Results tab shows the reserve range: summary table with the chosen percentiles, scaled/unscaled and reserves/ultimates switches, the distribution chart, the ultimates fan chart, and the run state in the header.

**Read first.** [Page design](#page-design); step 11's page; step 4's summary shape; `frontend/ui/method_pages/cape_cod/cape_cod_ratios_chart.js` and `frontend/ui/shared/components/chart_legend/` for chart conventions; `$arcrho-ui-design` references for tables and states.

**Do.**
- [ ] Results tab, percentile chooser (shared by table and charts), full-ladder toggle, copy-to-clipboard, empty and stale states, Simulate with progress and duration.
- [ ] `bootstrap_distribution_chart.js` and `bootstrap_fan_chart.js` following the per-page canvas chart pattern.
- [ ] Update the UI doc and the release fragment.

**Tests.** Node tests for percentile selection, the fan-chart band computation from the stored summary, and state-chip transitions; Node suite baseline.

**Done when.** Tests pass, and a screenshot check with the real COL summary shows the table and both charts.

**Estimate.** Estimate: code edit 65 min, test/validation 25 min, total 90 min.

### Step 13 — Consolidation page

**Goal.** A Stochastic Consolidation can be created from a vector row, its segments picked across classes, correlations entered, consolidated, and its combined range and segment breakdown read.

**Read first.** [Page design](#page-design); steps 11–12's pages and touch-point list; step 7's routes.

**Do.**
- [ ] `frontend/ui/method_pages/stochastic_consolidation/` with Details, Segments, Correlation, Results, Notes and Audit Log as designed, reusing step 12's table and chart modules (move them to `frontend/ui/shared/` in this step rather than copying them).
- [ ] Every Project Instance and shell touch point for `stochastic_consolidation` / `SCON@` / `sconTab`; `Add -> Stochastic Consolidation`.
- [ ] UI doc `frontend/docs/ui/stochastic_consolidation.md`; release fragment.

**Tests.** `frontend/tests/stochastic_consolidation_frontend.test.mjs` (matrix mirroring and bounds, option switching, stale-segment state, serialisation); colour-theme pins; Node suite baseline.

**Done when.** Tests pass, and a screenshot check with the Total consolidation's stored payload shows each tab per the design.

**Estimate.** Estimate: code edit 75 min, test/validation 25 min, total 100 min.

### Step 14 — Deploy the server components

**Goal.** The Bridge, Engine and Gateway carry the new calculations, hosted reads and saves, and imports.

**Read first.** [Component Deployment Authorization](../../agent-instructions/component-deployment-authorization.md); [Ship impact](#ship-impact); memories `remote-component-deploy`, `deploy-staleness-is-mtime-based`, `bridge-restart-after-deploy`, `hosted-save-fix-needs-engine-deploy`.

**Do.**
- [ ] Check the build listener's heartbeat names the buildbot clone; run `python server-components/deploy.py --stale`, then `python server-components/deploy.py`. If the payload lists files that are not this plan's work, stop and record it under Open decisions.
- [ ] Verify each component's deployed copy of the new modules against the tree, and that the Bridge came back.

**Tests.** The deploy's own checks.

**Done when.** All three components report fresh and a hosted `stochastic_consolidation` load of the Total method returns through the Gateway.

**Estimate.** Estimate: code edit 5 min, test/validation 25 min, total 30 min.

### Step 15 — End-to-end check in both GUIs

**Goal.** A person's path works in both apps, and the numbers agree: in ResQ, open the Total consolidation, consolidate, and read its results; in Arco, open the same consolidation and a segment bootstrap from the project list, run them, and read results that agree with ResQ within the parity bar.

**Read first.** [agent-instructions/gui-verification.md](../../agent-instructions/gui-verification.md) and the screen-control README; memories `arcrho-launch-electron-detached`, `desktop-input-control-works`, `arcrho-dev-ui-cache-restart`; step 10's Parity results.

**Do.**
- [ ] ResQ GUI: open COL `F 72 A` → Results (scaled summary), then Total `F 72 A` consolidation → Consolidate → Results; screenshot each and note total mean, standard deviation and 99.5%. Close editors with Cancel.
- [ ] Arco GUI (dev app on this machine): open COL `F 72 A` from the project list, check each tab renders, Simulate, read Results; open the Total consolidation, check Segments and Correlation, Consolidate, read Results; change one correlation, confirm the state chip and the result move, then Cancel without saving.
- [ ] Record both sets of numbers side by side and the verdict in the Parity results section; list any defect found as a new step appended after this one rather than fixing it here.
- [ ] Delete the screenshots under `temp\`.

**Tests.** The GUI walk.

**Done when.** Both walks complete, the numbers are recorded, and no blocking defect remains open.

**Estimate.** Estimate: code edit 15 min, test/validation 65 min, total 80 min.

## Rough size

15 steps, estimated at 1,095 minutes of agent time: 640 minutes of code editing and 455 minutes of test and validation runs. Step 3 (90 minutes: 55 editing, 35 validation) was dropped when step 2 could not identify ResQ's random stream. That leaves 14 steps and 1,005 minutes: 585 minutes of editing and 420 of validation.

## Parity results

Filled in by steps 10 and 15.
