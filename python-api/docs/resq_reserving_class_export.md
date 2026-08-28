# Export Reserving Class to ResQ — design notes and open questions

Status: first release notes for the `Export Reserving Class to ResQ` macro
(`python-api/macros/export_reserving_class_to_resq.py`), 2026-08-11.
Verified against ResQ connection `JGO_CO1SQLWPV22`, project
`NJ_Annual_Prod_202605_Fake` on both the ArcRho Server and the ResQ database.

## What the macro does

For the reserving-class path selected in the active Project Instance page, the
macro pushes ArcRho state into the matching ResQ reserving class over the ResQ
COM API (`ResQ3Automation.ResQApplication`), in this order:

1. **Plain datasets** (sidecar `method_type_code == 0`): triangle and vector
   values from the reserving-class `datasets/` CSV cache, cell by cell
   (`SetValuesByIndex`). Missing ResQ datasets are created under their existing
   Dataset Type; vectors are written at `StoredPeriodLength` and the display
   length is restored before `Save()`.
2. **DFM methods** (`methods/DFM@*.json`): ratio exclusions
   (`SetExcludedRatios`), User Entry factors (`SetUserRatios`), per-column
   selected averages (`SetSelectedRatios`), matching average rows by
   whitespace-normalized label against `AverageFormula(i)`, and Method Notes
   (`Notes`) taken from the method's output sidecar.
3. **Bornhuetter Ferguson** (`BF@*.json`): `Latest`/`LatestType`,
   `PercentageDeveloped(Type)`, `Prior`/`PriorType`, `OriginLength`.
4. **Cape Cod** (`CC@*.json`): `Exposure`, `Latest`, `PercentageDeveloped(Type)`,
   `AutoTrendFit`, `TrendRate`, `DecayFactor`, `AltUltimateCalc`.
5. **Result Selection** (`RS@*.json`): loads missing source datasets
   (`AddDataset`), weights (`SetWeights`), and selected-ultimate overrides
   (`ClearOverriddenUltimates` + `SetUltimates(i, OriginLength, v)`).

Each mutated object gets its own `Save()`; dataset writes run inside
`project.BeginDelayedUpdate()`/`EndDelayedUpdate()` when available. Errors and
skips are collected per item and reported in the summary dialog instead of
aborting the run.

Deliberately **not exported**: Bootstrap methods (excluded by request),
Berquist Sherman methods (no documented COM creation path), method *output*
datasets (their ResQ method recomputes them), datasets that are `Calculated`
in ResQ (ResQ recomputes them), and the derived `@6`/`@12` aggregated CSV
cache variants (only the sidecar's native `csv_file` granularity is written).

## Verified behavior (fake-project read/write tests)

- 749 read-back comparisons across vector values, DFM
  exclusions/selections/User Entry factors, RS weights, and BF linkage came
  back identical to the ArcRho sources for
  `PRNJ - PA\PA\NY\Direct Group\BI Total`; the Cape Cod method in
  `PRNJ - PA\PA\All States\Direct Group\COL` round-tripped its linkage,
  `AutoTrendFit`, and `DecayFactor`.
- Dataset creation was exercised end to end: a deleted ResQ vector was
  recreated under its existing Dataset Type with byte-identical values.
- The pywin32 write convention for parameterized VBA property puts is
  `Set<Property>(indices..., value)` (e.g. `SetValuesByIndex`,
  `SetSelectedRatios`); it appears nowhere in the ResQ documentation but is
  proven by `python-api/migration/references/ResQToolBox2.py`, the API example
  notebook, and the ArcRho Bridge `SyncDFM` implementation.

## Practical constraints found during testing

- **ResQ names carry stray whitespace.** Real objects exist with trailing or
  doubled spaces (`"...Earned Premium "`, `"C 92 -  Current Qtr Selected"`),
  while ArcRho normalized all names on import. A plain `collection.Item(name)`
  misses those objects, so every macro lookup falls back to a cached
  whitespace-normalized name map. Any future ResQ write-back code must do the
  same.
- **Dataset Type inserts can be permission-blocked.** The test ResQ user gets
  "You do not have permission to insert a Dataset Type", so ArcRho-only
  datasets whose Dataset Type does not exist in ResQ cannot be exported; the
  macro records the `dataset_type_not_creatable` skip. Genuinely new method
  exports (whose output type equals the new method name) hit the same wall.
- **Template-implementation methods are locked.** Deleting (and presumably
  structurally changing) a method that belongs to a ResQ reserving-class
  template fails with "it is part of the ... template implementation". Value
  and selection syncs still work; the method create path therefore only
  matters for non-template methods.
- **The ArcRho `datasets/` CSV cache is lazy.** In the test reserving class 75
  of 78 plain datasets had no CSV on disk and were skipped
  (`missing_csv_cache`). Users must open a dataset once in ArcRho (or a batch
  cache build must exist) before its values can be exported. Method JSONs are
  complete on disk, so method sync is unaffected.
- **COM collection state is cached per connection.** After `Delete()` the item
  still appears in the same session's collection; a fresh
  connection sees the truth. The macro uses a single connection and only
  creates, so this only affects external test tooling.

## Unclear / undocumented areas (for future work)

ResQ COM API:

1. Enum ordinals are undocumented; only `ResQMethodType` 0-4/8/9,
   `ResQDataFormat` 0/1, `RatioExclusionType` 0/1/2, and `PercDevelopedType`
   0-3 are empirically confirmed. `ScalingType` codes are unknown, so the
   macro does **not** write Cape Cod `scaling_type`.
2. `AddMethod` accepts 1-4 in live code; whether it supports Berquist Sherman
   (8/9) or Bootstrap (6) is unknown — no creation example exists anywhere.
3. The User Entry average row is documented as row 11 but is row 10 in this
   database; the macro always resolves it dynamically via `AverageFormula`
   labels, never by fixed index.
4. `GetCapeCodMethod` (docs) vs `GetCapeCodeMethod` (ResQToolBox2) — the macro
   avoids both and iterates `CapeCodMethods()`.
5. No bulk/SafeArray write path exists; every cell is one COM round trip.
   Whether `BeginDelayedUpdate` materially speeds up large triangle loads is
   unmeasured.
6. There is no explicit `Recalculate`; recalculation appears synchronous on
   property set, but save-failure semantics (partial in-memory state) are
   undocumented.
7. `Save()` on `Selected` must be isolated per the docs; the macro never
   touches dataset `Selected` flags for this reason.
8. BF multi-prior model (`AddPriorVector`/`PriorRatioObj`) has doc pages but
   no worked example; the macro uses the backwards-compatible single `Prior`,
   so only the first ArcRho `prior_datasets` entry is exported.
9. Whether ResQ accepts written Benchmark-row factors is unverified; the macro
   only writes User Entry rows.

ArcRho → ResQ mapping gaps (lossy or ambiguous reverse direction):

10. BF v3 JSON dropped `percentage_developed_type_code`/`prior_type_code`
    (v2 kept them). For v3 files the macro defaults to
    `pdCumDevFactors` (2) and `ptUltimates` (0).
11. Cape Cod `prior_ultimate_mode` collapses ResQ codes 0/2/3 to
    `latest_ultimates`; the macro writes 2 (`pdCumDevFactors`) for that mode
    and 1 for `pattern`, so an original 0/3 configuration is not restored.
12. BF per-origin prior weights in ArcRho (`prior_datasets[].weights`) have no
    confirmed ResQ write target (import hardcodes them to 1.0); they are not
    exported. Candidates (`ManualRatioWeights`, `PriorRatioObj.RatioWeights`)
    need a ResQ-side experiment.
13. DFM `excluded == 2` (no data) is never written; ResQ derives empty cells.
    Legacy v1 method files that stored 2s are treated as "not excluded".
14. ArcRho User Entry *formula text* (`average formulas.inputs`) cannot be
    represented in ResQ; only the resolved numeric factor is written.
15. Custom average definitions (`custom average formula settings`) are matched
    by label only. An ArcRho-authored average whose label does not exist in
    the ResQ method is skipped for that column (`SetSelectedRatios` is not
    called); creating/reordering ResQ averages via `CustomAverages(i)` writers
    is untested.
16. Notes live in the ArcRho sidecar — a dataset's own, or the *output
    sidecar* of a DFM, BF, Cape Cod, or Result Selection method, never the
    method JSON. `collect_rc_artifacts` attaches that value to a method entry
    whenever the output sidecar exists, and every writer sets the ResQ `Notes`
    of the triangle, vector, or method from it with line breaks normalized to
    `\r\n` (ResQ renders a `\n`-only value as one line), clearing them for an
    empty value and leaving them unchanged when the entry carries no `notes`
    — the same rule the Bridge `SyncDFM` write-back applies. The triangle and
    vector readers read ResQ `Notes` as well, so an import lands them in the
    sidecar. Only the bulk DFM import keeps an existing sidecar's notes; the
    sync never meets that case because it deletes the target before importing.
    Cell notes remain read-only in the Bridge.
17. Engine-generated datasets carry no ResQ provenance and no axis labels in
    their sidecars; the macro writes them by index position against the ResQ
    grid after aligning `OriginLength`/`DevelopmentLength` to the sidecar. If
    the ResQ project grid changed since import, index alignment is unchecked.
18. The ArcRho project name is assumed to equal the ResQ project name (true
    for the fake test pair). A mapping override exists on the headless entry
    point (`resq_project_name=`) but has no UI.
19. Result Selection dataset ordering after `AddDataset` is assumed stable;
    weights are addressed through a name→index map rebuilt after adds, but
    ResQ's `CustomSortIndex` semantics are undocumented.
20. Ultimate overrides push ArcRho `ultimate_overrides` as ResQ overridden
    ultimates. ArcRho's `calculated_ultimate` may already differ numerically
    from ResQ's own weighted calculation; whether to force-push non-overridden
    ultimates is a policy question left unanswered (they are not pushed).

Architecture:

21. The macro talks to ResQ COM directly in the app-server process (same
    pattern as `import_resq_dataset.py`), so it requires ResQ installed on the
    machine running ArcRho. Client PCs without ResQ would need a Bridge-based
    variant (a new `ExportResQReservingClass` Bridge function mirroring the
    import request/status contract) — not built yet.
22. The DFM selection-sync logic intentionally mirrors the ArcRho Bridge
    `SyncDFM` implementation (`server-components/src/arcrho_bridge/resq_client.py`).
    If the Bridge sync rules change, the macro must follow; consolidating both
    behind one shared module is open work (the macro cannot import the Bridge
    package today).
23. The in-app `run_macro` UI flow (Project Instance context, confirmation
    dialog, progress, summary) reuses the proven import-macro plumbing but was
    not exercised end to end inside the app in this round; the headless core
    (`export_reserving_class_to_resq(...)`) is what the tests drove.
