import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260715a";

const EXTERNAL_LINKS_STYLESHEET_ID = "arExternalLinksStylesheet";
const EXTERNAL_LINKS_STYLESHEET_HREF = "/ui/shared/tabs/links/links_tab.css?v=20260715b";
const MOUNTED_EXTERNAL_LINKS_TABS = new WeakMap();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

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

function appendSvgElement(documentRef, parent, tagName, attributes = {}) {
  const element = typeof documentRef.createElementNS === "function"
    ? documentRef.createElementNS(SVG_NAMESPACE, tagName)
    : documentRef.createElement(tagName);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  parent.appendChild(element);
  return element;
}

function appendToolbarIcon(documentRef, button, kind) {
  const icon = appendSvgElement(documentRef, button, "svg", {
    class: `arExternalLinksToolbarIcon is${kind}`,
    viewBox: "0 0 20 20",
    width: "20",
    height: "20",
    "aria-hidden": "true",
    focusable: "false",
  });

  if (kind === "Refresh") {
    appendSvgElement(documentRef, icon, "path", {
      d: "M16.6 6.8A7 7 0 1 0 17 12",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
    });
    appendSvgElement(documentRef, icon, "path", {
      d: "M13.2 3.6h3.6v3.6",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    return icon;
  }

  appendSvgElement(documentRef, icon, "path", {
    d: "M7.7 12.3 6.2 13.8a3 3 0 0 1-4.2-4.2l2.4-2.4a3 3 0 0 1 4.2 0",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.45",
    "stroke-linecap": "round",
  });
  appendSvgElement(documentRef, icon, "path", {
    d: "m10.5 9.5 1.2-1.2a3 3 0 0 1 4.2 4.2l-1.5 1.5",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.45",
    "stroke-linecap": "round",
  });
  appendSvgElement(documentRef, icon, "path", {
    d: "m11.8 13.2 5 5m0-5-5 5",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.55",
    "stroke-linecap": "round",
  });
  return icon;
}

function createToolbarButton(documentRef, parent, kind, label) {
  const button = documentRef.createElement("button");
  button.className = `arExternalLinksToolbarButton is${kind}`;
  button.type = "button";
  appendToolbarIcon(documentRef, button, kind);
  const text = appendTextElement(
    documentRef,
    button,
    "span",
    "arExternalLinksToolbarButtonText",
    label,
  );
  parent.appendChild(button);
  return { button, text };
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

  const toolbar = documentRef.createElement("div");
  toolbar.className = "arExternalLinksToolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", `${String(ariaLabel || "External links")} actions`);
  const refreshControl = createToolbarButton(documentRef, toolbar, "Refresh", "Refresh all");
  const breakControl = createToolbarButton(documentRef, toolbar, "Break", "Break all");
  root.appendChild(toolbar);

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
  let records = [];
  let selectionAnchorId = "";
  const selectedIds = new Set();
  const renderedRows = new Map();
  const statusHandler = typeof onStatus === "function" ? onStatus : () => {};
  const timerHost = documentRef.defaultView || globalThis;

  const clearScrollIdleTimer = () => {
    if (scrollIdleTimer === null) return;
    timerHost.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  };

  const handleScroll = () => {
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

  const syncToolbar = () => {
    if (destroyed) return;
    const busy = loading || Boolean(activeAction);
    const selected = hasSelection();
    const scope = scopedRecords();
    const breakable = scope.filter((record) => !record.readOnly);

    refreshControl.text.textContent = activeAction === "refresh"
      ? "Refreshing..."
      : selected ? "Refresh selected" : "Refresh all";
    breakControl.text.textContent = activeAction === "break"
      ? "Breaking..."
      : selected ? "Break selected" : "Break all";

    refreshControl.button.disabled = busy || scope.length === 0;
    breakControl.button.disabled = busy || breakable.length === 0;
    refreshControl.button.setAttribute(
      "aria-label",
      selected ? `Refresh ${scope.length} selected external links` : "Refresh all external links",
    );
    breakControl.button.setAttribute(
      "aria-label",
      selected ? `Break ${breakable.length} selected external links` : "Break all external links",
    );
    if (activeAction === "refresh") refreshControl.button.setAttribute("aria-busy", "true");
    else refreshControl.button.removeAttribute("aria-busy");
    if (activeAction === "break") breakControl.button.setAttribute("aria-busy", "true");
    else breakControl.button.removeAttribute("aria-busy");

    if (scope.length > 0 && breakable.length === 0) {
      breakControl.button.setAttribute(
        "aria-description",
        selected
          ? "The selected external links are read-only."
          : "The external links are read-only.",
      );
    } else {
      breakControl.button.removeAttribute("aria-description");
    }
    root.setAttribute("aria-busy", busy ? "true" : "false");
  };

  const applySelection = () => {
    renderedRows.forEach((row, id) => {
      const selected = selectedIds.has(id);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      row.classList.toggle("isSelected", selected);
    });
    syncToolbar();
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
    if (records.length) {
      hideState();
    } else {
      showState("Empty", "No external links", emptyDescription);
    }
    syncToolbar();
  };

  const setLoading = (message = "Loading external links...") => {
    loading = true;
    showState("Loading", message || "Loading external links...");
    syncToolbar();
  };

  const setError = (message) => {
    loading = false;
    showState(
      "Error",
      "Unable to load external links",
      message || "The external links could not be loaded.",
    );
    syncToolbar();
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

  const runAction = async (kind) => {
    if (destroyed || loading || activeAction) return false;
    const scope = scopedRecords();
    const actionRecords = kind === "break"
      ? scope.filter((record) => !record.readOnly)
      : scope;
    if (actionRecords.length === 0) return false;

    activeAction = kind;
    syncToolbar();
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
      syncToolbar();
    }
  };

  refreshControl.button.addEventListener("click", () => runAction("refresh"));
  breakControl.button.addEventListener("click", () => runAction("break"));
  syncToolbar();

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    refreshGeneration += 1;
    clearScrollIdleTimer();
    records = [];
    selectedIds.clear();
    renderedRows.clear();
    scrollHost.removeEventListener("scroll", handleScroll);
    scrollHost.removeEventListener("pointermove", handlePointerMove);
    scrollHost.removeEventListener("pointerleave", handlePointerLeave);
    scrollHost.classList.remove("isScrolling", "isScrollbarHover");
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
    destroy,
  };
  MOUNTED_EXTERNAL_LINKS_TABS.set(container, controller);
  return controller;
}
