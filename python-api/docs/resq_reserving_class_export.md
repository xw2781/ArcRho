# One-way ResQ reserving-class export

The `Export Reserving Class to ResQ` macro
(`python-api/macros/export_reserving_class_to_resq.py`) pushes one ArcRho
reserving class into the identically scoped ResQ reserving class, one way and
without a review. It is the push counterpart of the
[sync macro](resq_reserving_class_sync.md): the same Bridge queue, the same
canonical session, the same ResQ writer, and the same results window, minus
the comparison, the signatures, and the baseline.

The ArcRho project name is also used as the ResQ project name, and the
selected reserving-class path must exist in that project on both sides. The
UI does not offer a project or path mapping override.

## What is pushed

For the reserving-class path selected in the active Project Instance page,
every item below is written, each after the items it reads:

- **Input datasets** — every sidecar whose `method_type` is `None`, that is
  neither `calculated` nor an `engine` dataset, and that has a CSV cache on
  disk. Triangle and vector values are written cell by cell
  (`SetValuesByIndex`) and the sidecar Notes go into the ResQ `Notes`. A
  dataset ResQ does not hold is created under its Dataset Type; a dataset that
  is `Calculated` in ResQ is skipped, because ResQ recomputes it.
- **DFM methods** — ratio exclusions (`SetExcludedRatios`), User Entry factors
  (`SetUserRatios`), the selected average per column (`SetSelectedRatios`),
  and Notes, the writer the sync's apply phase uses too.
- **Result Selections** — the loaded source datasets, weights (`SetWeights`),
  selected-ultimate overrides (`ClearOverriddenUltimates` + `SetUltimates`),
  and Notes.
- **Bornhuetter Ferguson, Cape Cod, and Berquist Sherman methods** — saved
  only. The exporter finds the ResQ method by its ArcRho output name and calls
  `Save()`, so ResQ recalculates it from the datasets and DFMs written before
  it and re-stamps it. No field is carried across: ArcRho's own settings for
  these methods are not pushed, and a method ResQ does not hold is reported
  as skipped rather than created.

Left out, and not shown in the results:

- **Calculated datasets** — propagation recomputes them from their formula
  inputs in ArcRho and in ResQ alike.
- **Engine-generated datasets** (`source_kind: engine`) — ArcRho rebuilds them
  through the Engine and ResQ through its own generator.
- **Bootstrap methods** — ResQ has no write path for them yet.
- **Method output datasets** — they are written through their method, never
  as datasets.

A dataset without a CSV cache, or a method-owned output sidecar whose method
JSON is missing, is shown as `Skipped` with the reason.

## Write order

Items are written in ArcRho's dependency order, the same topological walk
the sync's apply phase uses (`resq_migration.sync_session`). The graph comes
from the sidecar `precedents`: a dataset row carries its own sidecar's
precedents, and a method row carries the precedents of its output sidecar
beside the links in its method tabs. A row is written only after every row it
reads, wherever that row sits in the inventory; rows with no link between
them keep a kind order — datasets, then DFMs and Berquist Sherman
adjustments, then Bornhuetter Ferguson and Cape Cod, then Result Selections —
and then the inventory order.

The graph is genuinely needed. In the fake project, `C 92 - Current Qtr
Selected` (a Result Selection of claim counts) feeds the B&S Settlement Rate
adjustment of `Gross Loss--Paid`, whose adjusted triangle `D 18 - BS Paid
DFM` reads, which `D 92 - Current Qtr Selected` loads in turn; the walk writes
them in exactly that order, so each save in ResQ finds its inputs already
written.

## No review, no timestamps

The export deliberately compares nothing, verifies nothing, and records no
baseline. It is the tool for the moment ArcRho is the source of truth for a
class and ResQ should simply follow.

One consequence to know: ResQ's `Save()` re-stamps every written object, and
no sync baseline records that this run did it. The next `Sync Reserving Class
with ResQ` preview therefore reports every exported item as `ResQ changed`
(or `Both changed`) and proposes the class direction ResQ to ArcRho. That
preview is a review, not a write — untick the rows or cancel it — but expect
it. Recording a paired baseline after an export is possible follow-up work.

## Results window

The results open inside the active Project Instance page as the same nested,
read-only review window the sync macro uses (`ui.reviewTableOpen` with
`host: "projectInstance"` and `selectable: false`): one row per item in write
order, with the type, the logical name, an outcome of `Exported`, `Saved`,
`Skipped`, or `Failed`, and the Bridge's message for the item, under a header
naming the project, the reserving class, the ResQ connection, and the counts.
The window is non-modal, so it can be minimized to the toolbar while the
class is inspected; the macro keeps running until it is closed.

Before anything is published, the macro asks for confirmation and refuses
while the active nested window has unsaved changes, since an unsaved edit
would not be part of the export.

## Runtime

ResQ automation exists only where ResQ itself is installed, which is usually
not the machine ArcRho runs on. The macro therefore owns no ResQ session and
reads no reserving-class file: it publishes an `export` request to the same
Bridge queue the sync macro uses (`SyncResQReservingClass`, contract version
3, under `requests\RPC bridge\resq_reserving_class_sync\`), and a
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
- Dataset creation was exercised end to end: a deleted ResQ vector was
  recreated under its existing Dataset Type with byte-identical values.
- The pywin32 write convention for parameterized VBA property puts is
  `Set<Property>(indices..., value)` (e.g. `SetValuesByIndex`,
  `SetSelectedRatios`); it appears nowhere in the ResQ documentation but is
  proven by `python-api/migration/references/ResQToolBox2.py`, the API example
  notebook, and the ArcRho Bridge `SyncDFM` implementation.
- **ResQ names carry stray whitespace.** Real objects exist with trailing or
  doubled spaces, while ArcRho normalized all names on import. A plain
  `collection.Item(name)` misses those objects, so every lookup falls back to
  a cached whitespace-normalized name map.
- **Dataset Type inserts can be permission-blocked.** The test ResQ user gets
  "You do not have permission to insert a Dataset Type", so an ArcRho-only
  dataset whose Dataset Type does not exist in ResQ cannot be created; the
  item is reported as skipped (`dataset_type_not_creatable`).
- **Template-implementation methods are locked.** Structurally changing a
  method that belongs to a ResQ reserving-class template fails with "it is
  part of the ... template implementation". Value and selection writes and a
  plain `Save()` still work.
- **The ArcRho `datasets/` CSV cache is lazy.** A dataset never opened in
  ArcRho has no CSV on disk and is skipped; open it once (or build the cache)
  before exporting.
- **COM collection state is cached per connection.** After `Delete()` the
  item still appears in the same session's collection; a fresh connection
  sees the truth. The exporter uses one connection and only creates.

## Unclear / undocumented areas

ResQ COM API:

1. Enum ordinals are undocumented; only `ResQMethodType` 0-4/8/9,
   `ResQDataFormat` 0/1, `RatioExclusionType` 0/1/2, and `PercDevelopedType`
   0-3 are empirically confirmed.
2. `AddMethod` accepts 1-4 in live code; whether it supports Berquist Sherman
   (8/9) or Bootstrap (6) is unknown, which is one reason those are saved
   rather than created.
3. The User Entry average row is documented as row 11 but is row 10 in this
   database; the writer always resolves it dynamically via `AverageFormula`
   labels, never by fixed index.
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

The Bornhuetter Ferguson and Cape Cod field writers remain in the exporter
for the sync macro's apply phase; their known gaps (one BF prior, no scaling
type, collapsed prior-ultimate modes) are the sync documentation's
`supported fields only` caveat and do not affect the export, which only saves
those methods.
