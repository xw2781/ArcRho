// The review table's grid, rendered as a `pi-table`.
//
// "Sync Reserving Class with ResQ" shows its actions beside the Project
// Instance dataset table, and a reader who has just been reading that table
// should not have to learn a second one: this module renders the same markup
// the dataset table renders - a colgroup carrying an explicit width per
// column, a sticky header cell holding a sortable label, a filter button and a
// resize grip, and body rows painted by the shared `pi-table` selection rules -
// so shared/styles/pi_table.css dresses both, and the dark and high-contrast
// sheets that already target those class names dress this table too.
//
// What the dataset table has and this one does not: grouping. A review lists
// the actions of one sync run, so there is nothing to group by and no
// group-status strip above the table.
//
// Selection here means "accept this action", not "look at this row". Ticking a
// row is what the caller reads back, so a click anywhere on the row toggles its
// tick and the row carries the pi-table selection highlight while ticked -
// there is only ever one meaning of "selected" on screen. Shift-click paints
// the range from the anchor with the anchor's own new state, the way a
// spreadsheet extends a fill rather than a cursor.
//
// Column state - order, widths, sort, filters - lives for as long as the window
// is open. A review is a one-off decision, so nothing is persisted; the next
// review opens on its payload's own column order.

const BLANK_LABEL = "(blank)";
const COLUMN_DRAG_TYPE = "text/x-review-table-column";
const SELECT_COLUMN_WIDTH = 34;
const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 1200;
// What a column needs beyond its text: cell padding for a body cell, and for a
// header also the gap, the filter button, and room for the sort caret.
const AUTOFIT_CELL_EXTRA_WIDTH = 22;
const AUTOFIT_HEADER_EXTRA_WIDTH = 58;
const AUTOFIT_FALLBACK_CHAR_WIDTH = 7;
const DEFAULT_MAX_AUTO_WIDTH = 320;

function toText(value) {
  return value == null ? "" : String(value);
}

function filterKeyOf(value) {
  return toText(value).trim() || BLANK_LABEL;
}

function compareTextValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function svg(doc, viewBox, className, paths) {
  const namespace = "http://www.w3.org/2000/svg";
  const node = doc.createElementNS(namespace, "svg");
  node.setAttribute("viewBox", viewBox);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  if (className) node.setAttribute("class", className);
  for (const d of paths) {
    const path = doc.createElementNS(namespace, "path");
    path.setAttribute("d", d);
    node.appendChild(path);
  }
  return node;
}

// Same carets the dataset table draws, so an ascending column reads the same
// way in both tables.
function sortIcon(doc, dir) {
  return dir === "desc"
    ? svg(doc, "0 0 12 12", "pi-table-sort-icon", ["M6 9.5L2.2 4h7.6L6 9.5z"])
    : svg(doc, "0 0 12 12", "pi-table-sort-icon", ["M6 2.5L9.8 8H2.2L6 2.5z"]);
}

function filterIcon(doc) {
  return svg(doc, "0 0 16 16", "", ["M2 3h12L9.5 8v4l-3 1V8z"]);
}

// A payload writes a direction as the ASCII arrow its Python producer can put
// in a plain string - "ArcRho -> ResQ". Drawing that as two hyphen-ish glyphs
// is the one place this table looks typed rather than rendered, so the token is
// swapped for a real arrow at paint time. Only the spaced token is treated as
// an arrow, so a value like "a->b" is left exactly as it was written.
const ARROW_TOKEN = " -> ";

function arrowIcon(doc) {
  const icon = svg(doc, "0 0 16 16", "reviewTableArrow", ["M2.5 8h11", "M9.5 4.2 13.3 8l-3.8 3.8"]);
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", "to");
  icon.removeAttribute("aria-hidden");
  return icon;
}

/**
 * Fills `node` with `text`, drawing any arrow token as an SVG arrow.
 *
 * The surrounding text stays in text nodes rather than wrapper elements: the
 * cell's two-line clamp is a `-webkit-box` and the filter list ellipsises every
 * span it contains, so both would treat added spans as content of their own.
 * Text nodes also keep payload text incapable of becoming markup.
 */
function appendTextWithArrows(doc, node, text) {
  const parts = toText(text).split(ARROW_TOKEN);
  parts.forEach((part, index) => {
    if (index > 0) node.appendChild(arrowIcon(doc));
    if (part) node.appendChild(doc.createTextNode(part));
  });
  return node;
}

function element(doc, tag, className = "", text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = toText(text);
  return node;
}

let measureCanvas = null;

/**
 * Width the given text needs in `sample`'s font.
 *
 * The font is read off the rendered element rather than repeated here, so
 * pi_table.css stays the only place the table's typography is declared.
 */
function measureTextWidth(value, sample, doc) {
  const source = toText(value);
  if (!source) return 0;
  if (!measureCanvas) measureCanvas = doc.createElement("canvas");
  const ctx = measureCanvas.getContext?.("2d");
  const view = doc.defaultView;
  const style = sample && view ? view.getComputedStyle(sample) : null;
  if (!ctx || !style) return source.length * AUTOFIT_FALLBACK_CHAR_WIDTH;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText(source).width;
}

/**
 * Keeps a fixed menu inside the viewport, the same clamp the dataset table's
 * filter popover uses.
 */
function positionFixedMenu(node, x, y) {
  if (!node) return;
  const view = node.ownerDocument?.defaultView;
  if (!view) return;
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  const rect = node.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(rect.left, view.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(rect.top, view.innerHeight - rect.height - pad));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

/**
 * Renders the review rows as a pi-table inside `container`.
 *
 * `rows` and `columns` arrive already normalized by review_table.js. The view
 * owns only what the user does to the grid: order, width, sort, per-column
 * filters, and which rows are ticked. It reports every tick change through
 * `onSelectionChange`, and the panel around it owns the search box, the
 * counters, and the Accept/Cancel decision.
 */
export function createReviewTableView(settings = {}) {
  const doc = settings.documentRef || document;
  const container = settings.container;
  if (!container) throw new Error("Review table view requires a container.");
  const allRows = Array.isArray(settings.rows) ? settings.rows : [];
  const columnsByKey = new Map();
  // `row.cells` is indexed by the payload's column order and never moves, so a
  // dragged column must still read the cell it was normalized against.
  const cellIndexByKey = new Map();
  (Array.isArray(settings.columns) ? settings.columns : []).forEach((column, index) => {
    columnsByKey.set(column.key, column);
    cellIndexByKey.set(column.key, index);
  });
  const selectedIds = settings.selectedIds instanceof Set ? settings.selectedIds : new Set();
  // A read-only report draws no tick column and ignores row clicks; sorting,
  // filtering, and column handling stay exactly as they are for a review.
  const selectable = settings.selectable !== false;
  const onSelectionChange = typeof settings.onSelectionChange === "function"
    ? settings.onSelectionChange
    : () => {};
  const onViewChange = typeof settings.onViewChange === "function" ? settings.onViewChange : () => {};
  // The search predicate belongs to review_table.js, which also exports it to
  // callers; taking it as an argument keeps one implementation without this
  // module importing the module that imports it.
  const filterRows = typeof settings.filterRows === "function"
    ? settings.filterRows
    : (rows) => [...rows];

  let columnOrder = [...columnsByKey.keys()];
  const widths = new Map(columnOrder.map((key) => [key, columnsByKey.get(key).width || 0]));
  // A column the user dragged keeps that width; auto-fit only touches the rest,
  // so re-rendering after a tick never undoes a deliberate resize.
  const manualWidths = new Set();
  const filters = new Map();
  let sort = { key: "", dir: "asc" };
  let searchText = "";
  let autoFitPending = true;
  let visibleRows = [];
  let anchorId = "";
  let activeId = "";
  let columnDragStarted = false;
  let columnDragSourceKey = "";
  let columnDragImage = null;
  let filterColumn = "";
  let filterAnchor = null;
  let filterSearchText = "";

  const wrap = element(doc, "div", "pi-table-wrap reviewTableFrame");
  const surface = element(doc, "div", "pi-table-surface reviewTableSurface");
  surface.tabIndex = 0;
  surface.setAttribute("role", "group");
  surface.setAttribute("aria-label", "Review actions");
  const table = element(doc, "table", "pi-table");
  const empty = element(doc, "div", "pi-table-empty", "No actions match the current search.");
  empty.hidden = true;
  surface.append(table, empty);
  wrap.appendChild(surface);
  container.appendChild(wrap);

  // The popover is fixed-position chrome; it hangs off the document so a
  // scrolled or clipped table frame cannot cut it off.
  const popover = element(doc, "div", "pi-table-filter-popover reviewTableFilterPopover");
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Column filter");
  popover.setAttribute("aria-hidden", "true");
  doc.body.appendChild(popover);

  function orderedColumns() {
    return columnOrder.map((key) => columnsByKey.get(key)).filter(Boolean);
  }

  function clampWidth(key, width) {
    const column = columnsByKey.get(key);
    const minWidth = Math.max(MIN_COLUMN_WIDTH, Number(column?.minWidth) || 0);
    const value = Number(width);
    if (!Number.isFinite(value)) return Math.max(minWidth, Number(column?.width) || minWidth);
    return Math.max(minWidth, Math.min(MAX_COLUMN_WIDTH, Math.round(value)));
  }

  function totalWidth() {
    let total = SELECT_COLUMN_WIDTH;
    for (const key of columnOrder) total += widths.get(key) || MIN_COLUMN_WIDTH;
    return total;
  }

  /**
   * The pi-table column model: every column carries an explicit width, the
   * colgroup sets it, and the table is exactly as wide as their sum, so a drag
   * resizes only the dragged column instead of redistributing its neighbours.
   */
  function syncTableWidth() {
    const total = `${totalWidth()}px`;
    table.style.width = total;
    table.style.minWidth = total;
    for (const col of table.querySelectorAll("col[data-col-key]")) {
      const width = widths.get(col.dataset.colKey);
      if (width) col.style.width = `${width}px`;
    }
  }

  function setColumnWidth(key, width) {
    widths.set(key, clampWidth(key, width));
    syncTableWidth();
  }

  /**
   * Width that fits a column's header and its rendered cells, capped by the
   * column's `maxAutoWidth`. Text past the cap is not cut: the cell wraps onto
   * a second line, the same two-line clamp the dataset table uses.
   */
  function autoFitColumnWidth(column) {
    const headCell = table.querySelector(`th[data-col-key="${CSS.escape(column.key)}"] .pi-table-col-label-text`);
    const bodyCell = table.querySelector(`td[data-col-key="${CSS.escape(column.key)}"] .pi-table-cell-text`);
    const maxWidth = Number(column.maxAutoWidth) || DEFAULT_MAX_AUTO_WIDTH;
    const index = columnIndex(column.key);
    let width = measureTextWidth(column.label, headCell, doc) + AUTOFIT_HEADER_EXTRA_WIDTH;
    for (const row of allRows) {
      const value = row.cells[index]?.text;
      if (!value) continue;
      width = Math.max(width, measureTextWidth(value, bodyCell, doc) + AUTOFIT_CELL_EXTRA_WIDTH);
      if (width >= maxWidth) return clampWidth(column.key, maxWidth);
    }
    return clampWidth(column.key, Math.min(maxWidth, Math.ceil(width)));
  }

  function autoFitColumns() {
    for (const column of orderedColumns()) {
      if (manualWidths.has(column.key)) continue;
      widths.set(column.key, autoFitColumnWidth(column));
    }
  }

  function columnIndex(key) {
    const index = cellIndexByKey.get(key);
    return Number.isInteger(index) ? index : -1;
  }

  function cellText(row, key) {
    const index = columnIndex(key);
    return index < 0 ? "" : toText(row.cells[index]?.text);
  }

  function columnOptions(key) {
    const seen = new Map();
    for (const row of allRows) {
      const value = filterKeyOf(cellText(row, key));
      if (!seen.has(value)) seen.set(value, { key: value, label: value });
    }
    return [...seen.values()].sort((a, b) => compareTextValues(a.label, b.label));
  }

  function passesFilters(row) {
    for (const [key, selected] of filters) {
      if (!selected.size) continue;
      if (!selected.has(filterKeyOf(cellText(row, key)))) return false;
    }
    return true;
  }

  function sortedRows(rows) {
    if (!columnsByKey.has(sort.key)) return rows;
    const dir = sort.dir === "desc" ? -1 : 1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const cmp = compareTextValues(cellText(a.row, sort.key), cellText(b.row, sort.key));
        return cmp !== 0 ? cmp * dir : a.index - b.index;
      })
      .map((item) => item.row);
  }

  function toggleSort(key) {
    if (!columnsByKey.has(key)) return;
    if (sort.key === key && sort.dir === "desc") sort = { key: "", dir: "asc" };
    else sort = { key, dir: sort.key === key && sort.dir === "asc" ? "desc" : "asc" };
    render();
  }

  // --- column drag ---------------------------------------------------------

  function removeColumnDragImage() {
    columnDragImage?.remove?.();
    columnDragImage = null;
  }

  function setColumnDragImage(event, label) {
    removeColumnDragImage();
    if (!event.dataTransfer?.setDragImage) return;
    const ghost = element(doc, "div", "pi-table-column-drag-image", label || "Column");
    doc.body.appendChild(ghost);
    columnDragImage = ghost;
    const rect = ghost.getBoundingClientRect();
    event.dataTransfer.setDragImage(ghost, Math.min(110, Math.max(24, rect.width / 2)), 15);
  }

  function clearColumnDragIndicators() {
    for (const th of table.querySelectorAll("th.pi-col-drag-before, th.pi-col-drag-after")) {
      th.classList.remove("pi-col-drag-before", "pi-col-drag-after");
    }
  }

  function dropPosition(event, header) {
    const rect = header?.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) return "before";
    return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
  }

  function moveColumn(sourceKey, targetKey, position = "before") {
    if (!columnsByKey.has(sourceKey) || !columnsByKey.has(targetKey) || sourceKey === targetKey) return;
    const next = columnOrder.filter((key) => key !== sourceKey);
    const targetIndex = next.indexOf(targetKey);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceKey);
    columnOrder = next;
    render();
  }

  // --- column resize -------------------------------------------------------

  function startColumnResize(event, key) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    closeFilterPopover();
    const startX = event.clientX;
    const startWidth = widths.get(key) || MIN_COLUMN_WIDTH;
    manualWidths.add(key);
    doc.body.classList.add("pi-resizing-table-column");
    const onMove = (moveEvent) => setColumnWidth(key, startWidth + moveEvent.clientX - startX);
    const onUp = () => {
      doc.body.classList.remove("pi-resizing-table-column");
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseup", onUp, true);
    };
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mouseup", onUp, true);
  }

  // --- filter popover ------------------------------------------------------

  function closeFilterPopover() {
    popover.classList.remove("open");
    popover.setAttribute("aria-hidden", "true");
    popover.replaceChildren();
    filterColumn = "";
    filterAnchor = null;
    filterSearchText = "";
  }

  function positionFilterPopover() {
    if (!popover.classList.contains("open") || !filterAnchor?.getBoundingClientRect) return;
    const rect = filterAnchor.getBoundingClientRect();
    positionFixedMenu(popover, rect.left, rect.bottom + 6);
  }

  function findFilterButton(key) {
    const th = table.querySelector(`th[data-col-key="${CSS.escape(key)}"]`);
    return th?.querySelector?.(".pi-table-filter-btn") || null;
  }

  function reopenFilterPopoverAfterChange(key) {
    const text = filterSearchText;
    render();
    const anchor = findFilterButton(key);
    if (anchor) openFilterPopover(key, anchor, text);
  }

  function openFilterPopover(key, anchor, text = "") {
    const column = columnsByKey.get(key);
    if (!column) return;
    const options = columnOptions(key);
    const selected = filters.get(key) || new Set();
    popover.replaceChildren();

    const title = element(doc, "div", "pi-table-filter-title", `${column.label} Filter`);
    popover.appendChild(title);

    const search = element(doc, "input", "pi-table-filter-search");
    search.type = "search";
    search.autocomplete = "off";
    search.placeholder = "Type to search";
    search.setAttribute("aria-label", `Search ${column.label} filter values`);
    search.value = text;
    popover.appendChild(search);

    const list = element(doc, "div", "pi-table-filter-list");
    popover.appendChild(list);

    const commit = (next) => {
      if (next.size && next.size !== options.length) filters.set(key, next);
      else filters.delete(key);
      reopenFilterPopoverAfterChange(key);
    };

    const renderOptions = () => {
      list.replaceChildren();
      const needle = toText(search.value).toLocaleLowerCase();
      const visible = needle
        ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle))
        : options;

      const allRow = element(doc, "label", "pi-table-filter-option");
      const allBox = element(doc, "input");
      allBox.type = "checkbox";
      allBox.checked = !selected.size || selected.size === options.length;
      allBox.addEventListener("change", () => commit(new Set()));
      allRow.append(allBox, element(doc, "span", "", "All"));
      list.appendChild(allRow);

      for (const option of visible) {
        const row = element(doc, "label", "pi-table-filter-option");
        const box = element(doc, "input");
        box.type = "checkbox";
        box.checked = selected.size ? selected.has(option.key) : true;
        box.addEventListener("change", () => {
          const next = new Set(selected.size ? selected : options.map((item) => item.key));
          if (box.checked) next.add(option.key);
          else next.delete(option.key);
          commit(next);
        });
        // Right-click keeps only this value, the dataset table's shortcut for
        // "show just this one" without unticking everything else.
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          commit(new Set([option.key]));
        });
        // The filter list names the same values the cells show, arrows and all.
        row.append(box, appendTextWithArrows(doc, element(doc, "span", ""), option.label));
        list.appendChild(row);
      }

      if (!visible.length) {
        list.appendChild(element(
          doc,
          "div",
          "pi-table-filter-empty",
          options.length ? "No matching values" : "No values",
        ));
      }
    };

    search.addEventListener("input", () => {
      filterSearchText = search.value;
      renderOptions();
    });
    renderOptions();

    filterColumn = key;
    filterAnchor = anchor || findFilterButton(key);
    filterSearchText = text;
    popover.classList.add("open");
    popover.setAttribute("aria-hidden", "false");
    positionFilterPopover();
    search.focus({ preventScroll: true });
  }

  function toggleFilterPopover(key, anchor) {
    if (filterColumn === key) {
      closeFilterPopover();
      return;
    }
    closeFilterPopover();
    openFilterPopover(key, anchor);
  }

  // --- ticking -------------------------------------------------------------

  function setRowTicked(row, ticked) {
    if (row.disabled) return;
    if (ticked) selectedIds.add(row.id);
    else selectedIds.delete(row.id);
  }

  /**
   * A click toggles the row it lands on; a Shift-click paints every row from
   * the anchor to it with the anchor's new state, so extending a run of ticks
   * takes two clicks rather than one per row.
   */
  function applyRowClick(row, event = {}) {
    if (row.disabled) return;
    const anchorIndex = visibleRows.findIndex((item) => item.id === anchorId);
    const targetIndex = visibleRows.findIndex((item) => item.id === row.id);
    if (event.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      const ticked = selectedIds.has(anchorId);
      const from = Math.min(anchorIndex, targetIndex);
      const to = Math.max(anchorIndex, targetIndex);
      for (let index = from; index <= to; index += 1) setRowTicked(visibleRows[index], ticked);
    } else {
      setRowTicked(row, !selectedIds.has(row.id));
      anchorId = row.id;
    }
    activeId = row.id;
    syncSelectionDom();
    onSelectionChange();
  }

  function syncSelectionDom() {
    for (const tr of table.querySelectorAll("tbody tr[data-record-key]")) {
      const id = tr.dataset.recordKey;
      const ticked = selectedIds.has(id);
      tr.classList.toggle("selected", ticked);
      tr.classList.toggle("multi", ticked && selectedIds.size > 1);
      tr.classList.toggle("active", id === activeId);
      tr.setAttribute("aria-selected", ticked ? "true" : "false");
      const box = tr.querySelector(".reviewTableRowSelect");
      if (box) box.checked = ticked;
    }
  }

  /**
   * Keeps the active row clear of the sticky header, which the browser counts
   * as visible space even while it covers a row.
   */
  function scrollRowIntoView(id) {
    const tr = table.querySelector(`tbody tr[data-record-key="${CSS.escape(id)}"]`);
    if (!tr) return;
    const headerHeight = table.querySelector("thead")?.getBoundingClientRect?.().height || 0;
    const rowRect = tr.getBoundingClientRect();
    const hostRect = wrap.getBoundingClientRect();
    const top = hostRect.top + headerHeight;
    if (rowRect.top < top) wrap.scrollTop -= top - rowRect.top;
    else if (rowRect.bottom > hostRect.bottom) wrap.scrollTop += rowRect.bottom - hostRect.bottom;
  }

  function moveActiveRow(offset, event) {
    if (!visibleRows.length) return;
    const current = visibleRows.findIndex((row) => row.id === activeId);
    const next = Math.max(0, Math.min(visibleRows.length - 1, (current < 0 ? 0 : current + offset)));
    const row = visibleRows[next];
    if (!row) return;
    activeId = row.id;
    if (event?.shiftKey) applyRowClick(row, { shiftKey: true });
    else syncSelectionDom();
    scrollRowIntoView(row.id);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveRow(1, event);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveRow(-1, event);
      return;
    }
    if (selectable && (event.key === " " || event.key === "Spacebar")) {
      const row = visibleRows.find((item) => item.id === activeId);
      if (!row) return;
      event.preventDefault();
      applyRowClick(row, {});
    }
  }

  // --- rendering -----------------------------------------------------------

  function buildHeaderCell(column) {
    const th = element(doc, "th");
    th.dataset.colKey = column.key;
    th.dataset.align = column.align;
    th.scope = "col";
    th.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes?.(COLUMN_DRAG_TYPE)) return;
      event.preventDefault();
      clearColumnDragIndicators();
      const sourceKey = columnDragSourceKey;
      if (!sourceKey || sourceKey === column.key) return;
      th.classList.add(dropPosition(event, th) === "after" ? "pi-col-drag-after" : "pi-col-drag-before");
    });
    th.addEventListener("dragleave", () => th.classList.remove("pi-col-drag-before", "pi-col-drag-after"));
    th.addEventListener("drop", (event) => {
      const sourceKey = event.dataTransfer?.getData(COLUMN_DRAG_TYPE) || columnDragSourceKey;
      clearColumnDragIndicators();
      if (!sourceKey || sourceKey === column.key) return;
      event.preventDefault();
      event.stopPropagation();
      moveColumn(sourceKey, column.key, dropPosition(event, th));
    });

    const cell = element(doc, "div", "pi-table-header-cell");
    const label = element(doc, "span", "pi-table-col-label");
    label.title = "Click to sort. Drag to reorder columns.";
    label.draggable = true;
    label.appendChild(element(doc, "span", "pi-table-col-label-text", column.label));
    if (sort.key === column.key) {
      label.classList.add("is-sorted");
      label.appendChild(sortIcon(doc, sort.dir));
    }
    label.addEventListener("click", (event) => {
      if (columnDragStarted) return;
      event.preventDefault();
      event.stopPropagation();
      toggleSort(column.key);
    });
    label.addEventListener("dragstart", (event) => {
      columnDragStarted = true;
      columnDragSourceKey = column.key;
      event.dataTransfer?.setData(COLUMN_DRAG_TYPE, column.key);
      event.dataTransfer?.setData("text/plain", column.label);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      setColumnDragImage(event, column.label);
    });
    label.addEventListener("dragend", () => {
      clearColumnDragIndicators();
      removeColumnDragImage();
      doc.defaultView?.setTimeout(() => {
        columnDragStarted = false;
        columnDragSourceKey = "";
      }, 0);
    });
    cell.appendChild(label);

    const filterBtn = element(doc, "button", "pi-table-filter-btn");
    filterBtn.type = "button";
    filterBtn.title = `${column.label} Filter`;
    filterBtn.setAttribute("aria-label", `${column.label} filter`);
    filterBtn.classList.toggle("active", !!filters.get(column.key)?.size);
    filterBtn.appendChild(filterIcon(doc));
    filterBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleFilterPopover(column.key, filterBtn);
    });
    cell.appendChild(filterBtn);

    const resizer = element(doc, "div", "pi-table-col-resizer");
    resizer.title = "Resize column";
    resizer.addEventListener("mousedown", (event) => startColumnResize(event, column.key));
    // Double-click hands the column back to auto-fit, the sizing it opened
    // with, rather than to a fixed default the payload may not match.
    resizer.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      manualWidths.delete(column.key);
      autoFitColumns();
      syncTableWidth();
    });
    cell.appendChild(resizer);

    th.appendChild(cell);
    return th;
  }

  function buildSelectHeaderCell() {
    const th = element(doc, "th", "reviewTableSelectColumn");
    th.scope = "col";
    const cell = element(doc, "div", "pi-table-header-cell");
    const selectAll = element(doc, "input", "reviewTableSelectAll");
    selectAll.type = "checkbox";
    selectAll.setAttribute("aria-label", "Select all visible actions");
    selectAll.addEventListener("change", () => {
      for (const row of visibleRows) setRowTicked(row, selectAll.checked);
      syncSelectionDom();
      onSelectionChange();
    });
    cell.appendChild(selectAll);
    th.appendChild(cell);
    return th;
  }

  function buildRow(row) {
    const tr = element(doc, "tr");
    // `data-record-key` is what pi_table.css paints selection with, so a ticked
    // review row gets the dataset table's highlight without a rule of its own.
    tr.dataset.recordKey = row.id;
    if (row.disabled) tr.setAttribute("aria-disabled", "true");

    if (selectable) {
      const selectCell = element(doc, "td", "reviewTableSelectColumn");
      const box = element(doc, "input", "reviewTableRowSelect");
      box.type = "checkbox";
      box.checked = selectedIds.has(row.id);
      box.disabled = row.disabled;
      box.setAttribute(
        "aria-label",
        row.disabled ? `Action unavailable for ${row.id}` : `Select action for ${row.id}`,
      );
      // The row handler already toggles this row, so the checkbox only has to
      // stop its own click from being counted twice.
      box.addEventListener("click", (event) => event.stopPropagation());
      box.addEventListener("change", () => {
        setRowTicked(row, box.checked);
        anchorId = row.id;
        activeId = row.id;
        syncSelectionDom();
        onSelectionChange();
      });
      selectCell.appendChild(box);
      tr.appendChild(selectCell);
    }

    for (const column of orderedColumns()) {
      const value = row.cells[columnIndex(column.key)] || { text: "", tone: "" };
      const td = element(doc, "td");
      td.dataset.colKey = column.key;
      td.dataset.align = column.align;
      if (value.tone) td.dataset.tone = value.tone;
      appendTextWithArrows(doc, td.appendChild(element(doc, "span", "pi-table-cell-text")), value.text);
      tr.appendChild(td);
    }

    if (selectable) {
      tr.addEventListener("click", (event) => {
        applyRowClick(row, event);
        try { surface.focus({ preventScroll: true }); } catch {}
      });
    }
    return tr;
  }

  function render() {
    closeFilterPopover();
    table.replaceChildren();
    const columns = orderedColumns();

    const colgroup = element(doc, "colgroup");
    if (selectable) {
      const selectCol = element(doc, "col", "reviewTableSelectCol");
      selectCol.style.width = `${SELECT_COLUMN_WIDTH}px`;
      colgroup.appendChild(selectCol);
    }
    for (const column of columns) {
      const col = element(doc, "col");
      col.dataset.colKey = column.key;
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const thead = element(doc, "thead");
    const headRow = element(doc, "tr");
    if (selectable) headRow.appendChild(buildSelectHeaderCell());
    for (const column of columns) headRow.appendChild(buildHeaderCell(column));
    thead.appendChild(headRow);
    table.appendChild(thead);

    visibleRows = sortedRows(filterRows(allRows, searchText).filter(passesFilters));
    const tbody = element(doc, "tbody");
    for (const row of visibleRows) tbody.appendChild(buildRow(row));
    table.appendChild(tbody);

    // Auto-fit runs against the rendered head and body cells so it can read the
    // fonts the stylesheet gave them. It is a load-time sizing, not a re-layout
    // on every filter or tick change.
    if (autoFitPending) {
      autoFitPending = false;
      autoFitColumns();
    }
    syncTableWidth();

    table.hidden = visibleRows.length === 0;
    empty.hidden = visibleRows.length !== 0;
    syncSelectionDom();
    onViewChange({ visibleRows: [...visibleRows] });
  }

  const onDocumentMouseDown = (event) => {
    if (!filterColumn) return;
    if (popover.contains(event.target)) return;
    if (event.target?.closest?.(".pi-table-filter-btn")) return;
    closeFilterPopover();
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === "Escape" && filterColumn) closeFilterPopover();
  };
  const onWrapScroll = () => closeFilterPopover();
  const onWindowResize = () => closeFilterPopover();

  doc.addEventListener("mousedown", onDocumentMouseDown, true);
  doc.addEventListener("keydown", onDocumentKeyDown, true);
  wrap.addEventListener("scroll", onWrapScroll);
  surface.addEventListener("keydown", onKeyDown);
  doc.defaultView?.addEventListener("resize", onWindowResize);

  render();

  return {
    /** Rows the search box and the column filters currently leave on screen. */
    get visibleRows() {
      return [...visibleRows];
    },
    setSearchText(value) {
      searchText = toText(value);
      render();
    },
    setSelectAllState({ checked, indeterminate, disabled }) {
      const selectAll = table.querySelector(".reviewTableSelectAll");
      if (!selectAll) return;
      selectAll.checked = !!checked;
      selectAll.indeterminate = !!indeterminate;
      selectAll.disabled = !!disabled;
    },
    focus() {
      try { surface.focus({ preventScroll: true }); } catch {}
    },
    destroy() {
      closeFilterPopover();
      removeColumnDragImage();
      doc.removeEventListener("mousedown", onDocumentMouseDown, true);
      doc.removeEventListener("keydown", onDocumentKeyDown, true);
      wrap.removeEventListener("scroll", onWrapScroll);
      doc.defaultView?.removeEventListener("resize", onWindowResize);
      popover.remove();
    },
  };
}
