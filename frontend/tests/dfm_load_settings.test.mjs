import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// "Load Settings From Another Method" copies a source DFM's lengths, average
// rows, selections, matching exclusions and Curves choices onto the open DFM,
// keeps the open DFM's identity, input and Notes, and is one undo step.

const frontendRoot = new URL("../", import.meta.url);
const source = async (path) => (await readFile(new URL(path, frontendRoot), "utf8")).replaceAll("\r\n", "\n");
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;

const {
  dfmSettingsLengthChange,
  listDfmCopySources,
  projectDfmSettingsCopy,
} = await import(new URL("../ui/method_pages/dfm/dfm_settings_copy.js", import.meta.url).href);

function targetMethod() {
  return {
    "json_format": "arcrho-dfm-v4",
    "details_tab": {
      name: "Target DFM",
      "output_type": "Paid LDF",
      "output_dataset": "Target DFM",
      "input_triangle": "Paid Loss",
      "origin_length": 12,
      "development_length": 12,
      "decimal_places": 5,
    },
    "data_tab": {
      "origin_labels": ["2022", "2023", "2024"],
      "development_labels": ["12", "24", "36"],
      "input_data_triangle_values": [[1, 2, 3], [4, 5], [6]],
    },
    "ratios_tab": {
      "ratio_triangle": {
        "origin_labels": ["2022", "2023", "2024"],
        "development_labels": ["12-24", "24-36", "36-Ult"],
        "excluded": [[1, 1, 0], [1, 0, 0], [0, 0, 0]],
      },
      "average_formulas": {
        label: ["Volume - all"],
        "custom_average_formula_settings": {
          "average_type": ["custom"], base: ["volume"], periods: ["all"], exclude: [0],
        },
        selected: [[1, 1, 1]],
        values: [[1.5, 1.2, null]],
        inputs: [["", "", ""]],
        "display_inputs": [["", "", ""]],
      },
      "cell_notes": { "2022|12-24": "target note" },
    },
    "curves_tab": { "fitting_method": "exponential", included: [1, 1], "selected_values": [1, 1, 1] },
    "results_tab": { "ratio_basis_dataset": "Target Basis", "ultimate_ratio_decimal_places": 3 },
    "method_metadata": { "owned_revision": "rev-target" },
  };
}

function sourceMethod() {
  return {
    "json_format": "arcrho-dfm-v4",
    "details_tab": {
      name: "Source DFM",
      "output_type": "Incurred LDF",
      "input_triangle": "Incurred Loss",
      "origin_length": 12,
      "development_length": 12,
      "decimal_places": 3,
    },
    "ratios_tab": {
      "ratio_triangle": {
        // 2021 and the 48-Ult column exist only in the source; 2024 and
        // 36-Ult only in the target.
        "origin_labels": ["2021", "2022", "2023"],
        "development_labels": ["12-24", "24-36", "48-Ult"],
        "excluded": [[1, 1, 1], [0, 1, 1], [1, 0, 1]],
      },
      "average_formulas": {
        label: ["Simple - 5", "Simple - 3", "User Entry"],
        "custom_average_formula_settings": {
          "average_type": ["custom", "custom", "user_entry"],
          base: ["simple", "simple", "simple"],
          periods: [5, 3, "all"],
          exclude: [1, 0, 0],
        },
        selected: [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
        values: [[1.4, 1.1, 1.05], [1.3, 1.0, 1.0], [1.35, null, 1.01]],
        inputs: [["", "", ""], ["", "", ""], ['=("Simple - 5"+"Simple - 3")/2', "", "1.01"]],
        "display_inputs": [["", "", ""], ["", "", ""], ["=(1.4+1.3)/2", "", "1.01"]],
      },
      "cell_notes": { "2021|12-24": "source note" },
    },
    "curves_tab": {
      "fitting_method": "power",
      "future_development_periods": 10,
      "free_fit_c": true,
      included: [0, 1],
      "user_columns": [{ label: "User", "column_type": "user_entry", values: [1.2, 1.1], tail: 1.05 }],
      "selected_estimates": [2, 3],
      "selected_tail_factor": 4,
      "selected_tail_curve": 2,
      "selected_values": [9, 9, 9],
    },
    "results_tab": { "ratio_basis_dataset": "Source Basis", "ultimate_ratio_decimal_places": 6 },
  };
}

test("the copy takes the source's average rows, settings, formulas and selections", () => {
  const merged = projectDfmSettingsCopy(targetMethod(), sourceMethod());
  const formulas = merged["ratios_tab"]["average_formulas"];
  assert.deepEqual(formulas.label, ["Simple - 5", "Simple - 3", "User Entry"]);
  assert.deepEqual(formulas["custom_average_formula_settings"].periods, [5, 3, "all"]);
  assert.deepEqual(formulas["custom_average_formula_settings"].exclude, [1, 0, 0]);
  // Columns follow their label: 12-24 and 24-36 match, 36-Ult is new.
  assert.deepEqual(formulas.selected, [[0, 1, 0], [0, 0, 0], [1, 0, 0]]);
  assert.deepEqual(formulas.values[2], [1.35, null, null]);
  assert.deepEqual(formulas.inputs[2], ['=("Simple - 5"+"Simple - 3")/2', "", ""]);
  assert.deepEqual(formulas["display_inputs"][2], ["=(1.4+1.3)/2", "", ""]);
});

test("exclusions carry across only where the origin and development labels match", () => {
  const merged = projectDfmSettingsCopy(targetMethod(), sourceMethod());
  assert.deepEqual(merged["ratios_tab"]["ratio_triangle"]["excluded"], [
    [0, 1, 0], // 2022: source row [0, 1, 1]; 36-Ult has no source column
    [1, 0, 0], // 2023: source row [1, 0, 1]
    [0, 0, 0], // 2024: no source row, so nothing is excluded
  ]);
});

test("the copy takes the source's Curves choices and drops the fitted chain", () => {
  const merged = projectDfmSettingsCopy(targetMethod(), sourceMethod());
  const curves = merged["curves_tab"];
  assert.equal(curves["fitting_method"], "power");
  assert.equal(curves["future_development_periods"], 10);
  assert.equal(curves["free_fit_c"], true);
  assert.equal(curves["selected_tail_factor"], 4);
  assert.equal(curves["selected_tail_curve"], 2);
  // Periods are the ratio columns but the tail: 12-24 and 24-36 on both sides.
  assert.deepEqual(curves.included, [0, 1]);
  assert.deepEqual(curves["selected_estimates"], [2, 3]);
  assert.deepEqual(curves["user_columns"][0].values, [1.2, 1.1]);
  assert.equal(curves["user_columns"][0].tail, 1.05);
  assert.equal("selected_values" in curves, false);
});

test("the open DFM keeps its identity, input, decimal places, cell notes and Results choices", () => {
  const target = targetMethod();
  const snapshot = JSON.stringify(target);
  const merged = projectDfmSettingsCopy(target, sourceMethod());
  assert.equal(JSON.stringify(target), snapshot, "the target payload is not modified");
  assert.deepEqual(
    {
      name: merged["details_tab"].name,
      outputType: merged["details_tab"]["output_type"],
      outputDataset: merged["details_tab"]["output_dataset"],
      input: merged["details_tab"]["input_triangle"],
      decimals: merged["details_tab"]["decimal_places"],
    },
    { name: "Target DFM", outputType: "Paid LDF", outputDataset: "Target DFM", input: "Paid Loss", decimals: 5 },
  );
  assert.deepEqual(merged["data_tab"], target["data_tab"]);
  assert.deepEqual(merged["ratios_tab"]["cell_notes"], { "2022|12-24": "target note" });
  assert.deepEqual(merged["results_tab"], target["results_tab"]);
  assert.deepEqual(merged["method_metadata"], target["method_metadata"]);
});

test("the lengths come from the source, and only a real difference asks for a reload", () => {
  assert.equal(dfmSettingsLengthChange(targetMethod(), sourceMethod()), null);
  const quarterly = sourceMethod();
  quarterly["details_tab"]["origin_length"] = 3;
  quarterly["details_tab"]["development_length"] = 3;
  assert.deepEqual(dfmSettingsLengthChange(targetMethod(), quarterly), { originLength: 3, developmentLength: 3 });
  const merged = projectDfmSettingsCopy(targetMethod(), quarterly);
  assert.equal(merged["details_tab"]["origin_length"], 3);
  assert.equal(merged["details_tab"]["development_length"], 3);
  assert.equal(dfmSettingsLengthChange(targetMethod(), { "details_tab": {} }), null);
});

test("the picker lists the class's DFMs by name without the open one", () => {
  const payload = {
    files: [
      { name: "Paid LDF B", "method_type": "DFM", status: 0 },
      { name: "Target Output", "method_name": "Target DFM", "method_type": "DFM", status: 0 },
      { name: "Paid Loss", "method_type": "None", status: 0 },
      { name: "BF Paid", "method_type": "BF", status: 0 },
      { name: "Paid LDF A", "method_type": "DFM", status: 2 },
    ],
  };
  const sameClass = listDfmCopySources(payload, {
    reservingClass: "A\\B", currentClass: "a\\b", currentMethodName: "target dfm",
  });
  assert.deepEqual(sameClass.map((row) => row.methodName), ["Paid LDF A", "Paid LDF B"]);
  assert.deepEqual(sameClass[0], { methodName: "Paid LDF A", outputDataset: "Paid LDF A", status: "Needs Review" });
  const otherClass = listDfmCopySources(payload, {
    reservingClass: "A\\C", currentClass: "A\\B", currentMethodName: "Target DFM",
  });
  assert.deepEqual(otherClass.map((row) => row.methodName), ["Paid LDF A", "Paid LDF B", "Target DFM"]);
  assert.equal(otherClass[2].outputDataset, "Target Output");
});

async function loadHistoryModule() {
  const stateStub = moduleUrl(`
    export const activeRatioCols = new Set();
    export const ratioStrikeSet = new Set();
    export const selectedSummaryByCol = new Map();
    let allActive = false;
    export const getRatioColAllActive = () => allActive;
    export const setRatioColAllActive = (value) => { allActive = !!value; };
    export const getDfmInst = () => "test";
    export const getHostApi = () => null;
    export const markDfmDirty = () => { globalThis.__historyDirtyMarks += 1; };
  `);
  const text = (await source("ui/method_pages/dfm/dfm_ratio_history.js"))
    .replace('"/ui/method_pages/dfm/dfm_state.js"', JSON.stringify(stateStub));
  return import(moduleUrl(`${text}\n// ${Math.random()}`));
}

test("a Load Settings copy is one undo step that restores the whole method, and redo reapplies it", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { parent: { postMessage() {} } };
  globalThis.__historyDirtyMarks = 0;
  try {
    const history = await loadHistoryModule();
    let current = { name: "after copy" };
    const restored = [];
    history.setMethodHistoryHandlers({
      capture: () => current,
      restore: async (payload) => {
        restored.push(payload.name);
        current = payload;
        return true;
      },
    });
    history.recordMethodHistoryStep({ name: "before copy" }, "load-settings");
    assert.equal(history.peekRatioHistoryStepKind("undo"), "method");
    assert.equal(history.getRatioHistoryState().canUndo, true);

    assert.equal(await history.runRatioUndo(), true);
    assert.deepEqual(restored, ["before copy"]);
    assert.equal(history.peekRatioHistoryStepKind("undo"), "");
    assert.equal(history.peekRatioHistoryStepKind("redo"), "method");

    assert.equal(await history.runRatioRedo(), true);
    assert.deepEqual(restored, ["before copy", "after copy"]);
    assert.equal(history.peekRatioHistoryStepKind("undo"), "method");
    assert.equal(globalThis.__historyDirtyMarks, 2);
  } finally {
    globalThis.window = previousWindow;
    delete globalThis.__historyDirtyMarks;
  }
});

test("a restore that fails leaves the undo step in place", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { parent: { postMessage() {} } };
  globalThis.__historyDirtyMarks = 0;
  try {
    const history = await loadHistoryModule();
    history.setMethodHistoryHandlers({ capture: () => ({ name: "now" }), restore: async () => false });
    history.recordMethodHistoryStep({ name: "before" }, "load-settings");
    assert.equal(await history.runRatioUndo(), false);
    assert.equal(history.peekRatioHistoryStepKind("undo"), "method");
    assert.equal(history.peekRatioHistoryStepKind("redo"), "");
  } finally {
    globalThis.window = previousWindow;
    delete globalThis.__historyDirtyMarks;
  }
});

test("the Details tab carries the button and the page wires it", async () => {
  const html = await source("ui/method_pages/dfm/dfm.html");
  const lengths = html.indexOf('id="decimalPlaces"');
  const button = html.indexOf('id="dfmLoadSettingsBtn"');
  assert.ok(lengths > 0 && button > lengths, "the button sits below the lengths");
  assert.match(html, />Load Settings From Another Method</u);
  const orchestrator = await source("ui/method_pages/dfm/dfm_tabs_orchestrator.js");
  assert.match(orchestrator, /wireDfmLoadSettingsButton\(\);/u);
});
