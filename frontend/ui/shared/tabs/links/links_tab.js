/*
===============================================================================
Links Tab
One compact table per kind of link a page holds, stacked in sections: ArcRho
dataset links first, Excel workbook links next, and formulas over both last.
A section is shown only while it has rows. The whole stack sits in one framed
scrolling area, so the tab has a single scrollbar and the sections scroll past
one another instead of each one scrolling inside its own frame. Each row says
where the values come from (Source), the exact address or formula (Reference),
and the cells it fills (Destination, Cells); the section title names the kind,
and only a formula row repeats it as a small tinted badge in the Source cell.

The page owns link discovery, refresh, break, and dirty state; this module
owns the tables: rendering, selection, the row context menu, column widths,
and the empty, loading, warning, and error states.
===============================================================================
*/
import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js";
import { openPathThroughDesktopHost } from "/ui/shared/integrations/open_path.js?v=20260812a";

const LINKS_STYLESHEET_ID = "arExternalLinksStylesheet";
const LINKS_STYLESHEET_HREF = "/ui/shared/tabs/links/links_tab.css?v=20260901a";
const MOUNTED_LINKS_TABS = new WeakMap();

// Every column carries an explicit width, the colgroup sets it, and the table
// is the sum, so a drag resizes one column and lets the table grow or shrink
// instead of redistributing its neighbours (the pi-table pattern). The
// sections share one set of widths, so their columns always line up.
export const LINK_COLUMNS = [
  { key: "source", label: "Source", width: 260, minWidth: 120 },
  { key: "reference", label: "Reference", width: 200, minWidth: 90 },
  { key: "destination", label: "Destination", width: 200, minWidth: 90 },
  { key: "cells", label: "Cells", width: 64, minWidth: 48 },
];
const COLUMN_BY_KEY = new Map(LINK_COLUMNS.map((column) => [column.key, column]));
const MAX_COLUMN_WIDTH = 3000;
// Widths a user has dragged survive a re-mount within the page session, so
// switching tabs never undoes a deliberate resize.
const sessionColumnWidths = new Map();

const KIND_LABELS = { excel: "Excel", internal: "ArcRho", formula: "Formula" };
// Section order on the page, top to bottom.
export const LINK_SECTIONS = [
  { kind: "internal", title: "ArcRho Links" },
  { kind: "excel", title: "Excel Links" },
  { kind: "formula", title: "Formula Links" },
];

function ensureLinksStylesheet(documentRef) {
  const existingById = documentRef.getElementById?.(LINKS_STYLESHEET_ID);
  if (existingById) return existingById;

  const matchingLink = Array.from(
    documentRef.querySelectorAll?.('link[rel="stylesheet"]') || [],
  ).find((link) => link.getAttribute("href") === LINKS_STYLESHEET_HREF);
  if (matchingLink) return matchingLink;

  const link = documentRef.createElement("link");
  link.id = LINKS_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = LINKS_STYLESHEET_HREF;
  (documentRef.head || documentRef.documentElement)?.appendChild(link);
  return link;
}

function appendTextElement(documentRef, parent, tagName, className, text) {
  const element = documentRef.createElement(tagName);
  element.className = className;
  element.textContent = String(text ?? "");
  parent.appendChild(element);
  return element;
}

function appendMenuItem(documentRef, parent, action, label) {
  const item = documentRef.createElement("button");
  item.className = "ctx-item";
  item.type = "button";
  item.dataset.action = action;
  item.textContent = label;
  item.setAttribute("role", "menuitem");
  parent.appendChild(item);
  return item;
}

function appendMenuSeparator(documentRef, parent) {
  const separator = documentRef.createElement("div");
  separator.className = "ctx-sep";
  separator.setAttribute("role", "separator");
  parent.appendChild(separator);
  return separator;
}

function normalizeAffectedCellCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function linkKind(record) {
  if (KIND_LABELS[record.sourceKind]) return record.sourceKind;
  if (record.workbookPath) return "excel";
  if (record.datasetName) return "internal";
  return record.formula ? "formula" : "excel";
}

/**
 * One row's presentation from a record of any kind: the page's Excel, ArcRho,
 * and formula controllers each describe a link in their own words, and the
 * table reads those into the same four columns.
 */
export function normalizeLinkRecord(record, index, idPrefix = "link") {
  const source = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  const kind = linkKind(source);
  const workbookPath = String(source.workbookPath ?? "").trim();
  const worksheet = String(source.worksheet ?? "").trim();
  const address = String(source.address ?? "").trim();
  const datasetName = String(source.datasetName ?? "").trim();
  const sourceRange = String(source.sourceRange ?? "").trim();
  const formula = String(source.formula ?? "").trim();
  const sources = Array.isArray(source.sources) ? source.sources.map((name) => String(name)) : [];
  let sourceText = "";
  let reference = "";
  if (kind === "excel") {
    sourceText = fileName(workbookPath);
    reference = worksheet && address ? `${worksheet}!${address}` : (address || worksheet);
  } else if (kind === "internal") {
    sourceText = datasetName;
    reference = sourceRange ? `[${sourceRange}]` : "";
  } else {
    sourceText = sources.join(", ");
    reference = formula;
  }
  return {
    id: String(source.id ?? "").trim() || `${idPrefix}-${index + 1}`,
    kind,
    kindLabel: KIND_LABELS[kind],
    workbookPath,
    datasetName,
    formula,
    source: sourceText,
    reference,
    destination: String(source.destination ?? "").trim(),
    affectedCellCount: normalizeAffectedCellCount(source.affectedCellCount),
    readOnly: source.readOnly === true,
  };
}

function errorMessage(error, fallback) {
  const direct = typeof error === "string" || typeof error === "number" ? error : "";
  const message = String(error?.message || error?.error || direct || "").trim();
  return message || fallback;
}

function actionFailureMessage(result, fallback) {
  if (result === false) return fallback;
  if (result && typeof result === "object" && result.ok === false) {
    return errorMessage(result, fallback);
  }
  if (result && typeof result === "object" && Number(result.failedCount) > 0) {
    return errorMessage(
      result,
      `${Number(result.failedCount)} linked value${Number(result.failedCount) === 1 ? "" : "s"} could not be refreshed.`,
    );
  }
  if (result && typeof result === "object" && result.error) {
    return errorMessage(result, fallback);
  }
  return "";
}

function clampWidth(key, width) {
  const column = COLUMN_BY_KEY.get(key);
  const value = Number(width);
  if (!Number.isFinite(value)) return column.width;
  return Math.max(column.minWidth, Math.min(MAX_COLUMN_WIDTH, Math.round(value)));
}

/**
 * Mounts the links table into a page-owned container.
 *
 * `getLinks` returns the page's records; `onRefreshLinks(records)` and
 * `onBreakLinks(records)` act on a selection of them. `onOpenWorkbook(path,
 * {readOnly})` and `onOpenDataset(record)` serve the row context menu's open
 * entries for Excel and ArcRho rows.
 */
export function createLinksTab({
  container,
  ariaLabel = "Links",
  emptyDescription = "Links used by this page will appear here.",
  getLinks,
  onRefreshLinks,
  onBreakLinks,
  onOpenWorkbook = openPathThroughDesktopHost,
  onOpenDataset = null,
  onStatus,
  documentRef = container?.ownerDocument || globalThis.document,
  noun = "links",
  idPrefix = "link",
} = {}) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("createLinksTab requires a document.");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createLinksTab requires a container element.");
  }
  if (typeof getLinks !== "function") {
    throw new TypeError("createLinksTab requires getLinks to be a function.");
  }
  if (typeof onRefreshLinks !== "function") {
    throw new TypeError("createLinksTab requires onRefreshLinks to be a function.");
  }
  if (typeof onBreakLinks !== "function") {
    throw new TypeError("createLinksTab requires onBreakLinks to be a function.");
  }
  if (typeof onOpenWorkbook !== "function") {
    throw new TypeError("createLinksTab onOpenWorkbook must be a function.");
  }
  if (onOpenDataset !== null && typeof onOpenDataset !== "function") {
    throw new TypeError("createLinksTab onOpenDataset must be a function when provided.");
  }
  if (onStatus !== undefined && typeof onStatus !== "function") {
    throw new TypeError("createLinksTab onStatus must be a function when provided.");
  }
  if (MOUNTED_LINKS_TABS.has(container)) {
    throw new Error("createLinksTab requires an unused container; destroy the existing Links tab first.");
  }

  ensureLinksStylesheet(documentRef);

  const nounText = String(noun || "links");
  const nounSentence = nounText.charAt(0).toUpperCase() + nounText.slice(1);

  const root = documentRef.createElement("div");
  root.className = "arExternalLinks";
  root.setAttribute("aria-busy", "false");

  const menu = documentRef.createElement("div");
  menu.className = "ctx-menu arExternalLinksMenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${String(ariaLabel || "Links")} actions`);
  menu.style.display = "none";
  const menuInner = documentRef.createElement("div");
  menuInner.className = "ctx-menu-inner";
  menu.appendChild(menuInner);
  // "Open ..." entries act on the row that was right-clicked; which ones show
  // depends on what that row reads from.
  const openItems = [
    {
      action: "open-workbook",
      label: "Open workbook",
      availableFor: (record) => record.kind === "excel" && !!record.workbookPath,
      run: (record) => onOpenWorkbook(record.workbookPath, { readOnly: false }),
      failure: "The workbook could not be opened.",
      success: "Workbook opened.",
    },
    {
      action: "open-workbook-read-only",
      label: "Open workbook as Read-Only",
      availableFor: (record) => record.kind === "excel" && !!record.workbookPath,
      run: (record) => onOpenWorkbook(record.workbookPath, { readOnly: true }),
      failure: "The workbook could not be opened read-only.",
      success: "Workbook opened read-only.",
    },
    {
      action: "open-dataset",
      label: "Open source dataset",
      availableFor: (record) => !!onOpenDataset && record.kind === "internal" && !!record.datasetName,
      run: (record) => onOpenDataset(record),
      failure: "The source dataset could not be opened.",
      success: "Dataset opened.",
    },
  ].map((item) => ({
    ...item,
    element: appendMenuItem(documentRef, menuInner, item.action, item.label),
  }));
  const openSeparator = appendMenuSeparator(documentRef, menuInner);
  const refreshSelectedItem = appendMenuItem(documentRef, menuInner, "refresh-selected", "Refresh selected");
  const breakSelectedItem = appendMenuItem(documentRef, menuInner, "break-selected", "Break selected");
  const menuSeparator = appendMenuSeparator(documentRef, menuInner);
  const refreshAllItem = appendMenuItem(documentRef, menuInner, "refresh-all", "Refresh all");
  const breakAllItem = appendMenuItem(documentRef, menuInner, "break-all", "Break all");
  (documentRef.body || documentRef.documentElement)?.appendChild(menu);

  const state = documentRef.createElement("div");
  state.className = "arExternalLinksState isEmpty isStandalone";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  state.setAttribute("aria-atomic", "true");
  const stateTitle = appendTextElement(documentRef, state, "strong", "arExternalLinksStateTitle", `No ${nounText}`);
  const stateDescription = appendTextElement(
    documentRef,
    state,
    "span",
    "arExternalLinksStateDescription",
    emptyDescription,
  );
  stateDescription.hidden = !stateDescription.textContent;
  root.appendChild(state);

  // One framed scrolling area for the whole tab. The sections stack inside it
  // and share its scrollbar, so a long ArcRho list scrolls the Excel and
  // formula tables into view instead of every section scrolling on its own.
  const scrollHost = documentRef.createElement("div");
  scrollHost.className = "arExternalLinksScroll";
  scrollHost.tabIndex = 0;
  scrollHost.hidden = true;
  scrollHost.setAttribute("role", "region");
  scrollHost.setAttribute("aria-label", `${String(ariaLabel || "Links")} tables`);
  scrollHost.setAttribute("aria-haspopup", "menu");
  root.appendChild(scrollHost);

  const sectionsHost = documentRef.createElement("div");
  sectionsHost.className = "arLinksSections";
  scrollHost.appendChild(sectionsHost);

  const widths = new Map(LINK_COLUMNS.map((column) => [
    column.key,
    sessionColumnWidths.get(column.key) || column.width,
  ]));
  const manualWidths = new Set(sessionColumnWidths.keys());

  // One table per section, all of them inside the shared scrolling frame;
  // every table carries the same colgroup and header so the shared widths
  // land in each of them.
  const sections = LINK_SECTIONS.map(({ kind, title }) => {
    const section = documentRef.createElement("section");
    section.className = "arLinksSection";
    section.dataset.linkKind = kind;
    section.hidden = true;
    appendTextElement(documentRef, section, "h3", "arLinksSectionTitle", title);

    const table = documentRef.createElement("table");
    table.className = "arExternalLinksTable";
    table.setAttribute("role", "grid");
    table.setAttribute("aria-multiselectable", "true");
    table.setAttribute("aria-label", `${String(ariaLabel || "Links")}: ${title}`);
    section.appendChild(table);

    const colElements = new Map();
    const colgroup = documentRef.createElement("colgroup");
    for (const column of LINK_COLUMNS) {
      const col = documentRef.createElement("col");
      col.dataset.colKey = column.key;
      colgroup.appendChild(col);
      colElements.set(column.key, col);
    }
    table.appendChild(colgroup);
    const body = documentRef.createElement("tbody");

    sectionsHost.appendChild(section);
    return { kind, section, table, colElements, body };
  });

  function totalWidth() {
    let total = 0;
    for (const column of LINK_COLUMNS) total += widths.get(column.key);
    return total;
  }

  /**
   * The width the tables have to sit in: the sections' own box, which is what
   * the shared frame leaves once its scrollbar has taken its lane.
   */
  function availableWidth() {
    return Number(sectionsHost.clientWidth) || 0;
  }

  /**
   * A table narrower than its frame draws its own right edge on the last
   * column, so a deliberately shrunk table never looks cut off; a table that
   * fills or overflows the frame leaves that edge to the frame.
   */
  function syncTableEdges() {
    const available = availableWidth();
    scrollHost.classList.toggle("isTableShort", available > 0 && totalWidth() < available);
  }

  function syncTableWidth() {
    const total = `${totalWidth()}px`;
    for (const { table, colElements } of sections) {
      table.style.width = total;
      table.style.minWidth = total;
      for (const [key, col] of colElements) col.style.width = `${widths.get(key)}px`;
    }
    syncTableEdges();
  }

  function setColumnWidth(key, width) {
    widths.set(key, clampWidth(key, width));
    syncTableWidth();
  }

  /**
   * Until a column has been dragged, the defaults are stretched to fill the
   * host, so the tables open edge to edge rather than short of the frame, and
   * they follow the host whenever it is resized. The single frame decides for
   * every section, so the stack never gains a horizontal scrollbar from the
   * fit even once its vertical one appears.
   */
  function fitColumnsToHost() {
    if (manualWidths.size) return;
    const available = availableWidth();
    if (available <= 0) return;
    const defaultTotal = LINK_COLUMNS.reduce((sum, column) => sum + column.width, 0);
    const scale = Math.max(1, available / defaultTotal);
    let assigned = 0;
    LINK_COLUMNS.forEach((column, index) => {
      const width = index === LINK_COLUMNS.length - 1 && scale > 1
        ? available - assigned
        : Math.floor(column.width * scale);
      widths.set(column.key, clampWidth(column.key, width));
      assigned += widths.get(column.key);
    });
    syncTableWidth();
  }

  function startColumnResize(event, key) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    closeMenu();
    const handle = event.currentTarget;
    const startX = Number(event.clientX) || 0;
    const startWidth = widths.get(key);
    manualWidths.add(key);
    root.classList.add("isResizingColumn");
    handle.setPointerCapture?.(event.pointerId);
    const onMove = (moveEvent) => {
      setColumnWidth(key, startWidth + (Number(moveEvent.clientX) || 0) - startX);
    };
    const onUp = () => {
      sessionColumnWidths.set(key, widths.get(key));
      root.classList.remove("isResizingColumn");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  for (const { table, body } of sections) {
    const head = documentRef.createElement("thead");
    const headerRow = documentRef.createElement("tr");
    for (const column of LINK_COLUMNS) {
      const header = documentRef.createElement("th");
      header.scope = "col";
      header.dataset.colKey = column.key;
      const inner = documentRef.createElement("div");
      inner.className = "arLinksHead";
      appendTextElement(documentRef, inner, "span", "arLinksHeadLabel", column.label);
      const resizer = documentRef.createElement("div");
      resizer.className = "arLinksColResizer";
      resizer.addEventListener("pointerdown", (event) => startColumnResize(event, column.key));
      // Double-click hands the column back to its default width.
      resizer.addEventListener("dblclick", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        manualWidths.delete(column.key);
        sessionColumnWidths.delete(column.key);
        widths.set(column.key, column.width);
        syncTableWidth();
        fitColumnsToHost();
      });
      inner.appendChild(resizer);
      header.appendChild(inner);
      headerRow.appendChild(header);
    }
    head.appendChild(headerRow);
    table.appendChild(head);
    table.appendChild(body);
  }
  syncTableWidth();

  container.classList?.add("arExternalLinksMount");
  container.appendChild(root);

  let destroyed = false;
  let refreshGeneration = 0;
  let scrollIdleTimer = null;
  let loading = false;
  let activeAction = "";
  let advisory = null;
  let records = [];
  let selectionAnchorId = "";
  let contextRowId = "";
  const selectedIds = new Set();
  const renderedRows = new Map();
  const statusHandler = typeof onStatus === "function" ? onStatus : () => {};
  const timerHost = documentRef.defaultView || globalThis;

  const clearScrollIdleTimer = () => {
    if (scrollIdleTimer === null) return;
    timerHost.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  };

  function closeMenu() {
    menu.style.display = "none";
  }

  const handleScroll = () => {
    closeMenu();
    scrollHost.classList.add("isScrolling");
    clearScrollIdleTimer();
    scrollIdleTimer = timerHost.setTimeout(() => {
      scrollIdleTimer = null;
      scrollHost.classList.remove("isScrolling");
    }, 550);
  };

  const handlePointerMove = (event) => {
    const rect = scrollHost.getBoundingClientRect();
    const verticalScrollbarWidth = Math.max(0, scrollHost.offsetWidth - scrollHost.clientWidth);
    const horizontalScrollbarHeight = Math.max(0, scrollHost.offsetHeight - scrollHost.clientHeight);
    const nearVerticalScrollbar = scrollHost.scrollHeight > scrollHost.clientHeight
      && verticalScrollbarWidth > 0
      && event.clientX >= rect.right - Math.max(verticalScrollbarWidth, 16);
    const nearHorizontalScrollbar = scrollHost.scrollWidth > scrollHost.clientWidth
      && horizontalScrollbarHeight > 0
      && event.clientY >= rect.bottom - Math.max(horizontalScrollbarHeight, 16);
    scrollHost.classList.toggle("isScrollbarHover", nearVerticalScrollbar || nearHorizontalScrollbar);
  };

  const handlePointerLeave = () => {
    scrollHost.classList.remove("isScrollbarHover");
  };

  scrollHost.addEventListener("scroll", handleScroll, { passive: true });
  scrollHost.addEventListener("pointermove", handlePointerMove, { passive: true });
  scrollHost.addEventListener("pointerleave", handlePointerLeave, { passive: true });

  // The host is resized by the window, the tab, and the panel splitters, and
  // a tab that was hidden while its links loaded measured no width at all.
  const resizeObserver = typeof timerHost.ResizeObserver === "function"
    ? new timerHost.ResizeObserver(() => {
      fitColumnsToHost();
      syncTableEdges();
    })
    : null;
  resizeObserver?.observe(sectionsHost);

  const reportStatus = (message, tone = "") => {
    try {
      statusHandler(String(message || ""), tone);
    } catch {
      // Status reporting must not replace the primary Links-tab result.
    }
  };

  const hasRows = () => renderedRows.size > 0;
  const hasSelection = () => selectedIds.size > 0;

  const scopedRecords = () => (
    hasSelection() ? records.filter((record) => selectedIds.has(record.id)) : records.slice()
  );

  const syncBusyState = () => {
    if (destroyed) return;
    const busy = loading || Boolean(activeAction);
    root.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) closeMenu();
  };

  /**
   * Shows only the entries that have something to act on and reports whether any
   * remain. The selected-scope entries sit above the always-available all-scope
   * entries so a selection never hides the "all" actions.
   */
  const syncMenuItems = () => {
    const selectedScope = records.filter((record) => selectedIds.has(record.id));
    const breakableSelected = selectedScope.filter((record) => !record.readOnly);
    const breakableAll = records.filter((record) => !record.readOnly);
    const contextRecord = records.find((record) => record.id === contextRowId) || null;

    for (const item of openItems) {
      item.element.hidden = !contextRecord || item.availableFor(contextRecord) !== true;
    }
    openSeparator.hidden = openItems.every((item) => item.element.hidden);
    refreshSelectedItem.hidden = selectedScope.length === 0;
    breakSelectedItem.hidden = breakableSelected.length === 0;
    refreshAllItem.hidden = records.length === 0;
    breakAllItem.hidden = breakableAll.length === 0;
    menuSeparator.hidden = (refreshSelectedItem.hidden && breakSelectedItem.hidden)
      || (refreshAllItem.hidden && breakAllItem.hidden);

    refreshSelectedItem.setAttribute("aria-label", `Refresh ${selectedScope.length} selected ${nounText}`);
    breakSelectedItem.setAttribute("aria-label", `Break ${breakableSelected.length} selected ${nounText}`);
    refreshAllItem.setAttribute("aria-label", `Refresh all ${nounText}`);
    breakAllItem.setAttribute("aria-label", `Break all ${nounText}`);

    return [
      ...openItems.map((item) => item.element),
      refreshSelectedItem,
      breakSelectedItem,
      refreshAllItem,
      breakAllItem,
    ].some((item) => !item.hidden);
  };

  const restoreTableFocus = () => {
    const row = contextRowId ? renderedRows.get(contextRowId) : null;
    const target = row || scrollHost;
    try {
      target.focus?.({ preventScroll: true });
    } catch {
      // Focus restoration is best-effort; the action result is what matters.
    }
  };

  const openMenu = (event) => {
    if (destroyed || loading || activeAction) return;
    if (!syncMenuItems()) {
      closeMenu();
      return;
    }
    openContextMenu(menu, {
      anchorEl: (contextRowId && renderedRows.get(contextRowId)) || scrollHost,
      clientX: Number(event?.clientX),
      clientY: Number(event?.clientY),
      offset: 8,
      align: "top-left",
    });
  };

  const applySelection = () => {
    renderedRows.forEach((row, id) => {
      const selected = selectedIds.has(id);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      row.classList.toggle("isSelected", selected);
    });
    syncBusyState();
  };

  const selectRecord = (record, event = {}) => {
    if (destroyed) return;
    const toggle = event.ctrlKey === true || event.metaKey === true;
    const extend = event.shiftKey === true;
    const recordIndex = records.findIndex((candidate) => candidate.id === record.id);
    const anchorIndex = records.findIndex((candidate) => candidate.id === selectionAnchorId);

    if (extend && recordIndex >= 0 && anchorIndex >= 0) {
      const first = Math.min(anchorIndex, recordIndex);
      const last = Math.max(anchorIndex, recordIndex);
      const next = toggle ? new Set(selectedIds) : new Set();
      records.slice(first, last + 1).forEach((candidate) => next.add(candidate.id));
      selectedIds.clear();
      next.forEach((id) => selectedIds.add(id));
    } else if (toggle) {
      if (selectedIds.has(record.id)) selectedIds.delete(record.id);
      else selectedIds.add(record.id);
      selectionAnchorId = record.id;
    } else {
      selectedIds.clear();
      selectedIds.add(record.id);
      selectionAnchorId = record.id;
    }
    applySelection();
  };

  const showState = (kind, title, description = "") => {
    if (destroyed) return;
    const retainRows = hasRows();
    state.className = `arExternalLinksState is${kind} ${retainRows ? "hasRows" : "isStandalone"}`;
    state.setAttribute("role", kind === "Error" ? "alert" : "status");
    state.setAttribute("aria-live", kind === "Error" ? "assertive" : "polite");
    stateTitle.textContent = String(title || "");
    stateDescription.textContent = String(description || "");
    stateDescription.hidden = !stateDescription.textContent;
    state.hidden = false;
    scrollHost.hidden = !retainRows;
  };

  const hideState = () => {
    if (destroyed) return;
    state.hidden = true;
    scrollHost.hidden = false;
  };

  const appendCell = (row, key, className, text) => {
    const cell = documentRef.createElement("td");
    cell.className = `arLinksCell arLinksCell-${key}${className ? ` ${className}` : ""}`;
    cell.dataset.colKey = key;
    appendTextElement(documentRef, cell, "span", "arLinksCellText", text);
    row.appendChild(cell);
    return cell;
  };

  const sectionOrder = new Map(LINK_SECTIONS.map(({ kind }, index) => [kind, index]));

  const render = (nextRecords) => {
    if (destroyed) return;
    // Rows keep the page's order within a section, and the sections keep
    // their order on the page, so Shift-click ranges follow what is seen.
    records = nextRecords
      .map((record, index) => normalizeLinkRecord(record, index, idPrefix))
      .sort((left, right) => sectionOrder.get(left.kind) - sectionOrder.get(right.kind));
    const availableIds = new Set(records.map((record) => record.id));
    Array.from(selectedIds).forEach((id) => {
      if (!availableIds.has(id)) selectedIds.delete(id);
    });
    if (selectionAnchorId && !availableIds.has(selectionAnchorId)) selectionAnchorId = "";

    for (const { body } of sections) body.replaceChildren();
    renderedRows.clear();

    records.forEach((record) => {
      const row = documentRef.createElement("tr");
      row.tabIndex = 0;
      row.dataset.linkKind = record.kind;
      row.setAttribute("aria-selected", selectedIds.has(record.id) ? "true" : "false");
      row.classList.toggle("isSelected", selectedIds.has(record.id));
      row.addEventListener("click", (event) => selectRecord(record, event));
      row.addEventListener("keydown", (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        selectRecord(record, event);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (!selectedIds.has(record.id)) selectRecord(record, {});
        contextRowId = record.id;
        openMenu(event);
      });

      const sourceCell = documentRef.createElement("td");
      sourceCell.className = "arLinksCell arLinksCell-source";
      sourceCell.dataset.colKey = "source";
      // The section title already names the kind, so ArcRho and Excel rows
      // carry no badge; a formula row keeps its one, since its Source column
      // names the datasets the formula reads rather than the formula itself.
      if (record.kind === "formula") {
        const badge = appendTextElement(
          documentRef,
          sourceCell,
          "span",
          `arLinksKind arLinksKind-${record.kind}`,
          record.kindLabel,
        );
        badge.setAttribute("aria-label", `${record.kindLabel} link`);
      }
      appendTextElement(documentRef, sourceCell, "span", "arLinksCellText", record.source);
      row.appendChild(sourceCell);

      appendCell(row, "reference", "", record.reference);
      appendCell(row, "destination", "", record.destination);
      appendCell(row, "cells", "", record.affectedCellCount ? String(record.affectedCellCount) : "");

      renderedRows.set(record.id, row);
      sections[sectionOrder.get(record.kind)].body.appendChild(row);
    });
    for (const { section, body } of sections) section.hidden = body.children.length === 0;

    loading = false;
    if (advisory) {
      showState("Warning", advisory.title, advisory.description);
    } else if (records.length) {
      hideState();
    } else {
      showState("Empty", `No ${nounText}`, emptyDescription);
    }
    fitColumnsToHost();
    syncBusyState();
  };

  const setLoading = (message = `Loading ${nounText}...`) => {
    loading = true;
    showState("Loading", message || `Loading ${nounText}...`);
    syncBusyState();
  };

  const setError = (message) => {
    loading = false;
    showState("Error", `Unable to load ${nounText}`, message || `The ${nounText} could not be loaded.`);
    syncBusyState();
  };

  const setWarning = (title, description = "") => {
    advisory = {
      title: String(title || `${nounSentence} require attention`),
      description: String(description || ""),
    };
    showState("Warning", advisory.title, advisory.description);
    syncBusyState();
  };

  const clearWarning = () => {
    advisory = null;
    if (records.length) hideState();
    else showState("Empty", `No ${nounText}`, emptyDescription);
    syncBusyState();
  };

  let refresh = async () => false;

  refresh = async () => {
    if (destroyed) return false;
    const generation = ++refreshGeneration;
    setLoading();
    try {
      const nextRecords = await getLinks();
      if (destroyed || generation !== refreshGeneration) return false;
      if (!Array.isArray(nextRecords)) {
        throw new TypeError("Link provider must return an array.");
      }
      render(nextRecords);
      return true;
    } catch (error) {
      if (destroyed || generation !== refreshGeneration) return false;
      const message = errorMessage(error, `The ${nounText} could not be loaded.`);
      setError(message);
      reportStatus(message, "error");
      return false;
    }
  };

  const runAction = async (kind, scopeMode = "selection") => {
    if (destroyed || loading || activeAction) return false;
    const scope = scopeMode === "all" ? records.slice() : scopedRecords();
    const actionRecords = kind === "break"
      ? scope.filter((record) => !record.readOnly)
      : scope;
    if (actionRecords.length === 0) return false;

    activeAction = kind;
    syncBusyState();
    // The bulk actions live in the row context menu, so the in-tab state banner
    // is the only place that can report progress while the page handler runs.
    showState("Loading", kind === "break" ? `Breaking ${nounText}...` : `Refreshing ${nounText}...`);
    const handler = kind === "break" ? onBreakLinks : onRefreshLinks;
    const title = kind === "break" ? "Unable to break links" : "Unable to refresh links";
    const fallback = kind === "break"
      ? `The ${nounText} could not be broken.`
      : `The ${nounText} could not be refreshed.`;

    try {
      const result = await handler(actionRecords.slice());
      if (destroyed) return false;
      const failure = actionFailureMessage(result, fallback);
      if (failure) {
        showState("Error", title, failure);
        reportStatus(failure, "error");
        return false;
      }

      const refreshed = await refresh();
      if (destroyed || !refreshed) return false;
      const defaultMessage = kind === "break" ? `${nounSentence} broken.` : `${nounSentence} refreshed.`;
      reportStatus(String(result?.message || defaultMessage), "success");
      return true;
    } catch (error) {
      if (destroyed) return false;
      const message = errorMessage(error, fallback);
      showState("Error", title, message);
      reportStatus(message, "error");
      return false;
    } finally {
      activeAction = "";
      syncBusyState();
    }
  };

  const handleMenuAction = (kind, scopeMode) => {
    closeMenu();
    restoreTableFocus();
    return runAction(kind, scopeMode);
  };

  const handleOpenMenuItem = async (item) => {
    const record = records.find((candidate) => candidate.id === contextRowId);
    closeMenu();
    restoreTableFocus();
    if (destroyed || loading || activeAction || !record || item.availableFor(record) !== true) {
      return false;
    }

    activeAction = item.action;
    syncBusyState();
    try {
      const result = await item.run(record);
      if (destroyed) return false;
      const failure = actionFailureMessage(result, item.failure);
      if (failure) {
        reportStatus(failure, "error");
        return false;
      }
      reportStatus(item.success, "success");
      return true;
    } catch (error) {
      const message = errorMessage(error, item.failure);
      reportStatus(message, "error");
      return false;
    } finally {
      activeAction = "";
      syncBusyState();
    }
  };

  const handleContextMenu = (event) => {
    event.preventDefault?.();
    contextRowId = "";
    openMenu(event);
  };

  const handleDocumentPointerDown = (event) => {
    if (menu.contains?.(event.target)) return;
    closeMenu();
  };

  const handleDocumentKeyDown = (event) => {
    if (event.key === "Escape") closeMenu();
  };

  for (const item of openItems) {
    item.element.addEventListener("click", () => handleOpenMenuItem(item));
  }
  refreshSelectedItem.addEventListener("click", () => handleMenuAction("refresh", "selection"));
  breakSelectedItem.addEventListener("click", () => handleMenuAction("break", "selection"));
  refreshAllItem.addEventListener("click", () => handleMenuAction("refresh", "all"));
  breakAllItem.addEventListener("click", () => handleMenuAction("break", "all"));
  scrollHost.addEventListener("contextmenu", handleContextMenu);
  documentRef.addEventListener?.("mousedown", handleDocumentPointerDown, true);
  documentRef.addEventListener?.("keydown", handleDocumentKeyDown, true);
  timerHost.addEventListener?.("resize", closeMenu);
  timerHost.addEventListener?.("blur", closeMenu);
  syncBusyState();

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    refreshGeneration += 1;
    clearScrollIdleTimer();
    records = [];
    advisory = null;
    selectedIds.clear();
    renderedRows.clear();
    contextRowId = "";
    closeMenu();
    resizeObserver?.disconnect();
    scrollHost.removeEventListener("scroll", handleScroll);
    scrollHost.removeEventListener("pointermove", handlePointerMove);
    scrollHost.removeEventListener("pointerleave", handlePointerLeave);
    scrollHost.removeEventListener("contextmenu", handleContextMenu);
    scrollHost.classList.remove("isScrolling", "isScrollbarHover");
    documentRef.removeEventListener?.("mousedown", handleDocumentPointerDown, true);
    documentRef.removeEventListener?.("keydown", handleDocumentKeyDown, true);
    timerHost.removeEventListener?.("resize", closeMenu);
    timerHost.removeEventListener?.("blur", closeMenu);
    menu.remove();
    root.remove();
    container.classList?.remove("arExternalLinksMount");
    if (MOUNTED_LINKS_TABS.get(container) === controller) {
      MOUNTED_LINKS_TABS.delete(container);
    }
  };

  const controller = {
    refresh,
    setLoading,
    setError,
    setWarning,
    clearWarning,
    getColumnWidth: (key) => widths.get(key),
    destroy,
  };
  MOUNTED_LINKS_TABS.set(container, controller);
  return controller;
}
