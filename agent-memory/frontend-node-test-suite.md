---
name: frontend-node-test-suite
description: How to run the frontend Node test suite and which failures are pre-existing
metadata: 
  node_type: memory
  type: project
  originSessionId: 70ce39fb-ac39-4edd-a4ac-59ca01231bb8
  modified: 2026-08-08T03:06:48.658Z
---

`frontend/package.json` has no `test` script. Run the suite from `frontend/` with the
portable Node: `./node-portable/node.exe --test "tests/**/*.test.mjs"` (bare `node` is not
on PATH; passing the directory instead of the glob fails to resolve).

As of 2026-08-07 four tests fail as a stable baseline (525 tests, 521 pass), and they also
fail when run in isolation: "BF, Cape Cod, and Result Selection Home cards open restorable
shell method tabs", "Project Settings loads its external stylesheets in cascade order",
"existing Result Selection apply uses persisted values without source or basis reloads", and
"a dependency update queued during save survives the save response".

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
