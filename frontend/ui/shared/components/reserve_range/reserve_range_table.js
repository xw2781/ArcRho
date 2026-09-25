/* Markup for a reserve range's Results table, shared by the Bootstrap and the
   Stochastic Consolidation pages: the summary table by origin with a total
   row, or the full ladder (statistics down the side, origins and the total
   across). The reserve-range model decides the rows and columns; this module
   only formats them. Class names take the page's prefix (cssPrefix), so each
   page styles its own table. */

import { ladderTableRows, summaryTableColumns } from "./reserve_range_model.js?v=20260924a";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function escapeRangeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// One formatter per decimal count: toLocaleString with options builds a new
// one per call, which took seconds over a 0.01% ladder's 100,000 cells.
const numberFormats = new Map();

export function formatRangeNumber(value, decimals = 0) {
  const n = numberOrNull(value);
  if (n === null) return "";
  // A value that rounds to zero shows as 0, not -0.
  const shown = Math.abs(n) < 0.5 * 10 ** -decimals ? 0 : n;
  if (!numberFormats.has(decimals)) {
    numberFormats.set(decimals, new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  }
  return numberFormats.get(decimals).format(shown);
}

export function formatRangePercent(value, decimals = 1) {
  const n = numberOrNull(value);
  return n === null ? "" : `${(n * 100).toFixed(decimals)}%`;
}

// A selected cell copies its raw figure, so a percentage copies as its fraction.
function cell(prefix, value, kind, extra = "") {
  const shown = kind === "percent" ? formatRangePercent(value) : formatRangeNumber(value);
  const raw = numberOrNull(value);
  return `<td class="${prefix}Cell${extra ? ` ${extra}` : ""}" data-copy-value="${raw === null ? "" : raw}">${shown}</td>`;
}

/* The summary table: one row per origin, then the total. */
export function summaryTableMarkup(view, percentiles, { cssPrefix = "bst" } = {}) {
  const p = cssPrefix;
  const columns = summaryTableColumns(view.measure, percentiles, { dfm: view.hasDfm !== false });
  const head = `<tr><th class="${p}OriginHead">Origin</th>${
    columns.map((column) => `<th>${escapeRangeHtml(column.label)}</th>`).join("")}</tr>`;
  const rowMarkup = (row, total) => `<tr${total ? ` class="${p}TotalRow"` : ""}>
    <td class="${p}OriginCell">${escapeRangeHtml(row.label)}</td>${
    columns.map((column) => cell(p, column.value(row), column.kind)).join("")}</tr>`;
  const body = view.rows.map((row) => rowMarkup(row, false)).join("") + rowMarkup(view.total, true);
  return { head, body };
}

/* The full ladder: statistics down the side, the chosen percentiles marked. */
export function ladderTableMarkup(view, percentiles, { cssPrefix = "bst", interval } = {}) {
  const p = cssPrefix;
  const rows = ladderTableRows(view, percentiles, interval);
  const head = `<tr><th class="${p}OriginHead">Statistic</th>${
    view.rows.map((row) => `<th>${escapeRangeHtml(row.label)}</th>`).join("")}<th>Total</th></tr>`;
  const body = rows.map((row) => `<tr${row.chosen ? ` class="${p}ChosenRow"` : ""}>
    <td class="${p}OriginCell">${escapeRangeHtml(row.label)}</td>${
    row.values.map((value, index) => cell(p, value, row.kind, index === row.values.length - 1 ? `${p}TotalCell` : "")).join("")}</tr>`).join("");
  return { head, body };
}
