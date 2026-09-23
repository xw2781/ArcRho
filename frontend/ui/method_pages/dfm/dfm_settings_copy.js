/*
===============================================================================
DFM settings copy - what "Load Settings From Another Method" takes from a
source DFM and what the open DFM keeps. A leaf module so the rule can be tested
without the page.

Copied from the source: the origin and development lengths, every average
formula row (labels, settings, User Entry formulas and values), the selected
row per column, the ratio exclusions where the origin and development labels
match, and the Curves tab choices.

Kept from the open DFM: its name, output type and output dataset, the input
triangle, the ratio decimal places, the cell notes, the Results tab choices,
and the Notes (which are not part of the method payload at all).

ResQ's own copy keeps the ratio decimal places too, so this follows ResQ there
rather than the plan's first draft. Per-column values follow their ratio
development label, so a column lands on the same age even when the two methods
started from different geometry; a column the source does not have starts
empty, and an exclusion the source does not have is included.
===============================================================================
*/

function tab(payload, key) {
  const value = payload && typeof payload === "object" ? payload[key] : null;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function labels(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()) : [];
}

function positiveInteger(value) {
  const number = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function textKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

// One row's cells moved from the source's column labels onto the target's.
// Without usable labels on both sides the row is copied by position.
function remapRow(row, sourceLabels, targetLabels, fill) {
  const source = Array.isArray(row) ? row : [];
  const width = targetLabels.length || source.length;
  const byLabel = sourceLabels.length && targetLabels.length;
  const lookup = new Map();
  if (byLabel) sourceLabels.forEach((label, index) => { if (!lookup.has(label)) lookup.set(label, index); });
  const out = [];
  for (let col = 0; col < width; col += 1) {
    const sourceCol = byLabel ? lookup.get(targetLabels[col]) : col;
    const value = sourceCol === undefined || sourceCol >= source.length ? fill : source[sourceCol];
    out.push(value === undefined ? fill : clone(value));
  }
  return out;
}

function remapMatrix(matrix, rowCount, sourceLabels, targetLabels, fill) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const out = [];
  for (let row = 0; row < rowCount; row += 1) {
    out.push(remapRow(rows[row], sourceLabels, targetLabels, fill));
  }
  return out;
}

function ratioLabels(payload) {
  return labels(tab(tab(payload, "ratios_tab"), "ratio_triangle")["development_labels"]);
}

function ratioOriginLabels(payload) {
  const ratio = tab(tab(payload, "ratios_tab"), "ratio_triangle");
  const own = labels(ratio["origin_labels"]);
  return own.length ? own : labels(tab(payload, "data_tab")["origin_labels"]);
}

/**
 * The lengths the open DFM must switch to before the copy, or null when they
 * already match. The caller reloads the input triangle at these lengths, so
 * the copy lands on the geometry the source was built for.
 */
export function dfmSettingsLengthChange(target, source) {
  const targetDetails = tab(target, "details_tab");
  const sourceDetails = tab(source, "details_tab");
  const originLength = positiveInteger(sourceDetails["origin_length"]);
  const developmentLength = positiveInteger(sourceDetails["development_length"]);
  if (!originLength || !developmentLength) return null;
  if (
    positiveInteger(targetDetails["origin_length"]) === originLength
    && positiveInteger(targetDetails["development_length"]) === developmentLength
  ) return null;
  return { originLength, developmentLength };
}

/**
 * The open DFM's payload with the source's settings laid over it. Nothing in
 * `target` or `source` is modified. The result is sent through the preview,
 * which recalculates every derived value from the kept input triangle.
 */
export function projectDfmSettingsCopy(target, source) {
  const merged = clone(target && typeof target === "object" ? target : {});
  const sourceDetails = tab(source, "details_tab");
  const details = { ...tab(merged, "details_tab") };
  for (const key of ["origin_length", "development_length"]) {
    const value = positiveInteger(sourceDetails[key]);
    if (value) details[key] = value;
  }
  merged["details_tab"] = details;

  const targetColumns = ratioLabels(merged);
  const sourceColumns = ratioLabels(source);
  const targetOrigins = ratioOriginLabels(merged);
  const sourceOrigins = ratioOriginLabels(source);

  const ratios = { ...tab(merged, "ratios_tab") };
  const ratioTriangle = { ...tab(ratios, "ratio_triangle") };
  const sourceRatios = tab(source, "ratios_tab");
  const sourceExcluded = tab(sourceRatios, "ratio_triangle")["excluded"];
  const sourceRows = new Map();
  sourceOrigins.forEach((label, index) => { if (!sourceRows.has(label)) sourceRows.set(label, index); });
  ratioTriangle["excluded"] = targetOrigins.map((origin) => {
    const sourceRow = sourceRows.get(origin);
    const row = sourceRow === undefined || !Array.isArray(sourceExcluded) ? [] : sourceExcluded[sourceRow];
    // A label pair the source lacks is included; only a named match can
    // carry an exclusion across.
    return remapRow(sourceRow === undefined ? [] : row, sourceColumns, targetColumns, 0)
      .map((value) => (Number(value) ? 1 : 0));
  });
  ratios["ratio_triangle"] = ratioTriangle;

  const sourceFormulas = tab(sourceRatios, "average_formulas");
  const formulaLabels = Array.isArray(sourceFormulas["label"]) ? sourceFormulas["label"].map((item) => String(item ?? "")) : [];
  if (formulaLabels.length) {
    const formulas = {
      label: formulaLabels,
      "custom_average_formula_settings": clone(sourceFormulas["custom_average_formula_settings"] || {}),
    };
    const fills = { selected: 0, values: null, inputs: "", "display_inputs": "" };
    for (const [key, fill] of Object.entries(fills)) {
      formulas[key] = remapMatrix(sourceFormulas[key], formulaLabels.length, sourceColumns, targetColumns, fill);
    }
    ratios["average_formulas"] = formulas;
  }
  merged["ratios_tab"] = ratios;

  const sourceCurves = tab(source, "curves_tab");
  if (Object.keys(sourceCurves).length) {
    // One Curves period per ratio column but the last (the tail column).
    const periodLabels = (list) => list.slice(0, Math.max(0, list.length - 1));
    const sourcePeriods = periodLabels(sourceColumns);
    const targetPeriods = periodLabels(targetColumns);
    const curves = {};
    for (const key of [
      "fitting_method",
      "future_development_periods",
      "free_fit_c",
      "selected_tail_factor",
      "selected_tail_curve",
    ]) {
      if (key in sourceCurves) curves[key] = clone(sourceCurves[key]);
    }
    if (Array.isArray(sourceCurves["included"])) {
      curves["included"] = remapRow(sourceCurves["included"], sourcePeriods, targetPeriods, 0);
    }
    if (Array.isArray(sourceCurves["selected_estimates"])) {
      curves["selected_estimates"] = remapRow(sourceCurves["selected_estimates"], sourcePeriods, targetPeriods, 1);
    }
    if (Array.isArray(sourceCurves["user_columns"])) {
      curves["user_columns"] = sourceCurves["user_columns"].map((column) => ({
        ...clone(column),
        values: remapRow(column?.values, sourcePeriods, targetPeriods, 1),
      }));
    }
    // The fitted chain is derived; the preview recalculates it.
    merged["curves_tab"] = curves;
  }
  return merged;
}

/**
 * The DFMs a class offers as a copy source, from the method-index response:
 * one row per method, sorted by name, without the open DFM.
 */
export function listDfmCopySources(indexPayload, { reservingClass = "", currentClass = "", currentMethodName = "" } = {}) {
  const sameClass = textKey(reservingClass) && textKey(reservingClass) === textKey(currentClass);
  const currentKey = textKey(currentMethodName);
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(indexPayload?.files) ? indexPayload.files : []) {
    if (textKey(item?.method_type) !== "dfm") continue;
    // An index row is named by its output dataset; `method_name` appears only
    // when the method's own name differs.
    const outputDataset = String(item?.name || item?.dataset_name || "").trim();
    const methodName = String(item?.method_name || outputDataset).trim();
    const key = textKey(methodName);
    if (!key || seen.has(key)) continue;
    if (sameClass && key === currentKey) continue;
    seen.add(key);
    rows.push({
      methodName,
      outputDataset: outputDataset || methodName,
      // The index stores 0 (Updated) or 2 (Needs Review); see review_status.js.
      status: Number(item?.status) === 2 ? "Needs Review" : "Updated",
    });
  }
  rows.sort((a, b) => a.methodName.localeCompare(b.methodName, undefined, { sensitivity: "base", numeric: true }));
  return rows;
}
