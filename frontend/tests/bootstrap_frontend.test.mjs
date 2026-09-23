import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BST_DEFAULT_PERCENTILES,
  BST_LADDER_PERCENTILES,
  BST_RESIDUAL_FLAG_MULTIPLE,
  applyBootstrapSettings,
  availableBases,
  bootstrapRunState,
  distributionChartData,
  fanChartBands,
  fanChartData,
  formatAxisTick,
  formatPercentileList,
  formatRunDuration,
  ladderTableRows,
  parsePercentileList,
  resultsClipboardText,
  resultsView,
  summaryTableColumns,
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

/* A stored summary for two origins: every ladder percentile p of origin w's
   reserve is w * 10 + p (index 0, the total, is their sum), so any lookup can
   be checked by hand. */
function resultsMethod() {
  const ladder = (offsets) => Object.fromEntries(
    BST_LADDER_PERCENTILES.map((p) => [String(p), offsets.map((offset) => offset + p)]),
  );
  const block = (shift) => ({
    mean: [70 + shift, 20 + shift, 50],
    standard_error: [14, 4, 10],
    minimum: [30, 10, 20],
    maximum: [300, 110, 190],
    percentiles: ladder([30 + shift, 10 + shift, 20]),
    ultimate_mean: [370 + shift, 120 + shift, 250],
    ultimate_standard_error: [14, 4, 10],
    histogram: { lower: 30, upper: 300, counts: [1, 3, 4, 2] },
  });
  const method = sampleMethod();
  method.results_tab.simulation_summary = {
    simulation_count: 10,
    random_seed: 7,
    scaled: block(0),
    unscaled: block(5),
    dfm_reserves: [18, 45],
    latest_values: [100, 200],
  };
  return method;
}

test("the percentile chooser keeps half-percent steps from 0 to 100, sorted and de-duplicated", () => {
  assert.deepEqual(parsePercentileList("99.5, 50 75%;90 95 99 50"), { ok: true, values: [50, 75, 90, 95, 99, 99.5] });
  assert.deepEqual(parsePercentileList("0 100"), { ok: true, values: [0, 100] });
  assert.equal(parsePercentileList("").ok, false);
  assert.match(parsePercentileList("99.9").error, /99\.9 is not a percentile/u);
  assert.equal(parsePercentileList("101").ok, false);
  assert.equal(parsePercentileList("abc").ok, false);
  assert.match(parsePercentileList("1 2 3 4 5 6 7 8 9 10 11 12 13").error, /at most 12/u);
  assert.equal(formatPercentileList(BST_DEFAULT_PERCENTILES), "50, 75, 90, 95, 99, 99.5");
  assert.deepEqual(parsePercentileList(formatPercentileList(BST_DEFAULT_PERCENTILES)).values, BST_DEFAULT_PERCENTILES);
});

test("the results view reads reserves by origin and total from the stored summary", () => {
  const method = resultsMethod();
  assert.deepEqual(availableBases(method), ["scaled", "unscaled"]);
  const view = resultsView(method, { basis: "scaled", measure: "reserves" });
  assert.deepEqual(view.rows.map((row) => row.label), ["2025", "2026"]);
  const [first, second] = view.rows;
  assert.equal(first.latest, 100);
  assert.equal(first.mean, 20);
  assert.equal(first.cv, 0.2);
  assert.equal(first.percentile(99.5), 109.5);
  assert.equal(first.other, 120, "the other measure is the mean ultimate");
  assert.equal(first.dfm, 18);
  assert.equal(first.difference, 2);
  assert.equal(second.percentile(50), 70);
  assert.equal(view.total.latest, 300);
  assert.equal(view.total.dfm, 63);
  assert.equal(view.total.percentile(0), 30);
  assert.equal(resultsView(method, { basis: "unscaled" }).total.mean, 75);
  assert.equal(resultsView({}, {}), null);
});

test("an ultimate is the latest plus the reserve, percentiles included", () => {
  const view = resultsView(resultsMethod(), { basis: "scaled", measure: "ultimates" });
  const [first] = view.rows;
  assert.equal(first.mean, 120);
  assert.equal(first.percentile(95), 100 + 10 + 95);
  assert.equal(first.minimum, 110);
  assert.equal(first.dfm, 118);
  assert.equal(first.other, 20, "the other measure is the mean reserve");
  assert.equal(view.total.percentile(50), 300 + 30 + 50);
  assert.deepEqual(
    summaryTableColumns("ultimates", [50]).map((column) => column.label),
    ["Latest", "Mean Ultimate", "Std. Deviation", "CV", "50%", "Mean Reserve", "DFM Ultimate", "Mean - DFM"],
  );
});

test("the full ladder lists every half percent between the minimum and maximum and marks the chosen ones", () => {
  const view = resultsView(resultsMethod());
  const rows = ladderTableRows(view, [50, 99.5]);
  assert.equal(rows.length, 5 + 201 + 1);
  assert.deepEqual(rows.slice(0, 5).map((row) => row.label), ["Latest", "Mean Reserve", "Std. Deviation", "CV", "Minimum"]);
  assert.equal(rows.at(-1).label, "Maximum");
  const median = rows.find((row) => row.label === "50%");
  assert.equal(median.chosen, true);
  assert.deepEqual(median.values, [60, 70, 80], "origins first, then the total");
  assert.equal(rows.find((row) => row.label === "75%").chosen, false);
});

test("copying the results gives tab-separated plain numbers", () => {
  const view = resultsView(resultsMethod());
  const lines = resultsClipboardText(view, { percentiles: [50] }).split("\r\n");
  assert.equal(lines[0], "Origin\tLatest\tMean Reserve\tStd. Deviation\tCV\t50%\tMean Ultimate\tDFM Reserve\tMean - DFM");
  assert.equal(lines[1], "2025\t100\t20\t4\t0.2\t60\t120\t18\t2");
  assert.equal(lines[3].split("\t")[0], "Total");
  const ladder = resultsClipboardText(view, { percentiles: [50], fullLadder: true }).split("\r\n");
  assert.equal(ladder[0], "Statistic\t2025\t2026\tTotal");
  assert.equal(ladder.length, 1 + 207);
});

test("the fan chart draws one band per symmetric pair of chosen percentiles, widest first", () => {
  assert.deepEqual(fanChartBands(BST_DEFAULT_PERCENTILES), [
    { lower: 0.5, upper: 99.5 },
    { lower: 1, upper: 99 },
    { lower: 5, upper: 95 },
    { lower: 10, upper: 90 },
    { lower: 25, upper: 75 },
  ]);
  assert.deepEqual(fanChartBands([5, 95, 50]), [{ lower: 5, upper: 95 }]);
  assert.deepEqual(fanChartBands([50]), []);
  const fan = fanChartData(resultsView(resultsMethod()), [90]);
  assert.deepEqual(fan.labels, ["2025", "2026"]);
  assert.deepEqual(fan.mean, [20, 50]);
  assert.deepEqual(fan.dfm, [18, 45]);
  assert.deepEqual(fan.bands, [{ lower: 10, upper: 90, lowerValues: [20, 30], upperValues: [100, 110] }]);
});

test("the distribution chart marks the chosen percentiles on the stored histogram", () => {
  const reserves = distributionChartData(resultsView(resultsMethod()), [50, 95]);
  assert.equal(reserves.lower, 30);
  assert.equal(reserves.total, 10);
  assert.equal(reserves.mean, 70);
  assert.deepEqual(reserves.markers, [{ percent: 50, value: 80 }, { percent: 95, value: 125 }]);
  const ultimates = distributionChartData(resultsView(resultsMethod(), { measure: "ultimates" }), [50]);
  assert.equal(ultimates.lower, 330, "moved by the total latest");
  assert.equal(ultimates.markers[0].value, 380);
});

test("the run chip moves from not run to running to up to date, and to changed on an edit", () => {
  const method = resultsMethod();
  const steps = [
    bootstrapRunState({ method: null, dirty: false }),
    bootstrapRunState({ method: null, dirty: false, running: true }),
    bootstrapRunState({ method, dirty: false }),
    bootstrapRunState({ method, dirty: true }),
    bootstrapRunState({ method, dirty: true, running: true }),
    bootstrapRunState({ method, dirty: false }),
  ];
  assert.deepEqual(steps.map((step) => step.key), ["not-run", "running", "current", "changed", "running", "current"]);
  assert.equal(steps[1].label, "Simulating");
  assert.equal(formatRunDuration(850), "850 ms");
  assert.equal(formatRunDuration(4210), "4.2 s");
  assert.equal(formatRunDuration(125000), "2 min 5 s");
  assert.equal(formatRunDuration(null), "");
});

test("chart axis labels keep neighbouring ticks distinct", () => {
  assert.deepEqual([1400000, 1420000, 1440000].map((tick) => formatAxisTick(tick, 20000)), ["1.40M", "1.42M", "1.44M"]);
  assert.deepEqual([-25000, 0, 75000].map((tick) => formatAxisTick(tick, 25000)), ["-25K", "0", "75K"]);
  assert.equal(formatAxisTick(1500000, 500000), "1.5M");
});

test("the Results tab carries the view switches, the percentile chooser and both charts", async () => {
  const html = await read("ui/method_pages/bootstrap/bootstrap.html");
  for (const id of [
    "bstSimulateBtn", "bstBasisControl", "bstMeasureControl", "bstPercentileInput", "bstFullLadderInput",
    "bstCopyResultsBtn", "bstResultsStale", "bstDistributionChart", "bstFanChart", "bstEmptySimulateBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"), `${id} is on the page`);
  }
});
