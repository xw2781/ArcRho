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
| `POST` | `/dfm/method/dataset-references/resolve` | Resolve a bounded batch of Ratios User Entry dataset references without mutating project data. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/dfm_method_router.py` - Aggregate DFM transport endpoints.
- `app_server/schemas/dfm_method.py` - Method identity, preview, save, and revision request schemas.
- `app_server/services/dfm_service.py` - Two-file load, v1 upgrade, source snapshot reads, revision checks, publication, and dependent refresh.
- `python-api/src/arcrho_api/dfm_contract.py` - Canonical location-independent v2 schema, six-decimal normalization, ownership projections, revisions, and DFM calculations. `persisted_projection` is the one on-disk form of a method (no input mask, trailing nulls trimmed), and every DFM method writer — this app server, the public Python API (`arcrho_api.dfm.DfmMethod.save`), and the ResQ migration — serializes through it and `arcrho_api.io.persisted_json_text`, so the same logical method lands as the same bytes whichever component saved it.
- `python-api/src/arcrho_api/revision_contract.py` - The one producer of every persisted fingerprint (`fingerprint`): the owned/derived/publication revisions of DFM, BF, CC and Bootstrap methods, every embedded `source revision`, and the processing `config_hash`. A fingerprint is `sha256:` plus the first sixteen hex characters of the digest of a sorted, compact JSON projection; the projection's keys are a fixed vocabulary spelled independently of the persisted field names, so renaming an on-disk field never moves a stored revision, and the shortening lives in that one function so both sides of every comparison shorten together.
- `ui/method_pages/dfm/dfm_method_api.js` - Frontend client for the aggregate endpoints.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- `POST /dfm/method/load` is the `dfm_method_load` Server-hosted workspace read: when the Gateway advertises it, the method JSON and sidecar (and, for an exact v1 file, the one-time upgrade) run on the server host under the opening user's identity and the response is returned verbatim; otherwise the service runs locally. See [`workspace_reads`](workspace_reads.md).
- Current methods use `json format = arcrho-dfm-method-by-tab-v2`.
- `details tab.name` owns the method filename. `details tab.output dataset` owns the output CSV/sidecar identity. `details tab.output type` remains the Vector Dataset Type.
- The method JSON embeds input values/labels/formatting/source revision, Ratio Basis values/labels/formatting/source revision, calculated ratios and formula values, the ultimate vector, ratio-cell notes, and owned/derived/publication revisions. It never stores absolute input or output CSV paths.
- The persisted input triangle omits `input data triangle mask` and trims trailing nulls from each row; loading derives the mask and refits the rectangular geometry. Every method write and unchanged-file comparison goes through the canonical `persisted_projection`, so the in-memory payload, all three revisions, and API responses are unchanged.
- Method Notes, Audit, status, and dependency graph remain in the output sidecar. Both Input Triangle and Ratio Basis are registered precedents.
- A valid v2 open performs exactly two project-data reads and never validates those embedded snapshots by reopening precedents. An exact v1 file is upgraded transactionally by reading its precedents once; no partial v2 is persisted.
- Save compares the owned revision independently from the derived revision. A clean owned patch may rebase over an automatic derived refresh; an externally changed owned revision returns a conflict. An ordinary v2 Save trusts its embedded source snapshots and does not reopen precedents to validate duplicate label metadata.
- Publication uses the reserving-class lock, staged replacement, rollback, unchanged-file suppression, and sidecar-last ordering. Every explicit Save acknowledges the DFM output as Current and starts downstream propagation even when its publication values are unchanged. Readable review-needed precedents are returned through `unreviewed_precedents` and `unreviewed_precedent_count` without blocking the save.
- When the per-user Gateway is enabled, DFM plan and save send the exact existing `ArcRhoHostedSave` request over HTTP instead of publishing and polling its Engine request through client-side SMB. The Gateway performs those filesystem operations on the server PC; ArcRho Engine still calls `dfm_service.save_dfm_method`, so the canonical v2 method projection, revision checks, publication transaction, response, propagation, review warning, dirty state, and close behavior do not change. Every other method type uses the same transport on the same terms.
- Automatic server refresh preserves exclusions, formula definitions and selections, literal User Entry values, the complete stored result of Excel-linked formulas, ratio-cell notes, Method Notes, Audit, and the method-owned origin/development axes. Source CSV values are mapped onto those axes without requiring duplicate precedent-sidecar labels. A change to a dataset referenced by a Ratios User Entry formula follows its registered graph edge and triggers the same automatic refresh: the walk re-resolves every dataset reference in the method, re-evaluates the affected User Entry values through the canonical contract, republishes the method JSON and outputs, and marks the DFM Review Needed. A blank or non-numeric referenced cell aborts that refresh, records the error, and preserves the last valid publication. Refresh alone is not acknowledgement; opening the DFM shows the refreshed persisted values and stays clean, and an explicit Save clears the Review Needed status. Whenever the refresh rewrites the method file — even when the published ultimate is unchanged — it stamps the output sidecar's `updated_at`/`modified_by` and appends an `Auto Refresh` audit record, so the dataset table's Last Modified follows the propagation; a refresh that changes nothing leaves both alone. Incompatible row, column, or period geometry leaves the prior publication intact and reports the refresh failure separately.
- `POST /dfm/method/dataset-references/resolve` resolves Ratios User Entry references against existing dataset instances in the requested project and Reserving Class. It loads each distinct dataset once with bounded parallel I/O, uses one-based positions or exact axis labels, defaults an omitted Vector column to its first column, and requires a Triangle column. Negative positions count backward from the latest valuation-valid dataset geometry: trailing empty Vector positions are excluded, and trailing empty Triangle calendar diagonals are excluded while interior blanks remain addressable. This read does not change persisted method JSON or dependency sidecars; the normal DFM Save derives formula-dataset edges from authoritative `inputs` and updates both sides of the graph transactionally.
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
