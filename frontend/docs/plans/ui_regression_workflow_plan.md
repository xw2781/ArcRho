# UI Regression Workflow Plan

Version: v1.0
Last updated: 2026-08-04

## Summary

A reusable, agent-runnable pre-release workflow that exercises the ArcRho UI against the
`NJ_Annual_Prod_202605_Fake` project, verifies load/save behavior, captures screenshots for visual
review, and emits one report per run marking every section `PASS`, `FAIL`, `REVIEW`, `SKIP`, or
`BLOCKED`.

The design goal is **token economy through determinism**: everything that can be decided by a
script is decided by a script. An agent is spent only on the judgment that scripts cannot make —
visual/UX inspection of captured screenshots, and the final narrative. A full run should cost a
small, roughly constant number of agent tokens regardless of how many assertions execute.

ArcRho already ships most of the transport this needs. `POST /ui_automation/commands` is a
localhost long-poll RPC queue, and `ui/shell/ui_automation.js` is a live executor inside the running
shell. This plan builds on that bus rather than introducing Playwright, Puppeteer, or CDP.

### Why not Playwright/Puppeteer/CDP

- The repo has no browser-automation dependency and uses a bundled portable Node
  (`frontend/node-portable/`) on machines that are not expected to have global Node or network
  installs. Adding a heavyweight driver is a supply and maintenance cost.
- Electron is never launched with `--remote-debugging-port`, so CDP would require a launch-path
  change anyway.
- The automation bus already reaches the exact objects a test needs (shell tab state, Project
  Instance windows, method pages) with **zero new dependencies** and no credentials —
  `require_local_client` is a peer-IP check only (`app_server/api/local_client.py`).

The bus is the right substrate. It needs commands added, not replacing.

## Architecture

Three layers, deliberately ordered cheapest-first. A failure in a lower layer short-circuits the
layers above it for that section, so a broken build fails fast instead of burning a full UI sweep.

### Layer A - Headless contract checks (script only, no app window)

Pure Python over the app-server HTTP API and on-disk JSON. No Electron, no screenshots, no agent.
This is where most regressions are caught, in seconds.

| Check | What it proves |
| --- | --- |
| `A1` index integrity | Every reserving-class `index.json` in the fixture parses, carries the current canonical version, and is served without rewrite (per the root `AGENTS.md` index contract). |
| `A2` method load/save round-trip | For a sampled set of the 569 fixture methods: `POST /<method>/load`, re-`save` the unmodified payload, assert the file is byte-identical. Catches producer drift, field-projection changes, and revision-hash instability. |
| `A3` persisted JSON text format | Every file written during `A2` conforms to `arcrho_api/io.py` `persisted_json_text` - notably 2D arrays one row per line. |
| `A4` cross-producer parity | Frontend app-server writer vs `python-api/migration/` writer for the same logical inputs, including path-alias independence. |
| `A5` route inventory freshness | `python tools/docs_index_builder.py --check`. |
| `A6` release fragment validity | `python build/release/release_notes.py check`. |
| `A7` unit/contract suite | `node --test tests/` plus `python -m unittest discover -s tests -p "test_*.py"`. |

`A2` mutates the fixture. The runner guards every mutating step with a **per-file byte snapshot**
taken immediately before the write and restored at scenario teardown. This is precise and cheap -
a whole-project copy of ~2,658 JSON files is not needed.

### Layer B - Driven UI scenarios (script only, live app)

A Python harness posts commands to `/ui_automation/commands` against the running Electron app and
walks a declarative scenario. Each step is deterministic; each checkpoint writes a structured
snapshot JSON and a PNG. No agent involvement.

Scenario execution is strictly serial because the shell's `pollLoop` executes one command at a
time (`ui/shell/ui_automation.js:844-870`). The harness must therefore own the app for the run.

### Layer C - Visual and UX review (agent, bounded)

The agent is handed only:
1. Screenshots on the curated *visual review* list, and
2. Screenshots whose Layer B structural snapshot changed versus baseline.

It judges layout, alignment, spacing, truncation, contrast, and obvious UX breakage against
`$arcrho-ui-design`, and returns a verdict per image. This is the only agent cost in a run.

## Test Project

`NJ_Annual_Prod_202605_Fake` on the ArcRho Server workspace. Measured scale:

| Item | Count |
| --- | --- |
| Reserving classes | 31 (20 carry methods) |
| Dataset sidecars | 2,089 |
| Method files | 569 total - DFM 341, RS 137, BF 75, BSSR 10, BSCRA 6 |
| Cape Cod methods | **0** |

A full sweep of 569 methods through the UI is not feasible per release, and most of those objects
are near-duplicates of one another. Coverage is therefore driven by a **curated test inventory**:
a checked-in, human-editable list of representative objects, seeded by the agent and owned jointly
with the user.

### Test inventory

`frontend/tests/ui_regression/test_inventory.json` records, per reserving class, which datasets and
methods are worth exercising. Each entry names the *group* it represents, so one object stands in
for a family of similar ones.

```json
{
  "version": 1,
  "reserving_classes": [
    {
      "path": "PRNJ - PA\\PA\\NJ\\Direct Group\\BI Total",
      "entries": [
        { "kind": "method", "type": "DFM", "name": "Quarterly DFM Claim Counts--CWOP",
          "group": "dfm/quarterly/claim-counts", "represents": 14,
          "reason": "Quarterly origin with ratio columns; widest grid in this class",
          "source": "agent", "enabled": true },
        { "kind": "dataset", "name": "ALAE--as % of Gross Paid Loss",
          "group": "dataset/engine/ratio", "represents": 31,
          "reason": "Engine-sourced ratio triangle; exercises formula hydration",
          "source": "human", "enabled": true, "pinned": true }
      ]
    }
  ],
  "excluded": [
    { "path": "...", "kind": "method", "name": "...", "note": "flaky chart render, tracked separately" }
  ]
}
```

### How the list is built and maintained

An **inventory builder** mode has the agent survey a reserving class, cluster its datasets and
methods by shape (source kind, data format, origin/development length, method type, column
structure), pick one representative per cluster, and record why. Groups it has already covered are
skipped, so repeat runs converge instead of churning.

Merge rules exist to make the list jointly owned without either side clobbering the other:

- The builder may **only append**. It never edits or removes an existing entry.
- `source: "human"` and `pinned: true` entries are untouchable - the builder does not re-cluster
  around them or drop them when its own heuristics change.
- `enabled: false` is the way to switch an entry off while keeping it visible in diffs. The runner
  skips it; the builder treats it as already-covered and will not re-propose that group.
- The `excluded` list is a tombstone set. Anything listed there is never re-proposed, which is what
  makes a deletion stick - without it the next build would silently re-add whatever was removed.

The user can hand-edit the file at any time: add an object the agent missed, delete one that is not
worth the wall-clock, or pin one that must never be dropped. The file is plain JSON with stable key
ordering so edits produce clean diffs.

Every run still covers **every method type** at least once regardless of inventory contents, and
adds any object whose owning code changed since the last release tag. The inventory controls
breadth within a type, not whether a type is tested at all.

Agents may read on-disk metadata JSON for this project only. Any other ArcRho Server project
requires explicit per-session permission (root `AGENTS.md`, Agent Project Data Access).

### ResQ as an oracle

The same-named ResQ project is reachable read-only through
`win32com.client.Dispatch("ResQ3Automation.ResQApplication")`
([resq_client.py:50](../../../data-engine/src/arcrho_bridge/resq_client.py#L50)) using the
`arcrho_bridge` virtual environment. Comparing ArcRho method output against ResQ for the same
reserving class is the strongest available regression oracle, but COM is slow and prone to
transient failure. It is therefore an **opt-in Layer A extension** (`A8`), sampled to a handful of
methods, and never allowed to fail the run - only to raise `REVIEW`.

## Scenario Specification

Scenarios are JSON under `frontend/tests/ui_regression/scenarios/<section>.json`. Declarative, so
the runner stays a fixed interpreter and new coverage costs no code.

```json
{
  "section": "dfm",
  "title": "Development Factor Method",
  "risk": "high",
  "requires": ["project:NJ_Annual_Prod_202605_Fake"],
  "steps": [
    { "op": "shell.openTab", "args": { "type": "project_instance", "project": "NJ_Annual_Prod_202605_Fake" } },
    { "op": "projectInstance.selectPath", "args": { "path": "PRNJ - PA\\PA\\NJ\\Direct Group\\BI Total" } },
    { "op": "shell.waitForIdle" },
    { "op": "projectInstance.openDataset",
      "args": { "name": "Claim Counts--CWOP", "openMethod": true, "methodType": "DFM" } },
    { "op": "shell.waitForIdle" },
    { "op": "page.snapshot", "as": "dfm_loaded" },
    { "op": "assert", "args": { "snapshot": "dfm_loaded", "path": "grid.columnCount", "op": "gt", "value": 0 } },
    { "op": "assert", "args": { "snapshot": "dfm_loaded", "path": "errors", "op": "empty" } },
    { "op": "ui.captureScreenshot", "args": { "name": "dfm-loaded", "review": true } },
    { "op": "page.action", "args": { "control": "dfm.selectionMode", "value": "volume-weighted" } },
    { "op": "page.snapshot", "as": "dfm_dirty" },
    { "op": "assert", "args": { "snapshot": "dfm_dirty", "path": "tab.isDirty", "op": "eq", "value": true } },
    { "op": "page.action", "args": { "control": "dfm.save" }, "guardFile": true },
    { "op": "page.snapshot", "as": "dfm_saved" },
    { "op": "assert", "args": { "snapshot": "dfm_saved", "path": "tab.isDirty", "op": "eq", "value": false } },
    { "op": "shell.closeTab", "args": { "match": "dfm" } }
  ]
}
```

Step vocabulary:

| Op | Purpose |
| --- | --- |
| `shell.openTab` / `activateTab` / `closeTab` / `listTabs` | Tab lifecycle and enumeration |
| `shell.waitForIdle` | Block until the active page reports its data load settled |
| `projectInstance.selectPath` | Put the Project Instance page in a deterministic state |
| `projectInstance.openDataset` | Open a dataset or method window |
| `page.snapshot` | Capture structured render state (see below) |
| `page.action` | Drive an allowlisted logical control (semantic path) |
| `page.locate` | Resolve a logical control to a window-relative rect |
| `ui.sendInput` | Real mouse/keyboard event through Chromium hit-testing (physical path) |
| `ui.captureScreenshot` | Write a PNG; `review:true` adds it to the Layer C list |
| `assert` | Compare a snapshot path to a literal or to baseline |
| `ui.dismissDialogs` | Teardown safety net |

`page.snapshot` returns a stable, presentation-independent structure - deliberately excluding
timestamps, user names, and generated ids so it can be diffed across builds:

```json
{
  "page": "dfm",
  "tab":  { "id": "dfm_3", "title": "...", "isDirty": false },
  "grid": { "rowCount": 12, "columnCount": 13, "columnHeaders": ["12","24","..."],
            "selectedCells": [], "totalsRow": ["..."] },
  "tabs": ["Factors", "Summary", "Notes", "Links"],
  "controls": { "dfm.selectionMode": "volume-weighted", "dfm.tailFactor": "1.000" },
  "errors": [], "warnings": []
}
```

## Human-Like Control And Live Observability

Two distinct concerns that are easy to conflate: *how faithfully the harness drives the app*, and
*what a human can see while it runs*.

### Driving: two paths, deliberately kept separate

| Path | Mechanism | Use for |
| --- | --- | --- |
| **Semantic** (`page.action`) | Calls the page's own handler through the automation bus | Bulk assertions across sampled methods. Fast, stable, coordinate-free. **Default.** |
| **Physical** (`page.locate` + `ui.sendInput`) | `webContents.sendInputEvent()` injects into Chromium's real input pipeline | A curated "human path" per surface, and anywhere hit-testing is the point. |

The physical path matters because it goes through **real hit-testing**. It catches regressions the
semantic path is blind to by construction: a control that renders but sits under an overlay, a
click target collapsed to a few pixels, a `z-index` change that makes a button unreachable, a
sticky header covering the first grid row.

The pattern is **locate semantically, click physically**: `page.locate("dfm.save")` returns a
window-relative rect derived from `getBoundingClientRect()` plus the iframe's offset, and
`ui.sendInput` then clicks those coordinates for real.

`sendInputEvent` injects into the renderer only - it does **not** move the OS cursor. That is
desirable here: no focus stealing, no interference from other windows, safe unattended.

**Do not convert everything to the physical path.** Coordinate-driven input is measurably more
fragile: rects shift with window size, scroll position, and virtualized grid rows. Running 569
sampled methods through synthetic input would trade a large amount of stability for faithfulness
that only matters on a handful of interactions per surface. Keep both.

### Watching: pointer overlay

A `position: fixed; pointer-events: none` overlay owned by the shell document, animated between
locate targets so a human can follow what the harness is doing. Feature pages are same-origin
iframes beneath the shell, so a single overlay covers all of them. It cannot paint over native
Electron dialogs or OS context menus.

Two hard requirements:

1. Travel animation is gated behind `ARCRHO_UI_TEST_VISUALIZE=1`. Unattended runs skip it and stay
   fast; demo and debugging runs turn it on.
2. The overlay **must be hidden for the duration of `ui.captureScreenshot`**, or the cursor glyph
   lands in every baseline and every subsequent run diffs against it.

### Watching: inspection window

The inspector is hosted by **the runner**, not by the app under test.

That placement is the whole point. If the console lived inside the ArcRho app, it would die with
the app - and a scenario that crashes, hangs, or restarts the app is exactly when a human most
needs to see what step was executing. The runner is also the only process that knows the current
scenario and step index.

Implementation: the runner opens a stdlib `http.server` on its own port and streams
Server-Sent Events (`text/event-stream` - no dependency required). The inspector is a small
always-on-top window pointed at that port. It survives app restarts by design.

Displays:

- Current section, scenario, and step index, with the step's op and arguments
- Running pass / fail / review tally
- Last assertion detail - expected versus actual
- Thumbnail of the most recent screenshot

Because the runner owns the execution loop, **pause-on-failure** costs almost nothing: the run
halts with the app frozen in the failing state so a human can inspect the real UI, then resume,
step, or abort. This is the highest-value capability in this section - post-hoc screenshots rarely
explain *why* something failed, and a live frozen app usually does.

## Report

One directory per run under `frontend/test_artifacts/ui_regression/<run_id>/`:

```
report.md              human-readable, section table first
report.json            machine-readable, same data
screenshots/<section>/<name>.png
snapshots/<section>/<name>.json
diffs/<section>/<name>.diff.json      structural diff vs baseline
logs/run.log
```

`report.md` opens with the table the release decision is actually made from:

| Section | Layer A | Layer B | Layer C | Verdict | Notes |
| --- | --- | --- | --- | --- | --- |
| Shell & tabs | 4/4 | 12/12 | 2 ok | `PASS` | |
| Dataset Viewer | 6/6 | 18/18 | 1 flagged | `REVIEW` | Totals row alignment shifted |
| DFM | 9/9 | 22/23 | 3 ok | `FAIL` | Save did not clear dirty state |
| Cape Cod | 0/0 | - | - | `BLOCKED` | Not wired into shell or Project Instance |

Verdict meanings:

- `PASS` - every assertion passed and no screenshot was flagged.
- `FAIL` - at least one assertion failed. Blocks release.
- `REVIEW` - assertions passed but a screenshot changed or the agent flagged a visual concern.
  **Needs a human.**
- `SKIP` - section deselected for this run.
- `BLOCKED` - the section could not run (missing wiring, unavailable dependency). Blocks release
  only if the section is on the release-critical list.

## Sections

Ordered by regression risk. Risk reflects complexity, cross-cutting reach, and recent churn.

| # | Section | Risk | Notes |
| --- | --- | --- | --- |
| 1 | Shell & tabs | high | Tab lifecycle, dirty state, close handshake, floating windows, state restore |
| 2 | Project Instance | high | Path tree, dataset table, context menus, temporary view, window management |
| 3 | Dataset Viewer | high | Grid, totals, origin labels, number formats, notes, links, audit log, chart |
| 4 | DFM | high | Largest method surface; 341 fixture instances; RPC bridge |
| 5 | Result Selection | high | Chart, details, known refresh/data races |
| 6 | Bornhuetter Ferguson | medium | Load/save/refresh, grid alignment |
| 7 | Berquist-Sherman | medium | Recently aligned with ResQ; 16 fixture instances |
| 8 | Cape Cod | medium | **In flight.** Not wired into shell or Project Instance today |
| 9 | Project Settings | medium | Source data, processing rules, duplicate job, shell progress |
| 10 | Workflow | medium | save / load / save_as compatibility |
| 11 | File Explorer & history | low | |
| 12 | Task Designer & macros | low | Already has automation handlers |
| 13 | Cross-cutting | medium | Theme, number-format defaults, user identity, preference scopes |

## Tools To Build

Nothing here is speculative - each entry closes a gap found while surveying the current code.

### Phase 1 - Foundation (makes a smoke run possible)

| # | Tool | Effort | Target |
| --- | --- | --- | --- |
| `T1` | Screenshot capture | small | `ipcMain.handle("window-capture-page", ...)` wrapping `webContents.capturePage()` in `electron/main.js`; expose `captureWindow` in `electron/preload.js`; add `ui.captureScreenshot` to `executeAutomationCommand` (`ui/shell/ui_automation.js:781`); wrap as `arcrho_api.ui.capture_screenshot()`. **Nothing in the Electron host can produce an image today.** |
| `T2` | `shell.*` commands | small | `shell.listTabs` / `openTab` / `activateTab` / `closeTab` branches in `ui/shell/ui_automation.js`. The underlying functions are already registered on the `shell` object - this is dispatch wiring only. |
| `T3` | `projectInstance.selectPath` | small | Handler in `ui/project_instance/project_instance_messages.js` beside the existing context handler. Without it, every `projectInstance.*` command fails until a human clicks a path. |
| `T4` | Determinism guards | small | `ui.dismissDialogs`; `POST /ui_automation/commands/{id}/cancel` so a timed-out command cannot execute against the *next* scenario. |
| `T5` | Deterministic launch profile | small | Honor `ARCRHO_WINDOW_SIZE` and `ARCRHO_COLOR_THEME` in `electron/main.js`, and suppress `saveMainWindowPrefs` during a test run so the harness does not mutate user prefs. Required for stable screenshots. |
| `T6` | UI-ready marker | small | `app_endpoint.json` appears when the *backend* is ready, well before the window paints. Write a sibling marker on `did-finish-load` so the harness never screenshots the splash. |
| `T7` | Artifact dir hygiene | small | Add `test_artifacts` to `EXCLUDED_DIRS` in `tools/docs_index_builder.py` and to `.gitignore`, or every run breaks the docs gate. |
| `T8` | Runner + report writer | medium | New `frontend/tests/ui_regression/` package: scenario loader, stdlib-only HTTP client, snapshot comparer, Markdown/JSON report writer. |
| `T9` | Entry points | small | `"test"` and `"test:ui"` scripts in `package.json`; a `build/prerelease_check.bat` bundling fragment check + docs check + tests. |
| `T10` | Synthetic input | medium | `ipcMain.handle("input-send-event", ...)` wrapping `webContents.sendInputEvent()`; `ui.sendInput` command taking window-relative coordinates plus click/move/key/scroll. Phase 1 covers raw coordinates and shell-owned controls; per-page `page.locate` arrives with `T13`. |
| `T11` | Pointer overlay | small | `position: fixed; pointer-events: none` cursor layer owned by the shell document, animated between targets when `ARCRHO_UI_TEST_VISUALIZE=1`. **Must be hidden for the duration of `ui.captureScreenshot`** or it contaminates every baseline. |
| `T12` | Inspector console | medium | Runner-hosted stdlib `http.server` streaming Server-Sent Events, plus a small always-on-top viewer window. Shows current section/scenario/step, live tally, last assertion detail, latest screenshot thumbnail. Includes **pause-on-failure**, which freezes the run with the app in its failing state. Hosted by the runner, not the app, so it survives an app crash or restart. |

### Phase 2 - Depth on the highest-risk surfaces

| # | Tool | Effort | Target |
| --- | --- | --- | --- |
| `T13` | Page automation protocol | large | Promote the pattern already proven in `project_instance_messages.js` into a shared module under `ui/shared/`, then adopt it in Dataset Viewer and DFM first. Provides `page.snapshot`, `page.action`, and `page.locate` (window-relative rect for a logical control, feeding `T10`). |
| `T14` | Readiness signal | medium | Pages post `arcrho:page-ready` when their initial load settles; `shell.waitForIdle` consumes it. Without this, assertions race the fetch and the suite is flaky. |
| `T15` | Unblock the poll loop | medium | Replace the blocking native `confirm()` in the dirty-close path (`ui/shell/tab_actions.js`) with the shell's existing async confirm. A native `confirm()` halts the same event loop `pollLoop` runs on, so **closing a modified tab currently deadlocks automation**. |
| `T16` | Configurable timeouts | small | The hardcoded 10s shell-to-iframe timeouts ignore the caller's `timeout_sec`; large methods on a network share legitimately exceed them. |

### Phase 3 - Breadth

Adopt `T13` across BF, Cape Cod, Result Selection, Berquist-Sherman, Project Settings, and
Workflow. Seed baselines. Add structural diffing.

### Phase 4 - Oracle

ResQ COM comparison (`A8`), opt-in and sampled.

## Agent Interface

The workflow is invoked as a repo skill, `arcrho-ui-regression`, following the existing
`.claude/skills/<name>/SKILL.md` convention. The skill's job is orchestration and judgment only:

1. Verify the app is running and healthy; start it if not.
2. Run Layer A. If `A5`/`A6`/`A7` fail, stop and report - the build is not release-ready.
3. Run Layer B for the selected sections (default: all).
4. Review the Layer C screenshot set.
5. Write `report.md` and summarize verdicts in chat.

Steps 2-3 are a single script invocation each. The agent does not read individual assertion output
unless a section fails.

## Known Constraints

- **Serial execution.** The shell executes one automation command at a time, and a modal dialog
  stalls the queue for up to the 120s service cap. Scenarios must dismiss dialogs in teardown.
- **Single global queue.** `poll_command` ignores `client_id`, so a regression run and a user (or
  an Arcode macro) driving the shell concurrently will interleave unpredictably. The harness must
  own the app for the duration of a run; honoring `client_id` is a later hardening step.
- **Dev app, not the installer.** Runs target the dev-mode app. The full packaged build takes
  roughly 12 minutes and is far outside the 60-second validation budget, so packaged verification
  stays with the existing manual build checklist.
- **Screenshot stability.** Captures must avoid surfaces containing timestamps, user names, or
  relative dates, or mask those regions, or they diff on every run.
- **Hidden-window capture.** `capturePage` on a window created with `show:false` can return an
  empty frame; the capture handler must ensure visibility first.

## Pre-existing Issues This Surfaced

Independent of the workflow, and worth fixing on their own:

1. **The generated route inventory silently omits whole domains.**
   `tools/docs_index_builder.py` parses every `app_server/api/*_router.py`
   ([docs_index_builder.py:238](../../tools/docs_index_builder.py#L238)) but renders only domains
   present in the hardcoded `BACKEND_DOMAIN_META` allowlist
   ([docs_index_builder.py:669](../../tools/docs_index_builder.py#L669), consumed at lines 1289,
   1520, 1684, 1708, 1722). Seven registered routers are absent from that map and therefore appear
   nowhere in `docs/generated/app_server_routes.md`, even after `--write`:
   `dfm_method`, `dfm_method_index`, `dfm_rpc_bridge` (all of DFM, the largest feature area),
   `project_user_preferences`, `result_selection_rpc_bridge`, `arcode_scripting`, and
   `user_identity`.

   The omission is silent - adding a router without adding it to `BACKEND_DOMAIN_META` produces no
   error and no `--check` failure, so the domain just vanishes from the docs. This is the drift the
   root `AGENTS.md` single-source-of-truth rule exists to prevent, and it means a UI regression
   workflow cannot use the generated inventory as its endpoint source of truth until the allowlist
   is either completed or replaced by the glob the parser already performs.
2. **No test step exists anywhere in the release pipeline,** and `package.json` has no `test`
   script. The build validates changelog fragments and nothing validates behavior.
3. **The `.test.mjs` suite asserts on source text,** via `readFile` + `assert.match`. It cannot
   observe rendered state, so contract rules about duplicate listeners, lost tab state, or iframe
   recreation are unobservable by construction.
4. **Cape Cod has no shell tab type and no Project Instance window kind.** If it ships without that
   wiring it cannot be regression-tested at all.
5. **Release evidence evaporates.** The build runs in a throwaway workspace and never writes back,
   so 453 fragments sit unreleased and the newest repo release note is 1.0.5 while 1.1.28 shipped.
   A gate whose evidence is not retained cannot be audited.

## Test Plan

1. `T1` capture returns a non-empty PNG of the main window, and of a named secondary window.
2. `T2` `shell.listTabs` reflects a tab opened by `shell.openTab`, and `closeTab` removes it.
3. `T3` `projectInstance.selectPath` puts the page in a state where `projectInstance.context`
   succeeds from a cold start.
4. `T4` a cancelled command is not delivered to a later poll.
5. `T5` two runs on the same machine produce byte-identical window geometry.
6. `T8` a scenario with a deliberately failing assertion produces `FAIL` in `report.json` with the
   step index, expected, and actual.
7. `T8` `guardFile` restores the fixture file byte-for-byte after a mutating scenario.
8. `T10` a synthetic click on a control's located rect fires the same handler a semantic
   `page.action` would - and a control deliberately covered by a transparent overlay **fails** the
   synthetic path while passing the semantic one, proving hit-testing is real.
9. `T11` a screenshot captured while the pointer overlay is active contains no cursor glyph, and
   two runs of the same scenario produce byte-identical PNGs with visualization on and off.
10. `T12` the inspector reports the current step within one second, and continues serving after the
    app under test is killed mid-scenario.
11. `T12` pause-on-failure halts the run with the app still responsive to manual interaction, and
    resume continues from the next step.
12. `T13` `page.snapshot` for an unchanged method is stable across two consecutive runs.
13. `T14` `shell.waitForIdle` returns only after the grid is populated - assert against a
    deliberately slow load.
14. `T15` closing a dirty tab through automation completes without stalling the poll loop.
15. Layer A `A2` detects an intentionally introduced field-projection change in a method writer.
16. A full default run completes within an agreed wall-clock budget and produces a report whose
    section count matches the scenario directory.
