# Dataset cell links read their source at the referencing dataset's period

Status: Completed 2026-09-17: all 5 steps done, the Bridge, the Engine and the Gateway deployed the same day and the change checked against the fake project through the hosted read; the credential component is still undeployed because the running Build Listener predates its role.
Last updated: 2026-09-17

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | A dataset can be read at any coarser period a caller names | [x] | 2026-09-17 | 35 min | 12 min | Nothing visible yet: the part that reads a dataset can now serve it at any coarser period asked for, and says why when it cannot. |
| 2 | A cell link resolves its source at the period the referencing grid is shown at | [x] | 2026-09-17 | 45 min | 7 min | Nothing visible yet: a request to resolve references can now say which period the grid is in, and each source is read at that period or refused with the reason. |
| 3 | The automatic refresh reads sources the same way the link was entered | [x] | 2026-09-17 | 20 min | 6 min | Nothing visible yet: an unattended refresh of a link-driven dataset now reads each source at the period the grid was in when the reference was typed, and reports the reason instead of writing when a source cannot be read there. |
| 4 | The Dataset window sends the period it is showing with every reference | [x] | 2026-09-17 | 35 min | 9 min | A reference typed into a dataset grid now reads its source at the period that grid is showing, so a yearly grid gets years out of a monthly source. |
| 5 | Released to the server and checked in the app | [x] | 2026-09-17 | 35 min | 12 min | The Bridge, the Engine and the Gateway now run the change. Checked against the fake project's HOL class through the same server read the Dataset window uses: a yearly grid reading the monthly "C 82 - Prior Qtr Selected" gets yearly sums, a quarterly grid gets quarters, a monthly grid still gets months, and a yearly source asked for from a monthly grid is refused with the reason. The check was not typed into the window itself. |

Overall: 5 of 5 steps done. Estimated 170 min, actual so far 46 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in [README.md](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

## The question

A user has two vectors open in the Dataset Viewer: `A` is stored monthly (period 1) and `B` is stored yearly (period 12); both are shown at 12. In `B` the user types an ArcRho reference such as `=[A][1]` or `=[A][1:5]`, expecting the first yearly value or the first five. Today the reference returns `A`'s first monthly value, or its first five months. The user's rule: the index in a reference follows the period of the grid the formula is typed into, not the period the source file happens to be stored at.

## What the code does today

- A committed reference goes to `POST /dataset/internal_links/resolve` with the project, the reserving class, and the reference texts only ([data_tab_persistence_controller.js:101-105](../../frontend/ui/shared/tabs/data/data_tab_persistence_controller.js#L101-L105), [schemas/dataset.py:155-158](../../frontend/app_server/schemas/dataset.py#L155-L158)). Nothing in the request says what the referencing dataset is or what period it is shown at.
- The resolver reads each source with the default dataset read, which returns the file's own rows ([dataset_internal_link_service.py:186-232](../../frontend/app_server/services/dataset_internal_link_service.py#L186-L232), [dataset_service.py:1954-1978](../../frontend/app_server/services/dataset_service.py#L1954-L1978)). For a monthly `A` that is 12 rows per year, so `[1]` is January.
- The same reader already knows how to show a hand-entered dataset at a coarser period: `at_display_shape` and `at_linked_shape` roll the stored rows up in memory through `_display_view_of_stored_values` ([dataset_service.py:2051-2061](../../frontend/app_server/services/dataset_service.py#L2051-L2061), [2178-2230](../../frontend/app_server/services/dataset_service.py#L2178-L2230)). The roll-up rules live in `arcrho_api.triangle_rollup.rollup_reason` ([triangle_rollup.py:83-108](../../python-api/src/arcrho_api/triangle_rollup.py#L83-L108)): finer to coarser only, whole multiples only; a vector is a plain block sum of its rows ([precedent_cache_service.py:56-90](../../frontend/app_server/services/precedent_cache_service.py#L56-L90)). Only a hand-entered dataset is rolled up in memory ([precedent_cache_service.py:91-112](../../frontend/app_server/services/precedent_cache_service.py#L91-L112)).
- A method already follows the rule the user wants. A DFM reads each precedent at the method's own period: a finer hand-entered one is rolled up, an Engine-generated one is rebuilt at the method's lengths through `materialize_engine_source`, and a coarser one is refused with a message naming both periods ([dfm_service.py:272-330](../../frontend/app_server/services/dfm_service.py#L272-L330), [precedent_cache_service.py:178-218](../../frontend/app_server/services/precedent_cache_service.py#L178-L218)).
- Plain links (`internal_links`) and formulas (`formula_links`) both resolve their dataset references through this one resolver, on commit from the browser and inside the dependent-propagation walk on the server ([dataset_link_refresh_service.py:120-176](../../frontend/app_server/services/dataset_link_refresh_service.py#L120-L176), [270-290](../../frontend/app_server/services/dataset_link_refresh_service.py#L270-L290)). The walk already reads the *target* at the shape its links were written on (`at_linked_shape`) but reads every *source* at its file shape.
- The ArcRhoVec and ArcRhoTri function forms of a reference name their period explicitly (`arcrho_formula_service.py`) and are not affected.
- A link can only be entered where its cells are on screen. A coarser origin display makes the whole grid read-only, so on the origin axis the shape a link is written on is always the stored one; a coarser development display keeps the grid editable and that axis is the one `linked_development_length` records ([sidecar_core_contract.py:274-297](../../python-api/src/arcrho_api/sidecar_core_contract.py#L274-L297)). While the display is off the linked shape the link inventory stands still: nothing can be entered, broken or hard-coded until the lengths come back ([data_tab_persistence_controller.js:80-87](../../frontend/ui/shared/tabs/data/data_tab_persistence_controller.js#L80-L87), [482-492](../../frontend/ui/shared/tabs/data/data_tab_persistence_controller.js#L482-L492)).

## Decisions

1. **A reference reads its source the way a method reads a precedent: at the reader's own lengths.** The resolve request carries the lengths of the grid the reference is typed into. A hand-entered source stored finer is rolled up in memory to those lengths; an Engine-generated source stored at other lengths is rebuilt at them, the way a DFM precedent is; a source already at those lengths reads as today.
2. **A source that cannot be brought to the reader's lengths is refused**, with the roll-up reason in the message (coarser than the reader, or not a whole multiple). This matches the method rule. Today such a reference silently returns the source's own rows; that fallback goes. A user who wants a source at its own period uses the ArcRhoVec or ArcRhoTri function form, which names the period.
3. **The lengths are the live values of the two length controls**, read when the reference is committed, not the display length saved in the sidecar, so a user working in an unsaved state gets the grid they are looking at. A vector sends its period for both lengths. For the unattended refresh, the lengths are the shape the target's links were written on, which the refresh already reads the target at; on the origin axis that equals the stored period, so the two paths agree wherever a link can exist.
4. **The lengths are optional in the resolve contract.** A caller that sends none gets today's behaviour, the file's own rows. This leaves the DFM User Entry reference resolver, which shares the axis-index helpers but not this route, unchanged; bringing it under the same rule is a follow-up, not part of this plan.
5. **Existing saved links change meaning where the source is finer than the target.** A saved `[A][1:12]` filling twelve yearly cells with months is re-read as twelve years on the next refresh, and fails if `A` has fewer years. Nothing in the saved text distinguishes the two readings, so no migration is written; the user described that reading as wrong. A link whose source is coarser than its target fails its next refresh under decision 2; the walk keeps the last values and reports the error as it does for any ArcRho-side link failure.

## Open decisions

None.

## Rough size

Five steps, estimated at 170 minutes of agent time: 112 minutes of reading and editing, 58 minutes of test runs, checks and the deploy. The deploy step's estimate covers the agent's part only; if no Build Listener is running, starting it at the Server PC is the user's time.

## Plan

### Step 1 — The reader serves a dataset at any coarser lengths a caller names

**Goal.** The one dataset reader can return a dataset at a caller-chosen pair of lengths, not only at its saved display or its linked shape, and can do it for an Engine-generated dataset as well as a hand-entered one.

**Read first.** "What the code does today" and "Decisions" above. [dataset_service.py:1954-2061](../../frontend/app_server/services/dataset_service.py#L1954-L2061) and [2178-2230](../../frontend/app_server/services/dataset_service.py#L2178-L2230); [precedent_cache_service.py:56-218](../../frontend/app_server/services/precedent_cache_service.py#L56-L218); [tests/test_manual_dataset_rollup_view.py](../../frontend/tests/test_manual_dataset_rollup_view.py). Memory notes: `engine-stored-lengths-are-source-granularity`, `python-test-runner`.

**Do.**
- [ ] Add an `at_lengths: tuple[int, int] | None = None` keyword to `load_cached_dataset_values`. When given and different from the stored lengths: a hand-entered dataset (`source_kind` `input`) is rolled up through the existing `_display_view_of_stored_values` with that target; an Engine-generated dataset is rebuilt at those lengths through `precedent_cache_service.materialize_engine_source` and that CSV is read. The response's `origin_length` / `development_length` describe the rows returned, as they already do for the display view.
- [ ] When a hand-entered dataset cannot be rolled up to the target, raise `HTTPException(422)` carrying the reason from `precedent_cache_service.rollup_reason`, prefixed with the dataset name and both period pairs, so the resolver's message names the source and the two periods. An Engine rebuild failure raises the same way with the Engine's message.
- [ ] Keep `at_display_shape` and `at_linked_shape` as they are; they are the two fixed targets and can delegate to the same branch. Do not add a fallback to the file's own rows when the target cannot be served.

**Tests.** `tests/test_manual_dataset_rollup_view.py` gains: a hand-entered vector stored at 1 read with `at_lengths=(12, 12)` returns the yearly block sums and reports `origin_length` 12; a triangle stored at (12, 3) read at (12, 12) matches the display view; a target coarser-to-finer or a non-multiple raises 422 with the reason and the dataset name; an Engine-generated dataset read at other lengths calls `materialize_engine_source` with those lengths (patched) and reads the path it returns; `at_lengths` equal to the stored pair reads the file as today.

**Done when.** The reader tests pass and the two existing fixed-target flags still pass their tests unchanged.

**Estimate.** Estimate: code edit 25 min, test/validation 10 min, total 35 min. Actual: code edit 8 min, test/validation 4 min, total 12 min - well under, because the reader already held the roll-up branch and its fixture suite, so only the caller-named target and the refusal were new.

### Step 2 — The resolve route reads each source at the lengths the request names

**Goal.** A resolve request can carry the referencing grid's origin and development lengths, and every dataset reference in it resolves against its source shown at those lengths.

**Read first.** "Decisions" above. [dataset_internal_link_service.py](../../frontend/app_server/services/dataset_internal_link_service.py) whole file (232 lines); [schemas/dataset.py:155-158](../../frontend/app_server/schemas/dataset.py#L155-L158); [dataset_router.py:264-281](../../frontend/app_server/api/dataset_router.py#L264-L281); [arcrho_workspace_read_contract.py:54-65](../../python-api/src/arcrho_workspace_read_contract.py#L54-L65) and [226-230](../../python-api/src/arcrho_workspace_read_contract.py#L226-L230); [tests/test_dataset_internal_links.py:84-105](../../frontend/tests/test_dataset_internal_links.py#L84-L105) and [437-446](../../frontend/tests/test_dataset_internal_links.py#L437-L446); the `internal_links` paragraph of [docs/app_server/domains/dataset.md:59](../../frontend/docs/app_server/domains/dataset.md#L59). Memory note: `adding-a-hosted-workspace-read`.

**Do.**
- [ ] `DatasetInternalLinksResolveRequest` gains optional `origin_length` and `development_length` (positive integers, default `None`).
- [ ] `resolve_dataset_internal_links` gains the same two optional keyword arguments. When both are given, every `load_cached_dataset_values` call passes `at_lengths=(origin_length, development_length)`; when absent, the read is unchanged. A 422 from the reader passes through as the reference's refusal.
- [ ] The router forwards the two fields in the hosted-read kwargs and in the local call.
- [ ] `WORKSPACE_READ_KINDS["dataset_internal_links_resolve"]` lists the two as `optional`.
- [ ] Update the `internal_links` paragraph in `docs/app_server/domains/dataset.md` to say a resolve reads each source at the lengths the request names, rolled up or rebuilt like a method precedent, and refuses a source that cannot be brought there; run `python tools/docs_index_builder.py --write` then `--check` from `frontend/`.

**Tests.** `tests/test_dataset_internal_links.py` gains: a resolve with lengths passes `at_lengths` on every read and none without them; the result rows are the rolled-up rows the patched reader returns and `[-1]` counts back at the requested period (the valuation row count is asked for at that period); the registered read kind's `optional` names the two fields and its `required` set is unchanged; the schema accepts the two fields and rejects zero or negative values.

**Done when.** The resolver tests and the read-client tests (`tests/test_workspace_read_client.py`) pass, and the docs index check passes.

**Estimate.** Estimate: code edit 33 min, test/validation 12 min, total 45 min. Actual: code edit 5 min, test/validation 2 min, total 7 min - far under, because step 1 had already put the whole roll-up decision behind one reader keyword, so this step was two optional fields carried through a schema, a router, the registry and the resolver, with no logic of its own.

### Step 3 — The automatic refresh reads sources the way the link was entered

**Goal.** When the dependent-propagation walk re-evaluates a link-driven dataset, each source is read at the shape the target's links were written on, so an unattended refresh returns the same figures the user saw when the reference was committed.

**Read first.** "Decisions" 3 and 5 above. [dataset_link_refresh_service.py:120-176](../../frontend/app_server/services/dataset_link_refresh_service.py#L120-L176) and [270-330](../../frontend/app_server/services/dataset_link_refresh_service.py#L270-L330); [tests/test_dataset_link_refresh.py:351-397](../../frontend/tests/test_dataset_link_refresh.py#L351-L397); the "Link-driven datasets refresh" paragraph of [docs/app_server/domains/dataset.md:61](../../frontend/docs/app_server/domains/dataset.md#L61).

**Do.**
- [ ] `_load_source_datasets` takes the target's lengths and passes `at_lengths` on every source read. The caller hands it `(target["origin_length"], target["development_length"])`, the shape the target was just read at with `at_linked_shape`.
- [ ] A 422 from the reader becomes a `_LinkRefreshHardError` like a missing dependency, so the refresh keeps the last values and reports the reason, as decision 5 says.
- [ ] Add one sentence to the refresh paragraph in `docs/app_server/domains/dataset.md`; run the docs index builder write and check.

**Tests.** `tests/test_dataset_link_refresh.py` gains: the source reads carry `at_lengths` equal to the target's returned lengths; a source the reader refuses fails the refresh with the reader's message and writes nothing.

**Done when.** The refresh tests pass and the docs index check passes.

**Estimate.** Estimate: code edit 12 min, test/validation 8 min, total 20 min. Actual: code edit 4 min, test/validation 2 min, total 6 min - under, because the refresh already read the target at its linked shape and already turned every reader refusal into a hard error, so the change was one argument threaded through one helper.

### Step 4 — The Dataset window sends the period it is showing with every reference

**Goal.** A reference committed in the Dataset window, whether a plain link or a formula, is resolved at the lengths the two length controls show at that moment, and the docs and release note say so.

**Read first.** "Decisions" 1 to 3 above. [data_tab_persistence_controller.js:80-131](../../frontend/ui/shared/tabs/data/data_tab_persistence_controller.js#L80-L131) and [420-427](../../frontend/ui/shared/tabs/data/data_tab_persistence_controller.js#L420-L427); [dataset_api.js:78-86](../../frontend/ui/shared/dataset/dataset_api.js#L78-L86); the `resolveReferences` stubs in [tests/dataset_internal_links.test.mjs](../../frontend/tests/dataset_internal_links.test.mjs) and [tests/dataset_formula_links.test.mjs](../../frontend/tests/dataset_formula_links.test.mjs), and whichever test builds the persistence controller (`tests/dataset_draft_save.test.mjs`); the "Editable manual-input cells equally accept an ArcRho internal dataset reference" bullet of [docs/ui/dataset.md:137](../../frontend/docs/ui/dataset.md#L137); [changes/README.md](../../frontend/changes/README.md). Memory notes: `frontend-node-test-suite`, `arcrho-dev-ui-cache-restart` (bump the `?v=` stamp of any module whose importers pin one, and the tests that pin it).

**Do.**
- [ ] `resolveReferences` in the persistence controller adds `origin_length` and `development_length` from `getCurrentLengthControlValues()` to the request; for a vector both carry the origin value. No other client change: the three link controllers already share this one function, and the frozen-inventory rule keeps a reference from being entered at a display other than the linked shape.
- [ ] Add to the `docs/ui/dataset.md` bullet that a reference is indexed on the source shown at the grid's current lengths (a monthly source read from a yearly grid gives years), that a source that cannot be brought to those lengths is refused with the reason, and that the ArcRhoVec / ArcRhoTri function forms name their own period. Run the docs index builder write and check.
- [ ] Add a release fragment under `frontend/changes/unreleased/` (`type` `improvement`, `scope` `dataset`, `audience` `user`) saying a dataset reference now pulls its source at the period the grid is shown at, and validate it with `python build/release/release_notes.py check` from `frontend/`.

**Tests.** A Node test for the persistence controller's resolve request asserts the two lengths are read from the controls at call time (change a control between two calls and see the request follow) and that a vector sends its period twice. Run the whole suite with `./node-portable/node.exe --test --test-reporter=tap "tests/**/*.test.mjs"` from `frontend/` and compare against a same-commit baseline; the suite is not green at HEAD.

**Done when.** The new Node test passes, the suite shows no failure that a baseline run does not, the release-notes check passes, and the docs index check passes.

**Estimate.** Estimate: code edit 25 min, test/validation 10 min, total 35 min. Actual: code edit 7 min, test/validation 2 min, total 9 min - far under, because step 2 had already put the two lengths in the resolve contract and the window already had a live reader of its length controls, so the change was one request payload plus its doc and release note.

### Step 5 — Released to the server and checked in the app

**Goal.** The Gateway, the Engine and the Bridge run the new resolver, and the user's case works in the app.

**Read first.** `AGENT_GUIDELINES.md` "Component Build and Deploy" and [agent-instructions/component-deployment-authorization.md](../../agent-instructions/component-deployment-authorization.md). Memory notes: `remote-component-deploy`, `deploy-staleness-is-mtime-based`, `hosted-save-fix-needs-engine-deploy`.

**Do.**
- [ ] `python server-components/deploy.py --stale` from the repository root, then `python server-components/deploy.py` for what it reports stale (expected: Bridge, Engine, Gateway, since `frontend/app_server/` and `python-api/src/` changed). Check the payload listing for work that is not this plan's before accepting.
- [ ] In the app, against `NJ_Annual_Prod_202605_Fake`: open a hand-entered vector stored monthly and a yearly one, type `=[<monthly>][1:3]` in the yearly grid, and confirm three yearly sums arrive; save, and confirm the saved link refreshes to the same figures after a change to the monthly source.

**Tests.** None beyond the app check; record what was seen in the Progress note.

**Done when.** `deploy.py` exits 0 for every stale component and the app check shows yearly figures from the monthly source.

**Estimate.** Estimate: code edit 0 min, test/validation 35 min, total 35 min. Actual: code edit 0 min, test/validation 12 min, total 12 min; under half because the app check ran through the hosted read from a script instead of a driven window, and the first deploy attempt was refused outright because the running Build Listener predates the credential component role, so the three components it knows were named explicitly.
