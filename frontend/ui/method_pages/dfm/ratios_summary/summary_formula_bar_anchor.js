/*
===============================================================================
DFM Ratios Summary Formula Bar Anchoring
Places the floating formula bar over the cell — or the linked dynamic array —
it edits, follows the array under the pointer, and owns the click that shows or
hides it.
===============================================================================
*/
import {
  registerSummaryFunctions,
  summaryRuntime,
} from "/ui/method_pages/dfm/ratios_summary/summary_runtime.js?v=20260812d";
import {
  computeFormulaBarLayout,
  FORMULA_BAR_FRAME_INSET_PX,
  getFormulaBarContentWidth,
  invalidateFormulaBarWidthCache,
} from "/ui/shared/components/formula_bar/formula_bar_layout.js?v=20260812a";

const isSummaryFormulaEditSessionActive = (...args) => summaryRuntime.isSummaryFormulaEditSessionActive(...args);
const isSummaryFormulaBarInputEditing = (...args) => summaryRuntime.isSummaryFormulaBarInputEditing(...args);
const isSummaryFormulaCommitPending = (...args) => summaryRuntime.isSummaryFormulaCommitPending(...args);
const isUserEntryConfig = (...args) => summaryRuntime.isUserEntryConfig(...args);
const updateSummaryFormulaBarForCell = (...args) => summaryRuntime.updateSummaryFormulaBarForCell(...args);
const refreshSummaryFormulaBar = (...args) => summaryRuntime.refreshSummaryFormulaBar(...args);
const hideSummaryFormulaBar = (...args) => summaryRuntime.hideSummaryFormulaBar(...args);
const scheduleSummaryFormulaBarValidationTooltipPosition = (...args) => (
  summaryRuntime.scheduleSummaryFormulaBarValidationTooltipPosition(...args)
);

/**
 * Identity of what the bar would show for a cell: a linked dynamic array counts
 * as one target, so clicking any of its cells toggles the same bar.
 */
function summaryFormulaBarTargetKey(cell) {
  if (!cell?.dataset) return "";
  const anchorRowId = String(cell.dataset.excelRangeAnchorRowId || "");
  const anchorCol = String(cell.dataset.excelRangeAnchorCol || "");
  if (anchorRowId && anchorCol) return `range:${anchorRowId},${anchorCol}`;
  const rowId = String(cell.dataset.r || "");
  const col = String(cell.dataset.col || "");
  return rowId && col !== "" ? `cell:${rowId},${col}` : "";
}

/**
 * Pressing a User Entry cell toggles its formula bar. This runs on the capture
 * phase of mousedown, before either interaction mode has selected the cell —
 * selecting it shows the bar on its own, so reading the bar's state any later
 * would see this very press's result and the first press would read as "hide
 * what is showing".
 */
function toggleSummaryFormulaBarForCell(summaryTable, cell) {
  if (!summaryTable || !cell) return;
  if (!isUserEntryConfig(summaryRuntime.summaryRowMap.get(String(cell.dataset.r || "")))) return;
  // Never fight an edit in progress.
  if (isSummaryFormulaEditSessionActive(summaryTable)) return;
  const input = document.getElementById("dfmSummaryFormulaBarInput");
  if (input && (isSummaryFormulaBarInputEditing(input) || isSummaryFormulaCommitPending(input))) return;
  const key = summaryFormulaBarTargetKey(cell);
  if (!key) return;
  if (String(summaryRuntime.summaryFormulaBarVisibleKey || "") === key) {
    summaryRuntime.summaryFormulaBarSuppressedKey = key;
    hideSummaryFormulaBar();
    return;
  }
  summaryRuntime.summaryFormulaBarSuppressedKey = "";
  updateSummaryFormulaBarForCell(cell);
}

/**
 * The cells the bar anchors itself to: every cell of the linked dynamic array
 * the target belongs to, or the target cell alone when it is a plain entry.
 */
function getSummaryFormulaBarAnchorCells(summaryTable, targetCell) {
  if (!summaryTable || !targetCell) return [];
  const anchorRowId = String(targetCell.dataset.excelRangeAnchorRowId || "");
  const anchorCol = String(targetCell.dataset.excelRangeAnchorCol || "");
  if (anchorRowId && anchorCol) {
    const rangeCells = summaryTable.querySelectorAll(
      `td.summaryCell[data-excel-range-anchor-row-id="${CSS.escape(anchorRowId)}"]`
      + `[data-excel-range-anchor-col="${CSS.escape(anchorCol)}"]`
    );
    if (rangeCells.length) return Array.from(rangeCells);
  }
  return [targetCell];
}

/**
 * What the bar is currently showing. Natural width depends only on this, so a
 * scroll or a reposition can reuse the last measurement.
 */
function summaryFormulaBarContentKey(barEl) {
  const input = barEl.querySelector("#dfmSummaryFormulaBarInput");
  const display = barEl.querySelector("#dfmSummaryFormulaBarDisplay");
  const label = barEl.querySelector("#dfmSummaryFormulaBarLabelText");
  // The "Validating…" chip takes layout space of its own while it is shown.
  const state = barEl.querySelector("#dfmSummaryFormulaBarState");
  const editing = !!input && input.style.display !== "none";
  return [
    editing ? "edit" : "display",
    state?.hidden === false ? String(state.textContent || "") : "",
    String(label?.textContent || ""),
    editing ? String(input?.value || "") : String(display?.textContent || ""),
    // Length-prefixed so no label or formula text can forge a part boundary.
  ].map((part) => `${part.length}:${part}`).join("|");
}

/**
 * Float the bar just above its anchor, sized to its own contents. Absolutely
 * positioned children of the scrolling host share the tables' coordinate space,
 * so the bar tracks the anchor through scrolling; the shared layout works in
 * viewport coordinates, which is what the conversion below undoes.
 */
function positionSummaryFormulaBar(barEl, summaryTable, targetCell) {
  if (!barEl || !summaryTable) return;
  const host = summaryTable.closest("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  if (!host) return;
  const rects = getSummaryFormulaBarAnchorCells(summaryTable, targetCell)
    .map((cell) => cell.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return;
  const anchorRect = {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };

  const hostRect = host.getBoundingClientRect();
  const scrollLeft = Number(host.scrollLeft || 0);
  const scrollTop = Number(host.scrollTop || 0);
  const layout = computeFormulaBarLayout({
    anchorRect,
    frame: {
      left: hostRect.left,
      right: hostRect.left + Number(host.clientWidth || 0) - FORMULA_BAR_FRAME_INSET_PX,
      // Where the tables' content starts, so "room above" is measured against the
      // grid rather than the window.
      top: hostRect.top - scrollTop,
    },
    contentWidth: getFormulaBarContentWidth(
      barEl,
      summaryFormulaBarContentKey(barEl),
      barEl.querySelector("#dfmSummaryFormulaBarInput"),
    ),
    barHeight: Number(barEl.offsetHeight || 0),
  });
  if (!layout) return;

  const px = `${layout.width}px`;
  barEl.style.width = px;
  barEl.style.minWidth = px;
  barEl.style.maxWidth = px;
  barEl.style.left = `${Math.round(layout.left - hostRect.left + scrollLeft)}px`;
  barEl.style.top = `${Math.round(layout.top - hostRect.top + scrollTop)}px`;
  scheduleSummaryFormulaBarValidationTooltipPosition();
}

/**
 * Re-anchor the bar against the cell it is already editing. Swapping between the
 * input and the rendered display changes how much room the formula needs — the
 * display draws each reference as a padded pill — so a mode change that skips
 * this leaves the bar at the other mode's width and clips the formula.
 */
function repositionSummaryFormulaBar(barEl = null) {
  const bar = barEl || document.getElementById("dfmSummaryFormulaBar");
  if (!bar?.isConnected || !bar.classList?.contains?.("isOpen")) return;
  const summaryTable = document.querySelector("#ratioWrap table.ratioSummaryTable");
  if (!summaryTable) return;
  const input = bar.querySelector("#dfmSummaryFormulaBarInput");
  const rowId = String(input?.dataset?.rowId || "");
  const col = Number(input?.dataset?.col);
  if (!rowId || !Number.isFinite(col) || col < 0) return;
  const cell = summaryTable.querySelector(
    `td.summaryCell[data-r="${CSS.escape(rowId)}"][data-col="${col}"]`,
  );
  if (!cell) return;
  positionSummaryFormulaBar(bar, summaryTable, cell);
}

/**
 * Point the bar at the linked dynamic array under the cursor. Leaving every
 * array hands the bar back to the active cell.
 */
function updateSummaryFormulaBarHoverTarget(summaryTable, hoverCell) {
  if (!summaryTable) return;
  // Retargeting mid-edit would move the pending formula onto another cell.
  if (isSummaryFormulaEditSessionActive(summaryTable)) return;
  const input = document.getElementById("dfmSummaryFormulaBarInput");
  if (input && (isSummaryFormulaBarInputEditing(input) || isSummaryFormulaCommitPending(input))) return;
  const arrayCell = hoverCell?.dataset?.excelRangeFormula ? hoverCell : null;
  const hoverKey = arrayCell
    ? `${arrayCell.dataset.excelRangeAnchorRowId || ""},${arrayCell.dataset.excelRangeAnchorCol || ""}`
    : "";
  if (hoverKey === String(summaryRuntime.summaryFormulaBarHoverKey || "")) return;
  summaryRuntime.summaryFormulaBarHoverCell = arrayCell;
  summaryRuntime.summaryFormulaBarHoverKey = hoverKey;
  if (arrayCell) updateSummaryFormulaBarForCell(arrayCell);
  else refreshSummaryFormulaBar();
}

/**
 * Pointer tracking sits on the scrolling host rather than the table: the bar is
 * a sibling overlay there, so pointing at the bar itself must not read as having
 * left the array it belongs to. The toggle runs on the capture phase of
 * mousedown so it behaves the same in Select and Edit mode, both of which select
 * the cell — and so show the bar — from their own later handlers.
 */
function wireSummaryFormulaBarPointer(summaryTable, listen) {
  const host = summaryTable?.closest?.("#ratioWrapHost") || document.getElementById("ratioWrapHost");
  if (!host || typeof listen !== "function") return;
  listen(host, "mousemove", (event) => {
    if (event.target?.closest?.("#dfmSummaryFormulaBar")) return;
    const hoverCell = event.target?.closest?.("td.summaryCell");
    updateSummaryFormulaBarHoverTarget(
      summaryTable,
      hoverCell && summaryTable.contains(hoverCell) ? hoverCell : null,
    );
  });
  listen(host, "mouseleave", () => updateSummaryFormulaBarHoverTarget(summaryTable, null));
  listen(host, "mousedown", (event) => {
    if (event.button) return;
    // The second press of a double-click opens the inline editor; leave it be,
    // or the bar would blink off and on under the editor.
    if (event.detail > 1) return;
    if (event.target?.closest?.("#dfmSummaryFormulaBar")) return;
    const cell = event.target?.closest?.("td.summaryCell");
    if (!cell || !summaryTable.contains(cell)) return;
    toggleSummaryFormulaBarForCell(summaryTable, cell);
  }, true);
}

registerSummaryFunctions({
  getSummaryFormulaBarAnchorCells,
  summaryFormulaBarTargetKey,
  toggleSummaryFormulaBarForCell,
  invalidateSummaryFormulaBarWidthCache: invalidateFormulaBarWidthCache,
  positionSummaryFormulaBar,
  repositionSummaryFormulaBar,
  updateSummaryFormulaBarHoverTarget,
  wireSummaryFormulaBarPointer,
});
