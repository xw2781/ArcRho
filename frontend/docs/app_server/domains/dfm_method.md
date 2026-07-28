# App Server Domain: DFM Method

## Purpose
<!-- MANUAL:BEGIN -->
The DFM method domain owns self-contained v2 method loading, canonical calculation preview, revision-aware saves, explicit recovery refreshes, and automatic refresh after ArcRho-managed precedent updates.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/dfm/method/load` | Load a method and its declared output sidecar. When Project Instance supplies both identities, the two files are read in parallel. |
| `POST` | `/dfm/method/preview` | Recalculate derived DFM state in memory with the canonical Python contract and no filesystem I/O. |
| `POST` | `/dfm/method/save` | Rebase submitted owned state onto the newest derived state, calculate, and publish the method/output transaction. |
| `POST` | `/dfm/method/refresh` | Explicitly reread registered precedents and recover a review-needed DFM when its source geometry is compatible. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/dfm_method_router.py` - Aggregate DFM transport endpoints.
- `app_server/schemas/dfm_method.py` - Method identity, preview, save, and revision request schemas.
- `app_server/services/dfm_service.py` - Two-file load, v1 upgrade, source snapshot reads, revision checks, publication, and dependent refresh.
- `python-api/src/arcrho_api/dfm_contract.py` - Canonical location-independent v2 schema, six-decimal normalization, ownership projections, revisions, and DFM calculations.
- `ui/method_pages/dfm/dfm_method_api.js` - Frontend client for the aggregate endpoints.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Current methods use `json format = arcrho-dfm-method-by-tab-v2`.
- `details tab.name` owns the method filename. `details tab.output dataset` owns the output CSV/sidecar identity. `details tab.output type` remains the Vector Dataset Type.
- The method JSON embeds input values/mask/labels/formatting/source revision, Ratio Basis values/labels/formatting/source revision, calculated ratios and formula values, the ultimate vector, ratio-cell notes, and owned/derived/publication revisions. It never stores absolute input or output CSV paths.
- Method Notes, Audit, status, and dependency graph remain in the output sidecar. Both Input Triangle and Ratio Basis are registered precedents.
- A valid v2 open performs exactly two project-data reads and never validates those embedded snapshots by reopening precedents. An exact v1 file is upgraded transactionally by reading its precedents once; no partial v2 is persisted.
- Save compares the owned revision independently from the derived revision. A clean owned patch may rebase over an automatic derived refresh; an externally changed owned revision returns a conflict. An ordinary v2 Save trusts its embedded source snapshots and does not reopen precedents to validate duplicate label metadata.
- Publication uses the reserving-class lock, staged replacement, rollback, unchanged-file suppression, and sidecar-last ordering. Every explicit Save acknowledges the DFM output as Current and starts downstream propagation even when its publication values are unchanged. Readable review-needed precedents are returned through `unreviewed_precedents` and `unreviewed_precedent_count` without blocking the save.
- Automatic refresh preserves exclusions, formula definitions and selections, literal User Entry values, the complete stored result of Excel-linked formulas, ratio-cell notes, Method Notes, Audit, and the method-owned origin/development axes. Source CSV values are mapped onto those axes without requiring duplicate precedent-sidecar labels. It refreshes the stored data but leaves the DFM Review Needed until an explicit Save; Refresh alone is not acknowledgement. Incompatible row, column, or period geometry leaves the prior publication intact and reports the refresh failure separately.
<!-- MANUAL:END -->

## External Excel Links
<!-- MANUAL:BEGIN -->
DFM hydration never waits for Excel. After a clean method revision is applied, the page may launch one abortable check-only request against last-saved workbook values. Workbook/cell reads are deduplicated and bounded, and the check does not modify the method, cache, rendering, or dirty state. Stale or unverifiable counts remain visible in the Links tab and are also reported through the app status bar. Existing Links and Ratios refresh controls remain the user-authorized mutating refresh path.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Direct out-of-band CSV edits do not participate in managed propagation and require explicit Refresh/Repair.
- Saved workbook values may differ from unsaved values in a live Excel session; the background check intentionally reports only disk-saved values.
- A failed dependent branch does not roll back the upstream save. Its last valid publication is retained and only its descendants are blocked.
- The app server owns the complete DFM -> calculated dataset -> Result Selection cascade. Standalone public-Python and ResQ-migration runs refresh DFM branches, then mark non-DFM calculated/Result Selection branches Review Needed with a propagation warning because those evaluators are not packaged in the headless runtime.
<!-- MANUAL:END -->
