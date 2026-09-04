import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The browser mirror of arcrho_api/dfm_curves.py is pinned to the same ResQ
// fixture the Python module is tested against, so the Curves tab a person
// clicks through shows the numbers the saved method will carry.

const fitUrl = new URL("../ui/method_pages/dfm/dfm_curve_fit.js", import.meta.url).href;
const {
  CURVE_KINDS,
  FIT_OK,
  curvesTable,
  defaultCurvesTab,
  fitCurves,
  normalizeCurvesTab,
} = await import(fitUrl);

const FIXTURE = JSON.parse(await readFile(
  new URL("../../python-api/tests/fixtures/dfm_curves_resq_c12.json", import.meta.url),
  "utf8",
));

function tab(overrides = {}) {
  const base = defaultCurvesTab(FIXTURE.initial_selection.length, FIXTURE.initial_selection);
  base.included = FIXTURE.all_included.included.slice();
  return { ...base, ...overrides };
}

function close(actual, expected, places, message) {
  assert.ok(Math.abs(actual - expected) < 10 ** -places, `${message}: ${actual} vs ${expected}`);
}

test("log regression fits match ResQ's parameters and R-squared", () => {
  const fits = fitCurves(FIXTURE.initial_selection, FIXTURE.all_included.included);
  for (const kind of CURVE_KINDS) {
    const expected = FIXTURE.all_included.fits[kind];
    assert.equal(fits[kind].result, FIT_OK);
    for (const key of ["a", "b", "c", "r_squared"]) close(fits[kind][key], expected[key], 9, `${kind}.${key}`);
  }
});

test("fitted values and tails match ResQ for one and three future periods", () => {
  for (const [periods, key] of [[1, "tail_one_future_period"], [3, "tail_three_future_periods"]]) {
    const table = curvesTable(FIXTURE.initial_selection, FIXTURE.initial_tail, tab({ future_development_periods: periods }));
    for (const column of table.columns) {
      if (column.column_type !== "curve") continue;
      const expected = FIXTURE.all_included.values[column.key];
      [...column.values, ...column.future].forEach((got, index) => close(got, expected[index], 9, column.key));
      close(column.tail, FIXTURE.all_included[key][column.key], 6, `${column.key} tail`);
    }
  }
});

test("excluded periods and Free Fit C refit the curves the way ResQ does", () => {
  const excluded = FIXTURE.periods_5_and_7_excluded;
  const fits = fitCurves(FIXTURE.initial_selection, excluded.included);
  for (const kind of CURVE_KINDS) {
    for (const key of ["a", "b", "r_squared"]) close(fits[kind][key], excluded.fits[kind][key], 9, `${kind}.${key}`);
  }
  const free = FIXTURE.periods_5_and_7_excluded_free_fit_c;
  const freeFits = fitCurves(FIXTURE.initial_selection, free.included, { freeFitC: true });
  for (const key of ["a", "b", "c", "r_squared"]) close(freeFits.inverse_power[key], free.inverse_power[key], 6, key);
  const table = curvesTable(FIXTURE.initial_selection, FIXTURE.initial_tail, tab({ included: free.included, free_fit_c: true }));
  [...table.columns[2].values, ...table.columns[2].future].forEach((got, index) => (
    close(got, free.inverse_power_values[index], 6, "inverse power")
  ));
});

test("the selected chain, cumulative values and percentages follow the Ratios tab tail", () => {
  const table = curvesTable(FIXTURE.initial_selection, FIXTURE.initial_tail, tab());
  assert.equal(table.selected_tail, FIXTURE.initial_tail);
  table.cumulative.forEach((got, index) => close(got, FIXTURE.all_included.cumulative[index], 9, "cumulative"));
  table.cumulative_percentage.forEach((got, index) => (
    close(got, FIXTURE.all_included.cumulative_percentage[index], 9, "cumulative %")
  ));
  const percentages = FIXTURE.all_included.cumulative_percentage;
  close(table.incremental_percentage.at(-1), 1 - percentages.at(-2), 9, "tail increment");
  close(table.tail_rows[0].incremental_percentage, percentages.at(-1) - percentages.at(-2), 9, "tail pattern increment");
  // Running off along the inverse power curve, the first future row still
  // holds the whole tail and the last only its own factor.
  const runOff = curvesTable(FIXTURE.initial_selection, FIXTURE.initial_tail, tab({
    future_development_periods: 3, selected_tail_factor: 3, selected_tail_curve: 3,
  }));
  const inverse = FIXTURE.all_included.values.inverse_power.slice(9, 12);
  close(runOff.tail_rows[0].cumulative_value, inverse[0] * inverse[1] * inverse[2], 9, "future row 1");
  close(runOff.tail_rows[2].cumulative_value, inverse[2], 9, "future row 3");
  assert.ok(runOff.tail_rows[1].incremental_percentage > 0);
});

test("a curve or user column selection feeds the selected values and the tail", () => {
  const table = curvesTable(FIXTURE.initial_selection, FIXTURE.initial_tail, tab({
    selected_estimates: [1, 1, 2, 1, 1, 1, 1, 1, 6],
    selected_tail_factor: 3,
    user_columns: [{ label: "Aug 2024", column_type: "prior_analysis", values: new Array(9).fill(1.5), tail: 1.0017 }],
  }));
  close(table.selected_values[2], FIXTURE.all_included.values.exponential_decay[2], 9, "period 3");
  assert.equal(table.selected_values[8], 1.5);
  close(table.selected_tail, FIXTURE.all_included.tail_one_future_period.inverse_power, 9, "tail");
  assert.equal(table.columns[5].label, "Aug 2024");
});

test("defaults exclude factors outside ResQ's thresholds and stored flags win", () => {
  assert.deepEqual(defaultCurvesTab(4, [2.5, 1.2, 1, 1.00001]).included, [0, 1, 0, 1]);
  assert.deepEqual(normalizeCurvesTab({ included: [1, 0] }, 4, [2.5, 1.2, 1, 1.00001]).included, [1, 0, 0, 1]);
});
