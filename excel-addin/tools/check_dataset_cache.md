# Check: saved workbook snapshots, formula entry, and refresh

Version 3.0.1 keeps existing ArcRho values in the workbook until an explicit
refresh, and loads missing requests after formula entry.
Use an isolated Excel process for checks and set DisplayAlerts, EnableEvents,
and ScreenUpdating to False before opening any workbook. Never close a user's
existing Excel process.

Run `py -3.10 -B excel-addin/tools/verify_workbook_snapshots.py` for the
isolated Excel integration checks. After building, run
`py -3.10 -B excel-addin/tools/verify_built_addin.py excel-addin/beta/ARCRHO_BETA.xlam`
to compare every compiled module/form with current source and check the version
and settings controls. Both commands require Excel and trusted VBA project access.

## Workbook

Use one array formula and twenty INDEX formulas referring to the same
ArcoTri request, plus a vector, headers, and project settings. Add a second
sheet with a different dataset and a second workbook with a different default
project. Use synthetic data in the automated smoke test; live checks may use
only an authorized project.

## Expected behavior

1. Opening or recalculating an existing formula with no snapshot shows a clear
   refresh-required message. It sends no server request. An older workbook
   needs one successful Refresh Workbook and save for its existing formulas.
2. Refresh Workbook fetches each distinct request once. Twenty-one identical
   triangle calls cost one fetch; later calls in that refresh use memory.
3. The hidden `_ArcRhoCache` sheet contains the snapshot. It is written after
   successful calculation, outside the worksheet function.
4. Save, close Excel, and reopen in a fresh process. All saved ArcRho figures
   match, with zero dataset fetches. Repeat with server access unavailable.
5. Ordinary recalculation still uses the saved values, even if the server's
   published values have changed. Only an explicit refresh updates them.
6. Refresh Worksheet updates requests on that sheet and retains the saved
   requests used elsewhere. Refresh Workbook affects the active workbook only.
7. A failed or cancelled refresh leaves the previous snapshot and figures
   available, reports the failure, and does not claim success.
8. Typing, editing, or pasting ArcRho formulas loads missing requests immediately
   after entry and stores successful results in the snapshot. Duplicate requests
   share one fetch. An entered formula whose request is already saved needs no
   server access or credential enrollment. Changing an explicit project name
   loads that project's missing result; `Default` and the same explicit project
   reuse one result.
9. Two open workbooks use their own snapshots and caller-specific default
   projects even when the other workbook is active.
10. Round-trip 1x1 values, vectors, arrays, blanks, and header/settings text.
    `ArcoVecCell` and `ADASVecCell` use the same saved vector as `ArcoVec`;
    check first and last 1-based indices for horizontal and vertical vectors.
11. Settings no longer shows the old always-refresh/removeData option.

## Server checks

- Exact published engine, calculated, input, and method datasets never call
  the Engine or modify their CSV, sidecar, or index during an Excel refresh.
- A permanent dataset without a readable publication fails clearly.
- Input datasets roll up only to compatible coarser periods in the same mode.
  Generated, calculated, and method outputs refuse unsupported shapes rather
  than summing non-additive results.
- A sidecar-less generated cache is reused when source/configuration provenance
  matches and regenerated when it changes. Failed generation preserves the last
  successful cache and creates no permanent metadata.
- Temporary calculations use published permanent dependencies and create no
  sidecars or index entries.
- A propagation hold causes a retry response.

## Counters

`datasetRequestCount`, `datasetHitCount`, and `datasetFetchCount` remain useful
for a live run. Read before and after the operation and compare differences.
A reopen or ordinary recalculation has zero fetches. An explicit refresh has
one fetch per distinct request, not one per formula cell. A formula-entry batch
fetches only distinct requests missing from the workbook snapshot.

The pre-3.0.0 check measured 21 calls, 20 hits, and one fetch on 2026-09-12.
Version 3.0.0 introduced persistence across Excel sessions and users; 3.0.1
retains it while allowing formula entry to load missing values. Earlier
always-refresh expectations no longer apply.

## Formula discovery performance

The workbook refresh scan reads formula batches and visits each legacy array
block once. In an isolated synthetic check on 2026-09-17, finding a 20,000-cell
legacy array took 36.842 seconds before the change and 0.103 seconds afterwards.
These timings measure formula discovery only, not Gateway or Engine work.
The progress display also advances during discovery, before data requests start.
