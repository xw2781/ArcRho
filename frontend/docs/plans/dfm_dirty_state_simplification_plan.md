# DFM Dirty-State Simplification Plan

## Status

Proposed — not yet implemented. Accepted trade-off: we drop the
"edit a value then change it back ⇒ clean again" behavior.

## Background

Opening certain DFM tabs shows a **transient dirty indicator on the window
titlebar (~1s) even though the user made no edits**. Confirmed on:

- `D 18 - BS Paid DFM` — input triangle is a *calculated/derived* dataset
  (`Gross Loss--Paid - B&S Settlement Rate Adjustment`).
- `F 13 - Paid DFM w/ Selected LDFs` — a large *quarterly* triangle
  (40 origins × 38 development columns).

### Root cause (single bug, two triggers)

Dirty state is currently decided by **comparing serialized snapshots of the
method payload**:

- [`isCurrentDfmDirtyComparedToCleanSnapshot()`](../../ui/dfm/dfm_persistence.js) compares
  `serializeDfmDirtySnapshot(buildDfmMethodPayload())` against the stored
  `lastCleanDfmDirtySnapshot`.
- [`buildDfmDirtySnapshot()`](../../ui/dfm/dfm_persistence.js) captures the
  `average formulas` object **including its computed `values`** and the
  `excluded` matrix.

Both of those are **derived from `state.model`**, not from user input:

- `average formulas.values` is recomputed every call by
  [`buildAverageFormulaValues()`](../../ui/dfm/dfm_persistence.js) from the live
  triangle.
- `excluded` is shape-trimmed against the model-derived ratio triangle
  ([`trimMatrixToReferenceRowShape()`](../../ui/dfm/dfm_persistence.js) +
  [`buildCalculatedRatioTriangleValues()`](../../ui/dfm/dfm_persistence.js)).

When the model finishes loading / recomputing **after** the "clean" baseline was
captured, these derived fields no longer match the baseline, so `markDfmDirty()`
(re-evaluating against the snapshot) publishes `dirty = true` until the next
clean snapshot is recorded — the flash.

- **Calculated input (annual B&S):** an async recompute fires a second
  `dataset-updated` → reload cycle after the first load.
- **Large quarterly triangle:** load+compute outlasts the 900 ms startup-clean
  window, so the baseline is captured against a not-yet-settled model; the
  multi-stage load then changes it.

The snapshot approach couples dirty state to asynchronous model computation.
This is a *class* of bug: any future computed field added to the payload
reintroduces it.

## Decision

Replace snapshot comparison with **interaction-based dirty tracking**:

> `dirty` = the user has edited something since the tab was last loaded or saved.

User edits are model-independent, so async dataset loads/recomputes can never
affect dirty. This makes the entire timing race structurally impossible and
deletes more code than it adds.

**Accepted trade-off:** editing a cell and reverting it leaves the tab `dirty`
(was `clean` under snapshot comparison). Worst case is an unnecessary save
prompt — never data loss.

## Implementation

### 1. New suppression scope in `dfm_state.js`

Replace the evaluator/suppressor machinery with a single re-entrant guard.

```js
// dfm_state.js
let dfmIsDirty = false;
let dfmProgrammaticDepth = 0; // > 0 while applying loaded/external data

export function isDfmApplyingProgrammatically() {
  return dfmProgrammaticDepth > 0;
}

// Run a (sync or async) programmatic mutation with dirty tracking suppressed.
export async function runDfmProgrammatic(fn) {
  dfmProgrammaticDepth++;
  try {
    return await fn();
  } finally {
    dfmProgrammaticDepth--;
  }
}

export function markDfmDirty() {
  if (dfmProgrammaticDepth > 0) return;   // ignore edits we cause ourselves
  notifyDfmDirtyState(true);
}

export function markDfmClean() {
  notifyDfmDirtyState(false);
}
```

`notifyDfmDirtyState()` keeps its current job (dispatch
`arcrho:dfm-dirty-state`, post `arcrho:dfm-dirty` to parent) but loses the
`dfmDirtyPublishSuppressor` branch.

**Delete from `dfm_state.js`:** `dfmDirtyEvaluator`, `dfmDirtyPublishSuppressor`,
`setDfmDirtyEvaluator`, `setDfmDirtyPublishSuppressor`, and the evaluator call
inside the old `markDfmDirty`.

### 2. Wrap every programmatic-apply entry point

These mutate DFM state without a user editing — wrap their bodies in
`runDfmProgrammatic(...)` so the `markDfmDirty()` calls they trigger
(renders, pattern applies, select syncs) are ignored:

| Entry point | File | Notes |
|---|---|---|
| `applyDfmMethodPayload()` | `dfm_persistence.js` | Core apply used by load, macro, assistant, external watch, restore. Wrap the whole body. |
| `loadRatioSelectionIfExists()` "missing file" reset branch | `dfm_persistence.js` | Clears strikes/notes/basis programmatically. |
| `checkDfmMethodFileWatch()` reload | `dfm_persistence.js` | External-file reload re-applies payload. |
| `restoreCleanDfmMethodState()` | `dfm_persistence.js` | Cancel/discard re-applies the saved payload. |
| `loadDfmTemplate()` | `dfm_persistence.js` | Applies template; should it mark dirty? Yes — see below. |

After a programmatic apply completes, the caller decides the resulting state
explicitly:

- **Load / external reload / restore (cancel):** call `markDfmClean()` —
  matches "freshly loaded = clean".
- **Macro / assistant / template apply (introduces unsaved content):** after the
  wrapped apply, call `markDfmDirty()` *outside* the scope so it registers.
  (Today the macro path already does this at
  [`dfm_tabs_orchestrator.js:652`](../../ui/dfm/dfm_tabs_orchestrator.js).)

### 3. `markDfmDirty()` call-site classification

Genuine user-edit sites — **keep unchanged** (they fire only on real input and
are naturally outside any programmatic scope):

- `dfm_details.js` — output/name change, tri/path/origin/dev `change` listeners.
- `dfm_notes_tab.js` — notes editor `setNotesDirty`.
- `dfm_ratios_tab.js` — `onRatioStateMutated()` (strike toggles, include-all,
  summary/chart callbacks), control `onChange`, header edits.
- `dfm_ratio_history.js` — undo/redo.
- `dfm_results_tab.js` — ratio-basis / ultimate-decimals edits (already gated by
  `programmatic`/`silent`).
- `dfm_percent_developed_curve_window.js` — curve-type select.
- `dfm_rpc_bridge_client.js` — "save failed, stay dirty" (intentional; runs
  outside the apply scope, so it still works).

These keep working because programmatic applies now short-circuit inside
`markDfmDirty()` rather than relying on each call site's local flag. The
existing `silent`/`programmatic` flags can stay (harmless) or be cleaned up
later; the scope guard is the new source of truth.

### 4. Delete the snapshot + startup-guard machinery

**`dfm_persistence.js` — remove:**

- `buildDfmDirtySnapshot`, `serializeDfmDirtySnapshot`,
  `canonicalizeForDirtySnapshot`
- `recordCleanDfmDirtySnapshot`, `isCurrentDfmDirtyComparedToCleanSnapshot`,
  `lastCleanDfmDirtySnapshot`, and the `setDfmDirtyEvaluator(...)` registration
- Replace `recordCleanDfmDirtySnapshot(...)` calls (e.g. after a successful save
  in `saveRatioSelectionPattern`, end of `applyDfmMethodPayload`) with
  `markDfmClean()`.

**Keep** `lastCleanDfmMethodPayload` — it is the in-memory copy used by
`restoreCleanDfmMethodState()` (Cancel) and is independent of dirty logic.
Update it whenever a payload is loaded/saved.

**`dfm_tabs_orchestrator.js` — remove the startup-clean guard entirely:**

- `dfmStartupCleanPending`, `dfmStartupUserInteracted`, `dfmStartupCleanTimer`,
  `DFM_STARTUP_CLEAN_WINDOW_MS`, `dfmStartupCleanDeadline`
- `noteDfmStartupUserInteraction`, `shouldSuppressDfmStartupDirtyPublish`,
  `wireDfmStartupCleanGuard`, `scheduleDfmStartupCleanState`
- The `pointerdown/keydown/input/change` capture listeners that fed it

This guard exists only to mask load-time false positives, which the
programmatic scope now removes at the source. `recordCurrentDfmCleanState()`
stays but simplifies to `markDfmClean()` + post `dirty:false`.

**Unaffected:** the external file watcher's revision-token logic
(`getRevisionToken`, `rememberDfmMethodFileRevision`, …) — file-based, separate
from dirty tracking.

### 5. Sequencing

1. Land §1 + §2 + §3 (scope guard + wrap applies) — fixes the flash.
2. Land §4 (delete dead snapshot/startup code) — cleanup, no behavior change.
3. Verify against both repro objects + a normal annual method.

## New expected UX / UI behavior

### Titlebar dirty indicator (`setWindowDirtyState`, project_instance)

- **On open (any method, incl. B&S calculated input and large quarterly):**
  stays **clean** — no flash. *(This is the fix.)*
- **First real user edit** (strike a ratio, change an average selection, edit
  notes, change a Details field, edit ratio basis, undo/redo): turns **dirty**
  immediately and stays dirty.
- **After Save:** returns to **clean**.
- **After Cancel/Discard** (`restoreCleanDfmMethodState`): returns to **clean**.
- **External file change** auto-reloaded while not dirty: stays **clean**
  (reload is programmatic). If the user is dirty, behavior is unchanged — a warn
  status is shown and no auto-reload happens.

### Cancel / Save buttons (`updateDfmSaveUi`)

- Disabled while clean, enabled once dirty — unchanged, but now driven purely by
  real edits, so they no longer momentarily enable on open.

### Unsaved-changes confirm modal (`dfmCancelConfirmOverlay`)

- Shown on close/cancel **only when there are real unsaved edits**. Opening and
  immediately closing a method no longer risks a spurious prompt.
- Yes/No/Escape/overlay-click behavior unchanged.

### Behavior change to call out to users/QA

- **Editing a value and manually reverting it now keeps the tab dirty** (Save or
  Cancel to clear). Previously the tab could return to clean on its own. This is
  the single intentional regression; no data-loss risk.

## Risks & mitigations

- **A programmatic apply path not wrapped** → that load would mark dirty. *Mitigation:*
  §2 table enumerates all `applyDfmMethodPayload` callers; route every apply
  through it and wrap once at the core.
- **A genuine edit routed through a wrapped path** → missed dirty (data-loss
  risk). *Mitigation:* only load/external/restore/macro/assistant/template go
  through the scope; live input handlers never do. Verify undo/redo and
  summary-table edits still mark dirty after a load.

## Verification checklist

- [ ] Open `D 18 - BS Paid DFM` → no titlebar flash within first 2s, stays clean.
- [ ] Open `F 13 - Paid DFM w/ Selected LDFs` (quarterly) → no flash, stays clean.
- [ ] Open a normal annual method → clean.
- [ ] Strike a ratio → dirty; Save → clean.
- [ ] Edit notes → dirty; Cancel → confirm modal → clean and restored.
- [ ] Undo/redo a ratio change → dirty.
- [ ] External edit of the JSON while clean → silent reload, stays clean.
- [ ] External edit while dirty → warn status, no clobber.
- [ ] Macro/assistant apply → dirty (unsaved), Save persists.
