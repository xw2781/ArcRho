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
