# Check: saved workbook snapshots and explicit refresh

Version 3.0.0 keeps ArcRho values in the workbook until an explicit refresh.
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
ArcRhoTri request, plus a vector, headers, and project settings. Add a second
sheet with a different dataset and a second workbook with a different default
project. Use synthetic data in the automated smoke test; live checks may use
only an authorized project.

## Expected behavior

1. Before the first refresh, a request absent from the snapshot shows a clear
   refresh-required message. It sends no server request.
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
8. A new request after opening asks for refresh; it never silently fetches.
9. Two open workbooks use their own snapshots and caller-specific default
   projects even when the other workbook is active.
10. Round-trip 1x1 values, vectors, arrays, blanks, and header/settings text.
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
one fetch per distinct request, not one per formula cell.

The pre-3.0.0 check measured 21 calls, 20 hits, and one fetch on 2026-09-12.
Version 3.0.0 retains that deduplication and also persists the result across
Excel sessions and users. Earlier always-refresh expectations no longer apply.
