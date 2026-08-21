/**
 * Project Settings - loading skeleton rows.
 *
 * Canonical builder for the flowing placeholder every ribbon page shows while
 * it reads the project folder over the network. Source Data renders its own
 * markup because its column list is not a table, but the row count and the bar
 * class come from here, so the six tabs stay one visual state.
 *
 * Painting lives in project_settings_skeleton.css.
 */

/** Placeholder rows a busy page shows. Enough to fill a short panel. */
export const SKELETON_ROW_COUNT = 7;

/** Class that carries the flowing fill. */
export const SKELETON_BAR_CLASS = "ps-skeleton-bar";

/** Class that marks a placeholder table row. */
export const SKELETON_ROW_CLASS = "ps-skeleton-row";

function ownerTable(tbody) {
  return tbody?.closest?.("table") || null;
}

/**
 * Column count of the table as it is currently rendered.
 *
 * Reserving Class Types rebuilds its own header and colgroup, so the count is
 * read from the live header rather than kept as a second copy here.
 */
function renderedColumnCount(tbody, fallback) {
  const table = ownerTable(tbody);
  const headerCells = table?.querySelectorAll?.("thead tr:last-child th")?.length || 0;
  if (headerCells > 0) return headerCells;
  const cols = table?.querySelectorAll?.("colgroup col")?.length || 0;
  if (cols > 0) return cols;
  const requested = Number(fallback);
  return Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 3;
}

/**
 * Replace a table body with placeholder rows and mark the table busy.
 *
 * Pair every call with clearTableSkeletonRows so the busy flag cannot outlive
 * the read it describes.
 */
export function renderTableSkeletonRows(tbody, options = {}) {
  if (!tbody) return;
  const columns = renderedColumnCount(tbody, options.columns);
  const requestedRows = Number(options.rows);
  const rows = Number.isFinite(requestedRows) && requestedRows > 0
    ? Math.floor(requestedRows)
    : SKELETON_ROW_COUNT;

  tbody.innerHTML = "";
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const tr = document.createElement("tr");
    tr.className = SKELETON_ROW_CLASS;
    tr.setAttribute("aria-hidden", "true");
    for (let colIndex = 0; colIndex < columns; colIndex++) {
      const td = document.createElement("td");
      const bar = document.createElement("i");
      bar.className = SKELETON_BAR_CLASS;
      td.appendChild(bar);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  ownerTable(tbody)?.setAttribute("aria-busy", "true");
}

/** Drop the busy flag once real rows or an empty message take over. */
export function clearTableSkeletonRows(tbody) {
  if (!tbody) return;
  ownerTable(tbody)?.setAttribute("aria-busy", "false");
}
