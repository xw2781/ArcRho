# One-way ResQ reserving-class export

The `Export Reserving Class to ResQ` macro
(`python-api/macros/export_reserving_class_to_resq.py`) pushes one ArcRho
reserving class into the identically scoped ResQ reserving class, one way and
in one piece. It is the push counterpart of the
[sync macro](resq_reserving_class_sync.md): the same Bridge queue, the same
canonical session, the same ResQ writer, the same shared baseline, and the
same results window — minus the per-row direction and the signatures. The
review before the write is the one the Import macro also opens; see
[the shared ResQ transfer review](resq_reserving_class_transfer_review.md).

The ArcRho project name is also used as the ResQ project name, and the
selected reserving-class path must exist in that project on both sides. The
UI does not offer a project or path mapping override.

## What is pushed

For the reserving-class path selected in the active Project Instance page,
every item below is written, each after the items it reads:

- **Input datasets** — every sidecar whose `method_type` is `None`, that is
  neither `calculated` nor an `engine` dataset, and that has a CSV cache on
  disk. Triangle and vector values are written cell by cell
  (`SetValuesByIndex`) and the sidecar Notes go into the ResQ `Notes`. ResQ
  takes values at the period lengths a dataset is shown at, so a triangle is
  emptied (`ClearData`), given the sidecar's `stored_development_length`, shown
  at the sidecar's stored pair for the write, and put back to its display pair
  before the save. When ResQ stores the triangle at a different origin length,
  the emptied triangle is also saved and read again (`Save`,
  `UnloadChildren`, re-find) before the shape is restated: `StoredOriginLength`
  has no setter, the origin store follows `OriginLength` while the triangle
  holds nothing, and that is the sequence the ResQ window itself asks for.
  A dataset that is `Calculated` in ResQ is skipped,
  because ResQ recomputes it, even when ArcRho's library treats the type as an
  editable input.
- **DFM methods** — ratio exclusions (`SetExcludedRatios`), User Entry factors
  (`SetUserRatios`, up to the last ratio column), each average row's `- Ult`
  tail factor (`CustomAverages(i).TailFactor`), the selected average per
  column including the tail column (`SetSelectedRatios`), the Curves tab
  (`FutureDevelopmentPeriods`, `FreeFitC`, `SetIncludedRatios`, the User
  Entry columns through `SetCurveColumnDescription` and `SetCurveValues`
  with `DevIndex = 0` for a column's tail, `SetSelectedEstimates` per period,
  `SelectedTailFactor` and `SelectedTailCurve`), and Notes, the writer the
  sync's apply phase uses too. `FittingMethod` is never written: ArcRho fits
  by log regression only, so a ResQ method fitted by least squares keeps that
  setting; a prior-analysis, pattern or benchmark user column keeps ResQ's
  own values. Before anything is
  written, the first column of every ResQ average formula is read; a DFM with
  a formula ResQ cannot evaluate is skipped with that formula named. The read
  covers the `RatioAverageCount` rows the DFM really has, never the phantom
  rows ResQ reports past them.
- **Result Selections** — the loaded source datasets, weights (`SetWeights`),
  selected-ultimate overrides (`ClearOverriddenUltimates` + `SetUltimates`),
  and Notes.
- **B&S Case Reserve Adequacy methods** — the `Avg. Selections` tab and
  Notes. For each development column of both grids the exporter writes the
  `User Value` row (`SetUserAvgInflation`, `SetUserAvgCaseReserves`) and then
  the estimator selected for the column (`SetSelectedAvgInflation`,
  `SetSelectedAvgCaseReserves`), using the ResQ ordinals the import's label
  maps in `resq_migration.extractors` translate from. The method JSON holds
  the `User Value` row as the numbers the page evaluated, with a formula's
  text kept beside them, so a formula-backed cell reaches ResQ as its plain
  value. The method is then saved.
- **Bornhuetter Ferguson, Cape Cod, and B&S Settlement Rate methods** — Notes
  and a save. The exporter finds the ResQ method by its ArcRho output name,
  writes the Notes of that output sidecar into the ResQ `Notes`, and calls
  `Save()`, so ResQ recalculates it from the datasets and DFMs written before
  it and re-stamps it. No other field is carried across: ArcRho's own
  settings for these methods are not pushed, and a method ResQ does not hold
  is reported as skipped rather than created.

Notes therefore reach ResQ for every kind the export pushes, and always from
the same place — the `notes` of the item's own sidecar, which for a method is
its output sidecar. `\n` line breaks become `\r\n`, because ResQ renders a
`\n`-only value as one line. A sidecar that could not be read carries no
`notes` field at all, and the ResQ Notes are then left untouched rather than
cleared; an empty value that was read does clear them.

Left out, and not shown in the results:

- **Calculated datasets** — propagation recomputes them from their formula
  inputs in ArcRho and in ResQ alike.
- **Engine-generated datasets** (`source_kind: engine`) — ArcRho rebuilds them
  through the Engine and ResQ through its own generator.
- **Bootstrap methods** — ResQ has no write path for them yet.
- **Method output datasets** — they are written through their method, never
  as datasets.

**The export never creates anything in ResQ.** A dataset or method that
exists in ArcRho but not in ResQ is shown as `Skipped` (a warning) and left
alone; a new object reaches ResQ through ResQ itself. Datasets that exist in
ResQ but not in ArcRho are never touched, because only ArcRho's inventory is
walked. A dataset without a CSV cache, or a method-owned output sidecar whose
method JSON is missing, is shown as `Skipped` with the reason as well.

## Write order

Items are written in ArcRho's dependency order, the same topological walk
the sync's apply phase uses (`resq_migration.sync_session`). The graph is the
sidecar `precedents`/`dependents` of the whole reserving class, calculated
datasets included, plus the links in each method row's tabs. A row is written
only after every row it reads, wherever that row sits in the inventory; a
calculated dataset is never written, so a row that reads one is written after
the rows that dataset derives from instead. Rows with no link between them
keep a kind order — datasets, then DFMs and Berquist Sherman adjustments,
then Bornhuetter Ferguson and Cape Cod, then Result Selections — and then the
inventory order.

The graph is genuinely needed. In the fake project, `C 92 - Current Qtr
Selected` (a Result Selection of claim counts) feeds the B&S Settlement Rate
adjustment of `Gross Loss--Paid`, whose adjusted triangle `D 18 - BS Paid
DFM` reads, which `D 92 - Current Qtr Selected` loads in turn; the walk writes
them in exactly that order, so each save in ResQ finds its inputs already
written.

Looking through calculated datasets is needed as well. `C 91 - Current Qtr
Indicated` loads `C 62 Reported *(CWOP/Reported) CDF`, a calculated vector
derived from the `C 52 - CWOP/Reported DFM` output. The B&S adjustment above
pulls `C 92` and `C 91` forward in the walk; without the calculated link,
`C 91` was saved before `C 52`, and ResQ marked it "Needs Review" the moment
`C 52` was saved a second later.

## The review table

Before anything is written, the macro runs the queue's `transfer_preview`
phase and opens the shared review table — the same window, columns, and tick
rules the Import macro opens. That window and the selection it remembers are
described once, in
[the shared ResQ transfer review](resq_reserving_class_transfer_review.md).

What is specific to the export:

- The table is opened with **Export Selected to ResQ** and **Cancel**. It is
  the only confirmation asked for; accepting it starts the write.
- The **This Run** column reads `Overwrites ResQ copy`, `Overwrites newer
  ResQ copy` (the warning, raised only when `ResQ` or `Both` changed since
  the saved pair), or `Not exported`.
- An ArcRho item ResQ does not hold is listed as `ArcRho only` and cannot be
  ticked, because the export creates nothing in ResQ.
- The ticked names go on the `export` request as `SelectedNames`, narrow the
  rows before the dependency walk orders them, and are saved as the default
  for the next export once the writes are done.
- A comparison that fails is not a gate. The failure is shown with
  `Export Anyway` and `Cancel`, and an `Export Anyway` sends no selection at
  all, so the whole class is pushed exactly as it was before selection
  existed. An unreachable Bridge is reported as such instead, since nothing
  could be published either way.

## No row-by-row review, but a baseline

Beyond that table the export compares nothing and verifies nothing before a
write. Every ticked item is written over the ResQ copy, however recently
ResQ changed it. It is the tool for the moment ArcRho is the source of truth
for a class and ResQ should simply follow; use `Sync Reserving Class with
ResQ` when the two sides need reconciling row by row.

What the export does record, once the writes are done, is the baseline: the
ArcRho and ResQ timestamps each written item ends up carrying. Without it,
ResQ's `Save()` re-stamps every written object and the very next review — this
macro's preview and the sync macro's alike — reports every exported item as
`ResQ changed` or `Both changed`, which is noise, not information.

- **Where** — the same shared document the sync macro keeps, one per project,
  reserving class and ResQ connection, under `projects/<project>/sync/resq/`
  on the ArcRho server (`sync.sync_state_path`). It is server-side and
  scoped to the reserving class, so every user reviews against the same pair;
  no copy of it lives on anyone's machine.
- **What** — one entry per logical item, holding both timestamps and when
  they were recorded (`sync.record_synced_items`). Only an item ResQ
  confirmed as `Exported` or `Saved` is baselined; a skipped or failed one
  keeps its old pair, so the next review still reports the difference.
- **The ArcRho side** is baselined at the values the export actually pushed,
  not at a fresh read, so an ArcRho edit made while the export ran stays
  pending rather than being recorded as delivered.
- **Ripple** — ResQ recalculates whatever reads a written item, which
  re-stamps rows the export never wrote. Those moves are the export's own
  doing, so they are absorbed into the baseline
  (`sync.absorb_propagated_changes`) instead of surfacing as ResQ edits.
- **Failure is never fatal** — the writes are already durable when the
  baseline is saved, so a baseline that cannot be read or written is reported
  in the results header and the export still reports its writes. The next
  review simply falls back to comparing timestamps.

Because the document is shared with `Sync Reserving Class with ResQ`, an
export also settles that macro's next preview for everything it wrote.

## Results window

The results open inside the active Project Instance page as the same nested,
read-only review window the sync macro uses (`ui.reviewTableOpen` with
`host: "projectInstance"` and `selectable: false`): one row per item in write
order, with the type, the logical name, an outcome of `Exported`, `Saved`,
`Skipped`, or `Failed`, and the Bridge's message for the item, under a header
naming the project, the reserving class, the ResQ connection, the counts, and
how many timestamp pairs were saved for the next review to compare against.
The window is non-modal, so it can be minimized to the toolbar while the
class is inspected; the macro keeps running until it is closed.

Before anything is published, the macro refuses while the active nested
window has unsaved changes, since an unsaved edit would not be part of the
export. The review table above is the only confirmation asked for.

## Runtime

ResQ automation exists only where ResQ itself is installed, which is usually
not the machine ArcRho runs on. The macro therefore owns no ResQ session and
reads no reserving-class file: it publishes an `export` request to the same
Bridge queue the sync macro uses (`SyncResQReservingClass`, contract version
4, under `requests\RPC bridge\resq_reserving_class_sync\`), and a
ResQ-connected ArcRho Bridge worker on the Server PC runs
`resq_migration.sync_session.export_reserving_class` on its behalf. The
worker takes the reserving-class job lease a ResQ import and a sync apply
take, so no two of them write one reserving class at the same time, and
connects to ResQ with the shared service account from the server
`config.json`.

The client side is shared with the sync macro: `arcrho_api.resq_sync_queue`
builds, publishes, and waits on the request and refuses before publishing
when no ResQ-connected worker heartbeat is live, and
`arcrho_api.ui.await_review_table` hosts the results window. Any Client PC
can therefore export, provided some machine is running ResQ with ArcRho open.
Inside the app the request is published through the
`resq_sync_request_publish` hosted mutation and its status is polled through
the hosted Bridge-liveness read, so the queue is never touched over the
share; see the transport notes in
[resq_reserving_class_sync.md](resq_reserving_class_sync.md).

The ResQ writer, `ResQReservingClassExporter`, lives in the macro file. The
Bridge freezes that file beside the canonical migration
(`arcrho_bridge/bundled_sources.py`) and loads it as its writer, so an edit to
the exporter or to the session has no effect on an export or a sync until the
Bridge is rebuilt and redeployed. The worker refuses a bundle whose
`SYNC_SESSION_API_VERSION` it was not built against rather than driving it.

For headless use, build a runtime with
`resq_migration.sync_session.build_runtime(migration, exporter_module)` and
call `export_reserving_class(runtime, project_name, rc_path, server_root=...)`
on a machine with ResQ.

## ResQ COM findings

Verified on 2026-08-11 against ResQ connection `JGO_CO1SQLWPV22`, project
`NJ_Annual_Prod_202605_Fake`, when the writer was first built, and still what
the writer relies on:

- 749 read-back comparisons across vector values, DFM
  exclusions/selections/User Entry factors, RS weights, and BF linkage came
  back identical to the ArcRho sources for
  `PRNJ - PA\PA\NY\Direct Group\BI Total`.
- Dataset creation was exercised end to end when the writer was built and
  removed on 2026-08-28: the export never creates a dataset, Dataset Type, or
  method in ResQ any more.
- The pywin32 write convention for parameterized VBA property puts is
  `Set<Property>(indices..., value)` (e.g. `SetValuesByIndex`,
  `SetSelectedRatios`); it appears nowhere in the ResQ documentation but is
  proven by `python-api/migration/references/ResQToolBox2.py`, the API example
  notebook, and the ArcRho Bridge `SyncDFM` implementation.
- **ResQ names carry stray whitespace.** Real objects exist with trailing or
  doubled spaces, while ArcRho normalized all names on import. A plain
  `collection.Item(name)` misses those objects, so every lookup falls back to
  a cached whitespace-normalized name map.
- **A DFM average formula ResQ cannot evaluate fails inside ResQ, not on the
  connection.** `D 14 - Paid DFM w/ External LDFs` in the fake project fails
  on every path that makes ResQ evaluate its averages: the import cannot read
  `AverageRatioValues` at formula 7 ("Vol + 0.9 - all"), the sync's read-back
  of the selected average fails at column 1, and the export's write surfaces
  as `Access violation at address ... in module 'ResQ3Automation.dll'` from
  `xDFMMethod`. The items written after it on the same connection succeed,
  so reconnecting does not help; the writer probes every formula first and
  skips the DFM (`resq_average_unreadable`) naming the formula to fix in ResQ.
- **`AverageFormula` never ends, so `RatioAverageCount` is the only end of the
  list.** Every DFM of the fake project has 13 average rows, `10: User Entry`
  through `12: User Entry` among them and the reserving class's own
  `13: Aug 2024` below them. Asked for row 14 or beyond, ResQ does not fail:
  it keeps answering `"14: User Entry"`, `"15: User Entry"` and so on out of
  unallocated memory, and evaluating one of those rows crashes in
  `ResQ3Automation.dll` — which skipped every DFM in the class as
  `resq_average_unreadable` until the walk was bounded by the count. The rows
  are read through `RatioAverageCount` by the import and the export alike, and
  both name them through `resq_migration.dfm.resq_average_row_labels`: the
  repeated `User Entry` rows become `User Entry`, `User Entry 2`, `User Entry
  3` in ResQ order, because ArcRho tells its rows apart by label where ResQ
  uses the position.
- **Template-implementation methods are locked.** Structurally changing a
  method that belongs to a ResQ reserving-class template fails with "it is
  part of the ... template implementation". Value and selection writes and a
  plain `Save()` still work.
- **The ArcRho `datasets/` CSV cache is lazy.** A dataset never opened in
  ArcRho has no CSV on disk and is skipped; open it once (or build the cache)
  before exporting.
- **COM collection state is cached per connection.** After `Delete()` the
  item still appears in the same session's collection; a fresh connection
  sees the truth. The exporter uses one connection and neither creates nor
  deletes.

## Creating and reconfiguring methods

Probed live on 2026-09-23 with
[`tools/resq_method_config_probe.py`](../../tools/resq_method_config_probe.py)
against `NJ_Annual_Prod_202605_Fake`, class
`PRNJ - PA\PA\All States\Direct Group\COL` (a roll-up class: `Aggregated` and
`Calculated` are both true). Early binding, every result re-read through a
fresh connection (`Disconnect` + `ConnectByName`). The case ids (C1, D2, ...)
are the probe's. These are the calls the export's create and mirror paths
rely on; nothing here is used by the export yet.

### Creating a method (C1-C4)

- **`ReservingClass.AddMethod(kind)`** with 1 = DFM, 2 = BF, 4 = Result
  Selection returns the new method with its output vector already attached.
  Before anything is set it reports an empty `Name`, output name and output
  type, `OriginLength` 12, and for a DFM `DevelopmentLength` 12, no input
  triangle and **5 average rows** (`Volume - 1` .. `Volume - 5`). A BF starts
  with `PriorVectorCount` 0, a Result Selection with `DatasetCount` 0.
- **The sequence that saves:** `method.Name`, `method.OutputVector.Name`,
  `method.OutputVector.DatasetType = <xDatasetType>`, the inputs, the lengths,
  then `method.Save()`. ResQ writes `Created: <date> by <user>` into a new
  DFM's Notes.
- **A DFM needs its input first.** `Save` without `InputTriangle` is refused:
  "You cannot save a DFM with no input triangle".
- **A new dataset type:** `project.DatasetTypes().Add()` starts as
  `Unique = True`, **`Aggregated = True`**, `DataFormat = 0`,
  `DecimalPlaces = -1`, no category. Put `Name`, `Category =
  project.Categories().Item(<name>)`, `DataFormat = 1` (origin vector),
  `DecimalPlaces`, `Unique = True` and `Aggregated = False`, then `Save()`.
  Every method output type in the class is `Unique = True, Aggregated =
  False`, so the create path should match that. `Aggregated = True` did not
  itself stop a save.
- **A missing category reads as `None`**, from `Categories().Item(<missing>)`
  and from a name scan alike, so the "category missing" skip of Decision 3 is
  a plain `None` check.
- **Refusals met, all at `Save`, all with a misleading text:**
  - a second vector on a unique type already used in the class: `There cannot
    be more than one "ZZ Probe DFM B" Vector in a Reserving Class` (the vector
    that holds the type);
  - an output type whose **category differs from the input triangle's**:
    `There cannot be more than one "<some vector of the input's category>"
    Vector in a Reserving Class`, for example `"C 52 - CWOP/Reported DFM w/
    Selected LDFs  "` for a D-category type on `Claim Counts--CWP`. Seven of
    the eight mismatched pairs tried were refused; every matched pair saved.
    Real method types share their input's category, so the export will meet
    this only when ArcRho's type is in a different category from its input;
    the result row should then say the category does not match the input
    rather than repeat ResQ's text;
  - the shared, non-unique `F 00 - Ultimate Net Loss` as a DFM's output type
    (a D-category input): refused naming `"D 92 - Current Qtr Selected"`.
  A refused save persists nothing and does not affect later saves on the
  same connection.
- **BF (C3):** `LatestType = 0` (triangle) or `1` (vector) and `Latest`;
  `PercentageDeveloped = <DFM output vector>`, **then**
  `PercentageDevelopedType`. Putting the dataset after the type moved a fresh
  BF's type from 2 to 3; putting the type again restores it. Priors through
  `AddPriorVector(vector, 0)` (0 = ultimates).
- **Result Selection (C4):** `AddDataset(<xTriangle or xVector>)` per dataset.
  **The order of `Dataset(i)` is ResQ's, not the order of the adds:** adding
  the DFM before the BF read back as triangle, BF, DFM, already in memory.
  Address weights through the index re-read after the adds, never by position
  in ArcRho's list.
- **Deleting:** `method.Delete()` removes the method and its output vector
  (no leftover vector), and the dataset type then deletes with
  `DatasetType.Delete()`.

### Reconfiguring a DFM (D1-D4)

- **Input triangle (D1):** a plain `InputTriangle` put. Selections,
  exclusions, User Entry values, rows, the Curves tab and Notes all survive;
  only the curve-fit `IncludedRatios` flags are recomputed.
- **Lengths (D2): put `OriginLength` first, then `DevelopmentLength`.**
  `OriginLength = 3` on an O12/D12 method is accepted and pulls the
  development length down to 3 with it. `DevelopmentLength = 12` on O3/D3 is
  refused ("The development length is incompatible with the origin length");
  `OriginLength = 12` first, then `DevelopmentLength = 12`, works. **A length
  change resets** every selection to ResQ's default row, clears the ratio
  exclusions and the Curves user values, and resets
  `FutureDevelopmentPeriods`. The average rows themselves survive. So the
  existing value writes must run after the structure writes, which is what
  Decision 5's order does.
- **Row count (D3):** `RatioAverageCount` is settable both ways. Growing
  appends ResQ's default rows in its own order (from row 6: `Volume - all`,
  `Vol + 0.9 - all`, `Simple - all`, `Lowest - all` (type 3), `Highest - all`
  (type 4)), then `User Entry` rows (type 5, value 1.0 in every column).
  Shrinking drops rows from the end. Columns the user had selected keep their
  row; columns still on ResQ's default move to the new default row (row 6,
  `Volume - all`). A selection that pointed at a dropped row was not tested,
  because the export writes selections after the rows.
- **Row fields (D4):** every `CustomAverages(i)` field is a plain put:
  `AverageType` (0 custom, 5 user entry, 6 calculated, 9 benchmark),
  `WeightType` (0 simple, 1 volume), `PeriodsIncluded` (**0 = all**),
  `ExcludeHighLow` (bool) with `ExcludeHighLow2` (count), and `Formula` (type
  6 only, `(Average(3)+Average(4))/2`). Every row kind evaluated
  (`AverageRatioValues` answered for each) and read back identically in a
  fresh connection.
- **ResQ renames a row from its fields until it is named explicitly.** After
  the field puts `AverageFormula(i)` read `Simple - all`, `Volume - all`,
  `Simple - 5`, `Volume - 3 Ex hi/lo`, `Simple - 6 Ex hi/lo x2`, `User Entry`,
  `Calculated` and `Benchmark Pattern`; `ResetName()` gives the same default.
  An explicit `Name` put sticks (`ZZ custom label`), survives later field
  puts (`Benchmark` stayed after `Formula` and `PeriodsIncluded` puts), and
  `ResetName()` returns it to the field-derived default. The import reads a
  custom row's weighting, periods and exclusion from the **name**
  (`_infer_avg_settings`), so the export must write the fields first and then
  put ArcRho's label as `Name` on every row.

### Reconfiguring a BF (B1)

- `LatestType = 1` with a vector `Latest`, and back to `0` with a triangle,
  both persist. `PercentageDevelopedType` 2 and 3 both persist.
- **The prior collection holds several vectors.** `AddPriorVector(vector, 0)`
  twice gives `PriorVectorCount` 2. Weights: `PriorRatioWeightSelection = 1`
  (manual), then `PriorRatioObj(k).SetRatioWeights(originIndex, weight)` per
  origin (default weight 1.0). Two priors at 0.25 / 0.75 read back exactly.
- `RemovePriorVector(k)` removes the k-th prior and the later ones move up
  with their weights.
- **The legacy `Prior` is prior 1 of the collection.** It reads
  `PriorRatioObj(1).Vector`, and a `Prior` put replaces that vector, keeping
  its weights. The import reads only `Prior`, so a BF with several priors
  imports its first one.

### Reconfiguring a Result Selection (R1)

- `SetWeights(datasetIndex, originIndex, weight)` persists.
- **`RemoveDataset(<xTriangle or xVector>)`** takes the dataset object, not an
  index (an index raises a type error). The remaining datasets keep their
  weights.
- A re-added dataset goes back where ResQ orders it (here last) with weight 0.
- `SetCustomSortIndex(i, n)` persists `CustomSortIndex(i)` but does not change
  the `Dataset(i)` order, so the order cannot be controlled through COM.

### Load Settings From Another Method (L1)

`targetDfm.LoadMethod(sourceDfm)` (documented as ResQ's "Apply To"), then
`Save`, read back in a fresh connection:

- **Copied:** origin and development lengths, every average row (count,
  names, types, weighting, periods, exclusion, formulas), User Entry values,
  the selected row per column, the ratio exclusions (by position), the Curves
  user columns and values, `FutureDevelopmentPeriods` and the curve-fit
  `IncludedRatios`.
- **Kept:** the name, the output vector and its type, the input triangle, the
  Notes, and `RatioDecimalPlaces` (source 3, target stayed 5).
- **Added:** ResQ appends a line to the target's Notes, `Method settings loaded
  from <class path>\<source> at <time> by <user>`.

This matches Decision 9 of the plan closely: ResQ keeps the ratio decimal
places and writes a Notes line, which Decision 9 does not.

**Not yet confirmed in the ResQ window.** The same comparison through the
Details tab's "Load Settings From Another Method" button could not run on
2026-09-23 because the Remote Desktop session was not drawing. The probe's
`--gui-setup` / `--gui-compare` modes set up a source and target DFM and
compare them afterwards; the check is carried into step 7 of
`docs/plans/resq_export_create_and_mirror_methods.md`.

### Probe summary (run 5 of 5, 2026-09-23)

```
C0  class COL: 17 DFM, 4 BF, 11 RS, 57 triangles, 74 vectors, 260 types; no ZZ Probe object
C1  AddMethod(1) defaults O12/D12, 5 rows; Save without input refused; Save ok
C2  DFM on a new C-category type ok; refused: second vector on a unique type,
    shared F 00 type, D-category type on a C-category input
C3  BF ok; % developed type 2 -> 3 when the dataset is put after it
C4  RS ok; Dataset(i) order triangle, BF, DFM (added triangle, DFM, BF)
V1  all four read back in a fresh connection
D1  input change keeps selections, exclusions, curves; recomputes IncludedRatios
D2  O12/D12 -> O3/D3 -> O12/D12: O first; D12 on O3 refused; selections,
    exclusions, curve values and future periods reset; rows kept
D3  5 -> 15 -> 11 -> 13 rows; default rows appended, User Entry after row 10
D4  8 row kinds written and read back; names follow fields until Name is put
B1  two priors 0.25/0.75, remove, latest vector/triangle, pd type 2/3 all persist
R1  remove keeps weights; re-add appends with weight 0; sort index does not reorder
L1  LoadMethod copies lengths, rows, values, selections, exclusions, curves;
    keeps name, output, input, Notes, ratio decimals; appends a Notes line
cleanup  counts back to 17/4/11/57/74/260, no ZZ Probe object left
```

## Unclear / undocumented areas

ResQ COM API:

1. Enum ordinals are undocumented; only `ResQMethodType` 0-4/8/9,
   `ResQDataFormat` 0/1, `RatioExclusionType` 0/1/2, and `PercDevelopedType`
   0-3 are empirically confirmed.
2. `AddMethod` accepts 1-4 in live code; whether it supports Berquist Sherman
   (8/9) or Bootstrap (6) is unknown, which is one reason those are saved
   rather than created.
3. The User Entry average row is documented as row 11; this database has three
   of them, rows 10-12, which ArcRho imports as `User Entry`, `User Entry 2`
   and `User Entry 3`. The writer resolves each row dynamically via
   `AverageFormula` labels, never by fixed index: the row ArcRho holds as
   ResQ's own User Entry goes to the first ResQ User Entry row even when it
   was renamed, and every further User Entry row goes to the ResQ row its
   import name points at.
4. No bulk/SafeArray write path exists; every cell is one COM round trip.
5. There is no explicit `Recalculate`; recalculation appears synchronous on
   property set and on `Save()`, but save-failure semantics (partial
   in-memory state) are undocumented.
6. `Save()` on `Selected` must be isolated per the docs; the writer never
   touches dataset `Selected` flags for this reason.

ArcRho → ResQ mapping gaps of the DFM and Result Selection writers:

7. DFM `excluded == 2` (no data) is never written; ResQ derives empty cells.
8. ArcRho User Entry *formula text* (`average formulas.inputs`) cannot be
   represented in ResQ; only the resolved numeric factor is written.
9. Custom average definitions are matched by label only. An ArcRho-authored
   average whose label does not exist in the ResQ method is skipped for that
   column; creating or reordering ResQ averages via `CustomAverages(i)` is
   untested.
10. Result Selection dataset ordering after `AddDataset` is assumed stable;
    weights are addressed through a name→index map rebuilt after adds, but
    ResQ's `CustomSortIndex` semantics are undocumented.
11. Ultimate overrides push ArcRho `ultimate_overrides` as ResQ overridden
    ultimates; non-overridden ultimates are not pushed.
12. On the Curves tab, ArcRho user columns map onto ResQ's by position
    (column 6 onward); `CurveUserValueColCount` is raised when ArcRho holds
    more, never lowered, and a column ResQ types as prior analysis, pattern
    or benchmark is left as ResQ has it. `SetSelectedEstimates(DevIndex)`
    changes the stored number without moving the tail's selected value, so
    the tail is always written through `SelectedTailFactor` (probed
    2026-09-03). A ResQ Curves tab fitted by least squares is read as
    `fitting_method = least_squares` and shown in ArcRho with its
    log-regression fits.

The Bornhuetter Ferguson and Cape Cod field writers remain in the exporter
for the sync macro's apply phase; their known gaps (one BF prior, no scaling
type, collapsed prior-ultimate modes) are the sync documentation's
`supported fields only` caveat and do not affect the export, which only saves
those methods.
