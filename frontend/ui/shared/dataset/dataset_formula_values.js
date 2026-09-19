import { parseDatasetFormula, evaluateDatasetFormula } from "/ui/shared/dataset/dataset_formula.js?v=20260917a";
import { resolveFormulaDatasets } from "/ui/shared/components/formula_bar/formula_api.js?v=20260917a";
import { readExcelCellsBatch } from "/ui/shared/integrations/excel_api.js?v=20260919a";
import { excelColumnFromIndex, parseExcelCellAddress } from "/ui/shared/integrations/excel_reference.js?v=20260715a";

export function substituteFormulaRowValues(raw, referenceValues) {
  let text = String(raw || "");
  if (!(referenceValues instanceof Map)) return text;
  const entries = [...referenceValues].filter(([label, value]) => label && Number.isFinite(Number(value)))
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  for (const [label, value] of entries) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const pattern of [`"${escaped}"`, `'${escaped}'`, escaped]) text = text.replace(new RegExp(pattern, "g"), String(Number(value)));
  }
  return text;
}

/** Read references without editing any target cell, then use the shared evaluator. */
export async function evaluateFormulaValues(raw, options = {}) {
  const parsed = typeof raw === "string" ? parseDatasetFormula(substituteFormulaRowValues(raw, options.referenceValues)) : raw;
  if (!parsed.ok) return parsed;
  const key = token => `${token.kind}\u001f${token.canonical}`;
  const matrices = new Map();
  try {
    const internal = parsed.references.filter(token => token.kind !== "excel");
    const texts = internal.map(token => `=${token.canonical}`);
    let resolved;
    if (texts.length && options.resolveReferences) {
      const response = await options.resolveReferences(texts);
      if (!response?.ok) throw new Error(response?.data?.detail || response?.data?.error || "Dataset reference could not be resolved.");
      resolved = (response.data?.results || []).map(item => {
        if (!item.row_count || !item.column_count || item.cells?.length !== item.row_count * item.column_count) throw new Error("Dataset reference response is incomplete.");
        return { rows: item.row_count, cols: item.column_count, values: Array.from({ length: item.row_count }, (_, r) => item.cells.slice(r * item.column_count, (r + 1) * item.column_count).map(cell => cell.value ?? null)) };
      });
      if (resolved.length !== texts.length) throw new Error("Dataset reference response is incomplete.");
    } else resolved = await resolveFormulaDatasets(texts, options.identity, options.signal);
    internal.forEach((token, index) => matrices.set(key(token), resolved[index]));
    const items = [];
    const spans = parsed.references.filter(token => token.kind === "excel").map(token => {
      const start = parseExcelCellAddress(token.parsed.cell), end = parseExcelCellAddress(token.parsed.endCell || token.parsed.cell);
      const rows = Math.abs(start.row - end.row) + 1, cols = Math.abs(start.col - end.col) + 1, offset = items.length;
      for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
        for (let c = Math.min(start.col, end.col); c <= Math.max(start.col, end.col); c++) {
          items.push({ book_path: token.parsed.bookPath, sheet: token.parsed.sheet, cell: `${excelColumnFromIndex(c)}${r + 1}` });
        }
      }
      return { token, rows, cols, offset };
    });
    if (items.length) {
      const response = await (options.readCellsBatch || readExcelCellsBatch)(items, { signal: options.signal });
      if (!response?.ok || response.results?.length !== items.length) throw new Error(response?.error || "Excel range read failed.");
      const values = response.results.map((result, index) => {
        if (!result.ok) throw new Error(`${items[index].cell}: ${result.error || "Excel read failed."}`);
        if (result.value == null || result.value === "") return null;
        const number = Number(result.value);
        if (!Number.isFinite(number)) throw new Error(`${items[index].cell}: Excel returned a non-numeric value: ${String(result.value)}`);
        return number;
      });
      spans.forEach(({ token, rows, cols, offset }) => matrices.set(key(token), { rows, cols, values: Array.from({ length: rows }, (_, r) => values.slice(offset + r * cols, offset + (r + 1) * cols)) }));
    }
    return evaluateDatasetFormula(parsed.tree, token => matrices.get(key(token)), { round: options.round });
  } catch (error) {
    return { ok: false, aborted: error.name === "AbortError", error: error.message || String(error) };
  }
}
