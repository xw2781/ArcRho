# DFM JSON Format

## Canonical Method JSON

Current DFM methods use `json format = arcrho-dfm-method-by-tab-v2`. The payload is a complete, location-independent snapshot that can render every DFM tab without reopening an Input Triangle, Ratio Basis dataset, CSV, sidecar, or reserving-class index.

An existing v2 open reads only:

1. `methods/DFM@<details tab.name>.json`
2. `sidecars/<details tab.output dataset>.json`

Project Instance supplies both identities so the reads can run in parallel. A method-name-only caller reads the method first and then reads the sidecar identity declared by that method. An exact `arcrho-dfm-method-by-tab-v1` file may take the one-time dependency-reading upgrade path; any other incomplete or unknown format is rejected rather than treated as current v2.

## Identity and Ownership

- `details tab.name` is the method identity and owns the `DFM@<name>.json` filename.
- `details tab.output dataset` is the output CSV/sidecar identity. A new GUI method defaults it to its method name, but migrated methods may keep a different output name.
- `details tab.output type` is the output Vector Dataset Type.
- `details tab.input triangle`, period lengths, decimal places, ratio exclusions, average definitions/order/selections/inputs, literal User Entry values, stored values for any Excel-linked formula, Ratio Basis selection, ultimate-ratio decimals, and ratio-cell notes are DFM-owned state.
- Input/basis snapshots, ratio values, standard-average values, non-Excel formula results, and ultimates are derived state.
- Method Notes, Audit, status, and `Precedents`/`Dependents` live only in the output sidecar. Ratio-cell notes live only in method JSON.

The output sidecar registers both the Input Triangle and configured Ratio Basis as precedents. A method save cannot silently reuse an output sidecar owned by another method.

## Stored Sections

`details tab` stores:

- `name`
- `output type`
- `output dataset`
- `output category`
- `input triangle`
- `origin length`
- `development length`
- `decimal places`

`data tab` stores:

- exact `origin labels` and `development labels`
- `input data triangle values`, with trailing nulls trimmed from each row so a row ends at its last populated development period
- data format, number format, decimal places, and `source revision`

The persisted file does not store `input data triangle mask`. A cell is inside the triangle if and only if it holds a value, so the mask can only restate the values beside it; loading derives it and refits every row back to the full development geometry. A null *inside* a row still marks a value missing inside the triangle, exactly as `ratio values` and `excluded` already store their rows. The in-memory canonical payload keeps the mask and its rectangular geometry, so revisions and calculations are unaffected, and a file written before this change still loads unchanged.

`ratios tab.ratio triangle` stores aligned origin/development labels, calculated `ratio values`, and DFM-owned `excluded` cells. `ratios tab.average formulas` remains the columnar object with `label`, `custom average formula settings`, `selected`, `values`, aligned User Entry `inputs`, and aligned display-only `display inputs`. A `display inputs` cell stores the same formula with dataset coordinate positions replaced by the labels returned when that formula was resolved; calculation, dependency parsing, and editing continue to use `inputs`. `ratios tab.cell notes` remains keyed by visible row label and visible development-column label.

`results tab` stores:

- `ratio basis dataset`
- Ratio Basis data/number format and decimal places
- aligned Ratio Basis origin labels and values
- `ratio basis source revision`
- `ultimate ratio decimal places`
- the calculated `ultimate vector`

`method metadata` stores:

- `last modified`: changed only by an owned user save
- `data refreshed`: changed when embedded precedent data is refreshed
- `owned revision`
- `derived revision`
- `publication revision`

Revisions are deterministic hashes over their canonical projections. They are separate so a dirty window can rebase an owned patch over a newer derived-only disk refresh, while a concurrent owned change produces a conflict.

V2 never stores absolute input or output CSV paths.

## On-Disk Text Format

`arcrho_api/io.py::persisted_json_text` owns the file's text, so every producer writes the same bytes for the same payload.

Two-dimensional arrays are stored one row per line: `input data triangle values`, `ratio values`, `excluded`, and the `average formulas` row arrays each read as a triangle rather than one scalar per line. A 40-origin method drops from roughly 1,900 lines to 170, and from about 30 KB to 13 KB, which is what a network-drive read pays for. Every other node keeps the two-space layout.

Layout never reaches a revision: `owned`, `derived`, and `publication` hash a `separators=(",", ":")` encoding of the canonical projection, so reformatting a file cannot shift a stored revision or mark a method Review Needed.

## Calculation and Numeric Rules

All persisted numeric values use six-decimal, half-away-from-zero normalization. The canonical Python contract owns ratio calculation, average calculation, internal User Entry formula evaluation, ultimate calculation, field projection, and revisions. The frontend calls the local preview endpoint for canonical interactive derivation.

A formula containing any Excel reference freezes its complete stored result during automatic upstream refresh, including mixed Excel/internal formulas. A non-Excel User Entry formula is recalculated. Literal User Entry values, formula definitions, selections, and exclusions are preserved.

Opaque migrated average rows such as ResQ `Benchmark` keep their persisted values. They are not reinterpreted as a standard Simple or Volume average by either the canonical contract or the frontend renderer.

Origin changes remap owned state by exact label; new origins default to included. Development geometry must remain compatible. Positional remapping is forbidden: an incompatible geometry leaves the prior publication intact and marks the DFM Review Needed.

Ratio Basis values are aligned by exact origin label. A missing or duplicate required label is a refresh error rather than a positional fallback.

## Refresh and Publication

ArcRho-managed durable precedent saves refresh affected DFM snapshots and calculations. In the desktop app-server workflow, DFM refresh runs before calculated datasets and Result Selection descendants. After the refresh wave, the DFM remains Review Needed until its own explicit Save; Refresh alone does not acknowledge the alert. Every explicit Save starts downstream propagation even when the DFM publication values are unchanged.

Standalone public-Python and ResQ-migration execution refreshes DFM descendants but does not host the app server's calculated-dataset or Result Selection evaluators. If propagation reaches either method type, that branch is marked Review Needed and a warning is returned so it can be recalculated through the app-server workflow.

Publication runs under the reserving-class lock and uses staged files, revision checks, rollback, unchanged-file suppression, and sidecar-last replacement. A failed branch retains its last valid publication and blocks only its descendants. The upstream save remains successful and reports the propagation warning separately from the human-review status.

Automatic refresh adds an Audit row only when the ultimate publication changes. Same-output and basis-only refreshes update freshness without Audit noise and do not clear Review Needed.

## Excel Freshness

Excel links are derived from User Entry `inputs`; there is no separate persisted Links section. DFM hydration never refreshes Excel values. After Ready, one abortable check-only task per applied method revision reads saved workbook values in a deduplicated batch, compares canonical results, and reports stale/unverified counts without changing method state, caches, rendering, JSON, or dirty state.

Manual refresh from the existing Links or Ratios controls remains mutating. Changed values mark the method dirty and require Save; ignoring a warning keeps the stored values.

## Producer Parity

The app server, public Python API, ResQ migration, and bridge-owned-patch flow delegate to the canonical v2 contract. Sparse RPC, ArcBot, macro, and template payloads are treated as owned-setting patches followed by canonical local calculation; sparse payloads are never persisted directly as v2.
