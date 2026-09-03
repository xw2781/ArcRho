// Cell selection and copy for the Berquist Sherman method grids.
//
// Every calculation view renders into one or two `.bsMethodTable` grids, and
// each grid tags its value cells with `data-r`/`data-c` and the raw figure in
// `data-copy-value`. This module gives those grids the selection UX of the
// Dataset Viewer and Result Selection grids through the shared spreadsheet
// controller: a click selects one cell, a drag a rectangle, Shift-click extends
// from the anchor, Ctrl-click adds a range, a row label or column header
// selects the line, the arrow keys move or extend the range, Ctrl+C or the
// context menu copies the values as a tab-delimited matrix, and Escape clears
// the highlight. The two stacked grids of the Avg. Selections view are
// exclusive: a selection in one clears the other.
import { createSpreadsheetTableController } from "/ui/shared/components/spreadsheet/spreadsheet_table.js?v=20260715a";
import { scrollSpreadsheetCellIntoView } from "/ui/shared/components/spreadsheet/table_selection.js?v=20260726a";
import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js";

const CELL_SELECTOR = "td[data-r][data-c]";
const ROW_LABEL_SELECTOR = "td[data-r]:not([data-c])";
const COLUMN_HEADER_SELECTOR = "thead th[data-c]";
const ARROW_DELTAS = Object.freeze({
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
});

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest("input, textarea, select, option, button, [contenteditable='true']")
    || target.isContentEditable === true;
}

function positionOf(cell) {
  return { r: Number(cell?.dataset?.r), c: Number(cell?.dataset?.c) };
}

function tableBounds(table) {
  let maxRow = -1;
  let maxCol = -1;
  table.querySelectorAll(CELL_SELECTOR).forEach((cell) => {
    const { r, c } = positionOf(cell);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  });
  return { maxRow, maxCol };
}

export function createBerquistShermanCellSelection({
  tables = [],
  contextMenu = null,
  onContextAction = null,
  onCopied = null,
} = {}) {
  const entries = new Map();
  let activeKey = null;
  let drag = null;

  function activate(key) {
    if (activeKey && activeKey !== key) entries.get(activeKey)?.controller.clear();
    activeKey = key;
  }

  function activeEntry() {
    return activeKey ? entries.get(activeKey) || null : null;
  }

  function hasSelection(entry) {
    return !!entry && entry.controller.selection().ranges.length > 0;
  }

  function closeContextMenu() {
    if (contextMenu) contextMenu.style.display = "none";
  }

  function openMenu(event) {
    if (!contextMenu) return;
    openContextMenu(contextMenu, { clientX: event.clientX, clientY: event.clientY });
  }

  async function copyActive() {
    const entry = activeEntry();
    if (!entry) return false;
    return entry.controller.copy();
  }

  function clearAll() {
    entries.forEach(({ controller }) => controller.clear());
  }

  function applyDom() {
    entries.forEach(({ controller }) => controller.applyDom());
  }

  // Selects one cell of whichever grid holds it, as the page does when a User
  // Value cell takes keyboard focus, so the cell wears the shared anchor.
  function selectCell(cell) {
    const entry = Array.from(entries.values()).find((item) => item.table.contains(cell));
    if (!entry) return;
    activate(entry.key);
    entry.controller.selectCell(positionOf(cell));
  }

  function wireTable(entry) {
    const { key, table, controller } = entry;
    table.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || isTypingTarget(event.target)) return;
      const cell = event.target.closest(CELL_SELECTOR);
      if (!cell || !table.contains(cell)) return;
      activate(key);
      const append = (event.ctrlKey || event.metaKey) && !event.shiftKey;
      const baseRanges = append ? controller.selection().ranges : [];
      const position = positionOf(cell);
      controller.selectCell(position, { append, extend: event.shiftKey });
      drag = { key, anchor: controller.selection().anchorCell || position, append, baseRanges };
    });
    table.addEventListener("mouseover", (event) => {
      if (!drag || drag.key !== key) return;
      const cell = event.target.closest(CELL_SELECTOR);
      if (!cell || !table.contains(cell)) return;
      controller.setRange(drag.anchor, positionOf(cell), { append: drag.append, baseRanges: drag.baseRanges });
    });
    table.addEventListener("click", (event) => {
      if (isTypingTarget(event.target)) return;
      const settings = {
        append: (event.ctrlKey || event.metaKey) && !event.shiftKey,
        extend: event.shiftKey,
      };
      const rowLabel = event.target.closest(ROW_LABEL_SELECTOR);
      if (rowLabel && table.contains(rowLabel)) {
        activate(key);
        controller.selectRow(Number(rowLabel.dataset.r), settings);
        return;
      }
      const header = event.target.closest(COLUMN_HEADER_SELECTOR);
      if (!header || !table.contains(header)) return;
      activate(key);
      controller.selectColumn(Number(header.dataset.c), settings);
    });
    // A right-click inside a highlighted range keeps it; elsewhere it selects
    // the target first, and on a label it opens the menu for the grid as is.
    table.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const cell = event.target.closest(CELL_SELECTOR);
      if (cell && table.contains(cell)) {
        activate(key);
        controller.prepareContextCell(positionOf(cell));
      }
      openMenu(event);
    });
  }

  for (const { key, table, scrollHost = null } of tables) {
    if (!table) continue;
    const selection = { ranges: [], activeCell: null, anchorCell: null };
    const controller = createSpreadsheetTableController({
      getRoot: () => table,
      getBounds: () => tableBounds(table),
      readSelection: () => selection,
      writeSelection: ({ ranges, activeCell, anchorCell }) => {
        selection.ranges = ranges;
        selection.activeCell = activeCell;
        selection.anchorCell = anchorCell;
      },
      cellSelector: CELL_SELECTOR,
      rowHeaderSelector: ROW_LABEL_SELECTOR,
      columnHeaderSelector: COLUMN_HEADER_SELECTOR,
      getCellValue: (_position, cell) => cell?.dataset?.copyValue ?? "",
      onAfterCopy: onCopied,
      scrollCellIntoView: ({ r, c }) => {
        const cell = table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
        if (cell) scrollSpreadsheetCellIntoView(cell, scrollHost);
      },
    });
    const entry = { key, table, controller };
    entries.set(key, entry);
    wireTable(entry);
  }

  contextMenu?.addEventListener("click", (event) => {
    const item = event.target.closest(".ctx-item");
    if (!item) return;
    const action = item.dataset.action || "";
    closeContextMenu();
    if (action === "copy_value") void copyActive();
    else if (action === "remove_highlights") clearAll();
    else if (action && typeof onContextAction === "function") onContextAction(action);
  });

  document.addEventListener("mousedown", (event) => {
    if (contextMenu && contextMenu.style.display !== "none" && !contextMenu.contains(event.target)) {
      closeContextMenu();
    }
  }, true);
  document.addEventListener("mouseup", () => {
    drag = null;
  });

  // A grid cell that handled the key itself (the User Value row moves its own
  // active cell with Left and Right) has already prevented the default, so the
  // highlight is only moved for keys nobody else claimed.
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    if (event.key === "Escape") {
      closeContextMenu();
      const entry = activeEntry();
      if (!hasSelection(entry)) return;
      entry.controller.clear();
      event.preventDefault();
      return;
    }
    const delta = ARROW_DELTAS[event.key];
    if (delta && !event.altKey) {
      const entry = activeEntry();
      if (!entry || !entry.controller.selection().activeCell) return;
      const moved = entry.controller.move(delta[0], delta[1], {
        extend: event.shiftKey,
        jump: event.ctrlKey || event.metaKey,
      });
      if (!moved) return;
      event.preventDefault();
      // A focused cell would keep answering the next key for its own row, so
      // the keyboard follows the moved highlight instead.
      if (entry.table.contains(document.activeElement)) document.activeElement.blur();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== "c") return;
    if (!hasSelection(activeEntry())) return;
    event.preventDefault();
    void copyActive();
  });

  return { applyDom, clearAll, closeContextMenu, copyActive, selectCell };
}
