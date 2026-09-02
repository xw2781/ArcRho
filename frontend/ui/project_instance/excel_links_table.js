// Excel Link Manager table.
//
// The manager lists one row per *usage*, not one per workbook: a workbook read
// by two datasets shows two rows, so the reader sees which datasets and DFM
// methods depend on it without hovering a summary cell. Everything that
// describes the workbook - folder, Last Modified, Created, User - repeats on
// every row of the same workbook, which is what makes the per-column filters
// meaningful.
//
// Last Modified, Created, and User answer the same questions the Project
// Instance dataset table's columns of those names answer, about the workbook
// instead of the dataset: they are the workbook's own document properties,
// read server-side where the workbook lives, so they survive a copy or a move
// that would reset the file's creation time.
//
// The table follows the pi-table column model used by the Project Instance
// dataset table: every column carries an explicit width, a colgroup sets those
// widths, and the table's own width is the sum, so a drag resizes only the
// dragged column and lets the table grow or shrink instead of redistributing
// its neighbours. Filters are the same value-checkbox popover pattern, kept
// local to this page because the dataset table's copy is wired into that
// page's preferences, sorting, and grouping state.
//
// Widths start from the content: when a listing loads, every column the user
// has not dragged is sized to fit its header and cells, capped by that
// column's `maxAutoWidth` so one long folder path cannot crowd out the
// columns the reader acts on. Text past the cap wraps onto a second line
// instead of being cut, which is why a cell's text lives in its own element.
//
// The page module owns the data, the row context menu, and every action; this
// module owns only the view: widths, filters, rendering, and the two callbacks
// a row can raise (open the used-by object, open the row's context menu).
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js?v=20260811b";
import { formatArcrhoTimestamp } from "/ui/shared/utils/timestamp.js?v=20260818a";

// `width` is the fallback the column starts at before any rows arrive;
// `maxAutoWidth` caps what auto-fit may grow it to, so a deep folder path
// cannot push the acting columns off screen. Anything longer than the cap
// wraps to a second line rather than being cut short (see the two-line clamp
// in excel_links_window.css).
export const EXCEL_LINK_COLUMNS = [
  { key: "name", label: "Dataset Name", width: 200, minWidth: 90, maxAutoWidth: 300, filterable: true },
  { key: "methodType", label: "Method Type", width: 132, minWidth: 70, maxAutoWidth: 180, filterable: true },
  { key: "workbook", label: "Workbook", width: 190, minWidth: 90, maxAutoWidth: 300, filterable: true },
  { key: "folder", label: "Location", width: 280, minWidth: 90, maxAutoWidth: 420, filterable: true },
  { key: "lastModified", label: "Last Modified", width: 151, minWidth: 110, maxAutoWidth: 200, filterable: true },
  { key: "created", label: "Created", width: 142, minWidth: 110, maxAutoWidth: 200, filterable: true },
  { key: "user", label: "User", width: 129, minWidth: 90, maxAutoWidth: 220, filterable: true },
];

const COLUMN_BY_KEY = new Map(EXCEL_LINK_COLUMNS.map((col) => [col.key, col]));
const BLANK_LABEL = "(blank)";
// What a column needs beyond its text: cell padding for a body cell, and for a
// header also the gap and the filter button that sit beside the label.
const AUTOFIT_CELL_EXTRA_WIDTH = 20;
const AUTOFIT_HEADER_EXTRA_WIDTH = 46;
const AUTOFIT_FALLBACK_CHAR_WIDTH = 7;

function text(value) {
  return String(value ?? "").trim();
}

/** Flattens the listing's workbook groups into one row per usage. */
export function excelLinkDetailRows(workbooks) {
  const rows = [];
  for (const workbook of Array.isArray(workbooks) ? workbooks : []) {
    const usages = Array.isArray(workbook?.usages) ? workbook.usages : [];
    const base = {
      workbookPath: text(workbook?.workbookPath),
      workbookName: text(workbook?.workbookName),
      folder: text(workbook?.folder),
      exists: workbook?.exists === true,
      created: text(workbook?.created),
      modified: text(workbook?.modified),
      lastModifiedBy: text(workbook?.lastModifiedBy),
    };
    if (!usages.length) {
      rows.push({ ...base, kind: "", name: "", datasetType: "", methodType: "" });
      continue;
    }
    for (const usage of usages) {
      rows.push({
        ...base,
        kind: usage?.kind === "dfm" ? "dfm" : "dataset",
        name: text(usage?.name),
        datasetType: text(usage?.datasetType),
        methodType: text(usage?.methodType),
      });
    }
  }
  return rows;
}

/** The text one column shows for a row; also the value its filter matches. */
export function excelLinkCellText(row, key) {
  if (key === "workbook") return text(row?.workbookName);
  // `row.folder` keeps its trailing separator for building an Excel external
  // reference; the column only displays the path, so it drops that separator.
  if (key === "folder") return text(row?.folder).replace(/[\\/]+$/, "");
  if (key === "methodType") {
    // The server resolves Method Type through the same owner the dataset table
    // reads. The kind stands in only for a server that predates the field.
    if (row?.methodType) return text(row.methodType);
    if (row?.kind === "dfm") return "DFM";
    return row?.kind === "dataset" ? "None" : "";
  }
  if (key === "name") return text(row?.name);
  // Last Modified, Created, and User describe the workbook, not the dataset in
  // the row: they are the workbook's own document properties, read server-side
  // where the workbook lives. They repeat on every row of the same workbook,
  // exactly as Workbook and Folder do.
  if (key === "lastModified") return formatArcrhoTimestamp(row?.modified);
  if (key === "created") return formatArcrhoTimestamp(row?.created);
  if (key === "user") return text(row?.lastModifiedBy);
  return "";
}

/** Distinct values a column offers, in display order. */
export function excelLinkColumnOptions(rows, key) {
  const seen = new Set();
  const options = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = excelLinkCellText(row, key);
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: value || BLANK_LABEL });
  }
  options.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  return options;
}

/** Keeps the rows every active column filter accepts; an empty filter is "all". */
export function filterExcelLinkRows(rows, filters) {
  const source = Array.isArray(rows) ? rows : [];
  if (!(filters instanceof Map) || !filters.size) return source.slice();
  return source.filter((row) => {
    for (const [key, selected] of filters) {
      if (!(selected instanceof Set) || !selected.size) continue;
      if (!selected.has(excelLinkCellText(row, key))) return false;
    }
    return true;
  });
}

/** Drops filter values the current rows no longer contain. */
export function pruneExcelLinkFilters(filters, rows) {
  if (!(filters instanceof Map) || !filters.size) return filters;
  for (const [key, selected] of [...filters]) {
    if (!(selected instanceof Set) || !selected.size) {
      filters.delete(key);
      continue;
    }
    const available = new Set(excelLinkColumnOptions(rows, key).map((option) => option.value));
    for (const value of [...selected]) {
      if (!available.has(value)) selected.delete(value);
    }
    if (!selected.size) filters.delete(key);
  }
  return filters;
}

function clampWidth(key, width) {
  const col = COLUMN_BY_KEY.get(key);
  const minWidth = col?.minWidth || 48;
  const value = Number(width);
  if (!Number.isFinite(value)) return col?.width || minWidth;
  return Math.max(minWidth, Math.min(1200, Math.round(value)));
}

let measureCanvas = null;

/**
 * Width the given text needs in `sample`'s font.
 *
 * The font is read off the rendered element rather than repeated here, so the
 * stylesheet stays the only place the table's typography is declared.
 */
function measureTextWidth(value, sample) {
  const source = String(value ?? "");
  if (!source) return 0;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext?.("2d");
  const style = sample ? window.getComputedStyle?.(sample) : null;
  if (!ctx || !style) return source.length * AUTOFIT_FALLBACK_CHAR_WIDTH;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText(source).width;
}

function filterIconSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 3h12L9.5 8v4l-3 1V8z");
  svg.appendChild(path);
  return svg;
}

/**
 * Wires the Excel Links table view.
 *
 * `onOpenUsage(row)` fires when a Dataset Name cell is clicked, and
 * `onRowMenu(row, rowEl, event, columnKey)` when a row is right-clicked, naming
 * the cell's column so the page can offer column-specific actions. The page
 * module decides what either one does. `onViewChange({ visible, total,
 * filtered })` reports what the current filters left on screen.
 */
export function createExcelLinksTable(options = {}) {
  const table = options.table || null;
  const wrap = options.wrap || null;
  const popover = options.popover || null;
  const onOpenUsage = typeof options.onOpenUsage === "function" ? options.onOpenUsage : () => {};
  const onRowMenu = typeof options.onRowMenu === "function" ? options.onRowMenu : () => {};
  const onViewChange = typeof options.onViewChange === "function" ? options.onViewChange : () => {};

  const widths = new Map(EXCEL_LINK_COLUMNS.map((col) => [col.key, col.width]));
  // A column the user dragged keeps that width; auto-fit only touches the rest,
  // so a refresh never undoes a deliberate resize.
  const manualWidths = new Set();
  const filters = new Map();
  let rows = [];
  let visibleRows = [];
  let autoFitPending = false;
  let filterColumn = "";
  let filterAnchor = null;
  let filterSearch = "";

  function totalWidth() {
    let total = 0;
    for (const col of EXCEL_LINK_COLUMNS) total += widths.get(col.key) || col.width;
    return total;
  }

  function syncTableWidth() {
    if (!table) return;
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
   * Width that fits the column's header and its rendered cells, capped by the
   * column's `maxAutoWidth`. A value longer than the cap is not cut off: the
   * cell wraps onto a second line instead.
   */
  function autoFitColumnWidth(col, headCell, bodyCell) {
    const maxWidth = col.maxAutoWidth || col.width;
    let width = measureTextWidth(col.label, headCell) + AUTOFIT_HEADER_EXTRA_WIDTH;
    for (const row of visibleRows) {
      const value = excelLinkCellText(row, col.key);
      if (!value) continue;
      width = Math.max(width, measureTextWidth(value, bodyCell) + AUTOFIT_CELL_EXTRA_WIDTH);
      if (width >= maxWidth) return clampWidth(col.key, maxWidth);
    }
    return clampWidth(col.key, Math.min(maxWidth, Math.ceil(width)));
  }

  /** Sizes every column the user has not resized to its own content. */
  function autoFitColumns() {
    if (!table) return;
    for (const col of EXCEL_LINK_COLUMNS) {
      if (manualWidths.has(col.key)) continue;
      widths.set(col.key, autoFitColumnWidth(
        col,
        table.querySelector(`th[data-col-key="${col.key}"] .pi-excel-links-col-label`),
        table.querySelector(`td[data-col-key="${col.key}"]`),
      ));
    }
  }

  function startColumnResize(event, key) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    closeFilterPopover();
    const startX = event.clientX;
    const startWidth = widths.get(key) || COLUMN_BY_KEY.get(key)?.width || 120;
    manualWidths.add(key);
    document.body.classList.add("pi-excel-links-resizing-column");
    const onMove = (moveEvent) => setColumnWidth(key, startWidth + moveEvent.clientX - startX);
    const onUp = () => {
      document.body.classList.remove("pi-excel-links-resizing-column");
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  function buildHeadCell(col) {
    const th = document.createElement("th");
    th.dataset.colKey = col.key;
    th.scope = "col";

    const inner = document.createElement("div");
    inner.className = "pi-excel-links-th";

    const label = document.createElement("span");
    label.className = "pi-excel-links-col-label";
    label.textContent = col.label;
    inner.appendChild(label);

    if (col.filterable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pi-excel-links-filter-btn";
      button.title = `${col.label} Filter`;
      button.setAttribute("aria-label", `${col.label} filter`);
      button.classList.toggle("active", !!filters.get(col.key)?.size);
      button.appendChild(filterIconSvg());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFilterPopover(col.key, button);
      });
      inner.appendChild(button);
    }

    const resizer = document.createElement("div");
    resizer.className = "pi-excel-links-col-resizer";
    resizer.title = "Resize column";
    resizer.addEventListener("mousedown", (event) => startColumnResize(event, col.key));
    // Double-click hands the column back to auto-fit, the same sizing it opened
    // with, rather than to a fixed default the content may not match.
    resizer.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      manualWidths.delete(col.key);
      autoFitColumns();
      syncTableWidth();
    });
    inner.appendChild(resizer);

    th.appendChild(inner);
    return th;
  }

  /**
   * Cell text lives in its own element because the two-line clamp that keeps a
   * wrapped row under twice the base row height needs a block of its own; a
   * `td` cannot carry it without leaving table layout.
   */
  function cellText(value) {
    const span = document.createElement("span");
    span.className = "pi-excel-links-cell-text";
    span.textContent = value;
    return span;
  }

  function buildBodyCell(row, col) {
    const td = document.createElement("td");
    td.className = `pi-excel-links-cell ${col.key}`;
    // The page's row menu is column-aware: a Folder cell offers to open the
    // folder, every other cell offers the workbook actions only.
    td.dataset.colKey = col.key;
    const value = excelLinkCellText(row, col.key);

    if (col.key === "name" && value) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "pi-excel-links-open";
      open.appendChild(cellText(value));
      const target = row.kind === "dfm" ? "DFM method" : "dataset";
      attachArcrhoTooltip(open, `Open ${target} ${value}`);
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenUsage(row);
      });
      td.appendChild(open);
      return td;
    }

    td.appendChild(cellText(value));
    if (col.key === "workbook") {
      // The listing's Found/Missing verdict has no column of its own; a
      // workbook ArcRho Server cannot open is called out on its name instead.
      td.classList.toggle("missing", !row.exists);
      attachArcrhoTooltip(td, row.exists
        ? row.workbookPath
        : `${row.workbookPath}\n\nArcRho Server cannot open this workbook at this path.`);
    } else if (col.key === "folder") {
      attachArcrhoTooltip(td, value);
    }
    return td;
  }

  function render() {
    if (!table) return;
    closeFilterPopover();
    table.replaceChildren();

    const colgroup = document.createElement("colgroup");
    for (const col of EXCEL_LINK_COLUMNS) {
      const colEl = document.createElement("col");
      colEl.dataset.colKey = col.key;
      colgroup.appendChild(colEl);
    }
    table.appendChild(colgroup);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of EXCEL_LINK_COLUMNS) headRow.appendChild(buildHeadCell(col));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    visibleRows = filterExcelLinkRows(rows, filters);
    for (const row of visibleRows) {
      const tr = document.createElement("tr");
      for (const col of EXCEL_LINK_COLUMNS) tr.appendChild(buildBodyCell(row, col));
      tr.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        onRowMenu(row, tr, event, text(event.target?.closest?.("td")?.dataset?.colKey));
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Auto-fit runs against the rendered head and body cells, so it can read
    // the fonts the stylesheet gave them; it is a load-time sizing, not a
    // re-layout on every filter change.
    if (autoFitPending) {
      autoFitPending = false;
      autoFitColumns();
    }
    syncTableWidth();
    onViewChange({ visible: visibleRows.length, total: rows.length, filtered: filters.size > 0 });
  }

  function closeFilterPopover() {
    if (!popover) return;
    popover.style.display = "";
    popover.replaceChildren();
    filterColumn = "";
    filterAnchor = null;
    filterSearch = "";
  }

  function positionFilterPopover() {
    if (!popover || !filterColumn || !filterAnchor?.getBoundingClientRect) return;
    const rect = filterAnchor.getBoundingClientRect();
    openContextMenu(popover, {
      clientX: rect.left,
      clientY: rect.bottom + 4,
      offset: 6,
      preferPointer: true,
    });
  }

  function findFilterButton(key) {
    return table?.querySelector?.(`th[data-col-key="${key}"] .pi-excel-links-filter-btn`) || null;
  }

  function applyFilterChange(key) {
    const searchText = filterSearch;
    render();
    const anchor = findFilterButton(key);
    if (!anchor) return;
    openFilterPopover(key, anchor, searchText);
  }

  function openFilterPopover(key, anchor, searchText = "") {
    const col = COLUMN_BY_KEY.get(key);
    if (!popover || !col?.filterable) return;
    const options = excelLinkColumnOptions(rows, key);
    const selected = filters.get(key) || new Set();
    popover.replaceChildren();

    const title = document.createElement("div");
    title.className = "pi-excel-links-filter-title";
    title.textContent = `${col.label} Filter`;
    popover.appendChild(title);

    const search = document.createElement("input");
    search.className = "pi-excel-links-filter-search";
    search.type = "search";
    search.autocomplete = "off";
    search.placeholder = "Type to search";
    search.setAttribute("aria-label", `Search ${col.label} filter values`);
    search.value = searchText;
    popover.appendChild(search);

    const list = document.createElement("div");
    list.className = "pi-excel-links-filter-list";
    popover.appendChild(list);

    const commit = (nextSelected) => {
      if (nextSelected.size) filters.set(key, nextSelected);
      else filters.delete(key);
      applyFilterChange(key);
    };

    const renderOptions = () => {
      list.replaceChildren();
      const needle = text(search.value).toLocaleLowerCase();
      const visible = needle
        ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle))
        : options;

      const allRow = document.createElement("label");
      allRow.className = "pi-excel-links-filter-option";
      const allBox = document.createElement("input");
      allBox.type = "checkbox";
      allBox.checked = !selected.size || selected.size === options.length;
      allBox.addEventListener("change", () => commit(new Set()));
      const allText = document.createElement("span");
      allText.textContent = "All";
      allRow.append(allBox, allText);
      list.appendChild(allRow);

      for (const option of visible) {
        const row = document.createElement("label");
        row.className = "pi-excel-links-filter-option";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selected.size ? selected.has(option.value) : true;
        box.addEventListener("change", () => {
          const next = new Set(selected.size ? selected : options.map((item) => item.value));
          if (box.checked) next.add(option.value);
          else next.delete(option.value);
          commit(next.size === options.length ? new Set() : next);
        });
        // Right-click keeps only this value, the dataset table's shortcut for
        // "show just this one" without unticking everything else.
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          commit(new Set([option.value]));
        });
        const label = document.createElement("span");
        label.textContent = option.label;
        row.append(box, label);
        list.appendChild(row);
      }

      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "pi-excel-links-filter-empty";
        empty.textContent = options.length ? "No matching values" : "No values";
        list.appendChild(empty);
      }
    };

    search.addEventListener("input", () => {
      filterSearch = search.value;
      renderOptions();
    });
    renderOptions();

    filterColumn = key;
    filterAnchor = anchor;
    filterSearch = searchText;
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

  document.addEventListener("mousedown", (event) => {
    if (!filterColumn) return;
    if (popover?.contains(event.target)) return;
    if (event.target?.closest?.(".pi-excel-links-filter-btn")) return;
    closeFilterPopover();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFilterPopover();
  }, true);
  wrap?.addEventListener("scroll", closeFilterPopover);
  window.addEventListener("resize", closeFilterPopover);
  window.addEventListener("blur", closeFilterPopover);

  return {
    setRows(nextRows) {
      rows = Array.isArray(nextRows) ? nextRows : [];
      pruneExcelLinkFilters(filters, rows);
      autoFitPending = true;
      render();
    },
    closeFilterPopover,
  };
}
