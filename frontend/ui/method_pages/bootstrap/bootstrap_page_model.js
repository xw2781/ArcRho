/* Pure view model for the Bootstrap page: the settings a user edits, how they
   are read from and written back into the persisted method, and the derived
   rows the setup tabs show. Nothing here touches the DOM, so the page and its
   tests share one owner for every rule.

   The persisted contract itself is owned by
   python-api/src/arcrho_api/bootstrap_contract.py; the page only edits the
   owned fields the server's apply_owned_patch accepts and never computes a
   derived value the server would recompute on save. */

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

export function simulationSummary(method) {
  const summary = tab(method, "results_tab").simulation_summary;
  return summary && typeof summary === "object" ? summary : null;
}

export function hasSimulationRun(method) {
  const summary = simulationSummary(method);
  const mean = summary?.scaled?.mean;
  return Array.isArray(mean) && mean.some((value) => numberOrNull(value) !== null);
}

/* The header chip. A run in flight wins; otherwise a run exists once a summary
   is stored, and any unsaved edit means the stored run no longer describes the
   inputs on screen. */
export function bootstrapRunState({ method, dirty, running = false }) {
  if (running) return { key: "running", label: "Simulating" };
  if (dirty) return { key: "changed", label: "Inputs changed — run again" };
  if (!hasSimulationRun(method)) return { key: "not-run", label: "Not run yet" };
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

export function originLabels(method) {
  const results = tab(method, "results_tab");
  const snapshot = tab(tab(method, "details_tab"), "dfm_snapshot");
  const labels = Array.isArray(results.origin_labels) && results.origin_labels.length
    ? results.origin_labels
    : snapshot.origin_labels;
  return Array.isArray(labels) ? labels.map(text) : [];
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

/* ---------------------------------------------------------------------------
   Results. Every view reads the stored summary only; nothing is simulated or
   re-derived beyond adding the latest diagonal to turn a reserve into an
   ultimate. Index 0 of every stored vector is the all-origin total and 1..n
   are the origins; the percentile ladder holds every half percent, keyed by
   percent text ("5", "99.5").
--------------------------------------------------------------------------- */

export const BST_DEFAULT_PERCENTILES = Object.freeze([50, 75, 90, 95, 99, 99.5]);
export const BST_MAX_PERCENTILES = 12;
export const BST_LADDER_PERCENTILES = Object.freeze(Array.from({ length: 201 }, (_, step) => step / 2));

export const BST_BASIS_OPTIONS = Object.freeze([
  { value: "scaled", label: "Scaled" },
  { value: "unscaled", label: "Unscaled" },
]);

export const BST_MEASURE_OPTIONS = Object.freeze([
  { value: "reserves", label: "Reserves" },
  { value: "ultimates", label: "Ultimates" },
]);

/* The stored ladder's key for a percentile given in percent. */
export function percentileKey(percent) {
  return String(Number(percent));
}

export function percentileLabel(percent) {
  return `${Number(percent)}%`;
}

export function formatPercentileList(percentiles) {
  return (percentiles || []).map((value) => String(Number(value))).join(", ");
}

/* Reads the percentile chooser's text: numbers in percent, separated by commas
   or spaces, each a half-percent step from 0 to 100 so the stored ladder holds
   it. Returns the sorted, de-duplicated list, or the reason it was refused. */
export function parsePercentileList(value) {
  const parts = text(value).split(/[\s,;]+/u).map((part) => part.replace(/%$/u, "")).filter(Boolean);
  if (!parts.length) return { ok: false, error: "Enter at least one percentile." };
  const values = new Set();
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0 || n > 100 || !Number.isInteger(n * 2)) {
      return { ok: false, error: `${part} is not a percentile from 0 to 100 in steps of 0.5.` };
    }
    values.add(n);
  }
  if (values.size > BST_MAX_PERCENTILES) {
    return { ok: false, error: `Choose at most ${BST_MAX_PERCENTILES} percentiles.` };
  }
  return { ok: true, values: Array.from(values).sort((a, b) => a - b) };
}

/* Both bases exist once a run is stored; a summary without one of them offers
   only the other. */
export function availableBases(method) {
  const summary = simulationSummary(method);
  return BST_BASIS_OPTIONS
    .map((option) => option.value)
    .filter((basis) => Array.isArray(summary?.[basis]?.mean) && summary[basis].mean.length > 0);
}

function sumOrNull(values) {
  const finite = values.map(numberOrNull).filter((value) => value !== null);
  return finite.length ? finite.reduce((total, value) => total + value, 0) : null;
}

/* The rows every Results view is built from: one per origin, then the total.
   Each row knows its latest, mean, standard deviation, CV, extremes and any
   ladder percentile in the chosen measure, the mean of the other measure, and
   the DFM's figure in the chosen measure. An ultimate is the latest plus the
   reserve, so its percentiles are the reserve's moved by the latest. */
export function resultsView(method, { basis = "scaled", measure = "reserves" } = {}) {
  const summary = simulationSummary(method);
  const block = summary?.[basis];
  if (!block || !Array.isArray(block.mean) || !block.mean.length) return null;
  const origins = originLabels(method);
  const count = Math.max(origins.length, block.mean.length - 1);
  const resultsLatest = tab(method, "results_tab").latest_values;
  const latestSource = Array.isArray(summary.latest_values)
    ? summary.latest_values
    : Array.isArray(resultsLatest) ? resultsLatest : [];
  const dfmSource = Array.isArray(summary.dfm_reserves) ? summary.dfm_reserves : [];
  const originLatest = Array.from({ length: count }, (_, index) => numberOrNull(latestSource[index]));
  const originDfm = Array.from({ length: count }, (_, index) => numberOrNull(dfmSource[index]));
  const latest = [sumOrNull(originLatest), ...originLatest];
  const dfmReserve = [sumOrNull(originDfm), ...originDfm];
  const ultimates = measure === "ultimates";
  const ladder = block.percentiles && typeof block.percentiles === "object" ? block.percentiles : {};
  const at = (vector, index) => (Array.isArray(vector) ? numberOrNull(vector[index]) : null);
  const toUltimate = (value, index) => (value === null || latest[index] === null ? null : value + latest[index]);
  const shift = (value, index) => (ultimates ? toUltimate(value, index) : value);
  const build = (index, label, key) => {
    const reserveMean = at(block.mean, index);
    const ultimateMean = at(block.ultimate_mean, index) ?? toUltimate(reserveMean, index);
    const mean = ultimates ? ultimateMean : reserveMean;
    const sd = ultimates
      ? at(block.ultimate_standard_error, index) ?? at(block.standard_error, index)
      : at(block.standard_error, index);
    const dfm = shift(dfmReserve[index], index);
    return {
      key,
      label,
      latest: latest[index],
      mean,
      sd,
      // A CV means nothing for a zero or negative mean, so it is left blank.
      cv: mean !== null && sd !== null && mean > 1e-9 ? sd / mean : null,
      minimum: shift(at(block.minimum, index), index),
      maximum: shift(at(block.maximum, index), index),
      other: ultimates ? reserveMean : ultimateMean,
      dfm,
      difference: mean !== null && dfm !== null ? mean - dfm : null,
      percentile: (percent) => shift(at(ladder[percentileKey(percent)], index), index),
    };
  };
  const rows = Array.from({ length: count }, (_, index) => build(index + 1, origins[index] || String(index + 1), index));
  return {
    basis,
    measure,
    simulationCount: numberOrNull(summary.simulation_count),
    randomSeed: numberOrNull(summary.random_seed),
    rows,
    total: build(0, "Total", "total"),
    histogram: block.histogram && typeof block.histogram === "object" ? block.histogram : null,
  };
}

/* The summary table's columns for a measure and the chosen percentiles. */
export function summaryTableColumns(measure, percentiles) {
  const ultimates = measure === "ultimates";
  return [
    { key: "latest", label: "Latest", kind: "number", value: (row) => row.latest },
    { key: "mean", label: ultimates ? "Mean Ultimate" : "Mean Reserve", kind: "number", value: (row) => row.mean },
    { key: "sd", label: "Std. Deviation", kind: "number", value: (row) => row.sd },
    { key: "cv", label: "CV", kind: "percent", value: (row) => row.cv },
    ...(percentiles || []).map((percent) => ({
      key: `p${percentileKey(percent)}`,
      label: percentileLabel(percent),
      kind: "number",
      percentile: true,
      value: (row) => row.percentile(percent),
    })),
    { key: "other", label: ultimates ? "Mean Reserve" : "Mean Ultimate", kind: "number", value: (row) => row.other },
    { key: "dfm", label: ultimates ? "DFM Ultimate" : "DFM Reserve", kind: "number", value: (row) => row.dfm },
    { key: "difference", label: "Mean - DFM", kind: "number", value: (row) => row.difference },
  ];
}

/* The full ladder is ResQ's Detail grid: statistics down the side, origins
   and the total across, every half percent from 0 to 100 between the minimum
   and the maximum. The chosen percentiles are marked so they stay easy to
   find. */
export function ladderTableRows(view, percentiles = []) {
  if (!view) return [];
  const columns = [...view.rows, view.total];
  const chosen = new Set((percentiles || []).map(percentileKey));
  const stat = (key, label, kind, pick) => ({ key, label, kind, chosen: false, values: columns.map(pick) });
  return [
    stat("latest", "Latest", "number", (row) => row.latest),
    stat("mean", view.measure === "ultimates" ? "Mean Ultimate" : "Mean Reserve", "number", (row) => row.mean),
    stat("sd", "Std. Deviation", "number", (row) => row.sd),
    stat("cv", "CV", "percent", (row) => row.cv),
    stat("minimum", "Minimum", "number", (row) => row.minimum),
    ...BST_LADDER_PERCENTILES.map((percent) => ({
      key: `p${percentileKey(percent)}`,
      label: percentileLabel(percent),
      kind: "number",
      chosen: chosen.has(percentileKey(percent)),
      values: columns.map((row) => row.percentile(percent)),
    })),
    stat("maximum", "Maximum", "number", (row) => row.maximum),
  ];
}

function clipboardNumber(value, kind) {
  const n = numberOrNull(value);
  if (n === null) return "";
  return String(Number(n.toFixed(kind === "percent" ? 8 : 6)));
}

/* The table on screen as tab-separated text, numbers unformatted so they
   paste into a spreadsheet as numbers (a CV as a fraction). */
export function resultsClipboardText(view, { percentiles = [], fullLadder = false } = {}) {
  if (!view) return "";
  const lines = [];
  if (fullLadder) {
    lines.push(["Statistic", ...view.rows.map((row) => row.label), "Total"].join("\t"));
    for (const row of ladderTableRows(view, percentiles)) {
      lines.push([row.label, ...row.values.map((value) => clipboardNumber(value, row.kind))].join("\t"));
    }
  } else {
    const columns = summaryTableColumns(view.measure, percentiles);
    lines.push(["Origin", ...columns.map((column) => column.label)].join("\t"));
    for (const row of [...view.rows, view.total]) {
      lines.push([row.label, ...columns.map((column) => clipboardNumber(column.value(row), column.kind))].join("\t"));
    }
  }
  return lines.join("\r\n");
}

/* The fan chart's bands: one per symmetric pair of the chosen percentiles
   (choosing 95 draws 5% to 95%), widest first so the narrower bands paint over
   it. Choosing only the median draws no band. */
export function fanChartBands(percentiles) {
  const lowers = new Set();
  for (const percent of percentiles || []) {
    const n = Number(percent);
    if (!Number.isFinite(n) || n === 50) continue;
    lowers.add(Math.min(n, 100 - n));
  }
  return Array.from(lowers).sort((a, b) => a - b).map((lower) => ({ lower, upper: 100 - lower }));
}

export function fanChartData(view, percentiles) {
  if (!view) return null;
  return {
    labels: view.rows.map((row) => row.label),
    mean: view.rows.map((row) => row.mean),
    dfm: view.rows.map((row) => row.dfm),
    bands: fanChartBands(percentiles).map((band) => ({
      ...band,
      lowerValues: view.rows.map((row) => row.percentile(band.lower)),
      upperValues: view.rows.map((row) => row.percentile(band.upper)),
    })),
  };
}

/* The distribution chart: the stored histogram of the total reserve, moved by
   the total latest for ultimates, with the chosen percentiles and the mean
   marked on it. */
export function distributionChartData(view, percentiles) {
  const histogram = view?.histogram;
  const counts = Array.isArray(histogram?.counts) ? histogram.counts.map((value) => numberOrNull(value) ?? 0) : [];
  const lower = numberOrNull(histogram?.lower);
  const upper = numberOrNull(histogram?.upper);
  if (!counts.length || lower === null || upper === null) return null;
  const offset = view.measure === "ultimates" ? view.total.latest ?? 0 : 0;
  return {
    lower: lower + offset,
    upper: upper + offset,
    counts,
    total: counts.reduce((sum, value) => sum + value, 0),
    mean: view.total.mean,
    markers: (percentiles || [])
      .map((percent) => ({ percent: Number(percent), value: view.total.percentile(percent) }))
      .filter((marker) => marker.value !== null),
  };
}

/* A chart axis label: thousands as K and millions as M, with just enough
   decimals that neighbouring ticks never read the same (1.40M, 1.42M). */
export function formatAxisTick(value, step) {
  const n = numberOrNull(value);
  if (n === null) return "";
  const size = Math.max(Math.abs(n), Math.abs(numberOrNull(step) ?? 0));
  const [unit, suffix] = size >= 1e6 ? [1e6, "M"] : size >= 1e3 ? [1e3, "K"] : [1, ""];
  const scaledStep = Math.abs(numberOrNull(step) ?? 0) / unit;
  const decimals = scaledStep > 0 ? Math.min(3, Math.max(0, Math.ceil(-Math.log10(scaledStep) - 1e-9))) : 0;
  const shown = Math.abs(n) < 1e-9 ? 0 : n / unit;
  return `${shown.toFixed(decimals)}${shown === 0 ? "" : suffix}`;
}

export function formatRunDuration(milliseconds) {
  const ms = numberOrNull(milliseconds);
  if (ms === null || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}
