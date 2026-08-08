import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260715a";

const EXTERNAL_LINKS_STYLESHEET_ID = "arExternalLinksStylesheet";
const EXTERNAL_LINKS_STYLESHEET_HREF = "/ui/shared/tabs/links/links_tab.css?v=20260807a";
const MOUNTED_EXTERNAL_LINKS_TABS = new WeakMap();

function ensureExternalLinksStylesheet(documentRef) {
  const existingById = documentRef.getElementById?.(EXTERNAL_LINKS_STYLESHEET_ID);
  if (existingById) return existingById;

  const matchingLink = Array.from(
    documentRef.querySelectorAll?.('link[rel="stylesheet"]') || [],
  ).find((link) => link.getAttribute("href") === EXTERNAL_LINKS_STYLESHEET_HREF);
  if (matchingLink) return matchingLink;

  const link = documentRef.createElement("link");
  link.id = EXTERNAL_LINKS_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = EXTERNAL_LINKS_STYLESHEET_HREF;
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

function normalizeExternalLinkRecord(record, index) {
  const source = record && typeof record === "object" && !Array.isArray(record)
    ? record
    : {};
  const id = String(source.id ?? "").trim() || `external-link-${index + 1}`;
  return {
    id,
    workbookPath: String(source.workbookPath ?? "").trim(),
    worksheet: String(source.worksheet ?? "").trim(),
    address: String(source.address ?? "").trim(),
    destination: String(source.destination ?? "").trim(),
    value: String(source.value ?? ""),
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

/**
 * Mounts a reusable external-links table into a page-owned container.
 * Domain adapters retain ownership of link discovery, refresh, persistence, and dirty state.
 */
export function createExternalLinksTab({
  container,
  ariaLabel = "External links",
  emptyDescription = "External workbook links used by this page will appear here.",
  getLinks,
  onRefreshLinks,
  onBreakLinks,
  onStatus,
  documentRef = container?.ownerDocument || globalThis.document,
} = {}) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("createExternalLinksTab requires a document.");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createExternalLinksTab requires a container element.");
  }
  if (typeof getLinks !== "function") {
    throw new TypeError("createExternalLinksTab requires getLinks to be a function.");
  }
  if (typeof onRefreshLinks !== "function") {
    throw new TypeError("createExternalLinksTab requires onRefreshLinks to be a function.");
  }
  if (typeof onBreakLinks !== "function") {
    throw new TypeError("createExternalLinksTab requires onBreakLinks to be a function.");
  }
  if (onStatus !== undefined && typeof onStatus !== "function") {
    throw new TypeError("createExternalLinksTab onStatus must be a function when provided.");
  }
  if (MOUNTED_EXTERNAL_LINKS_TABS.has(container)) {
    throw new Error(
      "createExternalLinksTab requires an unused container; destroy the existing Links tab first.",
    );
  }

  ensureExternalLinksStylesheet(documentRef);

  const root = documentRef.createElement("div");
  root.className = "arExternalLinks";
  root.setAttribute("aria-busy", "false");

  const menu = documentRef.createElement("div");
  menu.className = "ctx-menu arExternalLinksMenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${String(ariaLabel || "External links")} actions`);
  menu.style.display = "none";
  const menuInner = documentRef.createElement("div");
  menuInner.className = "ctx-menu-inner";
  menu.appendChild(menuInner);
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
  const stateTitle = appendTextElement(
    documentRef,
    state,
    "strong",
    "arExternalLinksStateTitle",
    "No external links",
  );
  const stateDescription = appendTextElement(
    documentRef,
    state,
    "span",
    "arExternalLinksStateDescription",
    emptyDescription,
  );
  stateDescription.hidden = !stateDescription.textContent;
  root.appendChild(state);

  const scrollHost = documentRef.createElement("div");
  scrollHost.className = "arExternalLinksScroll";
  scrollHost.tabIndex = 0;
  scrollHost.hidden = true;
  scrollHost.setAttribute("role", "region");
  scrollHost.setAttribute("aria-label", `${String(ariaLabel || "External links")} table`);
  scrollHost.setAttribute("aria-haspopup", "menu");
  root.appendChild(scrollHost);

  const table = documentRef.createElement("table");
  table.className = "arExternalLinksTable";
  table.setAttribute("role", "grid");
  table.setAttribute("aria-multiselectable", "true");
  table.setAttribute("aria-label", String(ariaLabel || "External links"));
  scrollHost.appendChild(table);

  const colgroup = documentRef.createElement("colgroup");
  for (const className of [
    "arExternalLinksWorkbookColumn",
    "arExternalLinksWorksheetColumn",
    "arExternalLinksAddressColumn",
    "arExternalLinksDestinationColumn",
    "arExternalLinksValueColumn",
  ]) {
    const column = documentRef.createElement("col");
    column.className = className;
    colgroup.appendChild(column);
  }
  table.appendChild(colgroup);

  const head = documentRef.createElement("thead");
  const headerRow = documentRef.createElement("tr");
  for (const label of ["Workbook", "Worksheet", "Cell Address", "Destination", "Values"]) {
    const header = documentRef.createElement("th");
    header.scope = "col";
    header.textContent = label;
    headerRow.appendChild(header);
  }
  head.appendChild(headerRow);
  table.appendChild(head);

  const body = documentRef.createElement("tbody");
  table.appendChild(body);

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

  const closeMenu = () => {
    menu.style.display = "none";
  };

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
    scrollHost.classList.toggle(
      "isScrollbarHover",
      nearVerticalScrollbar || nearHorizontalScrollbar,
    );
  };

  const handlePointerLeave = () => {
    scrollHost.classList.remove("isScrollbarHover");
  };

  scrollHost.addEventListener("scroll", handleScroll, { passive: true });
  scrollHost.addEventListener("pointermove", handlePointerMove, { passive: true });
  scrollHost.addEventListener("pointerleave", handlePointerLeave, { passive: true });

  const reportStatus = (message, tone = "") => {
    try {
      statusHandler(String(message || ""), tone);
    } catch {
      // Status reporting must not replace the primary Links-tab result.
    }
  };

  const hasRows = () => body.children.length > 0;
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

    refreshSelectedItem.hidden = selectedScope.length === 0;
    breakSelectedItem.hidden = breakableSelected.length === 0;
    refreshAllItem.hidden = records.length === 0;
    breakAllItem.hidden = breakableAll.length === 0;
    menuSeparator.hidden = (refreshSelectedItem.hidden && breakSelectedItem.hidden)
      || (refreshAllItem.hidden && breakAllItem.hidden);

    refreshSelectedItem.setAttribute(
      "aria-label",
      `Refresh ${selectedScope.length} selected external links`,
    );
    breakSelectedItem.setAttribute(
      "aria-label",
      `Break ${breakableSelected.length} selected external links`,
    );
    refreshAllItem.setAttribute("aria-label", "Refresh all external links");
    breakAllItem.setAttribute("aria-label", "Break all external links");

    return [refreshSelectedItem, breakSelectedItem, refreshAllItem, breakAllItem]
      .some((item) => !item.hidden);
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
      anchorEl: contextRowId ? renderedRows.get(contextRowId) || scrollHost : scrollHost,
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

  const render = (nextRecords) => {
    if (destroyed) return;
    records = nextRecords.map(normalizeExternalLinkRecord);
    const availableIds = new Set(records.map((record) => record.id));
    Array.from(selectedIds).forEach((id) => {
      if (!availableIds.has(id)) selectedIds.delete(id);
    });
    if (selectionAnchorId && !availableIds.has(selectionAnchorId)) selectionAnchorId = "";

    body.replaceChildren();
    renderedRows.clear();

    records.forEach((record) => {
      const row = documentRef.createElement("tr");
      row.tabIndex = 0;
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

      for (const [className, value] of [
        ["arExternalLinksWorkbookCell", record.workbookPath],
        ["arExternalLinksWorksheetCell", record.worksheet],
        ["arExternalLinksAddressCell", record.address],
      ]) {
        const cell = documentRef.createElement("td");
        cell.className = className;
        cell.textContent = value;
        attachArcrhoTooltip(cell, value, { document: documentRef });
        row.appendChild(cell);
      }

      const destinationCell = documentRef.createElement("td");
      destinationCell.className = "arExternalLinksDestinationCell";
      const destinationText = appendTextElement(
        documentRef,
        destinationCell,
        "span",
        "arExternalLinksDestinationText",
        record.destination,
      );
      attachArcrhoTooltip(destinationText, record.destination, { document: documentRef });
      if (record.affectedCellCount > 0) {
        const countLabel = `${record.affectedCellCount} ${record.affectedCellCount === 1 ? "cell" : "cells"}`;
        appendTextElement(
          documentRef,
          destinationCell,
          "span",
          "arExternalLinksAffectedCount",
          countLabel,
        );
      }
      row.appendChild(destinationCell);

      const valueCell = documentRef.createElement("td");
      valueCell.className = "arExternalLinksValueCell";
      valueCell.textContent = record.value;
      attachArcrhoTooltip(valueCell, record.value, { document: documentRef });
      row.appendChild(valueCell);

      renderedRows.set(record.id, row);
      body.appendChild(row);
    });

    loading = false;
    if (advisory) {
      showState("Warning", advisory.title, advisory.description);
    } else if (records.length) {
      hideState();
    } else {
      showState("Empty", "No external links", emptyDescription);
    }
    syncBusyState();
  };

  const setLoading = (message = "Loading external links...") => {
    loading = true;
    showState("Loading", message || "Loading external links...");
    syncBusyState();
  };

  const setError = (message) => {
    loading = false;
    showState(
      "Error",
      "Unable to load external links",
      message || "The external links could not be loaded.",
    );
    syncBusyState();
  };

  const setWarning = (title, description = "") => {
    advisory = {
      title: String(title || "External links require attention"),
      description: String(description || ""),
    };
    showState("Warning", advisory.title, advisory.description);
    syncBusyState();
  };

  const clearWarning = () => {
    advisory = null;
    if (records.length) hideState();
    else showState("Empty", "No external links", emptyDescription);
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
        throw new TypeError("External link provider must return an array.");
      }
      render(nextRecords);
      return true;
    } catch (error) {
      if (destroyed || generation !== refreshGeneration) return false;
      const message = errorMessage(error, "The external links could not be loaded.");
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
    // The bulk actions moved into the row context menu, so the in-tab state banner is the
    // only place left that can report progress while the domain handler runs.
    showState(
      "Loading",
      kind === "break" ? "Breaking external links..." : "Refreshing external links...",
    );
    const handler = kind === "break" ? onBreakLinks : onRefreshLinks;
    const title = kind === "break" ? "Unable to break links" : "Unable to refresh links";
    const fallback = kind === "break"
      ? "The external links could not be broken."
      : "The external links could not be refreshed.";

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
      const defaultMessage = kind === "break"
        ? "External links broken."
        : "External links refreshed.";
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
    scrollHost.removeEventListener("scroll", handleScroll);
    scrollHost.removeEventListener("pointermove", handlePointerMove);
    scrollHost.removeEventListener("pointerleave", handlePointerLeave);
    scrollHost.removeEventListener("contextmenu", handleContextMenu);
    documentRef.removeEventListener?.("mousedown", handleDocumentPointerDown, true);
    documentRef.removeEventListener?.("keydown", handleDocumentKeyDown, true);
    timerHost.removeEventListener?.("resize", closeMenu);
    timerHost.removeEventListener?.("blur", closeMenu);
    scrollHost.classList.remove("isScrolling", "isScrollbarHover");
    menu.remove();
    root.remove();
    container.classList?.remove("arExternalLinksMount");
    if (MOUNTED_EXTERNAL_LINKS_TABS.get(container) === controller) {
      MOUNTED_EXTERNAL_LINKS_TABS.delete(container);
    }
  };

  const controller = {
    refresh,
    setLoading,
    setError,
    setWarning,
    clearWarning,
    destroy,
  };
  MOUNTED_EXTERNAL_LINKS_TABS.set(container, controller);
  return controller;
}
