/*
===============================================================================
Berquist Sherman User Value entries
Pure helpers behind the editable "User Value" row of the Case Reserve Adequacy
"Avg. Selections" grids. A cell holds either a plain number or a formula: the
formula language is the DFM User Entry language minus its row and dataset
references - numbers, `+ - * /`, parentheses, `ROUND(x, digits)`, and external
Excel references such as `='C:\Folder\[Book.xlsx]Sheet 1'!$B$2`. The evaluated
number is what the calculation and the server-side refresh read; the formula
text is kept beside it so the cell can be refreshed, hard-coded, and listed on
the Links tab.
===============================================================================
*/
import {
  containsExcelReference,
  excelColumnFromIndex,
  findExcelReferences,
  formatExcelReference,
  normalizeExcelReferenceAddressCase,
  parseStandaloneExcelRange,
} from "/ui/shared/integrations/excel_reference.js?v=20260715a";
import { roundHalfUp } from "/ui/method_pages/dfm/dfm_ratio_calc.js";

const USER_VALUE_FORMULA_ERROR = "Enter a number, a formula, or an Excel cell reference.";

function text(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeUserValueInputs(values, count) {
  const source = Array.isArray(values) ? values : [];
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => text(source[index]));
}

export function isUserValueFormula(raw) {
  const value = text(raw);
  return value.startsWith("=") || containsExcelReference(value);
}

/**
 * A typed number: thousands separators are dropped, a blank clears the cell.
 * Returns `{ ok, value }` where `value` is `null` for a blank entry.
 */
export function parseUserValueNumber(raw) {
  const value = text(raw).replace(/,/gu, "");
  if (!value) return { ok: true, value: null };
  const number = Number(value);
  return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, value: null };
}

/**
 * Same arithmetic whitelist as the DFM User Entry evaluator
 * (`evaluateSimpleMathExpression` in ratios_summary/summary_model.js): after
 * every reference is replaced by its number the expression may hold only
 * digits, `+ - * / ( ) . ,`, whitespace, and `ROUND(`. Returns `null` when the
 * text is not such an expression.
 */
export function evaluateUserValueArithmetic(rawExpression) {
  let expr = text(rawExpression);
  if (expr.startsWith("=")) expr = expr.slice(1).trim();
  if (!expr) return null;
  expr = expr.replace(/\bround\s*\(/giu, "ROUND(");
  if (!/^(?:[0-9+\-*/().,\s]|ROUND\()+$/u.test(expr)) return null;
  if (expr.includes("**")) return null;
  try {
    const out = Function("ROUND", `"use strict"; return (${expr});`)(
      (value, digits = 0) => roundHalfUp(Number(value), Number(digits)),
    );
    return Number.isFinite(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

export function excelSourceKey(reference) {
  return [
    text(reference?.bookPath).toLowerCase(),
    text(reference?.sheet).toLowerCase(),
    text(reference?.cell).toUpperCase(),
    text(reference?.endCell || reference?.cell).toUpperCase(),
  ].join("\u001f");
}

export function userValueExcelReferences(raw) {
  const value = text(raw);
  if (!containsExcelReference(value)) return [];
  return findExcelReferences(value.startsWith("=") ? value : `=${value}`);
}

/**
 * One read item per distinct workbook cell across the given inputs, in the
 * shape `/excel/read_cells_batch` and `/excel/validate_links` take.
 */
export function excelReadItemsForInputs(inputs) {
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(inputs) ? inputs : []) {
    for (const reference of userValueExcelReferences(raw)) {
      const key = excelSourceKey(reference);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key, book_path: reference.bookPath, sheet: reference.sheet, cell: reference.cell });
    }
  }
  return items;
}

/**
 * Evaluates one User Value formula. `excelValues` maps `excelSourceKey` to the
 * number read from the workbook; a reference with no readable number is an
 * error naming the cell, as is anything the arithmetic whitelist refuses.
 */
export function evaluateUserValueFormula(raw, excelValues = new Map()) {
  let expr = normalizeExcelReferenceAddressCase(text(raw));
  if (expr.startsWith("=")) expr = expr.slice(1).trim();
  const references = userValueExcelReferences(expr);
  for (const reference of references) {
    if (reference.cell !== reference.endCell) {
      throw new Error(`${reference.sheet}!${reference.cell}:${reference.endCell} is a range; a formula may only read single cells.`);
    }
    const value = numberOrNull(excelValues.get(excelSourceKey(reference)));
    if (value === null) {
      throw new Error(`${reference.filename} ${reference.sheet}!${reference.cell} has no numeric value.`);
    }
    expr = expr.replace(new RegExp(escapeRegExp(reference.match), "gu"), `(${value})`);
  }
  const result = evaluateUserValueArithmetic(expr);
  if (result === null) throw new Error(USER_VALUE_FORMULA_ERROR);
  return result;
}

/**
 * A pasted or typed range such as `='C:\[Book.xlsx]Sheet'!B2:E2` fills the
 * row to the right of the anchor column: each column gets its own single-cell
 * reference, so every cell stays self-contained. Only the range's first row is
 * used - the grid has one User Value row - and columns past the grid are
 * dropped. Returns `null` when the text is not a standalone range.
 */
export function expandUserValueRangeEntry(raw, startColumn, columnCount) {
  const range = parseStandaloneExcelRange(text(raw));
  if (!range) return null;
  const entries = [];
  for (let offset = 0; offset < range.colCount; offset += 1) {
    const column = Number(startColumn) + offset;
    if (column >= Number(columnCount)) break;
    const cell = `${excelColumnFromIndex(range.col0 + offset)}${range.row0 + 1}`;
    entries.push({ column, input: formatExcelReference(range.bookPath, range.sheet, cell) });
  }
  return entries;
}

function columnSpan(labels) {
  const first = text(labels[0]);
  const last = text(labels[labels.length - 1]);
  return first === last ? first : `${first}~${last}`;
}

/**
 * Groups every Excel reference the User Value rows read by source cell, the
 * way the DFM Links tab does, so one workbook cell read by two columns is one
 * row. `grids` is `[{ scope, label, inputs, columnLabels }]`.
 */
export function collectUserValueExcelLinkGroups(grids) {
  const groups = new Map();
  for (const grid of Array.isArray(grids) ? grids : []) {
    const inputs = Array.isArray(grid?.inputs) ? grid.inputs : [];
    inputs.forEach((raw, column) => {
      for (const reference of userValueExcelReferences(raw)) {
        const key = excelSourceKey(reference);
        if (!groups.has(key)) {
          groups.set(key, { id: key, reference, consumers: [] });
        }
        const group = groups.get(key);
        if (!group.consumers.some((item) => item.scope === grid.scope && item.column === column)) {
          group.consumers.push({ scope: grid.scope, gridLabel: text(grid.label), column });
        }
      }
    });
  }
  return groups;
}

/** Records in the shape `createLinksTab` renders. */
export function buildUserValueLinkRecords(grids) {
  const labelsByScope = new Map(
    (Array.isArray(grids) ? grids : []).map((grid) => [grid.scope, Array.isArray(grid.columnLabels) ? grid.columnLabels : []]),
  );
  return Array.from(collectUserValueExcelLinkGroups(grids).values()).map((group) => {
    const byGrid = new Map();
    for (const consumer of group.consumers) {
      if (!byGrid.has(consumer.scope)) byGrid.set(consumer.scope, { label: consumer.gridLabel, columns: [] });
      byGrid.get(consumer.scope).columns.push(consumer.column);
    }
    const destination = Array.from(byGrid.entries()).map(([scope, entry]) => {
      const labels = labelsByScope.get(scope) || [];
      const columns = entry.columns.slice().sort((a, b) => a - b);
      return `${entry.label} / ${columnSpan(columns.map((column) => labels[column] ?? String(column + 1)))}`;
    }).join("; ");
    return {
      id: group.id,
      workbookPath: group.reference.bookPath,
      worksheet: group.reference.sheet,
      address: group.reference.cell,
      destination,
      affectedCellCount: group.consumers.length,
    };
  });
}
