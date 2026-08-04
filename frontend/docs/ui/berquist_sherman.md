## Purpose
<!-- MANUAL:BEGIN -->
Annual MVP page for `B&S Settlement Rate Adjustment` and `B&S Case Reserve Adequacy Adjustment`. It reproduces the imported ResQ COL calculations while keeping the saved ArcRho artifacts minimal.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.berquist_sherman.entry_points -->
- `ui/method_pages/berquist_sherman/berquist_sherman.html`: external scripts `/ui/method_pages/berquist_sherman/berquist_sherman_main.js?v=20260802a`, `/ui/shared/services/color_theme.js?v=20260724a`; inline imports _none_.

Detected `fetch(...)` targets in key JS files:
- `/dataset/cache/load`
- `/dataset/sidecar/load`
- `/dataset/sidecar/save`
- `/datasets/cached?${query.toString()}`
- `/workspace_paths`

Detected `arcrho:*` message types in key JS files:
- `arcrho:berquist-sherman-tab-changed`
- `arcrho:dataset-dirty`
- `arcrho:dependency-source-cleared`
- `arcrho:project-instance-refresh-datasets`
- `arcrho:status`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.berquist_sherman.key_files -->
- [`ui/method_pages/berquist_sherman/berquist_sherman.html`](../../ui/method_pages/berquist_sherman/berquist_sherman.html) - Shared annual B&S method page.
- [`ui/method_pages/berquist_sherman/berquist_sherman_main.js`](../../ui/method_pages/berquist_sherman/berquist_sherman_main.js) - B&S state, persistence, source preview, and tab coordination.
- [`ui/method_pages/berquist_sherman/settlement_rate_calculation.js`](../../ui/method_pages/berquist_sherman/settlement_rate_calculation.js) - Settlement Rate Adjustment calculation engine.
- [`ui/method_pages/berquist_sherman/case_reserve_adequacy_calculation.js`](../../ui/method_pages/berquist_sherman/case_reserve_adequacy_calculation.js) - Case Reserve Adequacy Adjustment calculation engine.
- [`ui/shared/dataset/berquist_sherman_contract.js`](../../ui/shared/dataset/berquist_sherman_contract.js) - Canonical B&S labels and storage identities.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Project Instance offers separate Add commands for the two B&S variants when an annual input triangle with Method Type `None` is selected.
- Both variants use the shared method page and canonical contract module. They participate in the standard save, close, status, tab-state, and live dependency-preview messages. After the first successful save, Project Instance keeps the same floating window open under the saved output Name.
- The migration macro imports the required ResQ source names, annual labels, and calculation selections. It also fills missing annual labels on existing source sidecars without replacing labels that are already present. B&S methods do not use the bidirectional synchronization workflow.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Settlement Rate uses paid claims, closed claim counts, an ultimate claim-count vector, selected proportions settled, a method-level loess span, and the selected adjustment for each populated cell.
- The page shell follows the DFM/BF frame: the shared tab strip, the bordered page frame, and the save bar are flex rows of the shell, the frame keeps the same left/right `--tabbed-page-gutter` as the strip so the strip's bottom rule meets the frame corners, and the save bar sits on the canvas outside the frame. Inside the Method tab, the nested calculation strip encloses its own client area the same way, matching the inner tab control in ResQ: `.bsMethodFrame` is inset by `--bs-method-inset` so its walls meet the ends of the strip's bottom rule, and its rows are inset by `--bs-method-pad`. Those rows are a flex column rather than fixed tracks, because the caption, the summary strip, and the message row are each hidden when the view has nothing to put in them and the grid must keep filling the rest of the client area. The message row reports calculation failures only; a successful calculation clears it, as in ResQ. Row hover tints plain value cells only: it never repaints a fill that carries meaning, so the result column, a selected estimator or proportion source cell, the Proportion Settled `Selected` band, and its spacer row keep their own fills under the pointer.
- The Method tab's Settlement Rate calculation views render as a nested tab strip using the shared tabbed-page chrome, in the exact ResQ sub-tab order: `Paid Claims`, `Numbers Closed` (closed triangle plus an `Ultimate` column), `Proportion Settled`, `Selected Numbers Closed`, and `Adjusted Paid Claims`. Each view shows its ResQ caption line above the grid, and the page opens on `Paid Claims`.
- The `Proportion Settled` view mirrors the ResQ selection UX: the triangle shows percentages, clicking a value selects it for that development period, the chosen source cell per column is highlighted (the leading diagonal by default), and a separated `Selected` bottom row shows the selections in a pale band with editable typed values. Right-click offers `Select Leading Diagonal` to reset the defaults.
- The `Adjusted Paid Claims` view is the ResQ-style selection grid: each origin period shows `Unadjusted`, `Pairs`, `All`, `Loess (n)`, and `Selected` rows. Clicking a value selects that estimator for the single cell, clicking a row label selects it for the origin period, and Ctrl+Click on a row label selects it for every populated cell. The chosen source cell is highlighted and the `Selected` row echoes it in accent color.
- The loess estimate is a tri-cube weighted local straight-line fit of log paid against closed counts over the `span + 1` nearest neighbours, evaluated at the selected claim counts; a degenerate fit reverts to the pair-wise interpolation, matching ResQ. The `Loess Span` stepper sits in the caption row of the `Adjusted Paid Claims` view and persists as `loess_span` in the method JSON, which the ResQ migration also emits from `LoessSpan`.
- The summary strip stays hidden for Settlement Rate; all its selections live inside the Method grids. The CRA summary editors are unchanged.
- Case Reserve Adequacy uses reported and closed claim counts, incurred and paid claims, inflation selections, and average-case-reserve selections.
- The COL CRA exclusion flags are deferred: verification with none, either matrix, or both matrices produced the same selected inflation and final output.
- The Method tab exposes the result-affecting selections at their ResQ granularity: per development age for proportions settled and CRA selections, and per populated cell for the Settlement Rate adjustment.
- Method JSON stores source dataset names, labels, selections, and identity metadata. Notes live only in the output dataset sidecar; method JSON does not duplicate notes, source matrices, or calculated result matrices.
- When opened inside Project Instance, B&S reuses the parent page's already-loaded dataset-index snapshot for its initial source inventory. Explicit refreshes and post-save refreshes still request the authoritative server index.
- The final result is stored as an annual Triangle CSV at `datasets/<Name>@12@12@cum@dev.csv`; the related sidecar stores the canonical method/source identity and direct precedents.
- Matching dirty source previews recalculate the open method in memory without making the B&S page dirty. The recalculated B&S triangle is relayed to open dependents, and clearing a preview reloads the source and clears or refreshes the downstream preview. Saving is blocked until upstream preview changes are saved or discarded, so the persisted result remains reproducible from its named sources. Once sources are durable and readable, their Review Needed status does not block Save; the committed save is followed by a page-local message box reporting how many precedents have not been reviewed.
- The post-save review warning lists every unreviewed precedent by name. Each name is a keyboard-focusable link that opens its related method window when the dataset is method-backed, or its Dataset Viewer otherwise, while keeping the saved B&S method unchanged.
- Fresh methods load annual origin and development labels from the project's canonical headers; inputs with mismatched formats or known periods are rejected. A legacy source sidecar with no labels is treated as unavailable metadata rather than as a conflicting period set.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change a formula in the corresponding pure calculation module and update the focused COL parity test.
2. Change saved fields only with the migration and dataset-index consumers aligned to the same contract.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- All MVP inputs must be annual and use matching triangle shapes.
- Persisted labels, prefixes, source kinds, and JSON formats are routing identities and must not drift between the frontend and migration.
<!-- MANUAL:END -->
