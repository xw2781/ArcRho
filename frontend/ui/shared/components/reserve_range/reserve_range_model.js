/* Pure view model for a reserve range: the Results views a Bootstrap and a
   Stochastic Consolidation share. Both methods store the same summary shape
   under results_tab.simulation_summary (a "scaled" block, and for a bootstrap
   an "unscaled" one), so one owner builds the rows by origin and total, the
   summary table's columns, the full ladder, the clipboard text, the percentile
   chooser, the fan bands and the distribution markers. Nothing here touches
   the DOM; the two chart modules beside it only draw what it hands them. */

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

export function rangeSummary(method) {
  const summary = tab(method, "results_tab").simulation_summary;
  return summary && typeof summary === "object" ? summary : null;
}

export function hasRangeRun(method) {
  const summary = rangeSummary(method);
  const mean = summary?.scaled?.mean;
  return Array.isArray(mean) && mean.some((value) => numberOrNull(value) !== null);
}

export function rangeOriginLabels(method) {
  const results = tab(method, "results_tab");
  const snapshot = tab(tab(method, "details_tab"), "dfm_snapshot");
  const labels = Array.isArray(results.origin_labels) && results.origin_labels.length
    ? results.origin_labels
    : snapshot.origin_labels;
  return Array.isArray(labels) ? labels.map(text) : [];
}

/* ---------------------------------------------------------------------------
   Every view reads the stored summary only; nothing is simulated or
   re-derived beyond adding the latest diagonal to turn a reserve into an
   ultimate. Index 0 of every stored vector is the all-origin total and 1..n
   are the origins; the percentile ladder holds every half percent, keyed by
   percent text ("5", "99.5").
--------------------------------------------------------------------------- */

export const RANGE_DEFAULT_PERCENTILES = Object.freeze([50, 75, 90, 95, 99, 99.5]);
export const RANGE_MAX_PERCENTILES = 12;

/* The full ladder's interval, as ResQ's Percentiles choice offers it. The
   stored ladder holds every half percent, so 5%, 1% and 0.5% read it as is;
   a finer interval needs its ladder worked out from a re-run. */
export const RANGE_STORED_LADDER_INTERVAL = "0.5";
export const RANGE_LADDER_INTERVAL_OPTIONS = Object.freeze([
  { value: "5", label: "5% Percentiles" },
  { value: "1", label: "1% Percentiles" },
  { value: "0.5", label: "0.5% Percentiles" },
  { value: "0.1", label: "0.1% Percentiles" },
  { value: "0.01", label: "0.01% Percentiles" },
]);

export function ladderIntervalIsStored(interval) {
  return Number.isInteger(Number(interval) / Number(RANGE_STORED_LADDER_INTERVAL));
}

/* Every percentile from 0 to 100 at an interval given in percent; index * 100
   / count is the correctly rounded percent, so its key matches the server's. */
export function ladderPercentiles(interval = RANGE_STORED_LADDER_INTERVAL) {
  const count = Math.round(100 / Number(interval));
  return Array.from({ length: count + 1 }, (_, index) => (index * 100) / count);
}

export const RANGE_LADDER_PERCENTILES = Object.freeze(ladderPercentiles());

export const RANGE_BASIS_OPTIONS = Object.freeze([
  { value: "scaled", label: "Scaled" },
  { value: "unscaled", label: "Unscaled" },
]);

export const RANGE_MEASURE_OPTIONS = Object.freeze([
  { value: "reserves", label: "Reserves" },
  { value: "ultimates", label: "Ultimates" },
]);

/* The stored ladder's key for a percentile given in percent. */
export function percentileKey(percent) {
  return String(Number(percent));
}

/* With an interval the label carries the interval's decimals, so a ladder's
   labels line up (0.10%, 0.11%) as ResQ's do. */
export function percentileLabel(percent, interval = null) {
  if (interval === null) return `${Number(percent)}%`;
  const decimals = (String(Number(interval)).split(".")[1] || "").length;
  return `${Number(percent).toFixed(decimals)}%`;
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
  if (values.size > RANGE_MAX_PERCENTILES) {
    return { ok: false, error: `Choose at most ${RANGE_MAX_PERCENTILES} percentiles.` };
  }
  return { ok: true, values: Array.from(values).sort((a, b) => a - b) };
}

/* Both bases exist once a run is stored; a summary without one of them offers
   only the other. */
export function availableBases(method) {
  const summary = rangeSummary(method);
  return RANGE_BASIS_OPTIONS
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
   reserve, so its percentiles are the reserve's moved by the latest. A finer
   ladder worked out for this basis (finerLadder, keyed as the stored one)
   adds its percentiles to the stored ones. */
export function resultsView(method, { basis = "scaled", measure = "reserves", finerLadder = null } = {}) {
  const summary = rangeSummary(method);
  const block = summary?.[basis];
  if (!block || !Array.isArray(block.mean) || !block.mean.length) return null;
  const origins = rangeOriginLabels(method);
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
  const ladder = {
    ...(block.percentiles && typeof block.percentiles === "object" ? block.percentiles : {}),
    ...(finerLadder || {}),
  };
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
    // A consolidation has no DFM of its own, so its views leave the DFM
    // columns and the fan chart's DFM line out.
    hasDfm: Array.isArray(summary.dfm_reserves),
  };
}

/* The summary table's columns for a measure and the chosen percentiles; the
   DFM columns only when the method has a DFM figure to compare with. */
export function summaryTableColumns(measure, percentiles, { dfm = true } = {}) {
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
    ...(dfm ? [
      { key: "dfm", label: ultimates ? "DFM Ultimate" : "DFM Reserve", kind: "number", value: (row) => row.dfm },
      { key: "difference", label: "Mean - DFM", kind: "number", value: (row) => row.difference },
    ] : []),
  ];
}

/* The full ladder is ResQ's Detail grid: statistics down the side, origins
   and the total across, every percentile at the interval from 0 to 100
   between the minimum and the maximum. The chosen percentiles are marked so
   they stay easy to find. */
export function ladderTableRows(view, percentiles = [], interval = RANGE_STORED_LADDER_INTERVAL) {
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
    ...ladderPercentiles(interval).map((percent) => ({
      key: `p${percentileKey(percent)}`,
      label: percentileLabel(percent, interval),
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
// The Results table as plain rows, header first: what Copy Table and
// Download CSV both hand out.
function resultsTableCells(view, { percentiles = [], fullLadder = false, interval = RANGE_STORED_LADDER_INTERVAL } = {}) {
  if (!view) return [];
  if (fullLadder) {
    return [
      ["Statistic", ...view.rows.map((row) => row.label), "Total"],
      ...ladderTableRows(view, percentiles, interval).map((row) => [row.label, ...row.values.map((value) => clipboardNumber(value, row.kind))]),
    ];
  }
  const columns = summaryTableColumns(view.measure, percentiles, { dfm: view.hasDfm !== false });
  return [
    ["Origin", ...columns.map((column) => column.label)],
    ...[...view.rows, view.total].map((row) => [row.label, ...columns.map((column) => clipboardNumber(column.value(row), column.kind))]),
  ];
}

export function resultsClipboardText(view, options = {}) {
  return resultsTableCells(view, options).map((cells) => cells.join("\t")).join("\r\n");
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultsCsvText(view, options = {}) {
  const lines = resultsTableCells(view, options).map((cells) => cells.map(csvField).join(","));
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
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
