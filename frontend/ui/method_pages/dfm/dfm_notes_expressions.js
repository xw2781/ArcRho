/*
===============================================================================
DFM Notes Expressions - the names a DFM note may use inside `{...}`

The whole grouped method JSON is exposed as nodes, so a note can walk it the
way the file is laid out: `{details_tab.name}`,
`{ratios_tab.ratio_triangle.development_labels(1)}`. Nested sections are
also reachable by their own name, `{ratio_triangle.development_label(1)}`,
and the most used values have flat shortcuts, `{ratio_value(1, 2)}`.
Positions are 1-based like the labels on screen; a negative position counts
back from the end, so `origin_label(-1)` is the latest origin.
===============================================================================
*/
import {
  describeNotesFunction,
  jsonToNotesValue,
} from "../../shared/tabs/notes/notes_expressions.js";

function tab(payload, key) {
  const value = payload?.[key];
  return value && typeof value === "object" ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function cell(value) {
  return value === undefined ? null : value;
}

function resolveIndex(position, count, what) {
  const number = Number(position);
  if (!Number.isInteger(number) || number === 0) {
    throw new Error(`${what} position must be a whole number, not ${String(position)}`);
  }
  const index = number > 0 ? number - 1 : count + number;
  if (index < 0 || index >= count) {
    throw new Error(`${what} ${number} is out of range (1-${count})`);
  }
  return index;
}

function cumulativeChain(selectedValues) {
  const chain = new Array(selectedValues.length).fill(null);
  let running = null;
  for (let index = selectedValues.length - 1; index >= 0; index -= 1) {
    const value = selectedValues[index];
    if (!Number.isFinite(value) || (index < selectedValues.length - 1 && !Number.isFinite(running))) {
      running = null;
      continue;
    }
    running = index === selectedValues.length - 1 ? value : value * running;
    chain[index] = running;
  }
  return chain;
}

const define = describeNotesFunction;

/**
 * Builds the expression context for one DFM method from its grouped JSON
 * payload (the object `buildDfmMethodPayload` returns).
 */
export function buildDfmNotesExpressionContext(payload) {
  const details = tab(payload, "details_tab");
  const data = tab(payload, "data_tab");
  const ratios = tab(payload, "ratios_tab");
  const triangle = tab(ratios, "ratio_triangle");
  const formulas = tab(ratios, "average_formulas");
  const curves = tab(payload, "curves_tab");
  const results = tab(payload, "results_tab");
  const metadata = tab(payload, "method_metadata");

  const originLabels = list(data.origin_labels).map((label) => String(label ?? ""));
  const developmentLabels = list(data.development_labels).map((label) => String(label ?? ""));
  const ratioDevelopmentLabels = list(triangle.development_labels).map((label) => String(label ?? ""));
  const inputValues = list(data.input_data_triangle_values);
  const ratioValues = list(triangle.ratio_values);
  const excluded = list(triangle.excluded);
  const formulaLabels = list(formulas.label).map((label) => String(label ?? ""));
  const formulaValues = list(formulas.values);
  const formulaSelected = list(formulas.selected);
  const selectedValues = list(curves.selected_values).map((value) => (Number.isFinite(value) ? value : null));
  const cumulative = cumulativeChain(selectedValues);
  const ultimateVector = list(results.ultimate_vector);
  const ratioBasisValues = list(results.ratio_basis_values);

  const origin = (position) => resolveIndex(position, originLabels.length, "origin");
  const development = (position) => resolveIndex(position, developmentLabels.length, "development period");
  const ratioColumn = (position) => resolveIndex(position, ratioDevelopmentLabels.length, "ratio column");
  const formulaRow = (row) => {
    if (typeof row === "string") {
      const index = formulaLabels.findIndex((label) => label.trim().toLowerCase() === row.trim().toLowerCase());
      if (index < 0) throw new Error(`no average formula named '${row}'`);
      return index;
    }
    return resolveIndex(row, formulaLabels.length, "average formula");
  };
  const latestColumn = (originIndex) => {
    const row = list(inputValues[originIndex]);
    for (let index = Math.min(row.length, developmentLabels.length) - 1; index >= 0; index -= 1) {
      if (Number.isFinite(row[index])) return index;
    }
    return -1;
  };

  const functions = {
    origin_label: define((i) => originLabels[origin(i)], "origin_label(i)", "Origin label at a position; -1 is the latest"),
    development_label: define((j) => developmentLabels[development(j)], "development_label(j)", "Development label at a position"),
    ratio_development_label: define((j) => ratioDevelopmentLabels[ratioColumn(j)], "ratio_development_label(j)", "Ratio column heading, e.g. (1) 12-24"),
    input_data_triangle_value: define((i, j) => cell(list(inputValues[origin(i)])[development(j)]), "input_data_triangle_value(i, j)", "Input triangle cell (origin, development)"),
    ratio_value: define((i, j) => cell(list(ratioValues[origin(i)])[ratioColumn(j)]), "ratio_value(i, j)", "Ratio triangle cell (origin, ratio column)"),
    excluded: define((i, j) => {
      const flag = list(excluded[origin(i)])[ratioColumn(j)];
      return flag === 1 || flag === true ? true : flag === 0 || flag === false ? false : null;
    }, "excluded(i, j)", "Whether a ratio cell is excluded"),
    average_formula_label: define((k) => formulaLabels[formulaRow(k)], "average_formula_label(k)", "Average formula row label"),
    average_formula_value: define((k, j) => cell(list(formulaValues[formulaRow(k)])[ratioColumn(j)]), "average_formula_value(k, j)", "Average formula value (row or label, ratio column)"),
    selected_average_formula: define((j) => {
      const column = ratioColumn(j);
      const row = formulaSelected.findIndex((flags) => Number(list(flags)[column]) === 1);
      return row < 0 ? null : formulaLabels[row];
    }, "selected_average_formula(j)", "Average formula selected in a ratio column"),
    selected_value: define((j) => cell(selectedValues[ratioColumn(j)]), "selected_value(j)", "Selected factor for a ratio column; the last is the tail"),
    cumulative_factor: define((j) => cell(cumulative[ratioColumn(j)]), "cumulative_factor(j)", "Factor to ultimate from a ratio column"),
    ultimate_value: define((i) => cell(ultimateVector[origin(i)]), "ultimate_value(i)", "Ultimate for an origin"),
    ratio_basis_value: define((i) => cell(ratioBasisValues[origin(i)]), "ratio_basis_value(i)", "Ratio Basis value for an origin"),
    percent_developed: define((i) => {
      const column = latestColumn(origin(i));
      const factor = column < 0 ? null : cumulative[column];
      return Number.isFinite(factor) && factor !== 0 ? 1 / factor : null;
    }, "percent_developed(i)", "Percentage developed for an origin"),
  };

  // The method JSON as it is laid out, one node per section, with the nested
  // ratios sections also reachable at the root.
  const sections = {};
  for (const key of ["details_tab", "data_tab", "ratios_tab", "curves_tab", "results_tab", "method_metadata"]) {
    sections[key] = jsonToNotesValue(tab(payload, key), key);
  }
  sections.ratio_triangle = jsonToNotesValue(triangle, "ratio_triangle");
  sections.average_formulas = jsonToNotesValue(formulas, "average_formulas");

  const values = {
    ...sections,
    name: String(details.name ?? ""),
    output_type: String(details.output_type ?? ""),
    output_dataset: String(details.output_dataset ?? ""),
    output_category: String(details.output_category ?? ""),
    input_triangle: String(details.input_triangle ?? ""),
    origin_length: cell(details.origin_length),
    development_length: cell(details.development_length),
    decimal_places: cell(details.decimal_places),
    origin_count: originLabels.length,
    development_count: developmentLabels.length,
    ratio_column_count: ratioDevelopmentLabels.length,
    average_formula_count: formulaLabels.length,
    selected_tail_factor: cell(selectedValues[selectedValues.length - 1]),
    ratio_basis_dataset: String(results.ratio_basis_dataset ?? ""),
    ultimate_ratio_decimal_places: cell(results.ultimate_ratio_decimal_places),
    last_modified: String(metadata.last_modified ?? ""),
    data_refreshed: String(metadata.data_refreshed ?? ""),
  };

  const catalog = [
    { snippet: "{name}", description: "Method name" },
    { snippet: "{input_triangle}", description: "Input triangle dataset" },
    { snippet: "{output_dataset}", description: "Output dataset" },
    { snippet: "{origin_label(1)}", description: "Origin label at a position; -1 is the latest" },
    { snippet: "{development_label(1)}", description: "Development label at a position" },
    { snippet: "{ratio_development_label(1)}", description: "Ratio column heading, e.g. (1) 12-24" },
    { snippet: "{input_data_triangle_value(1, 1)}", description: "Input triangle cell (origin, development)" },
    { snippet: "{ratio_value(1, 1)}", description: "Ratio triangle cell (origin, ratio column)" },
    { snippet: "{excluded(1, 1)}", description: "Whether a ratio cell is excluded" },
    { snippet: "{average_formula_label(1)}", description: "Average formula row label" },
    { snippet: "{average_formula_value(1, 1)}", description: "Average formula value (row or label, ratio column)" },
    { snippet: "{selected_average_formula(1)}", description: "Average formula selected in a ratio column" },
    { snippet: "{selected_value(1)}", description: "Selected factor for a ratio column; the last is the tail" },
    { snippet: "{cumulative_factor(1)}", description: "Factor to ultimate from a ratio column" },
    { snippet: "{selected_tail_factor}", description: "Selected tail factor" },
    { snippet: "{ultimate_value(1)}", description: "Ultimate for an origin" },
    { snippet: "{percent_developed(1):.1%}", description: "Percentage developed for an origin" },
    { snippet: "{ratio_basis_value(1)}", description: "Ratio Basis value for an origin" },
    { snippet: "{origin_count}", description: "Number of origins" },
    { snippet: "{development_count}", description: "Number of development periods" },
    { snippet: "{origin_length}", description: "Origin period length in months" },
    { snippet: "{development_length}", description: "Development period length in months" },
    { snippet: "{last_modified}", description: "Last saved" },
    { snippet: "{data_refreshed}", description: "Data last refreshed" },
    { snippet: "{details_tab.name}", description: "Any method JSON field by its path; type a dot to browse" },
    { snippet: "{ratio_triangle.development_labels(1)}", description: "A list in the JSON, called with a position" },
    { snippet: "{ratio_triangle.ratio_values(1, 1)}", description: "A triangle in the JSON, called with row and column" },
    { snippet: "{average_formulas.values(1, 1)}", description: "Average formula values by row and ratio column" },
  ];

  return { functions, values, catalog };
}
