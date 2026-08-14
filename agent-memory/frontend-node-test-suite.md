---
name: frontend-node-test-suite
description: How to run the frontend Node test suite and which failures are pre-existing
metadata: 
  node_type: memory
  type: project
  originSessionId: 70ce39fb-ac39-4edd-a4ac-59ca01231bb8
  modified: 2026-08-14T22:22:24.186Z
---

`frontend/package.json` has no `test` script. Run the suite from `frontend/` with the
portable Node: `./node-portable/node.exe --test "tests/**/*.test.mjs"` (bare `node` is not
on PATH; passing the directory instead of the glob fails to resolve).

As of 2026-08-14 the suite at clean HEAD (a71614b) has grown to 705 tests with 14 failures;
the failing set now includes several version-stamp/modularity tests ("DFM runtime imports
never load one module under multiple version URLs", "stateful shared-grid consumers use one
cache-busted module URL", "the data-tab controller and its interaction adapter share the
grid module version"), DFM Excel freshness (x2), dfm_formula_validation, installer progress
patcher, the B&S "app-server and migration adapters retain every canonical frontend contract
value" test, shell add-tab SVG, Data-tab split/facade, Details-format sync, DSV/DFM Data
validation runtime, Result Selection apply, and bundled Codex runtime. Some are flaky
run-to-run, so always diff against a same-commit worktree baseline rather than this list.

Separately, "changed theme and chart owners are reached through current cache-version chains"
(tests/color_theme.test.mjs) is a **flake in full-suite runs only** — it passes in isolation
and passes on a repeat full run. Earlier "every runtime frontend document bootstraps the
shared theme..." sightings were likely the same flake. Confirm any color_theme failure by
running that file alone before treating it as real. DFM Excel freshness, installer progress
patcher, and bundled Codex runtime also fail intermittently.

**Why:** the suite is not green, so a failure list alone does not tell you whether a change
broke something. **How to apply:** take a baseline with `git worktree add <tmp> HEAD` and run
the suite there before attributing a failure to your edit. Many tests pin exact `?v=`
cache-busting strings, so bumping a module version per [[arcrho-dev-ui-cache-restart]]
requires updating those pins in the same change.
