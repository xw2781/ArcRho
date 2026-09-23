# ResQ Export: Create Missing Methods and Mirror Method Settings

Status: Planned 2026-09-23 and broken into 8 session-sized steps. The export will create a DFM, Bornhuetter Ferguson or Result Selection that Arco holds and ResQ does not, bring an existing one's settings in line with Arco, and the DFM page gains "Load Settings From Another Method". Step 1 done 2026-09-23 (every ResQ call confirmed live; the ResQ-window check of Load Settings moved into step 7). Step 2 done 2026-09-23: exporting an existing DFM now brings its output type, input, lengths and average rows in line with Arco (live in ResQ after step 6). Step 3 done 2026-09-23: exporting an existing BF now brings its output type, origin length, latest, percentage developed and every prior with its weights in line with Arco, and a Result Selection also drops the datasets Arco does not hold (live in ResQ after step 6). Step 4 done 2026-09-23: a DFM, BF or Result Selection only Arco holds can now be ticked in the export review and is created in ResQ with Arco's settings, reading "Created in ResQ" (live in ResQ after step 6; the review label after the next app build). Step 5 done 2026-09-23: the DFM Details tab gains "Load Settings From Another Method" (ships with the next app release; the full app check is step 8). Step 6 done 2026-09-23: the Bridge runs the new export and the shared library offers the Export macro at 3.0.0; three other users' Bridges stayed down after the deploy until they relaunch. Step 7 done 2026-09-23: one export run from Arco created a new DFM, BF and Result Selection in ResQ and put back three methods changed in ResQ; a defect with prior-period Curves columns on a created DFM was fixed and shipped as macro 3.0.1 with a Bridge redeploy; one question about ResQ's read-only prior-period rows is open. Step 8 done 2026-09-23: Load Settings From Another Method was checked in the running app (copy, undo, redo and save behave as Decision 9 says; no defect). Completed 2026-09-23: all 8 steps done in 193 minutes against 455 estimated; Open decision 1 stays open for a follow-up.

Last updated: 2026-09-23

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Learn how ResQ creates and reconfigures these three methods | [x] | 2026-09-23 | 60 min | 22 min | ResQ was shown to accept creating, reshaping and copying these three methods, and the rules and pitfalls it follows are written down for the next steps. |
| 2 | The export brings an existing DFM's input, lengths and average rows in line with Arco | [x] | 2026-09-23 | 60 min | 20 min | Exporting a DFM that ResQ already has now also gives it Arco's input triangle, lengths, output type and average rows, and the results window says what changed; it reaches users with the step 6 update. |
| 3 | The export brings an existing BF's inputs and a Result Selection's loaded datasets in line with Arco | [x] | 2026-09-23 | 50 min | 17 min | Exporting a BF that ResQ already has now also gives it Arco's latest, percentage developed and every prior with its weights, and a Result Selection loses the datasets Arco does not load; the results window says what changed, and it reaches users with the step 6 update. |
| 4 | The export creates a DFM, BF or Result Selection that ResQ does not have yet | [x] | 2026-09-23 | 65 min | 16 min | A DFM, BF or Result Selection that only Arco has can now be ticked in the export review and is created in ResQ with Arco's settings, making its output type too when ResQ lacks it; one whose inputs ResQ lacks is skipped with the missing input named, and it reaches users with the step 6 update. |
| 5 | A DFM can copy every setting from another DFM in one click | [x] | 2026-09-23 | 70 min | 33 min | The DFM Details tab has a Load Settings From Another Method button: pick a class and one of its DFMs, and its lengths, average rows, selections, matching exclusions and Curves choices are copied, unsaved until Save and undoable; it reaches users with the next app release. |
| 6 | The new export reaches every user | [x] | 2026-09-23 | 30 min | 12 min | The server now runs the new export and the macro library offers Export Reserving Class to ResQ 3.0.0; three other users' ResQ connections did not restart on their own and need them to reopen Arco. |
| 7 | The export is checked end to end in Arco and ResQ | [x] | 2026-09-23 | 80 min | 54 min | One export from Arco created a new DFM, BF and Result Selection in ResQ and put back three methods changed in ResQ, with no failures; one defect was fixed (a newly created DFM lost the prior-period column on its Curves tab) and reaches users through the server and macro 3.0.1; ResQ's own prior-period rows cannot be written, which is left as an open question. |
| 8 | Copying DFM settings is checked in the running app | [x] | 2026-09-23 | 40 min | 19 min | In the running app a DFM took another class's DFM settings in one click, showed unsaved, undid and redid cleanly, and saved exactly the source's rows, selections, exclusions and Curves choices while keeping its own name, input and notes; it was then put back as it was, and no defect was found. |

Overall: 8 of 8 steps done. Estimated 455 min, actual 193 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in the [plans index](../README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

Two extra rules for this plan:

- **Other people's work is in this clone.** When the plan was written the tree held another session's uncommitted Excel add-in and server edits. Commit only your own files, by path, through the `arcrho-commit-workflow` skill. Never stage, stash, revert or deploy someone else's changes. If `git commit` reports `index.lock`, wait a few seconds and retry: steps 2-4 and step 5 may run at the same time.
- **The Fake project is yours to change.** The user allowed any change to `NJ_Annual_Prod_202605_Fake` in both Arco and ResQ for this plan. That permission stops at that project. Never touch another ResQ or Arco project.

## Ship impact

- **Server component redeploy, then a macro publish.** The export's ResQ writer and the session that drives it are frozen into the Bridge ([bundled_sources.py](../../../server-components/src/arcrho_bridge/bundled_sources.py)). Steps 2-4 take effect only after step 6 redeploys the Bridge and publishes the macro.
- **Frontend release only for step 5.** "Load Settings From Another Method" lives in the DFM page and reuses the existing method load and method list routes, so no server component bundles it. It is tested in dev mode and ships with the next app release.
- **Risk to the released app: none.** The released macro already sends the ticked names and renders the rows the Bridge returns. Which rows can be ticked is decided in the Bridge. One cosmetic gap: the released review window labels a row that will be created in ResQ "Overwrites ResQ copy". The corrected "Created in ResQ" label reads from the app's own library, so it appears after the next app build.
- **Do not bump `SYNC_SESSION_API_VERSION`** unless a step changes the request or response contract. None is expected to.

## Background

The Export Reserving Class to ResQ macro ([export_reserving_class_to_resq.py](../../../python-api/macros/export_reserving_class_to_resq.py)) has two halves:

- **The ResQ writer.** `ResQReservingClassExporter` runs inside the Bridge.
- **The client side.** `run_macro` publishes a `transfer_preview` request, shows the shared review window, then publishes an `export` request carrying the ticked names.

The canonical session [sync_session.py](../../../python-api/migration/resq_migration/sync_session.py) owns the inventory, the review rows, the dependency order and the dispatch:

- **Review rows.** `preview_transfer` builds them (`_transfer_rows`, `_transfer_row` around line 2355).
- **Tickability.** Whether a row can be ticked is [sync.transfer_support](../../../python-api/migration/resq_migration/sync.py#L193-L213). For the export direction it refuses every item ResQ lacks: "ResQ has no matching dataset or method to overwrite".
- **Write order.** `export_reserving_class` (line 2825) orders the ticked rows (`_dependency_ordered_rows`, line 169) and hands each to `_push_row_to_resq` (line 1048).
- **Dispatch today.** DFM goes to `export_dfms` and Result Selection to `export_result_selections`. BF, CC and B&S SR are **save-only** (`_SAVE_ONLY_METHOD_CODES`, line 88): only their Notes are written, then they are saved. The macro's `_export_bf` exists but the export phase never calls it.

What the writer does today for an existing method:

- **DFM** ([_export_dfm](../../../python-api/macros/export_reserving_class_to_resq.py#L537-L554)): excluded ratios, User Entry values, tail factors, selected rows, the Curves tab and Notes. It never touches the input triangle, the lengths, or the average formula rows themselves. It matches Arco rows to ResQ rows by label (`_average_formula_display_indexes`), so a row that exists on only one side is silently left out.
- **BF**: Notes and save only.
- **Result Selection** ([_export_result_selection](../../../python-api/macros/export_reserving_class_to_resq.py#L1175-L1259)): adds any loaded dataset ResQ lacks, writes weights and overridden ultimates. It never removes a dataset ResQ has and Arco does not.
- **Anything ResQ lacks**: skipped as `missing_in_resq`. The code and [resq_reserving_class_export.md](../../../python-api/docs/resq_reserving_class_export.md) both say the export never creates anything.

The review window renderer, [resq_transfer_review.py](../../../python-api/src/arcrho_api/resq_transfer_review.py#L112-L117), only projects what the Bridge sends. It greys a row out when `transfer_supported` is false.

### Arco method JSON the export reads

- **DFM** ([dfm_contract.py](../../../python-api/src/arcrho_api/dfm_contract.py)): `details_tab` has `name`, `output_type`, `input_triangle`, `origin_length`, `development_length` and `decimal_places`. `ratios_tab.average_formulas` holds one row per average:
  - `label` names the row.
  - `custom_average_formula_settings` gives each row's `average_type` (`custom` / `user_entry`), `base` (`simple` / `volume` / `benchmark`), `periods` (`all` or a count) and `exclude` (high/low count).
  - `inputs` holds the formula text of a User Entry row, for example `=("Simple - 5"+"Simple - 3")/2`.
  - `selected` and `values` hold the chosen row and the figures per column.

  `curves_tab` is owned by [dfm_curves.py](../../../python-api/src/arcrho_api/dfm_curves.py).
- **BF** ([bornhuetter_ferguson_contract.py](../../../python-api/src/arcrho_api/bornhuetter_ferguson_contract.py)): `details_tab` has `name`, `output_type` and `origin_length`. `method_tab` holds:
  - `latest_dataset`;
  - `dfm_dataset`, the DFM whose output supplies percentage developed;
  - `prior_datasets`, a list of `{name, weights}`.
- **Result Selection** (`normalize_method_payload` in [result_selection_service.py](../../../frontend/app_server/services/result_selection_service.py#L306)): `details_tab` has `name`, `output_type` and `origin_length`. `method_tab.loaded_datasets` is a list of `{name, weights}`, and `method_tab.ultimate_overrides` holds the overridden ultimates.

### How the import reads the same settings from ResQ

The export must be the exact inverse of these readers, so they stay the single owner of the mapping between Arco and ResQ settings:

- **DFM** ([dfm.py](../../../python-api/migration/resq_migration/dfm.py)):
  - `export_dfm` (line 796) reads the whole method.
  - `resq_average_row_labels` (306) and `_resq_average_formula_names` (329) name the average rows.
  - `_read_resq_average_definition` (383), `_translate_resq_average_formula` (493), `_infer_avg_settings` (553) and `_average_row_settings` (582) turn a ResQ row into Arco settings.
- **BF**: `export_bornhuetter_ferguson` in [extractors.py](../../../python-api/migration/resq_migration/extractors.py#L2309).
- **Result Selection**: `export_result_selection` in [extractors.py](../../../python-api/migration/resq_migration/extractors.py#L1966).

### ResQ COM surface found so far (to be confirmed live in step 1)

- **Creating a method.** `ReservingClass.AddMethod(type)` with 1 = DFM, 2 = BF, 4 = Result Selection. The class collections (`DFMMethods()` and so on) are read-only views. `AddMethod` creates the output vector with the method. Set `method.Name`, `method.OutputVector.Name` and `method.OutputVector.DatasetType = project.DatasetTypes().Item(<type>)`, the method's own inputs, then `method.Save()`. `ResQToolBox2.py` lines 2044-2153 show the production sequence. A new project-wide type comes from `project.DatasetTypes().Add()`: set Name, Category, DataFormat (1 = origin vector) and DecimalPlaces, then Save.
- **DFM.**
  - Inputs and lengths: `InputTriangle`, `OriginLength` and `DevelopmentLength`. The development length must divide the origin length, and ResQ warns that changing either resets parts of the method.
  - Row count: `RatioAverageCount` is settable. There is no add or delete call for a single row.
  - Row settings: `CustomAverages(i)` is 1-based, with Name, AverageType (0 custom, 5 user entry, 6 calculated, 9 benchmark …), WeightType (0 simple, 1 volume), PeriodsIncluded, ExcludeHighLow2, Formula (used only when AverageType = 6, written like `(Average(5)+Average(6))/2`), TailFactor and `ResetName()`.
  - Copying settings: `LoadMethod(otherDfm)` is ResQ's own "Load Settings From Another Method" / Apply To.
- **BF.** `Latest` / `LatestType`, `PercentageDeveloped` / `PercentageDevelopedType` (0 internal, 1 pattern, 2 cumulative development factors, 3 adjusted), and `OriginLength`. Priors come in two forms: the older single `Prior` / `PriorType`, and the current collection `PriorVectorCount`, `AddPriorVector` and `RemovePriorVector`, with weights through `PriorRatioObj` / `PriorRatioWeightSelection`.
- **Result Selection.** `AddDataset`, `RemoveDataset`, `Dataset(i)`, `DatasetCount`, `DatasetIndex`, `SetWeights(datasetIndex, originIndex, value)`, `ClearOverriddenUltimates` and `SetUltimates`.
- **Probing safely.** Use early binding (`gencache.EnsureDispatch`), `ConnectByName("JGO_CO1SQLWPV22", "", "")` and `py -3.10`. It works from the agent's shell on the Server PC. Read everything off an object before `UnloadChildren()`. Never call members blindly: see the `resq-com-probe` and `resq-com-probe-dont-call-blindly` memories.
- **ResQ's own copy feature.** "Load Settings From Another Method" in the ResQ DFM Details tab opens a "Select an item" dialog: a reserving-class tree on the left, and on the right the selected class's methods listed by output name with Method Type, Status and User columns.

### The Arco DFM page today

- **Details tab.** Sections for name / output type, input triangle / precedents / dependents, and origin length / development length / decimal places ([dfm.html](../../../frontend/ui/method_pages/dfm/dfm.html#L39-L144), wired in `dfm_details.js`).
- **Loading and listing.** `POST /dfm/method/load` takes any project and reserving class. `GET /dfm/method-index?project_name&reserving_class` lists a class's DFMs. Both wrappers are in `dfm_method_api.js`.
- **The nearest existing feature.** `saveDfmTemplate()` (`dfm_persistence.js:1862`) writes the lengths and average formulas to a local `.arc-dfm` file. Nothing reads one back. `apply_owned_patch` in `dfm_contract.py` (line 1987) rebases owned settings onto a method, for the ResQ RPC bridge.
- **Pickers.** None combines a reserving-class tree with a method list. `openReservingClassPicker` (`shared/components/pickers/reserving_class_picker.js`) returns a class path; the method index lists that class's DFMs.

## Decisions

These are settled for this plan so that no workflow step has to ask.

1. **What gets created.** The export creates a DFM, Bornhuetter Ferguson or Result Selection that Arco holds and ResQ does not. It still never creates a plain dataset, a Cape Cod or any other method kind, so those stay greyed out when ResQ lacks them.
2. **Inputs must already be in ResQ.** A new method whose input is missing in ResQ is skipped with a message naming that input: a DFM's input triangle, a BF's latest, percentage-developed or prior dataset, or a Result Selection's loaded dataset. Because the session writes in dependency order, a BF created in the same run finds the DFM created just before it.
3. **Output type.** The ResQ output vector gets the dataset type named by Arco's `output_type`. When ResQ has no type by that name, the export creates it from Arco's dataset-type definition: name, category and decimal places, as an origin vector. When ResQ lacks that category, the method is skipped with a message.
4. **Names.** The ResQ method name and its output vector name are Arco's `details_tab.name`. Lookups keep the existing whitespace-tolerant matching.
5. **Exporting an existing method mirrors Arco.** Ticking an existing DFM, BF or Result Selection overwrites its ResQ settings to match Arco. The review tick is the consent.
   - **DFM:** output type, input triangle, origin and development lengths (written first, keeping the rule that development length divides origin length), the number of average rows, and each row's name, type, weighting, periods, high/low exclusion and calculated formula. The existing writes (exclusions, User Entry values, tails, selections, Curves, Notes) follow, in that order.
   - **BF:** output type, origin length, latest, percentage developed, every prior with its weights, Notes.
   - **Result Selection:** output type, origin length, loaded datasets (adding what ResQ lacks and removing what Arco does not hold), weights, overrides, Notes.
6. **BF leaves the save-only group.** Cape Cod and B&S Settlement Rate stay save-only.
7. **The mapping lives beside the import.** The Arco-to-ResQ average-row mapping goes into [dfm.py](../../../python-api/migration/resq_migration/dfm.py) next to the import's ResQ-to-Arco translation. It is tested as a round trip, so the two cannot drift. The Bridge freezes the migration package beside the macro, so the exporter may call it; this is the same bundle, not the app's `arcrho_api`.
8. **Review label.** A row that will be created reads "Created in ResQ". The Bridge sends `presence: "arcrho"` with `transfer_supported: true`. The renderer in `arcrho_api` gains that case. Until the next app build, the released renderer shows "Overwrites ResQ copy" for such rows.
9. **"Load Settings From Another Method" in Arco.**
   - **Where and how.** A button on the DFM Details tab opens a picker with a reserving-class tree and that class's DFMs, in any class of the current project.
   - **What it copies.** Everything the user owns in the source DFM except its identity. It copies the origin and development lengths, decimal places, the average formula rows (labels, settings, User Entry formulas and values), the selected row per column, the ratio exclusions where the origin and development labels match, and the Curves tab settings.
   - **What it keeps.** The name, output type, input triangle and Notes.
   - **Saving.** The page recalculates and becomes unsaved. Nothing is written until the user saves, and the page's undo steps back over it.
   - **Checked against ResQ.** Step 1 records what ResQ's own button copies. If ResQ copies noticeably less or more, step 5 follows ResQ and says so in its commit.
10. **Macro version.** Steps 2-4 leave the macro's version header alone. Step 6 bumps it once to 3.0.0 (it now creates objects), archives 2.14.0 taken from commit `5e0f4535`, deploys it to the user macro folder and publishes the library.
11. **Deploys run from a commit.** Build with `server-components/deploy.py --ref <commit>` so the other session's uncommitted edits never ship. The standing deploy authorization covers the Bridge. The user's request for an end-to-end test through Arco requires it.

## Open decisions

1. **A ResQ prior-analysis row or Curves column whose values differ from Arco's** (found in step 7; does not block step 8). ResQ refuses any write to a prior-analysis average row ("You cannot set a user value for a read-only average") or a prior-analysis Curves column ("You may not set user entry values on a non-user entry curve"), and a length change clears both to 1.0. The import reads such a row as a User Entry row with ResQ's numbers, so after a length change (made in ResQ or by the export) Arco and ResQ disagree and the export cannot put them back. Should the export turn such a row or column into User Entry and write Arco's values when they differ (losing ResQ's link to the prior analysis), or leave it and name it in the results? Recommendation: turn it into User Entry only when the values differ, since that is how the import already holds it, and say so in the results row. Until then `D 13 - Paid DFM w/ Selected LDFs` in the Fake project's COL class keeps 1.0 in its "Aug 2024" ratio row and Curves column in ResQ, left by step 7's length-change test.

## Plan

Steps 1 → 2 → 3 → 4 run in order. Step 5 depends only on step 1 and may run beside steps 2-4, since it touches only frontend files. Step 6 needs 2-5. Steps 7 and 8 need 6 and both drive the desktop, so they run one after the other.

### Step 1 — Learn how ResQ creates and reconfigures these three methods

**Goal.** Confirm live, in the Fake project, every ResQ call steps 2-5 rely on, and record what ResQ's own "Load Settings From Another Method" copies.

**Read first.**
- This plan's Background and Decisions.
- [resq_reserving_class_export.md](../../../python-api/docs/resq_reserving_class_export.md), the "ResQ COM findings" section.
- [tools/resq_stored_length_probe.py](../../../tools/resq_stored_length_probe.py), as the template for a create / verify / clean-up probe.
- `ResQToolBox2.py` lines 1825 and 2044-2153 under `E:\XWSpace\ResQ API Doc\reference`.
- Memories: `resq-com-probe`, `resq-com-probe-dont-call-blindly`, `resq-custom-average-api`, `resq-dfm-curves-com-api`.
- [GUI Verification](../../../agent-instructions/gui-verification.md).

**Do.**
- [ ] Write `tools/resq_method_config_probe.py`. It connects to the Fake project, works in one reserving class (`PRNJ - PA\PA\All States\Direct Group\COL`), names every object it creates with a `ZZ Probe` prefix, re-reads each result in a fresh connection, and deletes its objects at the end.
- [ ] Confirm creation: `AddMethod` for DFM, BF and Result Selection, then name, output vector name, output dataset type (existing, and one made through `DatasetTypes().Add()`, deleted afterwards), inputs, and `Save`.
- [ ] Confirm DFM reconfiguration:
  - input triangle;
  - origin and development length, in the order ResQ accepts;
  - growing and shrinking `RatioAverageCount`;
  - each `CustomAverages(i)` field for simple, volume, "all", N-period, Ex hi/lo, user-entry, calculated-formula and benchmark rows, and what `AverageFormula(i)` reads back after `Name` / `ResetName()`;
  - that selections, exclusions and Curves survive or reset after each of these.
- [ ] Confirm BF: latest (triangle and vector), percentage-developed type and dataset, and priors. Test whether the prior collection can hold several vectors with weights and how weights are written. If it cannot, record that only the single `Prior` works.
- [ ] Confirm Result Selection: `RemoveDataset` of a loaded dataset, re-adding it, whether the order of `Dataset(i)` can be controlled, and weights after a remove.
- [ ] In the ResQ GUI, run "Load Settings From Another Method" on a probe DFM from another DFM, and compare every setting through COM before and after. Also compare `LoadMethod` from COM. Record exactly what is copied and what is kept. Close every ResQ edit form you open with Cancel unless the test needs OK.
- [ ] Add a "Creating and reconfiguring methods" section to [resq_reserving_class_export.md](../../../python-api/docs/resq_reserving_class_export.md) with each confirmed call, its argument order, every refusal met, and the Load Settings finding. If a finding contradicts a Decision, add it to "Open decisions" with a recommendation and stop.

**Tests.** The probe itself is the test. Run it twice to prove it cleans up after itself, and paste its summary into the doc section.

**Done when.** The doc section answers every question above from a live run, the probe leaves no `ZZ Probe` object behind in ResQ, and the tool and doc are committed.

Estimate: code edit 30 min, test/validation 30 min, total 60 min. Actual: code edit 11 min, test/validation 11 min, total 22 min; under half because the stored-length probe was a ready template and the COM calls mostly behaved as documented, and the ResQ-window Load Settings check could not run (the Remote Desktop screen was not drawing) and moved into step 7.

### Step 2 — The export brings an existing DFM's input, lengths and average rows in line with Arco

**Goal.** Exporting an existing DFM makes its ResQ input triangle, lengths, output type and average formula rows match Arco before the existing value writes run.

**Read first.**
- Decisions 5 and 7, and the step 1 section of [resq_reserving_class_export.md](../../../python-api/docs/resq_reserving_class_export.md).
- The macro's DFM half, [lines 522-901](../../../python-api/macros/export_reserving_class_to_resq.py#L522-L901).
- [dfm.py](../../../python-api/migration/resq_migration/dfm.py) lines 300-620, the import translation.
- [test_export_reserving_class_macro.py](../../../python-api/tests/test_export_reserving_class_macro.py): its fake COM classes and `ExportMacroAverageFormulaTests`.
- The tests that cover `dfm.py`'s average translation (grep `python-api/tests` for `_translate_resq_average_formula`).
- Memories: `python-test-runner`, `macro-must-not-depend-on-app-arcrho-api`.
- Added during the step: `_export_result_delta` in [sync_session.py](../../../python-api/migration/resq_migration/sync_session.py) (around line 942), which decides the results-window message, and the `resq_migration.dfm` import list in [resq_data_migration.py](../../../python-api/migration/resq_data_migration.py), since the exporter reaches the migration helpers through that module.

**Do.**
- [x] In `dfm.py`, add the inverse of the import translation. Given Arco's average-formula block, it returns per row the ResQ definition: name, AverageType, WeightType, PeriodsIncluded, ExcludeHighLow2, and a Formula whose quoted row labels become `Average(<row>)`. Map benchmark and User Entry rows exactly as the import reads them back.
- [x] In the macro, add one step that runs first in `_export_dfm`. It writes the output type, input triangle and lengths, sets `RatioAverageCount` to Arco's row count, and writes each row's definition. It writes only what differs, and the row-label map is rebuilt afterwards. Move `_probe_dfm_averages` after it, so a formula this step fixes no longer skips the DFM.
- [x] Report the structure changes in the DFM's success message, for example "rows 13 → 12, input changed".
- [x] Update the DFM paragraph of the export doc.

**Tests.**
- A round-trip test in `python-api/tests`: Arco rows → ResQ definitions → the import's reader → the same Arco settings, for every row kind in the step 1 findings.
- Macro tests with the fake DFM: a DFM with too many rows, too few, a changed row type, a calculated formula referencing other rows, a changed input triangle, and changed lengths in both directions.
- Run both test modules plus `test_resq_sync_session.py`.

**Done when.** Those tests pass, and a probe-style check against a `ZZ Probe` DFM in the Fake project (created and then deleted inside the step) shows its rows read back through the import equal to the Arco rows it was given.

Estimate: code edit 40 min, test/validation 20 min, total 60 min. Actual: code edit 16 min, test/validation 4 min, total 20 min; a third of the estimate because the import's own row reading could serve as the "already current" test, and the step 1 probe's helpers made the live ResQ check one script that passed on its first run.

### Step 3 — The export brings an existing BF's inputs and a Result Selection's loaded datasets in line with Arco

**Goal.** Exporting an existing BF writes its inputs and priors, not just its Notes. Exporting a Result Selection also removes the datasets Arco does not hold.

**Read first.**
- Decisions 5 and 6, and the step 1 doc section.
- The macro's BF and Result Selection writers, [lines 903-976](../../../python-api/macros/export_reserving_class_to_resq.py#L903-L976) and [1160-1259](../../../python-api/macros/export_reserving_class_to_resq.py#L1160-L1259).
- [sync_session.py](../../../python-api/migration/resq_migration/sync_session.py) lines 80-100, 958-1080 and 2340-2415.
- `export_bornhuetter_ferguson` and `export_result_selection` in [extractors.py](../../../python-api/migration/resq_migration/extractors.py).
- `SyncSessionExportTests` in [test_resq_sync_session.py](../../../python-api/tests/test_resq_sync_session.py).
- Added during the step: the BF branches of `_preflight_method_export` and `_verify_method_export` in [sync_session.py](../../../python-api/migration/resq_migration/sync_session.py) (around lines 1340 and 1505), because the Sync macro's apply phase calls the same BF writer and checks percentage-developed type 2 and prior 1; and the snapshot and create helpers of [tools/resq_method_config_probe.py](../../../tools/resq_method_config_probe.py), which the live check reuses.

**Do.**
- [x] In the session, take BF out of `_SAVE_ONLY_METHOD_CODES` and dispatch it to `export_bfs`. Keep the review-row override so BF stays tickable.
- [x] Extend `_export_bf` with the output type and every Arco prior with its weights, in the form step 1 confirmed. Keep latest, percentage developed and origin length, and match the percentage-developed type the import reads.
- [x] In `_export_result_selection`, write the output type and remove every ResQ dataset whose name Arco's `loaded_datasets` lacks, before re-reading indexes for the weights.
- [x] Update the BF and Result Selection paragraphs of the export doc and the save-only list.

**Tests.**
- Macro tests: a BF whose latest, percentage-developed source and priors all differ; a BF with two priors.
- Result Selection tests: one extra and one missing dataset.
- A session test: a BF row now goes to `export_bfs`, and CC and B&S SR still go to `save_method`.

**Done when.** The tests pass, and a `ZZ Probe` BF and Result Selection in the Fake project, changed on the ResQ side and then written from a hand-built Arco payload, read back through the import equal to that payload.

Estimate: code edit 35 min, test/validation 15 min, total 50 min. Actual: code edit 12 min, test/validation 5 min, total 17 min; a third of the estimate because the DFM step had already built the pattern (resolve, write only what differs, report the changes) and the step 1 probe's helpers made the live ResQ check one script that passed on its first run.

### Step 4 — The export creates a DFM, BF or Result Selection that ResQ does not have yet

**Goal.** A DFM, BF or Result Selection held only by Arco can be ticked in the export review, is created in ResQ with Arco's settings, and shows "Created in ResQ".

**Read first.**
- Decisions 1-4 and 8, and the step 1 doc section.
- [sync.py](../../../python-api/migration/resq_migration/sync.py#L180-L215).
- The sync_session ranges named in step 3, plus `export_reserving_class` (line 2825) and the baseline helpers (lines 2718-2790).
- [resq_transfer_review.py](../../../python-api/src/arcrho_api/resq_transfer_review.py#L100-L140).
- [resq_reserving_class_transfer_review.md](../../../python-api/docs/resq_reserving_class_transfer_review.md).
- How Arco's dataset-type definitions are read (grep `dataset_types.json` under `python-api/migration/resq_migration`).
- Added during the step: the export-review override in `_transfer_row` of [sync_session.py](../../../python-api/migration/resq_migration/sync_session.py) (around line 2404), which offered every Arco-only save-only method (a Cape Cod too) and had to be limited to methods ResQ holds; `_export_result_delta` (around line 960) and the `export_reserving_class` result loop, which carry the "Created in ResQ" message; and `export_result_table_payload` in the macro, whose header now counts created methods.

**Do.**
- [x] `transfer_support`: for the export direction, an Arco-only DFM, BF or Result Selection is supported with the reason "Creates the method in ResQ." Everything else ResQ lacks stays refused. The import direction and the Sync macro are unchanged.
- [x] The macro gains one create path used by the three writers when the lookup finds nothing:
  - check the required inputs exist (else skip, naming the missing input);
  - find or create the output dataset type (Decision 3);
  - `AddMethod`, name the method and its output, set the required inputs, `Save`;
  - clear the name caches, then continue into the step 2 / step 3 update path so the rest of the settings are written the same way.
- [x] Rewrite `_missing_in_resq` and its comment so plain datasets are still never created.
- [x] The result row for a created method says "Created in ResQ" and the counts gain a `methods_created`.
- [x] Check the export baseline records a created method, so the next review compares timestamps for it instead of calling it new again.
- [x] `resq_transfer_review._export_plan_cell`: `presence == "arcrho"` with support reads "Created in ResQ" (tone info).
- [x] Update the export doc and the transfer-review doc ("Arco only" rows for these three kinds can now be ticked).

Notes from the step:
- Creating is switched on by the export session only (`create_missing_methods` on the exporter); the Sync macro's apply phase drives the same writers and still creates nothing.
- The output vector is named by Arco's output dataset name (`details_tab.output_dataset`, falling back to `details_tab.name`), so a DFM whose output name differs from its method name pairs with Arco's row at the next review. For BF and Result Selection the two names are always the same, as Decision 4 says.
- A new dataset type takes the method's `decimal_places` (0 when the method has none), because Arco's dataset-type library holds no decimal places.
- The result outcome stays `exported` with the message "Created in ResQ." and a `created` flag, rather than a new outcome, so the released macro, which shows an unknown outcome as a failure, renders it correctly in the gap between the Bridge deploy and the macro publish.

**Tests.**
- A sync test: the three kinds are tickable when ResQ lacks them, and a dataset and a CC are not.
- Session order: a BF created in the same batch after the DFM it reads.
- Macro tests for each create path: a missing input skip, a missing dataset type created, and a missing category skip.
- The renderer label test.

**Done when.** The tests pass, and a probe run creates a DFM, a BF on it and a Result Selection loading both from hand-built Arco payloads in the Fake project, reads them back equal through the import, then deletes them.

Estimate: code edit 45 min, test/validation 20 min, total 65 min. Actual: code edit 11 min, test/validation 5 min, total 16 min; a quarter of the estimate because steps 2 and 3 had already built every setting write, so creating a method was one small path in front of them, and the live ResQ check passed on its first run.

### Step 5 — A DFM can copy every setting from another DFM in one click

**Goal.** The Arco DFM Details tab has a "Load Settings From Another Method" button that copies another DFM's settings (Decision 9) onto the open one.

**Read first.**
- Decision 9 and the step 1 Load Settings finding.
- [FRONTEND_AGENT_GUIDELINES.md](../../../frontend/FRONTEND_AGENT_GUIDELINES.md).
- The `arcrho-ui-design` skill.
- [dfm.html](../../../frontend/ui/method_pages/dfm/dfm.html#L39-L144), `dfm_details.js`, `dfm_method_api.js`, and the parts of `dfm_persistence.js` that build the payload and `saveDfmTemplate`.
- `openReservingClassPicker` in `frontend/ui/shared/components/pickers/reserving_class_picker.js`.
- The DFM page's undo and dirty-state helpers: `dfm_ratio_history.js` (the undo stack, Ratios-tab only until this step) and the undo routing in `dfm_tabs_orchestrator.js`; `applyDfmOwnedPatchPayload` and the preview scheduling in `dfm_persistence.js`.
- The method-index response shape: rows are named by output dataset in `name`, `method_name` appears only when it differs, `status` is 0 or 2 (`shared/dataset/review_status.js`).
- Memories: `frontend-node-test-suite`, `arcrho-dev-ui-cache-restart`, `concise-ui-message-copy`.

**Do.**
- [ ] Add the button to the Details tab in the section ResQ puts it: below the lengths.
- [ ] Build the picker: a reserving-class tree for the current project and the selected class's DFMs, from the existing method-index route. The open DFM is excluded. Reuse existing picker pieces rather than writing a new tree.
- [ ] Load the chosen DFM through the existing load route and apply the copied settings to the page state as one undoable edit. Recalculate through the existing preview, and mark the page unsaved. Keep the name, output type, input triangle and Notes. Copy exclusions only where origin and development labels match.
- [ ] Put the settings projection (what is copied and what is kept) in one small module with its own tests.
- [ ] Bump the `?v=` stamps of every importer of a changed module, and add a release fragment if the frontend guidelines ask for one.

**Tests.** Node tests for the projection: rows, selections, curves, lengths, exclusions with matching and non-matching labels, and identity kept. Run the frontend Node suite against the baseline failures the memory names.

**Done when.** The tests pass and the button, picker and copy work in a mock render or dev-mode check. The full GUI check is step 8.

Estimate: code edit 50 min, test/validation 20 min, total 70 min. Actual: code edit 21 min, test/validation 12 min, total 33 min; under half because the owned-patch preview and the embedded reserving-class tree already did the heavy lifting, so the step was one small projection module, a dialog and a method-level undo step.

### Step 6 — The new export reaches every user

**Goal.** The Bridge runs the new export, and the macro is published at 3.0.0.

**Read first.**
- Decisions 10 and 11.
- [Component Deployment Authorization](../../../agent-instructions/component-deployment-authorization.md).
- AGENT_GUIDELINES "Component Build and Deploy".
- [python-api/macros/README.md](../../../python-api/macros/README.md).
- Memories: `remote-component-deploy`, `bridge-restart-after-deploy`, `shared-macro-library-deploy`.

**Do.**
- [x] Copy the macro at commit `5e0f4535` to `python-api/macros/backup/export_reserving_class_to_resq/2.14.0/`.
- [x] Set the header to `Version: 3.0.0` with a one-line release note, and refresh its Description.
- [x] Commit, then confirm the newest build-listener heartbeat names `E:\XWSpace\Repos\ArcRho-buildbot`.
- [x] Run `python server-components/deploy.py --ref <that commit>`, letting the CLI pick the stale components, and check its payload holds only this plan's files.
- [x] Verify each deployed component as the authorization doc says. For the Bridge, check it is running again and check `apps.bridge.auto_create_instance`.
- [x] Copy the active macros to `C:\Users\xwei.PRCINS\Documents\ArcRho\macros` and run `python publish_macro_library.py` from `python-api/macros`.

Notes from the step:
- Only the Bridge was deployed (1.7.3, from commit `103247d2`). The CLI also listed the Engine, Gateway and Credential as stale, but for them this plan changed only the review-window label, which runs in the app; the rest of their staleness is another session's committed Excel-picker read (`dd95aafe`), which is theirs to deploy. The Bridge build still carries that commit's additive `latest_project` field, which the Bridge never serves.
- After the deploy only xwei's Bridge and worker came back. jhou's, JZhang's and JZhu's Bridges were stopped by the deploy and did not return within four minutes, because none of them has an Orchestrator running on the server; each needs to reopen their Arco session (see the `bridge-restart-after-deploy` memory).
- The library publish used `--only export_reserving_class_to_resq.py`. Six other macros hold committed versions the library lacks (mostly the 2026-09-18 product rename); they are not this plan's, so they stay unpublished. The ResQ migration support bundle is always republished with a macro, so it now matches `HEAD`, the same code the new Bridge runs.

**Tests.** Macro metadata tests (`frontend/tests/flight_deck.test.mjs` and `python-api/tests/test_publish_macro_library_support.py`). Deploy exit code 0. The deployed Bridge's bundled macro equals the committed file.

**Done when.** The Bridge heartbeat is fresh with the new build, and the shared library lists the macro at 3.0.0.

Estimate: code edit 10 min, test/validation 20 min, total 30 min. Actual: code edit 1 min, test/validation 11 min, total 12 min; under half because the Bridge build reused its warm slot (17 files changed, one minute) and the header bump was a three-line edit.

### Step 7 — The export is checked end to end in Arco and ResQ

**Goal.** Prove in the real GUIs that the export creates missing methods and restores changed settings, and fix what it finds.

**Read first.**
- [GUI Verification](../../../agent-instructions/gui-verification.md) and the screen tool [README](../../../tools/agent_screen_control/README.md).
- Memories: `arcrho-launch-electron-detached`, `desktop-input-control-works`, `bridge-worker-claim-identity`, `resq-export-order-diagnosis`.
- The step 1 doc section.
- Added during the step: the method save and load routes (`frontend/app_server/api/dfm_method_router.py`, `bornhuetter_ferguson_router.py`, `result_selection_router.py`, each a plan then a save carrying its fingerprint) and `/datasets/cached/delete`, used to make and remove the `ZZ E2E` methods; the exporter's `_sync_dfm_curves` and `_sync_dfm_average_rows`, to judge what the comparison found.

**Do.**
- [x] Launch Arco in dev mode detached and open the Fake project in a Project Instance window on class `PRNJ - PA\PA\All States\Direct Group\COL`.
- [x] Create in Arco a new DFM on a triangle ResQ holds (Project Instance "Add DFM"), a BF on that DFM with a prior, and a Result Selection loading the new DFM and BF. Give them `ZZ E2E` names. The screen tool cannot type yet, so set a name or a value through the app-server routes when the GUI needs typing, and say so in the report.
- [x] In ResQ, change an existing DFM's average rows and lengths, an existing BF's latest or prior, and an existing Result Selection's loaded datasets, through the GUI where it needs no typing and through COM otherwise.
- [x] Run the Export macro from the Arco GUI, tick the new and changed methods, and export.
  - Confirm the review shows the new rows as tickable.
  - Confirm the results window lists them as created or exported, with no failure.
- [x] In the ResQ GUI, open each new and changed method and screenshot its Details, Ratios or Method tab to compare with Arco.
- [x] Carried over from step 1: run `py -3.10 tools/resq_method_config_probe.py --gui-setup`, use the ResQ Details tab's "Load Settings From Another Method" on `ZZ Probe GUI Target` from `ZZ Probe GUI Source`, save it in ResQ, then run `--gui-compare` and `--cleanup`. Record in the export doc's "Load Settings From Another Method" section whether the button copies what `LoadMethod` copies.
- [x] Confirm through COM that every setting matches Arco's JSON.
- [x] Run the Review macro (or the import preview) to confirm no remaining setting differences for these methods.
- [x] Fix any defect found, with a test, commit it, and redeploy as in step 6 (patch-bump the macro and republish if it changed). Record each defect in this step's user note.
- [x] Clean up: delete the `ZZ E2E` methods in both Arco and ResQ, confirm the changed ResQ methods match Arco again, and delete screenshots under `temp/`.

**Tests.** The GUI run itself, and any regression test added for a defect.

**Done when.** One clean export run creates all three methods and restores all three changed ones, confirmed in the ResQ GUI and through COM, with no failure rows.

Estimate: code edit 20 min, test/validation 60 min, total 80 min. Actual: code edit 18 min, test/validation 36 min, total 54 min.

Notes from the step:
- The three `ZZ E2E` methods were made through the app-server save routes (loaded from D 13, D 41 and D 91 and saved under new names on output types no COL vector held), because the screen tool cannot type a name. The ResQ changes (D 13 rows +2, row 2 redefined, lengths 12/12 -> 3/3; D 41 latest to Paid and a second prior D 82; D 91 without D 53) were made through COM. Everything else ran in the GUIs: the Export macro from the Arco Macros panel, the review (the three new rows tickable as "Created in ResQ", the three changed ones "Overwrites newer ResQ copy"), the results window, and each method's tab in ResQ.
- Two clean runs, each "Exported 6, 3 of them created in ResQ; failed 0". D 41 and D 91 came back exactly as before the test. D 13 came back except its prior-analysis "Aug 2024" ratio row and Curves column, which ResQ cleared on the length change and refuses to write; see Open decision 1.
- Defect fixed (`abf9a1cb`, macro 3.0.1, Bridge redeployed from that commit, library republished): the Curves writer skipped every Arco column not typed User Entry, so the created DFM's third Curves column stayed at 1.0 instead of Arco's "Aug 2024" values. The second run carried them.
- The settings check read all six methods back through the import and compared them with Arco's method JSON instead of running the Review macro, which compares values, not settings. What remained is expected: ultimates follow `D 42 - Prior for BF Incurred`, whose Arco values (all 0, changed in Arco on 2026-09-16 and not exported) differ from ResQ's; the import reads only a BF's first prior; ResQ cannot create a prior-analysis Curves column, so the created DFM's reads back as User Entry with Arco's values.
- ResQ's Load Settings button was checked on `ZZ E2E DFM` from `D 23`, because DFMs made through COM do not show in the ResQ window until it reloads; it copies what `LoadMethod` copies (export doc, "Load Settings From Another Method").
- Clean-up: the `ZZ E2E` methods are gone from both sides (Arco COL back to 120 items; ResQ back to 17 DFM, 4 BF, 11 RS, 74 vectors, 260 types), the probe left no `ZZ Probe` object, and `D 92 - Current Qtr Selected`, flagged for review in ResQ after its precedent D 91 changed, was re-saved unchanged and reads OK. The dev-mode Arco window opened for the test is still running.

### Step 8 — Copying DFM settings is checked in the running app

**Goal.** Prove "Load Settings From Another Method" works in Arco dev mode.

**Read first.** Step 7's read-first list, Decision 9, and the step 5 commit.

**Do.**
- [x] In dev mode, open a DFM in class `PRNJ - PA\PA\All States\Direct Group\COL`, click the new button, and pick a DFM in another class with different rows.
- [x] Confirm the rows, selections, lengths and Curves match the source. Confirm the name, input triangle, output type and Notes stay.
- [x] Confirm the page shows unsaved, undo restores it, and a save persists the copy (check the saved method JSON).
- [x] Restore the DFM afterwards: re-copy from its ResQ copy with the Import macro, or save the original settings back.
- [x] Fix any defect with a test and commit.

**Tests.** The GUI run, plus any regression test.

**Done when.** The copy, undo and save all behave as Decision 9 says in the running app, and the test DFM is back to its original settings.

Estimate: code edit 10 min, test/validation 30 min, total 40 min. Actual: code edit 6 min, test/validation 13 min, total 19 min; under half because the dev-mode window from step 7 was still open and no defect turned up.

Notes from the step:
- Target `F 25 - Incurred DFM Bootstrap` in COL (13 average rows, Volume - all selected, one Curves column included, only `F 92 - Current Qtr Selected` downstream); source `C 22 - CWOP DFM w/ Selected LDFs` in `HPPREF\HO+DF\NJ\Legacy\HOL` (10 rows, User Entry then Simple - 5 selected, exclusions in the first two columns, seven Curves periods included, tail from column 6, method Notes present). Both are 12/12, so the length-change path was not exercised in the GUI; step 5's tests cover it.
- Everything ran through the GUI with the screen tool: the button, the picker (class chosen from the Shortcut list, the DFM from the right-hand list), Load, the Ratios, Curves and Notes tabs, Edit > Undo Ratio Change from the Notes tab (the page went back to clean), Edit > Redo, and Save.
- The saved method JSON matched the source in average-row labels, settings, User Entry formulas and values, selections, exclusions (same origin and development labels), and every Curves setting; the name, output type, input triangle, Decimal Places, cell notes and Results choices stayed, and the empty Notes stayed empty although the source has Notes.
- Restore: Edit > Undo after the save brought back the original method, which was saved again. The method JSON then matched a byte copy taken first except its revisions and timestamps and eleven User Entry figures written as `1` instead of `1.0`, the way any page save writes them; its output CSV is byte-identical. `F 92`, flagged for review by both saves, was re-saved unchanged and reads OK, its figures now written without float noise (`52253` for `52252.99999999999`).

## Rough size

Estimated 455 minutes of agent time across 8 steps: 240 minutes of code edits and 215 minutes of tests, checks and deploys. Actual: 193 minutes across the 8 steps.
