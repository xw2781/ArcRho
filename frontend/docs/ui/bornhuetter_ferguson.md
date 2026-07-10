## Purpose
<!-- MANUAL:BEGIN -->
Bornhuetter Ferguson method page for producing a final ultimate vector from latest actual triangle values, a selected DFM implied ultimate vector, and one or more weighted prior ultimate vectors.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN frontend.bornhuetter_ferguson.entry_points -->
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN frontend.bornhuetter_ferguson.key_files -->
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Opens inside Project Instance as a floating iframe method window at `/ui/bornhuetter_ferguson/bornhuetter_ferguson.html`.
- Uses shared tabbed-page, tab pop-out, notes editor, dataset origin-label, dataset picker, filename-sanitizer, and save-bar helpers.
- Details, Method table, Audit Log table, select carets, and save actions follow the compact DFM-style ArcRho controls; single-value BF dataset pickers use the same three-dot button design as DFM Details.
- Every BF tab uses the shared white `bfPageHost` workspace surface inside the DFM-style gutter and border frame.
- Origin Length uses a narrow 70px custom dropdown with the numeric period options `12`, `6`, `3`, and `1`; its menu layers above the adjacent source panel.
- The Details tab stacks the object fields above the source fields in two full-width panels without separate panel-header bars.
- The source fields are labeled `Latest`, `Development Pattern`, and `Prior Vector`; their persisted method fields remain `latest_dataset`, `dfm_dataset`, and `prior_datasets`.
- Selected Prior Vector tokens use the same compact white pill frame and pale-blue hover/focus treatment as Dataset Details formula components. Clicking a token opens its dataset through the Project Instance related-dataset route. Tokens have no inline close icon: dropping a dragged token outside the Prior Vector box or choosing Delete from its right-click context menu removes it. A trailing neutral `+` pill with a blue hover/focus state opens the prior-vector picker instead of a three-dot picker button.
- Saves method JSON to `methods/BF@<Name>.json`.
- Saves the output vector to `datasets/<Name>@<OriginLength>.csv` and writes coarser aggregated vector CSV variants when possible.
- Saves output sidecar metadata through `/dataset/sidecar/save` with `source_kind: "bornhuetter_ferguson"` and `method_type: "Bornhuetter Ferguson"`.
- Uses Project Instance `arcrho:dataset-dirty`, `arcrho:dataset-save`, `arcrho:dependency-source-preview`, `arcrho:dependency-source-cleared`, `arcrho:project-instance-refresh-datasets`, `arcrho:project-instance-open-dependent-dataset`, and `arcrho:bf-tab-changed` messages.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- The canonical method type label is exactly `Bornhuetter Ferguson` in UI, method JSON, and sidecar metadata.
- V2 inputs are one latest triangle, one DFM output vector, and one or more prior ultimate vectors with non-negative row weights. Existing v1 single-prior JSON loads as one source with default row weights of `1`.
- Existing or migrated BF method JSON that stores source configuration is hydrated on open by loading those sources and recomputing the Method table.
- Open BF windows consume matching Project Instance live dependency previews for Latest, Development Pattern, and Prior Vector sources. Dirty upstream Dataset, DFM, or method changes temporarily replace the matching in-memory source vector and immediately recompute Percentage Developed, Selected Prior, New Ultimate, and the Chart without changing the BF window's own dirty state. When the upstream preview is cleared, saved, or discarded, BF reloads that source from disk while preserving any other active dependency previews.
- Migrated BF method origin labels come from the ResQ BF method `OriginLabel(OriginIndex=...)` values and are preserved when source data is refreshed.
- Latest values come from the latest diagonal of the selected actual triangle.
- Percentage Developed is derived as `Latest / DFM Ultimate`; blank values, non-numeric values, and zero DFM ultimate values produce blank percentage-developed values.
- The Method grid follows the compact ResQ BF presentation with Accident Year, Latest, Percentage Developed, one dynamic prior column and optional Weight column per selected source, Selected Prior, New Ultimate, and a selectable Total row. Missing data cells display a muted gray `null` placeholder without changing the underlying empty value; structural Total-row cells remain blank. DFM Ultimate remains calculation state but is not shown separately.
- The Method toolbar contains only Result Selection-style Formatting controls for Show Weights, Index/Effective % display, and decimal places. Method cells support click-and-drag highlights, row/column selection, Shift extension, arrow movement, `Esc` clearing, copy, and weight paste. In Index mode, double-clicking a prior value or Weight cell toggles its weight between `0` and `1`; Effective % cells remain read-only. Typing or pasting into highlighted prior/Weight cells updates row weights, and Delete sets them to `0`.
- Selected Prior is the weighted average `SUM(Prior * Weight) / SUM(Weight)` across available positive-weight prior values for each row.
- New Ultimate is `Latest` when Selected Prior is blank for that row. Otherwise it is `ROUND(Latest + (1 - Percentage Developed) * Selected Prior, 0)`; it remains blank when Latest is blank, or when Percentage Developed is blank while Selected Prior is available.
- The Chart tab plots DFM Implied Ultimate (`Latest / Percentage Developed`), Selected Prior, and BF Ultimate (`New Ultimate`) as three responsive lines by origin period. Missing or zero percentage-developed inputs leave the DFM implied point blank, and hovering a plotted point shows its series, origin, and formatted value.
- Exposure and ResQ/RPC sync are deferred.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change BF calculation behavior: update `ui/bornhuetter_ferguson/bornhuetter_ferguson_main.js` and keep `frontend/docs/plans/bornhuetter_ferguson_method_plan.md` in sync.
2. Change BF routing: update Project Instance dataset table, window, and message modules together.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- BF output depends on source vector/triangle period alignment; mismatched source periods can produce blank or misaligned rows.
- The persisted method label must remain `Bornhuetter Ferguson` so Project Instance and dataset dependency chips route to the BF page.
<!-- MANUAL:END -->
