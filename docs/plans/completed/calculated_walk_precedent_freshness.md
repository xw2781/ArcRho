# Calculated datasets read a current copy of every input

Status: Diagnosed 2026-09-21 from logs, sidecars and cache-provenance records in `NJ_Annual_Prod_2026 Q3-Aug`; four session-sized steps, none started. The user decided on 2026-09-21 that a failed dependent walk must show its reason in the window that saved (reversing the 2026-08-07 "no message" rule).
Last updated: 2026-09-21

Ship impact: steps 1 and 2 change what the Engine and the Gateway calculate and need both deployed; users on the released app see no difference until then, and nothing in these steps can break a client that has not updated. Step 3 is a client change that ships with the next app release.

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | What changed for the user |
| :--- | :--- | :--- | :--- | :--- |
| 1 | A formula dataset always reads a current copy of each input | [ ] | | |
| 2 | A source-table refresh rebuilds a vector at the period it is shown at | [ ] | | |
| 3 | A save tells the user when a dependent could not be refreshed, and why | [ ] | | |
| 4 | Released to the server and checked on the live class | [ ] | | |

Overall: 0 of 4 steps done.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date and the one-line user note, update the "Overall" count, and update the `Status:` line at the top and this plan's row in [README.md](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.
- Project data: the live class is `PRNJ - PA\PA\NY\Direct Group\BI Total` in `NJ_Annual_Prod_2026 Q3-Aug`, which an agent may open only with the user's permission in that session. `NJ_Annual_Prod_202605_Fake` carries the same dataset types and is the default place to read sidecars.

## What happened

`F 63 - Expected Net Loss % * Earned Premium` is a quarterly calculated vector built from `P 06 Net Loss--Expected Net Loss % of Earned Premium` (hand-entered, quarterly, Excel-linked), `Earned Premium` and `Remaining Budget Premium` (both Engine-generated vectors shown quarterly, whose sidecars name an annual file).

On 2026-09-21 every save of P 06 rewrote F 63 (its timestamp and audit log moved, the walk reported "8 of 8 refreshed"), yet F 63 kept old values. They became correct only after the user re-ran the two premium dataset windows at 14:44 UTC and saved P 06 once more. No message appeared at any point.

The chain, established from `hosted_saves.log`, `source_table_refresh.log`, the class's sidecars, file times and the `.arcrho-cache-provenance` records:

1. On 2026-09-18 18:49 UTC a Project Settings refresh with a new source table (`psrefresh_…`, `import=True`) regenerated every Engine dataset in the class. For each vector it rebuilt only the file the sidecar names, the annual `@12` copy, and the `@3` view beside it kept the pre-import figures.
2. The walk that recalculates F 63 runs at 3-month periods and, for each input, scores every CSV in the class folder. A vector file named `@3` gets a bonus for matching the target period, so `Earned Premium@3.csv` beats the sidecar-named `@12` copy. The 2026-09-18 fix (`_engine_cache_at_target_shape`) then sees a file already at the formula's shape and reads it as it stands. Nothing checks whether that file is current. The provenance record F 63 wrote at 14:44:37 lists `Earned Premium@3.csv`, `Remaining Budget Premium@3.csv` and `P 06 …@3.csv` as the files it read, which pins this path.
3. The dataset window takes a different path: `arcrho_runtime_service.run_arcrho_tri` validates a cached file against runtime provenance whose processing hash includes the source-table signature, so opening Earned Premium at a quarterly display regenerated `@3` (14:44:03) and the next walk read fresh figures.

Two defects, one shared cause: a coarser or finer view file left beside a dataset is trusted by the walk but by nothing else.

- `frontend/app_server/services/calculated_dataset_service.py`, `_candidate_csvs` and the Engine branch of `_load_components`: an existing `@<target period>` sibling of an Engine-generated or hand-entered input wins the scoring and is read without validation. The runtime's own rule (`_is_stale_input_variant`, `_vector_cache_candidates`) is that only the sidecar-named file is current and any other copy is "a view an older release wrote down". The same trap catches hand-entered inputs: a 6-month target would prefer `P 06 …@6.csv`, written by the 2026-09-10 import, over the sidecar-named quarterly copy.
- `server-components/src/arcrho_engine/source_table_refresh.py`, `_regeneration_request`: the display shape is read from `origin_length` and `development_length`, which a vector sidecar does not carry (it states `period_length`), so every Engine vector is regenerated at 12 months whatever period it is shown at. That is why Earned Premium is shown quarterly while its sidecar names `Earned Premium@12.csv`.

The earlier fix of 2026-09-18 (`0e9c28a5`, deployed 2026-09-20) is correct for the case it covers, an input with no file at the formula's period, and stays.

## Why the change is safe

Verified against the code on 2026-09-21; an implementer who finds one of these no longer true should stop and record it under "Open decisions".

- `precedent_cache_service.materialize_engine_source` already brings an Engine input to any shape through `run_arcrho_tri`, which reuses a cached file only when its provenance (identity, processing hash including the source-table signature, file fingerprint) matches and regenerates it otherwise. The DFM, Berquist Sherman and dataset-window paths rely on it today. Routing the walk through it adds one provenance check per Engine input per walk, on the Engine's local disk.
- `precedent_cache_service.rollup_rows` already rolls a hand-entered input up from its sidecar-named copy, and `_component_at_target_shape` in the walk calls it; only the candidate choice before it is wrong.
- F 63 and every other calculated vector run at their finest existing period and write the coarser views by rolling their own result up (`_rollup_calculated_vector`), so the walk's output files are not affected by this change.
- The dependent walk reports a failed input as a named failure of the dependent (`Failed to read dependency …`), the summary reaches the client in the completed payload's `message`, and the client already receives it; only its display is missing.

## Plan

### Step 1 — A formula dataset always reads a current copy of each input

Make the walk resolve an `engine` or `input` precedent through the file its sidecar names, then bring it to the formula's shape the way the methods do.

- In `_candidate_csvs`, once a candidate's sidecar is known and its `source_kind` is `engine` or `input`, keep only the sidecar-named file for that dataset; the `@<target>` name bonus must not apply to those kinds. A `calculated` or method-output sidecar keeps today's scoring.
- In `_load_components`, an `engine` input whose sidecar-named file is not at the target shape goes through `materialize_engine_source` (already there); an `input` one goes through `_component_at_target_shape` (already there). Delete `_engine_cache_at_target_shape` only if the sidecar-named rule makes it unreachable; otherwise leave it.
- Phrase the failure of an input that cannot be produced at the formula's shape as the method services do: `<input> could not be generated at <n> months: <engine reason>`.
- Tests in `frontend/tests/test_calculated_component_stored_shape.py` and `test_calculated_dependency_folder_scan.py`: a stale `@3` sibling beside an Engine vector's `@12` copy is ignored and the Engine is asked for the `@3` shape; a stale `@6` sibling beside a hand-entered quarterly vector is ignored and the quarterly copy is rolled up; the existing "no file at the formula's period" case still materializes.

Done when: the three tests pass, the earlier test of `0e9c28a5` still passes, and the failure text names the input and the period.

### Step 2 — A source-table refresh rebuilds a vector at the period it is shown at

- In `_regeneration_request`, take a vector's shape from `period_length` (both lengths) and fall back to 12 only when neither field is present. Triangles keep `origin_length` / `development_length`.
- Test in `server-components/tests`: a vector sidecar with `period_length: 3` and no `origin_length` produces a request at 3 months and the `@3` cache path.

Done when: the test passes and a refresh over a class whose premium vectors are shown quarterly regenerates `@3` files and leaves the sidecars naming them.

### Step 3 — A save tells the user when a dependent could not be refreshed, and why

Reverses the 2026-08-07 owner decision recorded in `frontend/docs/app_server/domains/dependent_propagation.md` and in the `trackSavePropagation` comment; the user asked for this on 2026-09-21.

- In `frontend/ui/shared/services/dependent_propagation_job.js`, the completed-inline branch of `trackSavePropagation`: when `propagation.ok` is false, show `propagation.message` through `showPageMessageBox` (title "Dependent updates", warn tone) before resolving null; the queued branch does the same with the job's terminal message. Keep the null resolution so the save window still stays open and the table's Review Needed flags still refresh.
- Keep the copy short: the message the server already composes, nothing added (see the concise-UI rule in memory).
- Update the domain doc and the code comment; add a test beside the existing `dependent_propagation_job` tests that a failed inline outcome opens the message box with the server text and a clean one does not.

Done when: saving P 06 in a class whose Earned Premium cannot be produced at F 63's period shows one box naming F 63, the input and the period, and a clean save shows nothing new.

### Step 4 — Released to the server and checked on the live class

- `python server-components/deploy.py` (Engine and Gateway become stale from steps 1 and 2).
- With the user's permission for `NJ_Annual_Prod_2026 Q3-Aug`, and reading metadata only: save P 06 in NY BI Total and confirm the new F 63 provenance record lists the sidecar-named or freshly rebuilt input files; run a scoped source refresh and confirm `Earned Premium@3.csv` is rewritten and F 63's walk that follows it reads the rewritten file.

Done when: both checks hold and the Status line says so.

## Open decisions

- Whether a refresh or a dataset save should delete the stale `@n` view files an older release left beside an Engine or hand-entered dataset. Step 1 makes them harmless to the walk; removing them is cleanup with behaviour risk for any reader not yet audited (the `dataset_service` stored-shape reads are still unaudited, see memory), so it is not part of this plan unless the user asks.
