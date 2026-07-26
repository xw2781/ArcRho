## Purpose
<!-- MANUAL:BEGIN -->
Annual MVP page for `B&S Settlement Rate Adjustment` and `B&S Case Reserve Adequacy Adjustment`. It reproduces the imported ResQ COL calculations while keeping the saved ArcRho artifacts minimal.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.berquist_sherman.entry_points -->
- `ui/method_pages/berquist_sherman/berquist_sherman.html`: external scripts `/ui/method_pages/berquist_sherman/berquist_sherman_main.js?v=20260724b`, `/ui/shared/services/color_theme.js?v=20260724a`; inline imports _none_.

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
- Settlement Rate uses paid claims, closed claim counts, an ultimate claim-count vector, selected proportions settled, and the selected adjustment for each populated cell.
- Case Reserve Adequacy uses reported and closed claim counts, incurred and paid claims, inflation selections, and average-case-reserve selections.
- The COL CRA exclusion flags are deferred: verification with none, either matrix, or both matrices produced the same selected inflation and final output.
- The Method tab exposes the result-affecting MVP selections by development age or origin while leaving deferred ResQ-only options out.
- Method JSON stores source dataset names, labels, selections, and identity metadata. Notes live only in the output dataset sidecar; method JSON does not duplicate notes, source matrices, or calculated result matrices.
- When opened inside Project Instance, B&S reuses the parent page's already-loaded dataset-index snapshot for its initial source inventory. Explicit refreshes and post-save refreshes still request the authoritative server index.
- The final result is stored as an annual Triangle CSV at `datasets/<Name>@12@12@cum@dev.csv`; the related sidecar stores the canonical method/source identity and direct precedents.
- Matching dirty source previews recalculate the open method in memory without making the B&S page dirty. The recalculated B&S triangle is relayed to open dependents, and clearing a preview reloads the source and clears or refreshes the downstream preview. Saving is blocked until upstream preview changes are saved or discarded, so the persisted result remains reproducible from its named sources.
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
