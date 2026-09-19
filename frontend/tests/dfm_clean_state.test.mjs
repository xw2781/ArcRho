import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A DFM window that no longer differs from what it loaded or saved goes back
// to clean, so an edit that was undone leaves no close prompt. The key keeps
// only the user's choices from the save payload plus the Notes text; the
// check runs only after a user edit and only ever clears the flag.

const { buildDfmCleanStateKey } = await import(
  new URL("../ui/method_pages/dfm/dfm_clean_state.js", import.meta.url).href
);

function samplePayload() {
  return {
    "json_format": "dfm-v2",
    "details_tab": { name: "D 1", "output_type": "Paid LDF", "decimal_places": 6 },
    "data_tab": { "input_data_triangle_values": [[1, 2], [3]], "source_revision": "r1" },
    "ratios_tab": {
      "ratio_triangle": {
        "origin_labels": ["2019", "2020"],
        "ratio_values": [[2.0000000001], []],
        excluded: [[0, 1], [0]],
      },
      "average_formulas": {
        label: ["Volume - all", "User Entry", "Benchmark"],
        "custom_average_formula_settings": {
          "average_type": ["volume", "user_entry", ""],
          base: ["volume", "", "benchmark"],
        },
        selected: [[1, 0, 0]],
        values: [[1.5, 1.25], [1.4, 1.2], [1.3, 1.1]],
      },
      "cell_notes": {},
    },
    "curves_tab": { "selected_values": [1.5, 1.25, 1] },
    "results_tab": {
      "ratio_basis_dataset": "Paid",
      "ratio_basis_values": [10, 20],
      "ratio_basis_source_revision": "r1",
      "ultimate_ratio_decimal_places": 3,
      "ultimate_vector": [18.75, 25],
    },
    "method_metadata": {
      "last_modified": "2026-09-18T10:00:00.000Z",
      "data_refreshed": "2026-09-01T00:00:00.000Z",
      "owned_revision": "abc",
    },
  };
}

const cleanKey = buildDfmCleanStateKey(samplePayload(), "note");

test("derived values the tabs recompute after an edit take no part in the key", () => {
  // A ratio edit drops the stored ultimate vector for a locally recomputed one,
  // and the computed averages and ratio values follow the model, not the user.
  const settled = samplePayload();
  settled["results_tab"]["ultimate_vector"] = [18.750000000000004, 25.000000000000004];
  settled["results_tab"]["ratio_basis_values"] = [10.5, 20];
  settled["ratios_tab"]["ratio_triangle"]["ratio_values"] = [[2], []];
  settled["ratios_tab"]["average_formulas"].values[0] = [1.5000000000000002, 1.25];
  settled["data_tab"]["source_revision"] = "r2";
  settled["method_metadata"] = { "last_modified": "later", "data_refreshed": "later", "owned_revision": "def" };
  assert.equal(buildDfmCleanStateKey(settled, "note"), cleanKey);
});

test("every user choice changes the key and undoing it restores the key", () => {
  const cases = [
    (p) => { p["ratios_tab"]["ratio_triangle"].excluded = [[1, 1], [0]]; },
    (p) => { p["ratios_tab"]["average_formulas"].selected = [[0, 1, 0]]; },
    (p) => { p["ratios_tab"]["average_formulas"].values[1] = [1.45, 1.2]; },
    (p) => { p["ratios_tab"]["average_formulas"].values[2] = [1.35, 1.1]; },
    (p) => { p["ratios_tab"]["cell_notes"] = { "2019|12": "checked" }; },
    (p) => { p["curves_tab"] = { "selected_values": [1.5, 1.3, 1] }; },
    (p) => { p["details_tab"]["decimal_places"] = 4; },
    (p) => { p["results_tab"]["ratio_basis_dataset"] = "Incurred"; },
    (p) => { p["results_tab"]["ultimate_ratio_decimal_places"] = 2; },
  ];
  for (const edit of cases) {
    const edited = samplePayload();
    edit(edited);
    assert.notEqual(buildDfmCleanStateKey(edited, "note"), cleanKey, edit.toString());
  }
  assert.notEqual(buildDfmCleanStateKey(samplePayload(), "note edited"), cleanKey);
  assert.equal(buildDfmCleanStateKey(samplePayload(), "note"), cleanKey);
});

test("the key leaves the payload it was given untouched", () => {
  const payload = samplePayload();
  buildDfmCleanStateKey(payload, "");
  assert.deepEqual(payload, samplePayload());
});

test("a user edit sets the flag only through the comparison's verdict", async () => {
  const state = await readFile(
    new URL("../ui/method_pages/dfm/dfm_state.js", import.meta.url),
    "utf8",
  );
  const mark = state.slice(
    state.indexOf("export function markDfmDirty"),
    state.indexOf("export function applyDfmDirtyCheckResult"),
  );
  assert.match(mark, /if \(dfmProgrammaticDepth > 0\) return;/u);
  assert.match(mark, /if \(dfmDirtyChecker\) dfmDirtyChecker\(\);\s*else applyDfmDirtyCheckResult\(true\);/u);
  assert.doesNotMatch(mark, /notifyDfmDirtyState/u, "an edit never sets the flag on its own");

  const persistence = await readFile(
    new URL("../ui/method_pages/dfm/dfm_persistence.js", import.meta.url),
    "utf8",
  );
  const record = persistence.slice(
    persistence.indexOf("function recordCleanDfmMethodPayload"),
    persistence.indexOf("export function recordCurrentDfmCleanState"),
  );
  assert.match(
    record,
    /lastCleanDfmNotesText = getDfmNotesText\(\);[\s\S]*lastCleanDfmStateKey = buildDfmCleanStateKey\(buildDfmMethodPayload\(\), lastCleanDfmNotesText\)/u,
  );
  const check = persistence.slice(
    persistence.indexOf("export function scheduleDfmCleanStateCheck"),
    persistence.indexOf("export async function buildDfmAssistantContextPayload"),
  );
  // No baseline or a failed build counts as changed; equality clears.
  assert.match(check, /let differs = true;/u);
  assert.match(check, /differs = !lastCleanDfmStateKey\s*\|\| buildDfmCleanStateKey\(buildDfmMethodPayload\(\), getDfmNotesText\(\)\) !== lastCleanDfmStateKey;/u);
  assert.match(check, /applyDfmDirtyCheckResult\(differs\);/u);
  assert.match(check, /setDfmDirtyChecker\(scheduleDfmCleanStateCheck\);/u);
  assert.doesNotMatch(check, /markDfmDirty|markDfmClean/u, "the verdict alone moves the flag");
});
