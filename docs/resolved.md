# Resolved Issues

Issues moved out of [knowun_issues.md](knowun_issues.md) once fixed, newest first.

# DSV

## Temporary View Mode

### 2026-08-05 - Temporary view ignored the default number format until a parameter changed

**Reported:** A dataset viewer opened in Temporary view did not use the default number format at first; changing a parameter such as Origin Length fixed it automatically.

**Cause:** `bootDatasetDataTabSteps` in [data_tab_controller.js](../frontend/ui/shared/tabs/data/data_tab_controller.js) short-circuits the dropdown/preference/sidecar boot chain for a temporary view, because its inputs all arrive in the URL. That chain contains the only boot-time call to `syncSidecarForCurrentDataset`, which is what resolves a number format. The first run therefore called `renderTable()` while `#numberFormatSelect` and `#decimalPlaces` still held the page defaults, and the Dataset Viewer grid reads those controls at render time. The post-run sync in [data_tab_persistence_controller.js](../frontend/ui/shared/tabs/data/data_tab_persistence_controller.js) did resolve the Dataset Type default and write it into the controls, but it runs after the run controller's `renderTable()` and did not repaint - so the format only became visible on the next render, which is what changing Origin Length triggers.

**Fix:**
- Added `resolveTemporaryDatasetSettings` and `applyTemporaryNumberFormatDefaults` to `data_tab_persistence_controller.js`. The resolver is the single place that merges the current control values with the `GET /dataset/number-format-defaults` response for the open Dataset Type; the post-run sidecar sync now calls it instead of repeating that merge inline.
- The temporary-view branch of `bootDatasetDataTabSteps` awaits `applyTemporaryNumberFormatDefaults()` after `applyTriInputsFromQueryParams()` and before the run is scheduled, so the first paint is already formatted. The endpoint response is memoized per Dataset Type, so the later sidecar sync reuses it without a second request.
- The temporary-view branch of `syncSidecarForCurrentDataset` now applies its resolved settings for both the sidecar and no-sidecar cases and repaints the grid when the resolved format differs from what was rendered. That also fixes a temporary view of a dataset that already has a sidecar, which previously kept the page default format permanently.

**Verification:** `frontend/tests/project_instance_temporary_view.test.mjs` extended to pin the boot-time resolution, the shared resolver, and the repaint guard; suite passes.

# PI

### 2026-08-12 - Saving a dataset showed the login name instead of the mapped full name

**Reported:** After saving a dataset, the user name shown in the dataset table still shows the login name, but the full name mapped in `E:\ArcRho Server\config\username_index.json` was expected.

**Cause:** `username_index.json` was read in exactly one place, `resolve_display_name` in [user_identity_service.py](../frontend/app_server/services/user_identity_service.py), whose only caller was `get_current_identity` behind the Home-screen identity route. No dataset writer used it. Every save path stamped the raw Windows login instead: `_current_user_name` in [dataset_service.py](../frontend/app_server/services/dataset_service.py) and [calculated_dataset_service.py](../frontend/app_server/services/calculated_dataset_service.py) read `USERNAME`, while [result_selection_service.py](../frontend/app_server/services/result_selection_service.py), [dfm_service.py](../frontend/app_server/services/dfm_service.py), [bornhuetter_ferguson_service.py](../frontend/app_server/services/bornhuetter_ferguson_service.py), [cape_cod_service.py](../frontend/app_server/services/cape_cod_service.py), [bootstrap_service.py](../frontend/app_server/services/bootstrap_service.py), [arcrho_runtime_service.py](../frontend/app_server/services/arcrho_runtime_service.py), and [audit_service.py](../frontend/app_server/services/audit_service.py) called `getpass.getuser()` directly. The reserving-class index is pass-through by contract, so the table could only show what the sidecar already held. Rows that still read `Wei, Xiao` were untouched ResQ imports, which copy ResQ's own `User` attribute; every row re-saved in ArcRho reverted to `xwei`.

**Fix:**
- `user_identity_service` gained `get_current_display_name()` plus a process-lifetime cache of both the parsed index and the current account's resolved name, keyed by index path, with `clear_display_name_cache()` for tests. Resolving a name during a save now costs no file I/O after the first call.
- All nine writers listed above stamp `user`, `modified_by`, and audit records through that helper, falling back to the raw login when the account is unmapped. `_resolve_audit_user_name` also maps an explicitly passed login, which is idempotent for a value that is already a display name.
- Machine-facing identity was deliberately left on the raw login: engine/bridge request `UserName` fields, dependent-propagation requests, and the per-user preference folder name, since a display name is many-to-one and cannot key an account.

**Verification:** New `frontend/tests/test_dataset_user_display_name.py` (6 tests) pins the resolved name for the dataset, calculated, result-selection, and audit writers plus the unmapped fallback; `test_user_identity_service.py` extended with the session-cache and no-login cases; 176 tests across the affected app-server modules pass.

### 2026-08-07 - Live preview took a long time to update downstream values on client PCs

**Reported:** The live preview feature works fine on the dev PC but takes a long time to update downstream dataset values in open windows on a client PC; consider letting the client's app server compute instantly for open datasets and avoid many network-drive reads.

**Cause:** Every debounced edit posts `/dataset/calculated/preview`, and each request resolved the non-edited precedents from scratch in [calculated_dataset_service.py](../frontend/app_server/services/calculated_dataset_service.py): `_scan_dataset_cache_folder` re-read every dataset sidecar JSON in the reserving class (~120 files in COL), `_scan_dfm_method_folder` re-read every `DFM@*.json`, and the component CSVs plus their SHA-256 fingerprints were re-read per request. On the dev PC `E:` is local so this is fast; on a client each file open is an SMB round trip, so one preview cost seconds and repeated on every edit.

**Fix:**
- New [class_folder_scan_cache.py](../frontend/app_server/services/class_folder_scan_cache.py): in-process caches for sidecar/method JSON payloads and component CSV matrices, validated against the `(mtime_ns, size)` identities that the `os.scandir` folder listing already returned - so a repeat request costs directory enumerations instead of one read per file. Discipline follows `file_read_cache`: files modified within the last few seconds are always re-read, failed reads are never cached, results are copied on the way out.
- `_scan_dataset_cache_folder` and `_scan_dfm_method_folder` now read through the cache (the sidecar folder gets its own listing for validation), `_load_components` reads component CSVs and their fingerprints through `read_matrix_cached` using the listing's stat identity, and `_existing_target_settings` reads the target sidecar through `file_read_cache`. The same cache also speeds up calculated-dataset refreshes during saves, which resolve dependencies through the same scans.

**Verification:** New `frontend/tests/test_class_folder_scan_cache.py` (6 tests: memory hits, change/recent-write re-reads, unvalidatable paths never cached, matrix copy/failure semantics, scan reuse); `test_calculated_dependency_folder_scan.py` updated to pin the cached shape; full frontend python discovery back at its 2 pre-existing baseline failures (465 tests).

## pi-hidden-tabs-menu

### 2026-08-05 - Hidden-tabs menu had no close icon and stayed visible with nothing hidden

**Reported:** The Project Instance hidden-tabs menu needs a close icon, and it should not show its menu components at all when there are no hidden tabs.

**Cause:** `updateHiddenTabsArea` in [project_instance_hidden_tabs.js](../frontend/ui/project_instance/project_instance_hidden_tabs.js) always rendered the toolbar button (`0 hidden`) and always populated the dropdown, falling back to a `No hidden tabs.` placeholder when the map was empty. The dropdown itself could only be dismissed by hovering away, clicking outside, or pressing Escape - the panel had per-item close controls but no control that closed the panel.

**Fix:**
- `updateHiddenTabsArea` now calls a new `syncHiddenTabsVisibility(count)`, which toggles an `empty` class on `#hiddenTabsWrap` and force-closes any open/pinned menu. New CSS hides `.pi-hidden-tabs-button` and `.pi-hidden-tabs-menu` under that class, and `project_instance.html` ships the class so the button never flashes before boot. Every existing caller already routes through `updateHiddenTabsArea`, including `closeDatasetWindow`, so the three now-redundant `setHiddenTabsMenuOpen(false, ...)` calls in `closeHiddenWindow`, `closeAllHiddenWindows`, and `restoreAllHiddenWindows` were removed and the single-source rule keeps one place deciding menu visibility.
- The menu build returns early when the count is zero, so the `pi-hidden-tabs-empty` placeholder and its light/dark CSS are gone.
- Added a `.pi-hidden-tabs-dismiss` button at the right of the dropdown action row using the same centered inline SVG stroke close icon as the minimized tabs (design rule C09), with light and dark styling and an `aria-label` of `Close hidden tabs menu`.

**Verification:** New `frontend/tests/project_instance_hidden_tabs_menu.test.mjs` pins the empty-state visibility wiring, the removal of the empty placeholder from JS and both themes, and the dismiss button's markup, handler, and styling; the existing Project Instance suites still pass. Cache-busting `?v=` tokens for `project_instance.css`, `dark.css`, and `project_instance_hidden_tabs.js` were bumped.

# DFM

### 2026-09-03 - A DFM reading a Berquist-Sherman method drifted from ResQ because a BF ultimate was rounded to a whole number

**Reported:** Comparing `NJ_Annual_Prod_2026 Q3-Aug` with the ad-hoc `dfm_ratio_side_by_side_review.py` script flagged four Berquist-Sherman paid DFMs, worst in `PRNJ - PA\PA\NJ\Direct Group\BIx51+UMBIx51` "F 18 - BS Paid DFM": a maximum ratio difference of 0.0198 over 17 cells, every one in development periods 1 and 2. The suspected chain ran from "C 41 - BF Reported ex CWOP" storing 63 and 58 where ResQ holds 63.0147 and 57.8946, through "C 91 - Current Qtr Indicated" and "C 92 - Current Qtr Selected", into the ultimate claim counts the B&S Settlement Rate Adjustment divides closed claims by.

**Cause:** Confirmed against the live method file: `BF@C 41 - BF Reported ex CWOP.json` holds `latest [55, 23]`, `percentage_developed [0.966342, 0.505991]` and `selected_prior_values [86, 81]` for 2025 and 2026, so `Latest + (1 - Percentage Developed) * Selected Prior` is 57.894588 and 63.014729, while `new_ultimate` holds 58 and 63. `_calculate_vectors` in [bornhuetter_ferguson_contract.py](../python-api/src/arcrho_api/bornhuetter_ferguson_contract.py) passed the ultimate through a deliberate half-up whole-number quantizer, and `calculateOutputs` in [bornhuetter_ferguson_main.js](../frontend/ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js) mirrored it with `roundBornhuetterFergusonWholeNumber`. Every other BF vector, and the Cape Cod ultimate, keep six decimals, so the BF ultimate was the one method output that lost its fraction. ResQ never rounds it, and the ResQ import re-runs ArcRho's calculation instead of copying ResQ's output vector, so an imported method carried the rounding too. Dividing closed claim counts by a whole-number ultimate moves the Selected Proportion Settled by up to 0.2% on a claim count in the tens, and the interpolated B&S paid triangle amplifies that at its two earliest ages, where the paid-versus-closed curve is steepest; the latest diagonal is unadjusted by construction, so later periods were untouched. Recomputing the chain unrounded brings the largest F 18 difference down to 0.00005, the review's own tolerance; what remains is ResQ's own stale saved Selected Proportion Settled row.

**Fix:**
- `_calculate_vectors` now canonicalizes the ultimate with the same six-decimal `_number` helper as Selected Prior and every other BF vector. The whole-number quantizer and its `Decimal` imports are gone.
- `calculateOutputs` uses the shared `roundBornhuetterFergusonNumber` (six decimals) and the whole-number export was removed from [bornhuetter_ferguson_json_contract.js](../frontend/ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_json_contract.js); the page's contract import stamp was bumped so a running app picks up the new module.
- The BF page and plan docs now state the ultimate formula without `ROUND(..., 0)`.

**Scope on live data:** A BF method saved before the fix keeps its whole-number ultimates until it is saved or refreshed again; the four flagged DFMs need their BF precedents recomputed once (a re-save, a dependent refresh, or a re-import) before they match ResQ. The fix runs on the Engine's bundled copy for hosted saves and refreshes and on the Bridge's for the ResQ import, so both need a redeploy before it reaches production.

**Verification:** `python-api/tests/test_bornhuetter_ferguson_contract.py` - the whole-number test now pins the live 2025/2026 figures (57.894588 and 63.014729) and the negative-ultimate test expects -1.5 rather than -2; `test_resq_bornhuetter_ferguson_v3.py` and `frontend/tests/test_bornhuetter_ferguson_service.py` pass unchanged; `frontend/tests/bornhuetter_ferguson_v3_frontend.test.mjs` pins the six-decimal helper in the output calculation and drops the whole-number asserts. All four suites pass.

### 2026-09-03 - A DFM ratio could differ from ResQ in its fourth decimal on a near-zero "% of" input

**Reported:** Comparing `NJ_Annual_Prod_2026 Q3-Aug` with the ad-hoc `python-api/migration/validation/dfm_ratio_side_by_side_review.py` review script (not kept in the tree) found one cell where ArcRho and ResQ disagreed by more than four decimal places: `PRNJ - PA\PA\Penn+CT\Direct Group\MP+PIP`, DFM `G 22 B - ALAE/Net Paid Loss DFM w/ Selected LDFs`, origin 2025 Q2, development `(1) 2-5` - ArcRho 1231.89947 against ResQ 1231.89967. Both systems agreed on the underlying loss data, and ResQ had already excluded the cell from its own averaging, so nothing downstream was wrong.

**Cause:** `canonical_input_number` in [dfm_contract.py](../python-api/src/arcrho_api/dfm_contract.py) rounded every observed input-triangle cell to ten decimal places before storing it in the method file, and every ratio and average then divided that stored copy rather than the value the source holds. Everything upstream already carried full double precision - the ResQ extractor reads raw COM doubles in `export_triangle`, `_csv_matrix_bytes` writes them as plain text, and no dataset sidecar keeps a rounded copy - so the ten-decimal quantum was the only place a digit was lost. A rounding rule fixed at a decimal place keeps a different fraction of a number depending only on how large that number is: ten decimals is generous for a loss figure and far too coarse for a `% of` figure near zero, where the trimmed tail is a large share of the denominator and reappears multiplied by the ratio.

**Fix (in [dfm_contract.py](../python-api/src/arcrho_api/dfm_contract.py)):**
- `canonical_input_number` no longer quantizes. It keeps the observation exactly as read and only rejects what was never a number - blanks, booleans, infinities and NaN - while preserving the previous handling of negative zero and whole numbers. `_INPUT_QUANTUM` and the exported `DFM_INPUT_VALUE_DECIMAL_PLACES` are gone with it; nothing outside the module referenced either.
- Everything that consumed the helper - the input matrix normalizer, the two ratio-calculation sites, and the latest-value scan - inherits the change unaltered, so no call site moved.
- Readability of the persisted file is unaffected. The values are copied rather than computed, and a JSON number round-trips a double exactly, so the shortest text that reads back as the same value is what lands on disk; an ordinary figure still reads as an ordinary figure.
- Nothing else changed precision. Ratio triangle values, average formula values, the ultimate vector and the Ratio Basis stay at six decimals, and `source_snapshot_revision` still fingerprints the input snapshot at six decimals - a deliberate choice made when this figure went from six decimals to ten in [release 1.4.0](../frontend/docs/releases/1.4.0.md) - so no stored revision shifts and no method is marked out of date by the change alone.

**Scope on live data:** An existing method keeps the numbers already in its file until it takes a fresh snapshot from its source, through a re-import or a refresh. The one production cell this was found on was already excluded from ResQ's own averaging and changes no result, so nothing in the live project was refreshed.

**Verification:** `python-api/tests/test_dfm_contract.py` updated - the three tests that pinned the ten-decimal rule now pin full precision, the existing unrounded-division test expects the ratio the two observations actually make (1.9 rather than 1.899968), and a new test reproduces the reported shape by dividing a large ratio out of a near-zero denominator. Suite passes.

### 2026-08-05 - Saving a DFM took a long time on a Client PC

**Reported:** On a Client PC, editing a DFM in Project Instance and saving it took a long time to respond and finish. ([reported screenshot](image.png), showing the `Saving DFM method...` status line.)

**Cause:** Profiled `dfm_service.save_dfm_method` end to end against a copy of a real 119-dataset reserving class (`PRNJ - PA\PA\All States\Direct Group\COL`). One save issued **316 file opens, 112 stats, 84 isdir and 14 scandir calls**. The dominant cost was inside the post-save cascade: `calculated_dataset_service._candidate_csvs` listed the whole `datasets/` folder and then read each CSV's sidecar **one at a time**, and it did that once per formula component - 238 sequential sidecar reads for a single recalculated dependent. On a mapped or UNC drive every one of those is a full network round trip, which is the shape the root `AGENTS.md` "Network-Drive Project Data I/O (MUST)" rule forbids. `_candidate_dfm_methods` had the same per-file loop over `methods/DFM@*.json`, and both re-stat-ed candidate paths that the directory listing had already reported.

**Fix (in [calculated_dataset_service.py](../frontend/app_server/services/calculated_dataset_service.py)):**
- Added `_read_json_files_bulk`, which deduplicates paths and reads them through a bounded 12-worker pool. Cache variants of one dataset share a sidecar, so the duplicates disappear before any I/O.
- Added `_scan_dataset_cache_folder` and `_scan_dfm_method_folder`, which enumerate a folder once with `os.scandir` and keep the modification time the listing already returned rather than re-statting each path.
- `_candidate_csvs`, `_candidate_dfm_methods`, `_sidecar_for_csv`, `_read_dfm_input_triangle`, and `_build_dfm_method_vector` accept an optional folder observation, and `_load_components` builds each folder's observation at most once and reuses it for every component. Exact-path lookups still avoid forcing a folder scan.
- Scoring, ambiguity detection, and candidate ordering are untouched, so the chosen dependency for any folder is the same as before.

**Measured on the same reserving class:**

| | before | after |
| --- | --- | --- |
| file opens per save | 316 | 195 |
| longest sequential read loop | 238 reads | one 12-way parallel batch |
| save at 3 ms simulated round trip | 1825 ms | 977 ms |
| save at 8 ms simulated round trip | 3337 ms | 1392 ms |

**Verification:** Ran the same save on two identical sandbox copies of the project with the old and new code; every written file matched byte for byte apart from timestamps and the sandbox path, and `changed_paths`, `propagation`, `targets`, and `unreviewed_precedents` were identical. New `frontend/tests/test_calculated_dependency_folder_scan.py` covers deduplicated reads, bounded concurrency, deterministic candidate ordering, reuse of a supplied observation, and missing-folder/unreadable-sidecar failure handling. The existing calculated-dataset, DFM service, and dataset-index test modules pass.
