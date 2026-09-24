/* Pure view model for the Bootstrap page: the settings a user edits, how they
   are read from and written back into the persisted method, and the derived
   rows the setup tabs show. Nothing here touches the DOM, so the page and its
   tests share one owner for every rule.

   The persisted contract itself is owned by
   python-api/src/arcrho_api/bootstrap_contract.py; the page only edits the
   owned fields the server's apply_owned_patch accepts and never computes a
   derived value the server would recompute on save. */

import {
  hasRangeRun as hasSimulationRun,
  rangeOriginLabels as originLabels,
  rangeSummary as simulationSummary,
} from "../../shared/components/reserve_range/reserve_range_model.js?v=20260923a";

export const BST_METHOD_TYPE = "Bootstrap";
export const BST_JSON_FORMAT = "arcrho-bootstrap-v4";
export const BST_FILE_PREFIX = "BST@";

export const BST_MODEL_OPTIONS = Object.freeze([
  { value: "odp_single_scale", label: "ODP Single Scale" },
  { value: "odp_varying_scale", label: "ODP Varying Scale" },
  { value: "mack", label: "Mack", disabled: true, hint: "Mack is not available yet." },
]);

export const BST_RESIDUAL_TYPE_OPTIONS = Object.freeze([
  { value: "unscaled", label: "Unscaled" },
  { value: "unscaled_bias_adjusted", label: "Unscaled, Bias-Adjusted" },
  { value: "scaled", label: "Scaled" },
  { value: "scaled_bias_adjusted", label: "Scaled, Bias-Adjusted" },
  { value: "scaled_bias_adjusted_zero_average", label: "Scaled, Bias-Adjusted, Zero-Average" },
]);

export const BST_DISTRIBUTION_OPTIONS = Object.freeze([
  { value: "none", label: "None" },
  { value: "resampled", label: "Resampled" },
  { value: "normal", label: "Normal" },
  { value: "log_normal", label: "Log Normal" },
  { value: "gamma", label: "Gamma" },
  { value: "odp", label: "Over-dispersed Poisson" },
]);

export const BST_NEGATIVE_MEAN_OPTIONS = Object.freeze([
  { value: "value_0_01", label: "Use value of 0.01" },
  { value: "normal", label: "Use Normal distribution" },
]);

export const BST_ODP_NEGATIVE_MEAN_OPTIONS = Object.freeze([
  { value: "odp", label: "Use Over-dispersed Poisson" },
  { value: "gamma_or_log_normal", label: "Use Gamma or Log Normal setting" },
  { value: "negative_mean", label: "Use negative mean" },
]);

export const BST_SCALING_OPTIONS = Object.freeze([
  { value: "unscaled", label: "Unscaled" },
  { value: "additive", label: "Additive" },
  { value: "multiplicative", label: "Multiplicative" },
  { value: "user_defined", label: "User Defined" },
  { value: "from_target", label: "From Target" },
]);

/* A residual is flagged when its size reaches this multiple of the root mean
   square of the residuals shown in the same grid. ResQ reddens the reference
   method's scaled, bias-adjusted residuals from about 1.5, where that root mean
   square is close to one; measuring against the grid's own spread keeps the
   rule meaningful for the unscaled types too. */
export const BST_RESIDUAL_FLAG_MULTIPLE = 1.5;

export const BST_SCALE_ROWS = Object.freeze([
  { key: "unsmoothed", label: "Unsmoothed" },
  { key: "smoothed", label: "Smoothed" },
  { key: "user_entry", label: "User Entry" },
  { key: "selected", label: "Selected" },
]);

const MAX_SEED = 2147483646;

function text(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tab(method, name) {
  const value = method?.[name];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function choice(value, options, fallback) {
  const key = text(value);
  return options.some((option) => option.value === key) ? key : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function optionLabel(options, value) {
  return options.find((option) => option.value === value)?.label || text(value);
}

/* Every setting the page edits, read out of a persisted method (or out of an
   empty object for a new one). The defaults are the contract's defaults. */
export function readBootstrapSettings(method = {}) {
  const details = tab(method, "details_tab");
  const residuals = tab(method, "residuals_tab");
  const simulation = tab(method, "simulation_tab");
  const results = tab(method, "results_tab");
  const seed = Number.parseInt(String(simulation.random_seed ?? ""), 10);
  const count = Number.parseInt(String(simulation.simulation_count ?? ""), 10);
  return {
    name: text(details.name),
    outputType: text(details.output_type),
    datasetCategory: text(details.dataset_category),
    dfmMethod: text(details.dfm_method),
    modelType: choice(details.model_type, BST_MODEL_OPTIONS, "odp_single_scale"),
    residualType: choice(residuals.residual_type, BST_RESIDUAL_TYPE_OPTIONS, "scaled_bias_adjusted_zero_average"),
    showScaleValues: residuals.show_scale_values === true,
    residualScaleSmoothing: numberOrNull(residuals.residual_scale_smoothing) ?? 0,
    forecastScaleSmoothing: numberOrNull(residuals.forecast_scale_smoothing) ?? 0,
    userScaleValuesResiduals: Array.isArray(residuals.user_scale_values_residuals)
      ? residuals.user_scale_values_residuals.map(numberOrNull)
      : [],
    userScaleValuesForecasting: Array.isArray(residuals.user_scale_values_forecasting)
      ? residuals.user_scale_values_forecasting.map(numberOrNull)
      : [],
    estimationVariance: choice(simulation.estimation_variance, BST_DISTRIBUTION_OPTIONS, "gamma"),
    processVariance: choice(simulation.process_variance, BST_DISTRIBUTION_OPTIONS, "gamma"),
    simulationCount: Number.isFinite(count) && count > 0 ? count : 10000,
    randomSeed: Number.isFinite(seed) && seed >= 0 ? seed : 0,
    preventNegativeData: simulation.prevent_negative_data !== false,
    negativeMeanAction: choice(simulation.negative_mean_action, BST_NEGATIVE_MEAN_OPTIONS, "normal"),
    odpNegativeMeanAction: choice(
      simulation.odp_negative_mean_action,
      BST_ODP_NEGATIVE_MEAN_OPTIONS,
      "negative_mean",
    ),
    targetUltimate: text(results.target_ultimate),
    targetScalingMethods: Array.isArray(results.target_scaling_methods)
      ? results.target_scaling_methods.map((value) => choice(value, BST_SCALING_OPTIONS, "additive"))
      : [],
    targetCvs: Array.isArray(results.target_cvs) ? results.target_cvs.map((value) => numberOrNull(value) ?? 0) : [],
  };
}

/* The method to send to Save: the loaded method (or a new skeleton) with every
   edited setting written back. Writing back what readBootstrapSettings read
   leaves the method unchanged, so an untouched page saves exactly what it
   loaded. */
export function applyBootstrapSettings(method, settings) {
  const next = clone(method && typeof method === "object" ? method : {}) || {};
  next.json_format = BST_JSON_FORMAT;
  const s = settings || {};
  next.details_tab = {
    ...tab(next, "details_tab"),
    name: text(s.name),
    method_type: BST_METHOD_TYPE,
    output_type: text(s.outputType),
    dataset_category: text(s.datasetCategory),
    dfm_method: text(s.dfmMethod),
    model_type: s.modelType,
  };
  next.residuals_tab = {
    ...tab(next, "residuals_tab"),
    residual_type: s.residualType,
    show_scale_values: !!s.showScaleValues,
    residual_scale_smoothing: Number(s.residualScaleSmoothing) || 0,
    forecast_scale_smoothing: Number(s.forecastScaleSmoothing) || 0,
    user_scale_values_residuals: (s.userScaleValuesResiduals || []).slice(),
    user_scale_values_forecasting: (s.userScaleValuesForecasting || []).slice(),
  };
  next.simulation_tab = {
    ...tab(next, "simulation_tab"),
    estimation_variance: s.estimationVariance,
    process_variance: s.processVariance,
    simulation_count: s.simulationCount,
    random_seed: s.randomSeed,
    prevent_negative_data: !!s.preventNegativeData,
    negative_mean_action: s.negativeMeanAction,
    odp_negative_mean_action: s.odpNegativeMeanAction,
  };
  next.results_tab = {
    ...tab(next, "results_tab"),
    target_ultimate: text(s.targetUltimate),
    target_scaling_methods: (s.targetScalingMethods || []).slice(),
    target_cvs: (s.targetCvs || []).slice(),
  };
  return next;
}

/* The over-dispersed Poisson negative-mean choice only matters when one of the
   two distributions is ODP, so the page disables it otherwise. */
export function odpNegativeMeanApplies(settings) {
  return settings?.estimationVariance === "odp" || settings?.processVariance === "odp";
}

export function newRandomSeed(random = Math.random) {
  return 1 + Math.floor(random() * MAX_SEED);
}



/* A snapshot of exactly what a run depends on, so the page can tell whether
   the run on screen still describes the settings on screen. Name, output
   type, category, the scale-values display switch and notes do not change a
   run. */
export function runInputSnapshot(settings) {
  const {
    name: _name,
    outputType: _outputType,
    datasetCategory: _datasetCategory,
    showScaleValues: _showScaleValues,
    ...inputs
  } = settings || {};
  return JSON.stringify(inputs);
}

/* The header chip. A run in flight wins; then whether a run is on screen at
   all, and whether it was made from the settings on screen. */
export function bootstrapRunState({ hasRun = false, settingsMatchRun = true, running = false } = {}) {
  if (running) return { key: "running", label: "Simulating" };
  if (!hasRun) return { key: "not-run", label: "Not run yet" };
  if (!settingsMatchRun) return { key: "changed", label: "Inputs changed — run again" };
  return { key: "current", label: "Up to date" };
}

export function residualGrid(method, residualType) {
  const values = tab(method, "residuals_tab").residual_values;
  const grid = values && typeof values === "object" ? values[residualType] : null;
  return Array.isArray(grid) ? grid.map((row) => (Array.isArray(row) ? row.map(numberOrNull) : [])) : [];
}

export function residualFlagThreshold(grid) {
  let sum = 0;
  let count = 0;
  for (const row of grid || []) {
    for (const value of row || []) {
      const n = numberOrNull(value);
      if (n === null) continue;
      sum += n * n;
      count += 1;
    }
  }
  if (!count) return null;
  const rms = Math.sqrt(sum / count);
  return rms > 0 ? rms * BST_RESIDUAL_FLAG_MULTIPLE : null;
}

export function flagLargeResiduals(grid) {
  const threshold = residualFlagThreshold(grid);
  return (grid || []).map((row) => (row || []).map((value) => {
    const n = numberOrNull(value);
    return threshold !== null && n !== null && Math.abs(n) >= threshold;
  }));
}

/* Column captions for the residual grid: the DFM's development labels, with
   the tail period the model adds after them. */
export function residualColumnLabels(method, columnCount) {
  const snapshot = tab(tab(method, "details_tab"), "dfm_snapshot");
  const labels = Array.isArray(snapshot.development_labels) ? snapshot.development_labels.map(text) : [];
  return Array.from({ length: columnCount }, (_, index) => labels[index] || (index === labels.length ? "Tail" : String(index + 1)));
}


/* One row per origin for the Targets tab, then a total. Target reserve and the
   unscaled mean come from the last save; the scaling method and CV are the
   page's current settings. */
export function targetRows(method, settings) {
  const results = tab(method, "results_tab");
  const origins = originLabels(method);
  const summary = simulationSummary(method);
  const unscaledMean = Array.isArray(summary?.unscaled?.mean) ? summary.unscaled.mean : [];
  const targetReserves = Array.isArray(results.target_reserve_values) ? results.target_reserve_values : [];
  const targetUltimates = Array.isArray(results.target_ultimate_values) ? results.target_ultimate_values : [];
  const scaling = settings?.targetScalingMethods || [];
  const cvs = settings?.targetCvs || [];
  const derive = (targetReserve, mean) => ({
    difference: targetReserve !== null && mean !== null ? targetReserve - mean : null,
    ratio: targetReserve !== null && mean !== null && mean !== 0 ? targetReserve / mean : null,
  });
  const rows = origins.map((origin, index) => {
    const targetReserve = numberOrNull(targetReserves[index]);
    const mean = numberOrNull(unscaledMean[index + 1]);
    return {
      origin,
      index,
      targetUltimate: numberOrNull(targetUltimates[index]),
      targetReserve,
      scalingMethod: scaling[index] || "additive",
      cv: numberOrNull(cvs[index]) ?? 0,
      unscaledMean: mean,
      ...derive(targetReserve, mean),
    };
  });
  const sum = (key) => {
    const values = rows.map((row) => row[key]).filter((value) => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const totalReserve = sum("targetReserve");
  const totalMean = numberOrNull(unscaledMean[0]);
  return {
    rows,
    total: {
      origin: "Total",
      targetUltimate: sum("targetUltimate"),
      targetReserve: totalReserve,
      unscaledMean: totalMean,
      ...derive(totalReserve, totalMean),
    },
  };
}

/* The Results views are shared with the Stochastic Consolidation page and
   live in the reserve-range model; they are re-exported here under the
   names this page and its tests have always used. */
export {
  rangeSummary as simulationSummary,
  hasRangeRun as hasSimulationRun,
  rangeOriginLabels as originLabels,
  RANGE_DEFAULT_PERCENTILES as BST_DEFAULT_PERCENTILES,
  RANGE_MAX_PERCENTILES as BST_MAX_PERCENTILES,
  RANGE_LADDER_PERCENTILES as BST_LADDER_PERCENTILES,
  RANGE_BASIS_OPTIONS as BST_BASIS_OPTIONS,
  RANGE_MEASURE_OPTIONS as BST_MEASURE_OPTIONS,
  percentileKey,
  percentileLabel,
  formatPercentileList,
  parsePercentileList,
  availableBases,
  resultsView,
  summaryTableColumns,
  ladderTableRows,
  resultsClipboardText,
  resultsCsvText,
  fanChartBands,
  fanChartData,
  distributionChartData,
  formatAxisTick,
  formatRunDuration,
} from "../../shared/components/reserve_range/reserve_range_model.js?v=20260923a";
