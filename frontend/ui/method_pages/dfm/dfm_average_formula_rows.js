/*
===============================================================================
DFM Average Formula Rows - infer summary row configs from canonical labels
===============================================================================
*/

function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function makeRowId(base, periods, exclude) {
  const periodPart = String(periods || "all").toLowerCase();
  if (!exclude) return `${base}_${periodPart}`;
  return `${base}_${periodPart}_ex_hi_lo${exclude > 1 ? `_x${exclude}` : ""}`;
}

const AVERAGE_FORMULA_SETTINGS_KEY = "custom average formula settings";

function cloneSummaryRow(row) {
  const next = { ...(row || {}) };
  if (Array.isArray(row?.values)) next.values = row.values.slice();
  if (Array.isArray(row?.inputs)) next.inputs = row.inputs.slice();
  if (Array.isArray(row?.formulas)) next.formulas = row.formulas.slice();
  return next;
}

export function buildDfmAverageFormulaObject(summaryRows, matrix, values) {
  const rows = Array.isArray(summaryRows) ? summaryRows : [];
  const out = {
    label: [],
    [AVERAGE_FORMULA_SETTINGS_KEY]: {
      averageType: [],
      base: [],
      periods: [],
      exclude: [],
    },
  };
  const settings = out[AVERAGE_FORMULA_SETTINGS_KEY];
  const inputs = [];
  let hasInputs = false;
  rows.forEach((row) => {
    out.label.push(normalizeLabel(row?.label || row?.id));
    settings.averageType.push(row?.averageType ?? "");
    settings.base.push(row?.base ?? "");
    settings.periods.push(row?.periods ?? "");
    settings.exclude.push(row?.exclude ?? 0);
    const rowInputs = Array.isArray(row?.inputs)
      ? row.inputs
      : Array.isArray(row?.formulas)
        ? row.formulas
        : null;
    const normalizedInputs = Array.isArray(rowInputs) ? rowInputs.map((value) => String(value ?? "").trim()) : [];
    if (normalizedInputs.some((value) => value)) hasInputs = true;
    inputs.push(normalizedInputs);
  });
  if (Array.isArray(matrix)) out.selected = matrix;
  if (Array.isArray(values)) out.values = values;
  if (hasInputs) out.inputs = inputs;
  return out;
}

export function getDfmAverageFormulaLabels(averageFormulas) {
  if (averageFormulas && typeof averageFormulas === "object" && Array.isArray(averageFormulas.label)) {
    return averageFormulas.label;
  }
  return [];
}

export function getDfmAverageFormulaSelectedIndex(averageFormulas) {
  if (averageFormulas && typeof averageFormulas === "object" && Array.isArray(averageFormulas.selected)) {
    return averageFormulas.selected;
  }
  return [];
}

export function getDfmAverageFormulaValues(averageFormulas) {
  if (averageFormulas && typeof averageFormulas === "object" && Array.isArray(averageFormulas.values)) {
    return averageFormulas.values;
  }
  return [];
}

export function getDfmAverageFormulaInputs(averageFormulas) {
  if (averageFormulas && typeof averageFormulas === "object" && Array.isArray(averageFormulas.inputs)) {
    return averageFormulas.inputs;
  }
  if (averageFormulas && typeof averageFormulas === "object" && Array.isArray(averageFormulas.formulas)) {
    return averageFormulas.formulas;
  }
  return [];
}

function getDfmAverageFormulaSettings(averageFormulas) {
  const settings = averageFormulas?.[AVERAGE_FORMULA_SETTINGS_KEY];
  return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
}

export function buildDfmSummaryRowsFromAverageFormulaObject(averageFormulas) {
  if (!averageFormulas || typeof averageFormulas !== "object" || Array.isArray(averageFormulas)) return null;
  const labels = getDfmAverageFormulaLabels(averageFormulas);
  if (!labels.length) return null;
  const settings = getDfmAverageFormulaSettings(averageFormulas);
  const inputs = getDfmAverageFormulaInputs(averageFormulas);
  return labels.map((label, index) => {
    const normalized = normalizeLabel(label);
    const inferred = resolveDfmAverageFormulaRowFromLabel(normalized) || {};
    const row = {
      ...inferred,
      label: normalized,
      averageType: settings.averageType?.[index] ?? inferred.averageType ?? "custom",
      base: settings.base?.[index] ?? inferred.base ?? "",
      periods: settings.periods?.[index] ?? inferred.periods ?? "all",
      exclude: settings.exclude?.[index] ?? inferred.exclude ?? 0,
    };
    const rowInputs = Array.isArray(inputs?.[index]) ? inputs[index].map((value) => String(value ?? "").trim()) : null;
    if (rowInputs && rowInputs.some((value) => value)) row.inputs = rowInputs;
    return row;
  });
}

function indexRowsByLabel(rows) {
  const byLabel = new Map();
  rows.forEach((row) => {
    const label = normalizeLabel(row?.label || row?.id);
    if (label && !byLabel.has(label.toLowerCase())) {
      byLabel.set(label.toLowerCase(), row);
    }
  });
  return byLabel;
}

export function resolveDfmAverageFormulaRowFromLabel(label) {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;

  const match = /^(volume|simple)\s*-\s*(all|[1-9]\d*)(?:\s+ex\s+hi\/lo(?:\s*x\s*([1-9]\d*))?)?$/i.exec(normalized);
  if (!match) return null;

  const base = match[1].toLowerCase();
  const periods = match[2].toLowerCase() === "all" ? "all" : Number(match[2]);
  const hasExclude = /\s+ex\s+hi\/lo/i.test(normalized);
  const exclude = hasExclude ? Number(match[3] || 1) : 0;

  return {
    id: makeRowId(base, periods, exclude),
    label: normalized,
    averageType: "custom",
    base,
    periods,
    exclude,
  };
}

export function buildDfmSummaryRowsFromAverageFormulas(summaryRows, formulas) {
  const sourceRows = Array.isArray(summaryRows) ? summaryRows.map(cloneSummaryRow) : [];
  if (!Array.isArray(formulas) || !formulas.length) {
    return { rows: Array.isArray(summaryRows) ? sourceRows : null, order: null, inferred: false };
  }

  const byLabel = indexRowsByLabel(sourceRows);
  const usedLabels = new Set();
  const usedIds = new Set();
  const rows = [];
  let inferred = false;

  formulas.forEach((formula) => {
    const label = normalizeLabel(formula);
    if (!label) return;
    const labelKey = label.toLowerCase();
    if (usedLabels.has(labelKey)) return;

    const existing = byLabel.get(labelKey);
    const row = existing ? cloneSummaryRow(existing) : resolveDfmAverageFormulaRowFromLabel(label);
    if (!row) return;

    if (!row.id) row.id = resolveDfmAverageFormulaRowFromLabel(label)?.id || `formula_${rows.length + 1}`;
    const rowId = String(row.id || "").trim();
    if (!rowId || usedIds.has(rowId)) return;

    rows.push(row);
    usedLabels.add(labelKey);
    usedIds.add(rowId);
    if (!existing) inferred = true;
  });

  return {
    rows: rows.length ? rows : (sourceRows.length ? sourceRows : null),
    order: rows.length ? rows.map((row) => String(row.id)).filter(Boolean) : null,
    inferred,
  };
}
