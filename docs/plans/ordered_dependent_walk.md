# Ordered single-pass dependent walk

Status: Diagnosed 2026-09-16 on a real save that rewrote 26 objects 54 times; broken into 5 session-sized steps the same day covering the ordered closure, one refresher per object kind, the pass itself, the log and docs, and the measured deploy; the walk-scoped index snapshot that was the cheap half of the fix already shipped 2026-09-16; no decisions open, 2 of 5 done — the ordered closure landed 2026-09-16 as a pure module that names everything a save reaches and sorts it after its precedents, and each of the eight object kinds now has a one-object refresher beside it.
Last updated: 2026-09-16

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | What changed for the user |
| :--- | :--- | :--- | :--- | :--- |
| 1 | The walk works out, up front, everything a save reaches and the order to refresh it in | [x] | 2026-09-16 | Nothing to see yet: the app can now list everything one save affects and put it in the order it has to be redone in. |
| 2 | Every kind of object can be refreshed on its own, without starting a walk of its own | [x] | 2026-09-16 | Nothing to see yet: the app can now bring any one affected object up to date on its own, and say why it could not, instead of starting a chain of its own. |
| 3 | A save refreshes each downstream object exactly once, in that order | [ ] | | |
| 4 | The saving popup and the server log describe the new walk | [ ] | | |
| 5 | Released to the server and timed on the save that started this | [ ] | | |

Overall: 2 of 5 steps done.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Read the sections between here and the Steps before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date and the one-line user note, update the "Overall" count, and update the `Status:` line at the top and this plan's row in [README.md](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.
- Work on a clean tree: the walk is bundled into the Engine, the Bridge and the Gateway, and a working-tree deploy ships whatever else is uncommitted under `frontend/app_server` and `python-api/src`.

## Why

Since the full-chain refresh landed (commit `849b20f9`, 2026-09-16) every eligible save recalculates its whole downstream chain. That is the intended behaviour and this plan keeps it. What it does not keep is *how many times* each object is recalculated on the way.

Traced on 2026-09-16 from the sidecar audit entries of one production reserving class after saving the prior vector of a Bornhuetter-Ferguson method (`C 42a - Prior for BF Reported ex CWOP`; the hosted save took 11.6 s, of which the Bornhuetter-Ferguson wave took 11.1 s):

| Measure | Value |
| :--- | :--- |
| Distinct objects downstream of the save | 26 |
| Rewrites the walk performed | 54 |
| Cost per rewrite, any kind | ~0.2 s |
| Passes over `D 91 - Current Qtr Indicated` and its 13 descendants | 3 (about 3 s each) |

The three passes over the `D 91` subtree came from three different triggers, in this order: the Berquist-Sherman cascade nested under `C 92`'s refresh, `D 31` arriving in the Result Selection loop, and the Berquist-Sherman wave of `C 41`'s cascade after `D 18 - BS Paid DFM` changed. Only the last pass had final inputs; the first two were overwritten. A pass in dependency order does the same 26 objects once.

The cause is structural, not a bug in any one domain. `calculated_dataset_service._recalculate_dependents_impl` runs fixed waves (DFM, linked inputs, calculated, Result Selection, Berquist-Sherman, Bornhuetter-Ferguson, Cape Cod, Bootstrap), and every method wave re-enters `recalculate_dependents` **per refreshed method** (`_refresh_downstream_domains` in each method service; the Result Selection loop does the same per Result Selection). Each nested walk re-runs every stage below it, so any object reachable by more than one path is refreshed once per path, and an object visited before a slower precedent has been refreshed is visited again afterwards.

The cheap half — each nested walk rebuilt the reserving-class index because the walk's own writes had moved the folder signature — was fixed on 2026-09-16 with a walk-scoped snapshot of the existing dataset names (`_existing_dataset_keys_snapshot`). What is left is the ordering.

## What must not change

Verified against the code on 2026-09-16; the steps rely on these, so an implementer who finds one no longer true should stop and record it under "Open decisions".

- Every object downstream of the save is recalculated and republished, values unchanged or not; timestamps, user and audit entries move on every publication (business-logic contract rule 12).
- The review decision stays where it is: `method_review_service.refreshed_status` compares the proposed files with the current publication at commit time and records an OK → Needs Review flip into the walk's `review_flag_collector`; the Saved notice shows that list (`propagation.review_flagged_datasets`).
- A failed refresh keeps its last valid publication, marks the object Needs Review, and blocks its descendants; independent branches continue; the walk's result carries the reasons (`cascade_failure_reasons`, `_summarize_walk_failure`).
- The walk's result shape — `updated`, `skipped`, `dfm_updates`, `result_selection_updates`, `berquist_sherman_updates`, `bornhuetter_ferguson_updates`, `cape_cod_updates`, `bootstrap_updates`, `link_updates`, `review_flagged`, `index_ok`, `index_error` — is read by the save response, the hosted-save log, the queued job status and many tests. Keep it.
- A link-driven input that reads its own descendant (a candidate ultimate reading the Result Selection it feeds) converges instead of looping: today a per-walk visited set refreshes it once. The ordered pass must break such cycles the same way, once, in first-seen order.
- `additional_roots` (several coalesced saves in one walk), `deferred_save_propagation` (the Excel retarget's one flush), `finalize_method_review_status` and `rebuild_index` keep their meaning for the callers in `dependent_propagation_service` and the Engine.
- An Engine-generated precedent stored at another period is still brought to the method's period by `precedent_cache_service` inside the per-object refresher; nothing in the ordering touches that.
- The transport is untouched: the Engine still runs the walk inline for hosted saves and as a queued `ArcRhoRefreshDependents` job for refresh flows.

## Design

One module, `frontend/app_server/services/dependent_walk_service.py`, owns the pass. Everything domain-specific stays in the domain services, exposed as one refresher per object kind.

1. **Closure.** From the roots, follow two edge sources the walk already reads today: each sidecar's `dependents` list (`dataset_sidecar_status_service.entry_names`) and the dataset-type formula graph restricted to instances that exist in the class (`_existing_downstream_keys`, now served from the walk-scoped snapshot). Read each sidecar once into a walk-scoped cache; Result Selection's `_dependency_subgraph` is the model, including its node cap.
2. **Order.** Kahn's algorithm over the closure's edges. A node is ready when every precedent of it that is *inside the closure* has been visited. A cycle (only links can make one) is broken by visiting its first-seen node with what has been refreshed so far, once — the same result the visited set gives today.
3. **Refreshers.** Each kind gets one function `refresh_output(project, class, name, sidecar, changed_precedents, caches)` that republishes that one object and returns the same per-object dict its `_refresh_one` returns today, with no nested cascade: DFM (`dfm_service._refresh_one`), Result Selection (`_refresh_one_method`), Berquist-Sherman, Bornhuetter-Ferguson, Cape Cod, Bootstrap (their `_refresh_one`), calculated datasets (`recalculate_dataset`), link-driven inputs (`dataset_link_refresh_service.refresh_dataset_links`). A plain input dataset that is neither is passed through: it is a node the walk crosses so later methods are reached, never rewritten.
4. **The pass.** For each node in order: if any precedent in the closure failed, record it blocked (`upstream_calculation_failed` / "Precedent refresh failed: …") and mark it Needs Review as today; otherwise call its refresher with the precedents refreshed earlier in this walk as `changed_precedents`. Fill the result buckets by kind so the shape above is unchanged. Emit the progress callback per object with the domain name as the stage, so the popup and the stage-timing line keep working. Rebuild the index once at the end when `rebuild_index` is set.
5. **The old entry points.** `calculated_dataset_service.recalculate_dependents` keeps its signature and calls the pass. Each domain's `refresh_dependents` keeps its signature for its external callers (the ResQ import, the public API, the refresh routes) and becomes the pass restricted to roots of that domain, so there is one traversal in the codebase, not seven.

Expected result on the traced save: 26 refreshes instead of 54, so roughly half the time, on top of what the index snapshot already saved.

## Steps

### Step 1 — the ordered closure

Files: new `frontend/app_server/services/dependent_walk_service.py` (closure and order only, no writes), new `frontend/tests/test_dependent_walk_order.py`.

- Build the closure from the two edge sources and return the nodes in order with, for each node, its kind (from `method_type` / `source_kind` / the formula graph) and its precedents inside the closure.
- Cycle handling as in the Design; a node cap like Result Selection's `MAX_REFRESH_GRAPH_NODES`, raising the same wording.
- Tests on synthetic sidecar folders: a chain, a diamond, the traced shape above (assert `D 91` sorts after `D 18`, `D 18` after the B&S adjustment, the adjustment after `C 92`), a link cycle, a root with no dependents, and a missing sidecar on a non-root node (an error, as today).

Done when: the function is pure, the tests pass, and no existing test changed.

Landed 2026-09-16 as `dependent_walk_service.ordered_closure(project, class, roots, *, sidecar_snapshot=None, dataset_type_rows=None)`, which returns a `WalkClosure` of `WalkNode(key, name, kind, method_type, precedents, is_root)` in dependency order; `closure.refresh_order` drops the saved roots, and a node's `precedents` are closure keys, so the pass intersects them with what it has already refreshed to get `changed_precedents` (that intersection is also what makes a broken cycle use only what is final).

### Step 2 — one refresher per object kind

Files: `dfm_service.py`, `result_selection_service.py`, `berquist_sherman_service.py`, `bornhuetter_ferguson_service.py`, `cape_cod_service.py`, `bootstrap_service.py`, `calculated_dataset_service.py`, `dataset_link_refresh_service.py`; their existing test files.

- Add `refresh_output(...)` to each, a thin wrapper over the existing per-object function that takes the sidecar write lock, publishes, and returns the per-object dict; on an exception it marks Needs Review and returns `{"ok": False, "reason": …}` instead of raising, so the pass can block descendants uniformly.
- Do not remove the nested cascades yet; nothing calls the new functions until step 3.
- One test per domain that calls `refresh_output` directly and asserts the same files, status and audit entry the domain's `refresh_dependents` produces for one object.

Done when: every domain has the function, the new tests pass, and every existing test still passes unchanged.

Landed 2026-09-16 as `refresh_output(project_name, reserving_class, dataset_name, sidecar=None, changed_precedents=(), caches=None)` in all eight services, one signature for every kind. `caches` is the walk-scoped cache dict: each domain keeps its own entry in it through `dependent_walk_service.walk_cache`, and drops what a just-republished object owns through `forget_cached`, because the domains do not normalise a dataset name the same way and a cached precedent must never outlive its publication. The six method domains take the sidecar write lock, re-read the sidecar inside it, call their own `_refresh_one` with no `blocked_precedent_keys` — the pass decides what is blocked — and on a failure mark the output Review Needed before returning `{"ok": False, "reason": ...}`. Calculated datasets and link-driven inputs carry no review flag of their own, so their failures come back as the same `calculation_error` and `link_error` steps the waves record today, which is what blocks their descendants.

### Step 3 — the pass

Files: `dependent_walk_service.py`, `calculated_dataset_service.py` (`_recalculate_dependents_impl` replaced; `recalculate_dependents`, `preview_dependents`, `cascade_failure_reasons` kept), the six method services (`refresh_dependents` delegating, `_refresh_downstream_domains` deleted), `frontend/tests/test_calculated_dataset_runtime.py`, `test_method_review_service.py`, `test_engine_hosted_saves.py`, the six domain test files.

- Implement the pass as designed, filling the existing result buckets.
- Delete the per-method nested cascade from every domain and the wave orchestration from `_recalculate_dependents_impl`; the link visited set and the review-flag collector move into the pass.
- Re-pin only the tests that asserted wave mechanics; tests that assert outcomes (what was written, what was blocked, what stayed green) must pass unchanged — they are the behaviour guarantee.
- Add a replay test with the traced shape that counts refresher calls per object and asserts exactly one each, in order, and that a failure in `D 18` blocks the 14 objects below it and nothing else.

Done when: the full `frontend/tests` Python suite is at its baseline (see the agent memory for the known failures), the replay test passes, and `grep -rn _refresh_downstream_domains frontend/app_server` finds nothing.

### Step 4 — popup, log and docs

Files: `server-components/src/arcrho_engine/save_jobs.py` (`_walk_stage_timing`, `_inline_walk_summary`) and `server-components/tests/test_save_jobs.py`; `frontend/docs/app_server/domains/dependent_propagation.md`; `frontend/docs/contracts/business_logic_contract.md` (rules 10, 12 and 15 describe wave order — say "dependency order" and name this plan); `frontend/docs/ui/dataset.md`; a release fragment under `frontend/changes/unreleased/`.

- The stage-timing line in `hosted_saves.log` keeps its shape; a domain's time is now the sum of its objects' refreshes, and the line gains the object count (`walk refreshed 26 of 26 reachable`).
- The popup's progress text keeps naming the object being refreshed.
- `python tools/docs_index_builder.py --write` and `--check` from `frontend/`.

Done when: the Engine tests pass, docs check passes, the fragment validates.

### Step 5 — deploy and measure

Files: none in the repository except this plan.

- `python server-components/deploy.py` (Engine, Bridge and Gateway all bundle `frontend/app_server`; the Gateway's payload also carries `frontend/ui`, so the tree must be clean).
- Save the same prior vector in the same reserving class the diagnosis used (the owner knows which; the agent memory `propagation-walk-nested-cascade-cost` records it), read the new line in `E:\ArcRho Server\runtime\logs\hosted_saves.log`, and count the audit entries the walk appended (the script technique is in the same memory). Record both figures next to the 11.6 s / 54 rewrites baseline in this plan's Status line.

Done when: the count is 26 and the total is well under the baseline; if either is not, stop and record why under "Open decisions" rather than tuning.

## Open decisions

None. Two choices were made while writing this plan and are recorded so nobody reopens them by accident:

- The pass emits progress per object with the domain as the stage name, rather than a new progress shape, so the client poller, the popup and the stage-timing line keep working without a client release.
- Cycles are broken by visiting the first-seen node once, which is exactly what the per-walk visited set does today; no attempt is made to iterate a cycle to a fixed point.

## Code evidence

- [calculated_dataset_service.py](../../frontend/app_server/services/calculated_dataset_service.py): `_recalculate_dependents_impl` is the staged walk; `recalculate_dependents` is the wrapper that opens the link visited set, the review-flag collector and the existing-names snapshot; `_existing_downstream_keys` / `_dependency_map` give the formula-graph edges; `recalculate_dataset` refreshes one calculated dataset.
- [result_selection_service.py](../../frontend/app_server/services/result_selection_service.py): `_dependency_subgraph` and `_assert_acyclic_dependency_subgraph` already build and check the closure from sidecar edges; `refresh_dependents` nests `recalculate_dependents` per updated method; `_refresh_one_method` is the per-object refresher.
- [bornhuetter_ferguson_service.py](../../frontend/app_server/services/bornhuetter_ferguson_service.py), [cape_cod_service.py](../../frontend/app_server/services/cape_cod_service.py), [berquist_sherman_service.py](../../frontend/app_server/services/berquist_sherman_service.py), [bootstrap_service.py](../../frontend/app_server/services/bootstrap_service.py), [dfm_service.py](../../frontend/app_server/services/dfm_service.py): each has `_refresh_one` and a `refresh_dependents` loop that calls `_refresh_downstream_domains` after every method it refreshes.
- [dataset_link_refresh_service.py](../../frontend/app_server/services/dataset_link_refresh_service.py): `refresh_dataset_links` refreshes one link-driven input; `_refresh_link_driven_dependents` in the calculated service is the wave around it with the visited-set cycle guard.
- [method_review_service.py](../../frontend/app_server/services/method_review_service.py): `refreshed_status` and `review_flag_collector`.
- [dependent_propagation_service.py](../../frontend/app_server/services/dependent_propagation_service.py): `_run_inline_save_propagation` builds the save response from the walk result; `_collect_refreshed_dataset_names` reads the top-level buckets.
- [save_jobs.py](../../server-components/src/arcrho_engine/save_jobs.py): `_walk_stage_timing` and `_inline_walk_summary` write the log line; [dependent_propagation.py](../../server-components/src/arcrho_engine/dependent_propagation.py) runs the queued form of the same walk.
- The diagnosis, the audit-entry technique and the exact three triggers are recorded in the agent memory `propagation-walk-nested-cascade-cost`.
