export function shouldShowDatasetGridTotals({ isDfmHost = false, formula = "" } = {}) {
  const normalizedFormula = String(formula || "").trim();
  if (isDfmHost) return !/[*/]/.test(normalizedFormula);
  return !normalizedFormula.includes("/");
}

function normalizeCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function getDatasetGridTotalLayout({
  rowCount = 0,
  columnCount = 0,
  showTotals = true,
  transposed = false,
} = {}) {
  const rows = normalizeCount(rowCount);
  const columns = normalizeCount(columnCount);
  const totalRowIndex = showTotals && !transposed ? rows : null;
  const totalColumnIndex = showTotals && transposed ? columns : null;
  return {
    rowCount: rows,
    columnCount: columns,
    totalRowIndex,
    totalColumnIndex,
    maxRow: totalRowIndex ?? (rows - 1),
    maxCol: totalColumnIndex ?? (columns - 1),
  };
}

function numericCellValue(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function sumDatasetGridRow(values, mask, rowIndex, columnCount) {
  let sum = 0;
  let count = 0;
  for (let columnIndex = 0; columnIndex < normalizeCount(columnCount); columnIndex += 1) {
    if (!mask?.[rowIndex]?.[columnIndex]) continue;
    const number = numericCellValue(values?.[rowIndex]?.[columnIndex]);
    if (number == null) continue;
    sum += number;
    count += 1;
  }
  return count > 0 ? sum : null;
}

export function sumDatasetGridColumn(values, mask, columnIndex, rowCount) {
  let sum = 0;
  let count = 0;
  for (let rowIndex = 0; rowIndex < normalizeCount(rowCount); rowIndex += 1) {
    if (!mask?.[rowIndex]?.[columnIndex]) continue;
    const number = numericCellValue(values?.[rowIndex]?.[columnIndex]);
    if (number == null) continue;
    sum += number;
    count += 1;
  }
  return count > 0 ? sum : null;
}
