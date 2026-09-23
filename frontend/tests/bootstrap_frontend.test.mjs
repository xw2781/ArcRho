import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BST_RESIDUAL_FLAG_MULTIPLE,
  applyBootstrapSettings,
  bootstrapRunState,
  flagLargeResiduals,
  odpNegativeMeanApplies,
  readBootstrapSettings,
  residualColumnLabels,
  residualFlagThreshold,
  targetRows,
} from "../ui/method_pages/bootstrap/bootstrap_page_model.js";
import {
  BOOTSTRAP_TAB_DEFS,
  appDefaultWindowTab,
  resolveWindowTab,
  windowTabKind,
} from "../ui/shared/tabs/window_tab_catalog.js";

const frontendRoot = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, frontendRoot), "utf8");

function sampleMethod() {
  return {
    json_format: "arcrho-bootstrap-v4",
    details_tab: {
      name: "F 72 A - Bootstrap",
      method_type: "Bootstrap",
      output_type: "F 00 - Ultimate Net Loss",
      dataset_category: "F Net Loss",
      origin_length: 12,
      development_length: 12,
      model_type: "odp_varying_scale",
      dfm_method: "F 25 - Incurred DFM Bootstrap",
      dfm_source_revision: "sha256:1",
      dfm_snapshot: { development_labels: ["12", "24"], origin_labels: ["2025", "2026"] },
    },
    residuals_tab: {
      residual_type: "scaled",
      show_scale_values: true,
      tile_grid_and_graph: false,
      residual_scale_smoothing: 0.5,
      forecast_scale_smoothing: 0,
      user_scale_values_residuals: [null, 2, null],
      user_scale_values_forecasting: [null, null, null],
      residual_values: { scaled: [[1, -1, null], [0.5, null, null]] },
    },
    simulation_tab: {
      estimation_variance: "odp",
      process_variance: "gamma",
      simulation_count: 5000,
      random_seed: 735889630,
      prevent_negative_data: false,
      negative_mean_action: "value_0_01",
      odp_negative_mean_action: "odp",
    },
    results_tab: {
      target_ultimate: "F 92 - Current Qtr Selected",
      target_ultimate_values: [110, 220],
      target_reserve_values: [10, 30],
      target_scaling_methods: ["additive", "user_defined"],
      target_cvs: [0, 0.25],
      origin_labels: ["2025", "2026"],
      simulation_summary: { unscaled: { mean: [50, 8, 42] }, scaled: { mean: [40, 10, 30] } },
    },
    output_tab: { observed_triangle: true },
    method_metadata: { owned_revision: "sha256:2" },
  };
}

test("the catalog registers the Bootstrap window kind and opens it on Results by default", () => {
  assert.deepEqual(
    BOOTSTRAP_TAB_DEFS.map(({ id }) => id),
    ["details", "residuals", "simulation", "targets", "results", "notes", "audit"],
  );
  assert.equal(windowTabKind("bootstrap")?.label, "Bootstrap");
  assert.equal(appDefaultWindowTab("bootstrap"), "results");
  assert.equal(resolveWindowTab("bootstrap", "", {}), "results");
  assert.equal(resolveWindowTab("bootstrap", "details", {}), "details");
  assert.equal(resolveWindowTab("bootstrap", "method", { bootstrap: "targets" }), "targets");
});

test("Project Instance opens Bootstrap rows in their own window kind and names the method file BST@", async () => {
  const [windows, table, messages, html] = await Promise.all([
    read("ui/project_instance/project_instance_windows.js"),
    read("ui/project_instance/project_instance_dataset_table.js"),
    read("ui/project_instance/project_instance_messages.js"),
    read("ui/project_instance/project_instance.html"),
  ]);
  assert.match(windows, /kind: "bootstrap"/u);
  assert.match(windows, /\/ui\/method_pages\/bootstrap\/bootstrap\.html\?/u);
  assert.match(windows, /windowTab\("bootstrap", options\.initialTab \|\| options\.bstTab\)/u);
  assert.match(table, /=== "bootstrap";/u);
  assert.match(table, /if \(isBootstrapDatasetRecord\(record\)\) \{\s+openBootstrapTabForDataset\(record\);/u);
  assert.match(html, /data-row-action="add-bootstrap">Bootstrap</u);
  assert.match(messages, /filename = `BST@\$\{namePart\}\.json`;/u);
  assert.match(messages, /msg\.type === "arcrho:bst-tab-changed"/u);
});

test("a large residual is flagged against the grid's own spread", () => {
  const grid = [[0.2, -0.3, 2.4], [-0.1, 0.4, null], [0.3, null, null]];
  const threshold = residualFlagThreshold(grid);
  const values = grid.flat().filter((value) => value !== null);
  const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  assert.equal(threshold, rms * BST_RESIDUAL_FLAG_MULTIPLE);
  assert.deepEqual(flagLargeResiduals(grid), [[false, false, true], [false, false, false], [false, false, false]]);
  assert.equal(residualFlagThreshold([[null, null]]), null);
  assert.deepEqual(flagLargeResiduals([[0, 0]]), [[false, false]]);
});

test("writing back the settings read from a method leaves it unchanged", () => {
  const method = sampleMethod();
  const settings = readBootstrapSettings(method);
  assert.deepEqual(applyBootstrapSettings(method, settings), method);
  assert.equal(settings.modelType, "odp_varying_scale");
  assert.equal(settings.randomSeed, 735889630);
  assert.equal(settings.preventNegativeData, false);
  assert.deepEqual(settings.targetCvs, [0, 0.25]);
});

test("an edited setting lands in its owned field and nowhere else", () => {
  const method = sampleMethod();
  const settings = { ...readBootstrapSettings(method), randomSeed: 42, targetScalingMethods: ["multiplicative", "user_defined"] };
  const saved = applyBootstrapSettings(method, settings);
  assert.equal(saved.simulation_tab.random_seed, 42);
  assert.deepEqual(saved.results_tab.target_scaling_methods, ["multiplicative", "user_defined"]);
  assert.deepEqual(saved.results_tab.simulation_summary, method.results_tab.simulation_summary);
  assert.equal(method.simulation_tab.random_seed, 735889630, "the loaded method is not mutated");
});

test("a new method starts from the contract defaults", () => {
  const settings = readBootstrapSettings({});
  assert.equal(settings.modelType, "odp_single_scale");
  assert.equal(settings.residualType, "scaled_bias_adjusted_zero_average");
  assert.equal(settings.estimationVariance, "gamma");
  assert.equal(settings.simulationCount, 10000);
  assert.equal(settings.preventNegativeData, true);
  assert.equal(settings.odpNegativeMeanAction, "negative_mean");
  const saved = applyBootstrapSettings(null, { ...settings, name: "B", outputType: "T", dfmMethod: "D" });
  assert.equal(saved.json_format, "arcrho-bootstrap-v4");
  assert.equal(saved.details_tab.method_type, "Bootstrap");
  assert.equal(saved.details_tab.dfm_method, "D");
});

test("the ODP negative-mean choice applies only when a distribution is ODP", () => {
  assert.equal(odpNegativeMeanApplies({ estimationVariance: "gamma", processVariance: "gamma" }), false);
  assert.equal(odpNegativeMeanApplies({ estimationVariance: "gamma", processVariance: "odp" }), true);
});

test("the Targets rows compare each target reserve with the unscaled mean", () => {
  const method = sampleMethod();
  const { rows, total } = targetRows(method, readBootstrapSettings(method));
  assert.deepEqual(rows.map((row) => [row.origin, row.targetReserve, row.unscaledMean, row.difference]), [
    ["2025", 10, 8, 2],
    ["2026", 30, 42, -12],
  ]);
  assert.equal(rows[1].scalingMethod, "user_defined");
  assert.equal(rows[1].cv, 0.25);
  assert.equal(total.targetReserve, 40);
  assert.equal(total.unscaledMean, 50);
  assert.equal(total.ratio, 0.8);
  assert.deepEqual(residualColumnLabels(method, 3), ["12", "24", "Tail"]);
});

test("the run chip reads the stored run and unsaved edits", () => {
  const method = sampleMethod();
  assert.equal(bootstrapRunState({ method, dirty: false }).label, "Up to date");
  assert.equal(bootstrapRunState({ method, dirty: true }).label, "Inputs changed — run again");
  assert.equal(bootstrapRunState({ method: null, dirty: false }).label, "Not run yet");
});
