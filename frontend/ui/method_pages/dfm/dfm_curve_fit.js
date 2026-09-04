/*
===============================================================================
DFM Curve Fit - the browser mirror of arcrho_api/dfm_curves.py
===============================================================================
The Curves tab fits four curves to the Initial Selection (the Ratios tab's
selected factor per development period) by linear regression in log space,
the way ResQ's Log Regression fitting method does, and runs each curve off
over the Future Dev. Periods to give its tail factor. The Python module owns
the rules; this file repeats them so the tab can recompute as the user clicks,
and frontend/tests/dfm_curve_fit.test.mjs pins both to the same ResQ fixture.

  Exponential Decay  r = 1 + a * exp(b * t)         ln(r - 1) on t
  Inverse Power      r = 1 + a * (t + c) ** b       ln(r - 1) on ln(t + c)
  Power              r = a ** (b ** t)              ln(ln r) on t
  Weibull            r = 1 / (1 - exp(-a * t ** b)) ln(-ln(1 - 1 / r)) on ln t

t is 1 for the first development period. c comes from (-0.5, 0, 1, 3, 5) by
the best R-squared, or from a golden-section search over c > -1 with Free Fit C.
*/

export const CURVE_KINDS = Object.freeze(["exponential_decay", "inverse_power", "power", "weibull"]);
export const CURVE_LABELS = Object.freeze({
  exponential_decay: "Exponential Decay",
  inverse_power: "Inverse Power",
  power: "Power",
  weibull: "Weibull",
});
export const INITIAL_SELECTION_LABEL = "Initial Selection";
export const FIXED_COLUMN_COUNT = 1 + CURVE_KINDS.length;
export const FITTING_METHODS = Object.freeze(["log_regression", "least_squares"]);
export const DEFAULT_FITTING_METHOD = "log_regression";
export const USER_COLUMN_TYPES = Object.freeze(["user_entry", "prior_analysis", "pattern", "benchmark"]);
export const DEFAULT_USER_COLUMN_LABEL = "User Entry";
export const DEFAULT_FUTURE_DEVELOPMENT_PERIODS = 1;
export const MAX_FUTURE_DEVELOPMENT_PERIODS = 200;
const INVERSE_POWER_C_CANDIDATES = [-0.5, 0, 1, 3, 5];
const FREE_FIT_C_LOWER = -0.999;
const FREE_FIT_C_UPPER = 10;
const FREE_FIT_C_LIMIT = -0.5;
export const DEFAULT_EXCLUDE_ABOVE = 2;
export const DEFAULT_EXCLUDE_BELOW = 1.00001;
export const FIT_UNFITTED = "unfitted";
export const FIT_OK = "ok";
export const FIT_LIMIT = "limit";
export const FIT_FAIL = "fail";
export const FIT_WARNING = "warning";
const GOLDEN = (Math.sqrt(5) - 1) / 2;

function number(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function factor(value, fallback = 1) {
  const n = number(value);
  return n !== null && n > 0 ? n : fallback;
}

function flag(value) {
  return value === 1 || value === true || value === "1" || value === "true" ? 1 : 0;
}

function integer(value, fallback, minimum, maximum) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minimum, Math.min(maximum, n));
}

export function defaultIncluded(initialSelection) {
  return (Array.isArray(initialSelection) ? initialSelection : []).map((value) => {
    const n = number(value);
    return n !== null && n >= DEFAULT_EXCLUDE_BELOW && n <= DEFAULT_EXCLUDE_ABOVE ? 1 : 0;
  });
}

export function defaultCurvesTab(periodCount, initialSelection = []) {
  const count = Math.max(0, Number(periodCount) || 0);
  const selection = Array.isArray(initialSelection) ? initialSelection.slice(0, count) : [];
  const included = defaultIncluded(selection);
  while (included.length < count) included.push(0);
  return {
    fitting_method: DEFAULT_FITTING_METHOD,
    future_development_periods: DEFAULT_FUTURE_DEVELOPMENT_PERIODS,
    free_fit_c: false,
    included,
    user_columns: [
      { label: DEFAULT_USER_COLUMN_LABEL, column_type: "user_entry", values: new Array(count).fill(1), tail: 1 },
    ],
    selected_estimates: new Array(count).fill(1),
    selected_tail_factor: 1,
    selected_tail_curve: 1,
    selected_values: [],
  };
}

export function normalizeUserColumn(raw, periodCount) {
  const source = raw && typeof raw === "object" ? raw : {};
  let columnType = String(source.column_type || "user_entry").trim().toLowerCase();
  if (!USER_COLUMN_TYPES.includes(columnType)) columnType = "user_entry";
  const values = Array.isArray(source.values) ? source.values : [];
  return {
    label: String(source.label || DEFAULT_USER_COLUMN_LABEL).trim() || DEFAULT_USER_COLUMN_LABEL,
    column_type: columnType,
    values: Array.from({ length: periodCount }, (_, index) => factor(values[index])),
    tail: factor(source.tail),
  };
}

export function normalizeCurvesTab(raw, periodCount, initialSelection = []) {
  const count = Math.max(0, Number(periodCount) || 0);
  if (!raw || typeof raw !== "object" || !Object.keys(raw).length) return defaultCurvesTab(count, initialSelection);
  let fittingMethod = String(raw.fitting_method || DEFAULT_FITTING_METHOD).trim().toLowerCase();
  if (!FITTING_METHODS.includes(fittingMethod)) fittingMethod = DEFAULT_FITTING_METHOD;
  const selection = Array.isArray(initialSelection) ? initialSelection.slice(0, count) : [];
  const defaults = defaultIncluded(selection);
  while (defaults.length < count) defaults.push(0);
  const includedSource = Array.isArray(raw.included) ? raw.included : [];
  const included = Array.from({ length: count }, (_, index) => (
    index < includedSource.length ? flag(includedSource[index]) : defaults[index]
  ));
  const userColumns = Array.isArray(raw.user_columns)
    ? raw.user_columns.map((item) => normalizeUserColumn(item, count))
    : defaultCurvesTab(count).user_columns;
  const columnCount = FIXED_COLUMN_COUNT + userColumns.length;
  const columnNumber = (value) => integer(value, 1, 1, Math.max(1, columnCount));
  const selectedSource = Array.isArray(raw.selected_estimates) ? raw.selected_estimates : [];
  const selectedValuesSource = Array.isArray(raw.selected_values) ? raw.selected_values : [];
  const selectedValues = selectedValuesSource.length === count + 1
    ? selectedValuesSource.map((item) => number(item))
    : [];
  return {
    fitting_method: fittingMethod,
    future_development_periods: integer(
      raw.future_development_periods,
      DEFAULT_FUTURE_DEVELOPMENT_PERIODS,
      1,
      MAX_FUTURE_DEVELOPMENT_PERIODS,
    ),
    free_fit_c: !!raw.free_fit_c,
    included,
    user_columns: userColumns,
    selected_estimates: Array.from({ length: count }, (_, index) => (
      index < selectedSource.length ? columnNumber(selectedSource[index]) : 1
    )),
    selected_tail_factor: columnNumber(raw.selected_tail_factor),
    selected_tail_curve: columnNumber(raw.selected_tail_curve),
    selected_values: selectedValues.every((item) => item !== null) ? selectedValues : [],
  };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    syy += (ys[i] - meanY) ** 2;
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  return { intercept: meanY - slope * meanX, slope, rSquared: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1 };
}

function logPoints(kind, points, c = 0) {
  const xs = [];
  const ys = [];
  for (const [t, value] of points) {
    if (value <= 1) continue;
    if (kind === "exponential_decay") {
      xs.push(t);
      ys.push(Math.log(value - 1));
    } else if (kind === "inverse_power") {
      if (t + c <= 0) continue;
      xs.push(Math.log(t + c));
      ys.push(Math.log(value - 1));
    } else if (kind === "power") {
      xs.push(t);
      ys.push(Math.log(Math.log(value)));
    } else if (kind === "weibull") {
      xs.push(Math.log(t));
      ys.push(Math.log(-Math.log(1 - 1 / value)));
    }
  }
  return [xs, ys];
}

function fitKind(kind, points, c = 0) {
  const [xs, ys] = logPoints(kind, points, c);
  const regression = linearRegression(xs, ys);
  if (!regression) return null;
  const { intercept, slope, rSquared } = regression;
  if (kind === "power") {
    return { a: Math.exp(Math.exp(intercept)), b: Math.exp(slope), c: 0, r_squared: rSquared };
  }
  return { a: Math.exp(intercept), b: slope, c: kind === "inverse_power" ? c : 0, r_squared: rSquared };
}

function inversePowerRSquared(points, c) {
  const fit = fitKind("inverse_power", points, c);
  return fit ? fit.r_squared : -1;
}

function freeFitC(points) {
  let low = FREE_FIT_C_LOWER;
  let high = FREE_FIT_C_UPPER;
  let x1 = high - GOLDEN * (high - low);
  let x2 = low + GOLDEN * (high - low);
  let f1 = inversePowerRSquared(points, x1);
  let f2 = inversePowerRSquared(points, x2);
  for (let i = 0; i < 200; i++) {
    if (f1 < f2) {
      low = x1;
      x1 = x2;
      f1 = f2;
      x2 = low + GOLDEN * (high - low);
      f2 = inversePowerRSquared(points, x2);
    } else {
      high = x2;
      x2 = x1;
      f2 = f1;
      x1 = high - GOLDEN * (high - low);
      f1 = inversePowerRSquared(points, x1);
    }
    if (high - low < 1e-12) break;
  }
  return (low + high) / 2;
}

export function unfitted() {
  return { a: null, b: null, c: null, r_squared: null, result: FIT_UNFITTED };
}

export function fitCurves(initialSelection, included, { freeFitC: free = false } = {}) {
  const points = [];
  (Array.isArray(initialSelection) ? initialSelection : []).forEach((value, index) => {
    const n = number(value);
    if (n === null || !(index < included.length && flag(included[index]))) return;
    points.push([index + 1, n]);
  });
  const fits = {};
  for (const kind of CURVE_KINDS) {
    if (kind === "inverse_power") {
      if (free) {
        const c = freeFitC(points);
        const fit = fitKind(kind, points, c);
        if (!fit) {
          fits[kind] = unfitted();
          continue;
        }
        const firstPeriod = points.length ? Math.min(...points.map(([t]) => t)) : 1;
        fit.result = firstPeriod + c <= 0 ? FIT_WARNING : c < FREE_FIT_C_LIMIT ? FIT_LIMIT : FIT_OK;
        fits[kind] = fit;
        continue;
      }
      let best = null;
      for (const candidate of INVERSE_POWER_C_CANDIDATES) {
        const fit = fitKind(kind, points, candidate);
        if (fit && (!best || fit.r_squared > best.r_squared)) best = fit;
      }
      fits[kind] = best ? { ...best, result: FIT_OK } : unfitted();
      continue;
    }
    const fit = fitKind(kind, points);
    fits[kind] = fit ? { ...fit, result: FIT_OK } : unfitted();
  }
  return fits;
}

export function curveValue(kind, fit, t) {
  const a = number(fit?.a);
  const b = number(fit?.b);
  if (a === null || b === null) return null;
  let value;
  if (kind === "exponential_decay") {
    value = 1 + a * Math.exp(b * t);
  } else if (kind === "inverse_power") {
    const base = t + (number(fit.c) || 0);
    if (base <= 0) return null;
    value = 1 + a * base ** b;
  } else if (kind === "power") {
    value = a ** (b ** t);
  } else if (kind === "weibull") {
    value = 1 / (1 - Math.exp(-a * t ** b));
  } else {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function product(values) {
  let out = 1;
  for (const value of values) {
    if (value === null || value === undefined) return null;
    out *= value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Curves | Data table
// ---------------------------------------------------------------------------

export function curvesTable(initialSelection, initialTail, curvesTab) {
  const periodCount = initialSelection.length;
  const tab = normalizeCurvesTab(curvesTab, periodCount, initialSelection);
  const futureCount = tab.future_development_periods;
  const selection = initialSelection.map((value) => factor(value));
  const tail = factor(initialTail);
  const fits = fitCurves(selection, tab.included, { freeFitC: tab.free_fit_c });

  const columns = [{
    number: 1,
    key: "initial_selection",
    label: INITIAL_SELECTION_LABEL,
    column_type: "value",
    values: selection.slice(),
    // A non-fitted column runs off its whole tail in the first future period.
    future: [tail, ...new Array(futureCount - 1).fill(1)],
    tail,
    fit: null,
  }];
  CURVE_KINDS.forEach((kind, offset) => {
    const fit = fits[kind];
    const values = Array.from({ length: periodCount }, (_, i) => curveValue(kind, fit, i + 1));
    const future = Array.from({ length: futureCount }, (_, i) => curveValue(kind, fit, periodCount + 1 + i));
    columns.push({
      number: 2 + offset,
      key: kind,
      label: CURVE_LABELS[kind],
      column_type: "curve",
      values,
      future,
      tail: fit.result !== FIT_UNFITTED ? product(future) : null,
      fit,
    });
  });
  tab.user_columns.forEach((column, offset) => {
    columns.push({
      number: FIXED_COLUMN_COUNT + 1 + offset,
      key: `user_${offset + 1}`,
      label: column.label,
      column_type: column.column_type,
      values: column.values.slice(),
      future: [column.tail, ...new Array(futureCount - 1).fill(1)],
      tail: column.tail,
      fit: null,
    });
  });
  const byNumber = new Map(columns.map((column) => [column.number, column]));
  const pick = (n) => byNumber.get(n) || byNumber.get(1);

  const selectedValues = selection.map((value, index) => {
    const column = pick(tab.selected_estimates[index]);
    const candidate = column.values[index];
    return candidate === null || candidate === undefined ? value : candidate;
  });
  const tailColumn = pick(tab.selected_tail_factor);
  const selectedTail = tailColumn.tail === null || tailColumn.tail === undefined ? tail : tailColumn.tail;
  const patternColumn = pick(tab.selected_tail_curve);

  const chain = [...selectedValues, selectedTail];
  const cumulative = new Array(chain.length).fill(0);
  let running = 1;
  for (let index = chain.length - 1; index >= 0; index--) {
    running *= chain[index];
    cumulative[index] = running;
  }
  const cumulativePercentage = cumulative.map((value) => (value ? 1 / value : null));
  const incrementalPercentage = [];
  let previous = 0;
  cumulativePercentage.forEach((value, index) => {
    if (index === cumulativePercentage.length - 1) {
      incrementalPercentage.push(value !== null ? 1 - previous : null);
      return;
    }
    incrementalPercentage.push(value !== null ? value - previous : null);
    if (value !== null) previous = value;
  });

  // The first future period still carries the whole selected tail; each later
  // row is what remains once the pattern column's earlier periods have run off.
  const tailRows = [];
  let runningFuture = cumulative.length ? cumulative[cumulative.length - 1] : 1;
  const cumulativeFuture = new Array(futureCount).fill(null);
  for (let index = 0; index < futureCount; index++) {
    cumulativeFuture[index] = runningFuture;
    const value = patternColumn.future[index];
    runningFuture = value ? runningFuture / value : runningFuture;
  }
  for (let index = 0; index < futureCount; index++) {
    const cumulativeValue = cumulativeFuture[index];
    tailRows.push({
      period: periodCount + 1 + index,
      values: new Map(columns.map((column) => [column.number, column.future[index] ?? null])),
      selected_value: patternColumn.future[index] ?? null,
      cumulative_value: cumulativeValue,
      cumulative_percentage: cumulativeValue ? 1 / cumulativeValue : null,
    });
  }
  tailRows.forEach((row, index) => {
    const prior = index
      ? tailRows[index - 1].cumulative_percentage
      : cumulativePercentage.length > 1 ? cumulativePercentage[cumulativePercentage.length - 2] : 0;
    row.incremental_percentage = row.cumulative_percentage !== null ? row.cumulative_percentage - (prior || 0) : null;
  });

  return {
    curves_tab: tab,
    columns,
    fits,
    selected_values: selectedValues,
    selected_tail: selectedTail,
    selected_tail_column: tailColumn.number,
    selected_tail_pattern_column: patternColumn.number,
    cumulative,
    cumulative_percentage: cumulativePercentage,
    incremental_percentage: incrementalPercentage,
    tail_rows: tailRows,
  };
}

export function selectedDevelopmentFactors(initialSelection, initialTail, curvesTab) {
  const table = curvesTable(initialSelection, initialTail, curvesTab);
  return [...table.selected_values, table.selected_tail];
}
