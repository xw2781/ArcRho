# A recalculated formula vector keeps its vector period

Status: Found 2026-09-29 while checking [calculated_walk_precedent_freshness.md](completed/calculated_walk_precedent_freshness.md) in the Fake project; broken into 4 session-sized steps, none started.
Last updated: 2026-09-29

Ship impact: steps 1-3 change what the Engine, Gateway and Bridge write, and step 4 deploys them. No app release is needed. Risk to the released app: none — every reader it has already expects a vector's period under `period_length`, and this fix makes the recalculation write it there again.

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | A recalculated formula vector keeps the period it is shown at | [ ] | | 40 min | | |
| 2 | Every part of the app writes a vector's period the same way | [ ] | | 40 min | | |
| 3 | Formula vectors already written the wrong way are repaired | [ ] | | 30 min | | |
| 4 | Released to the server and checked in the Fake project | [ ] | | 35 min | | |

Overall: 0 of 4 steps done. Estimated 145 min, actual so far 0 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in the [plans index](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.
- Project data: test only in `NJ_Annual_Prod_202605_Fake`. Do not read or change `NJ_Annual_Prod_2026 Q3-Aug` or any other project without the user's permission in that session.

## What happens

A dataset sidecar records its **display** shape in one of two layouts, chosen by its format (`arcrho_api.sidecar_core_contract`, see [dataset.md](../../frontend/docs/app_server/domains/dataset.md)):

- a **triangle** carries `origin_length`, `development_length`, `cumulative`, `calendar`;
- a **vector** carries `period_length` only, beside its stored `stored_period_length`.

When a save's dependent walk recalculates an app-calculated dataset, `_recalculate_dataset_impl` in [calculated_dataset_service.py](../../frontend/app_server/services/calculated_dataset_service.py) (payload built around line 1834) always writes the triangle layout, whatever the format. A recalculated vector therefore loses `period_length` and gains four fields a vector never carries. Every other producer writes the vector layout:

- the Engine runtime, `_apply_dataset_sidecar_shape_fields` in [arcrho_runtime_service.py:1296](../../frontend/app_server/services/arcrho_runtime_service.py#L1296);
- a dataset save, [dataset_service.py:2556-2575](../../frontend/app_server/services/dataset_service.py#L2556-L2575), and a new empty dataset, [dataset_service.py:1324-1330](../../frontend/app_server/services/dataset_service.py#L1324-L1330);
- the ResQ import, [extractors.py:1610-1613](../../python-api/migration/resq_migration/extractors.py#L1610-L1613).

So four producers write one file and one of them disagrees, against the Persisted JSON Producer Parity rule in `AGENT_GUIDELINES.md`. The vector rule itself is written out three times (runtime, and twice in `dataset_service`).

`validate_period_lengths` does not catch it: it compares a vector's display period with its stored one only when `period_length` is present.

A second, smaller defect sits beside it: `_existing_target_settings` ([calculated_dataset_service.py:1113](../../frontend/app_server/services/calculated_dataset_service.py#L1113)) reads only `origin_length`, so for a vector that is still written correctly it answers 12 whatever the vector's period. The vector branch of `recalculate_dataset` does not use it (it takes the finest existing cache period), but the other callers (lines 1162 and 2242) do.

### What users see

- **A display choice is lost.** F 63 shown at 12 months and saved records `period_length: 12` over a quarterly store. The next walk rewrites the sidecar without it, and the window reopens at the file's own period.
- **Readers that ask for a vector's period get nothing.** The dataset details load ([dataset_service.py:1679-1681](../../frontend/app_server/services/dataset_service.py#L1679-L1681)), the save response ([dataset_service.py:2768-2770](../../frontend/app_server/services/dataset_service.py#L2768-L2770)) and the Result Selection source list ([result_selection_service.py:519](../../frontend/app_server/services/result_selection_service.py#L519)) read `period_length` only and answer `None`.
- **Values are right.** The class index falls back to `origin_length` (`dataset_index_contract`, line 664), so the Project Instance table shows the right period, which is why nobody noticed.

### How far it has spread

On 2026-09-29 the Fake project held 84 calculated vector sidecars: 77 in the vector layout (written by the ResQ import) and 7 in the triangle layout, the ones a walk has rewritten since, for example D 31 in `PRNJ - PA\PA\All States\Direct Group\COL` (2026-09-23) and F 63 and G 23 in `PRNJ - PA\PA\MA\Direct Group\BI Total` (2026-09-29). Every walk adds more.

## Approach

- **One rule, one owner.** Add a function to `arcrho_api.sidecar_core_contract` that applies a display shape to a sidecar payload by format — for a vector it sets `period_length` and removes `origin_length`, `development_length`, `development_count`, `cumulative`, `calendar`, `stored_origin_length`, `stored_development_length` and the linked development field; for a triangle it sets the four triangle fields and removes `period_length` and `stored_period_length`. It is the rule the runtime and the dataset save already apply, moved to the contract so every producer calls it.
- **Keep the user's display period.** The walk writes a vector at its finest cache period (the stored shape). The display period it records is the one the existing sidecar already holds when that is a whole multiple of the new stored period, and the stored period otherwise — the same rule `validate_period_lengths` enforces.
- **No new fallback.** Readers are not changed to fall back to `origin_length` for a vector; the writers are fixed and the existing files are repaired (step 3).

## Open decisions

- **Refuse the triangle layout on a vector in validation.** Once step 3 has repaired the existing files, `validate_period_lengths` could reject a vector carrying `origin_length`, so a future producer cannot regress silently. Recommended: yes, as a follow-up after this plan, not inside it, because other projects are repaired only when someone runs step 3's tool against them.
- **Full-payload parity for calculated vectors.** The walk writer and the ResQ import also differ outside the shape (the import writes `source`, `origin_labels`, `development_labels`, `notes`). Recommended: a separate plan; this one fixes the shape fields only.

## Rough size

Estimated 145 minutes of agent time across 4 steps: 80 minutes of code edit and 65 minutes of test, validation and deploy.

## Plan

Step 1 comes first. Step 2 needs step 1's contract function. Step 3 needs step 1 (it uses the same function). Step 4 follows all three. Steps 2 and 3 are independent of each other.

### Step 1 — The walk writes a vector's period under `period_length`

**Goal.** A recalculated calculated vector's sidecar carries `period_length` (the user's display period when it still fits) and none of the triangle fields; a triangle is written as today.

**Read first.** "What happens" and "Approach" above; [sidecar_core_contract.py](../../python-api/src/arcrho_api/sidecar_core_contract.py) `stored_length_fields` (line 167) and `validate_period_lengths` (line 411); [calculated_dataset_service.py](../../frontend/app_server/services/calculated_dataset_service.py) `_existing_target_settings` (line 1113) and the payload in `_recalculate_dataset_impl` (around line 1834); the runtime's rule in [arcrho_runtime_service.py:1296-1326](../../frontend/app_server/services/arcrho_runtime_service.py#L1296-L1326) as the model. Skill `arcrho-json-contract`.

**Do.**
- [ ] Add the display-shape function to `sidecar_core_contract` (name it for what it does, for example `apply_display_length_fields(payload, data_format, origin, development, *, cumulative, calendar)`), exported in `__all__`.
- [ ] Build the walk's payload through it; for a vector, take the display period from the existing sidecar's `period_length` when it is a whole multiple of the new stored period, else the stored period.
- [ ] `_existing_target_settings` reads a vector's `period_length` for both lengths.
- [ ] Update the calculated-output paragraph of [dataset.md](../../frontend/docs/app_server/domains/dataset.md) (line 84) in one sentence.

**Tests.** A new case in `frontend/tests/test_calculated_dataset_runtime.py` (or the module that already drives `_recalculate_dataset_impl`): a vector recalculated at 3 over a sidecar showing 12 keeps `period_length: 12`, has `stored_period_length: 3` and no `origin_length`/`development_length`/`cumulative`/`calendar`; a vector showing 2 over a new store of 3 falls back to 3; a triangle output is unchanged. A unit test of the contract function in `python-api/tests`.

**Done when.** The tests pass, and the new test fails on the old writer.

Estimate: code edit 25 min, test/validation 15 min, total 40 min.

### Step 2 — Every producer uses the one rule

**Goal.** The Engine runtime and the dataset save call the contract function instead of their own copies, and a test pins the four producers to the same shape fields.

**Read first.** Step 1's contract function; [arcrho_runtime_service.py:1296-1326](../../frontend/app_server/services/arcrho_runtime_service.py#L1296-L1326); [dataset_service.py:1324-1330](../../frontend/app_server/services/dataset_service.py#L1324-L1330) and [2556-2575](../../frontend/app_server/services/dataset_service.py#L2556-L2575); [extractors.py:1590-1615](../../python-api/migration/resq_migration/extractors.py#L1590-L1615). Skill `arcrho-json-contract`.

**Do.**
- [ ] Replace the three copies of the vector/triangle rule with the contract function; no behaviour change.
- [ ] Have the ResQ import's vector payload use it too, or, if the migration cannot import it at that point, leave it and let the parity test pin it.

**Tests.** One cross-producer test (in `frontend/tests`, beside the existing sidecar contract tests) that writes the same logical vector through the runtime writer, the dataset save, the walk writer and the migration builder and asserts identical shape fields (`data_format`, `period_length`, `stored_period_length`, and the absence of every triangle field); the same for a triangle. The existing runtime, dataset-save and migration suites still pass.

**Done when.** No copy of the rule is left outside the contract (a search for the obsolete-key list finds only the contract), and the parity test passes.

Estimate: code edit 25 min, test/validation 15 min, total 40 min.

### Step 3 — Repair tool for sidecars already written the wrong way

**Goal.** A one-off tool finds calculated vector sidecars in the triangle layout and rewrites them in the vector layout; run on the Fake project.

**Read first.** Step 1's contract function; an existing one-off repair tool under `tools/` for the pattern (for example `tools/migrate_dataset_link_blocks.py`); `arcrho_api.io.persisted_json_text`; memory `agent-share-listing-blocked-use-python`.

**Do.**
- [ ] `tools/repair_calculated_vector_sidecars.py <project>`: dry run by default, listing each file and the change; `--write` applies it through the contract function and `persisted_json_text`, taking the display period from `origin_length` and the stored one from `stored_period_length`, and leaves everything else in the file as it is.
- [ ] Run it on `NJ_Annual_Prod_202605_Fake` (dry run, then `--write`), and record the count in this plan. Other projects are the user's to run.

**Tests.** `tools/tests/test_repair_calculated_vector_sidecars.py` with a temporary folder under `test/`: a triangle-layout vector is repaired, a correct vector and a triangle are untouched, a second run changes nothing.

**Done when.** A dry run on the Fake project after `--write` reports nothing to repair.

Estimate: code edit 20 min, test/validation 10 min, total 30 min.

### Step 4 — Deploy and check in the Fake project

**Goal.** The fix is live and a walk no longer loses a vector's period.

**Read first.** [component-deployment-authorization.md](../../agent-instructions/component-deployment-authorization.md); [gui-verification.md](../../agent-instructions/gui-verification.md); memory `fake-ma-bi-total-f63-test-class` and `build-listener-down-local-build`.

**Do.**
- [ ] `python server-components/deploy.py` (Engine, Gateway and Bridge bundle the app server); if it exits 3 on the Server PC, use the local `build_exe.py` fallback from the memory note and delete `server-components/builds` and `venvs` afterwards.
- [ ] In Arco, Fake project, `PRNJ - PA\PA\MA\Direct Group\BI Total`: open F 63, set Origin Length to 12, save; open P 06 and save it with no edit; reopen F 63 and confirm it opens at 12 and its sidecar holds `period_length: 12`, `stored_period_length: 3` and no `origin_length`. Save screenshots under `temp/` for the user.

**Tests.** The GUI check above.

**Done when.** F 63 reopens at 12 after the walk and `deploy.py --stale` reports every component up to date.

Estimate: code edit 0 min, test/validation 35 min, total 35 min.
