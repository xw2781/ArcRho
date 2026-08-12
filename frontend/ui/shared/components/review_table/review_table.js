const CELL_TONES = new Set(["", "muted", "info", "ok", "warn", "error", "newer", "older"]);
let reviewTableSequence = 0;

function toText(value) {
  return value == null ? "" : String(value);
}

function cleanText(value) {
  return toText(value).trim();
}

function titleFromKey(value) {
  return cleanText(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizedTone(value) {
  const tone = cleanText(value).toLowerCase();
  return CELL_TONES.has(tone) ? tone : "";
}

function normalizeCell(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      text: toText(value.text ?? value.value),
      tone: normalizedTone(value.tone),
    };
  }
  return { text: toText(value), tone: "" };
}

function deriveColumns(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const first = sourceRows.find((row) => row && typeof row === "object" && !Array.isArray(row));
  if (!first) return [];
  if (first.cells && typeof first.cells === "object" && !Array.isArray(first.cells)) {
    return Object.keys(first.cells).map((key) => ({ key, label: titleFromKey(key) }));
  }
  const metadataKeys = new Set(["id", "rowId", "row_id", "selected", "disabled", "actionable", "cells"]);
  return Object.keys(first)
    .filter((key) => !metadataKeys.has(key))
    .map((key) => ({ key, label: titleFromKey(key) }));
}

export function normalizeReviewTableColumns(columns = [], rows = []) {
  const source = Array.isArray(columns) && columns.length ? columns : deriveColumns(rows);
  const seen = new Set();
  const normalized = source.map((item, index) => {
    const raw = item && typeof item === "object" && !Array.isArray(item) ? item : { key: item, label: item };
    const key = cleanText(raw.key ?? raw.id ?? raw.name);
    if (!key) throw new Error(`Review table column ${index + 1} requires a key.`);
    if (seen.has(key)) throw new Error(`Review table column key is duplicated: ${key}`);
    seen.add(key);
    const align = cleanText(raw.align).toLowerCase();
    return {
      key,
      label: cleanText(raw.label) || titleFromKey(key),
      align: ["left", "center", "right"].includes(align) ? align : "left",
    };
  });
  if (!normalized.length && Array.isArray(rows) && rows.length) {
    return [{ key: "id", label: "Item", align: "left" }];
  }
  return normalized;
}

function rawCellValue(row, key) {
  if (row?.cells && typeof row.cells === "object" && !Array.isArray(row.cells)) {
    if (Object.prototype.hasOwnProperty.call(row.cells, key)) return row.cells[key];
  }
  if (key === "id") return row?.id ?? row?.rowId ?? row?.row_id;
  return row?.[key];
}

export function normalizeReviewTableRows(rows = [], columns = [], selectedRowIds = null) {
  const source = Array.isArray(rows) ? rows : [];
  const initialSelection = Array.isArray(selectedRowIds)
    ? new Set(selectedRowIds.map((value) => cleanText(value)).filter(Boolean))
    : null;
  const seen = new Set();
  return source.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Review table row ${index + 1} must be an object.`);
    }
    const id = cleanText(item.id ?? item.rowId ?? item.row_id);
    if (!id) throw new Error(`Review table row ${index + 1} requires a stable id.`);
    if (seen.has(id)) throw new Error(`Review table row id is duplicated: ${id}`);
    seen.add(id);
    const disabled = item.disabled === true || item.actionable === false;
    const cells = columns.map((column) => normalizeCell(rawCellValue(item, column.key)));
    const selected = !disabled && (initialSelection ? initialSelection.has(id) : item.selected !== false);
    return {
      id,
      disabled,
      selected,
      cells,
      searchText: [id, ...cells.map((cell) => cell.text)].join("\n").toLocaleLowerCase(),
    };
  });
}

export function filterReviewTableRows(rows = [], query = "") {
  const needle = cleanText(query).toLocaleLowerCase();
  if (!needle) return Array.isArray(rows) ? [...rows] : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => toText(row?.searchText).includes(needle));
}

export function selectedReviewTableRowIds(rows = [], selectedIds = new Set()) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => !row.disabled && selected.has(row.id))
    .map((row) => row.id);
}

export function summarizeReviewTableSelection(rows = [], selectedIds = new Set(), visibleRows = rows) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const allRows = Array.isArray(rows) ? rows : [];
  const visible = Array.isArray(visibleRows) ? visibleRows : [];
  const actionable = allRows.filter((row) => !row.disabled);
  const visibleActionable = visible.filter((row) => !row.disabled);
  const selectedCount = actionable.filter((row) => selected.has(row.id)).length;
  const selectedVisibleCount = visibleActionable.filter((row) => selected.has(row.id)).length;
  return {
    actionableCount: actionable.length,
    selectedCount,
    visibleCount: visible.length,
    visibleActionableCount: visibleActionable.length,
    selectedVisibleCount,
    allVisibleSelected: visibleActionable.length > 0 && selectedVisibleCount === visibleActionable.length,
    someVisibleSelected: selectedVisibleCount > 0 && selectedVisibleCount < visibleActionable.length,
  };
}

export function normalizeReviewTableOptions(options = {}) {
  const sourceRows = Array.isArray(options.rows) ? options.rows : [];
  const columns = normalizeReviewTableColumns(options.columns, sourceRows);
  const rows = normalizeReviewTableRows(sourceRows, columns, options.selectedRowIds ?? options.selected_row_ids);
  return {
    title: cleanText(options.title) || "Review Sync Actions",
    message: toText(options.message ?? options.summary).trim(),
    columns,
    rows,
    searchPlaceholder: cleanText(options.searchPlaceholder ?? options.search_placeholder) || "Search actions",
    acceptLabel: cleanText(options.acceptLabel ?? options.accept_label) || "Accept Selected",
    cancelLabel: cleanText(options.cancelLabel ?? options.cancel_label) || "Cancel",
    allowEmptySelection: options.allowEmptySelection === true || options.allow_empty_selection === true,
  };
}

function createSvgCloseIcon(doc) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const first = doc.createElementNS(namespace, "path");
  first.setAttribute("d", "M4 4l8 8");
  const second = doc.createElementNS(namespace, "path");
  second.setAttribute("d", "M12 4l-8 8");
  svg.append(first, second);
  return svg;
}

function element(doc, tag, className = "", text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = toText(text);
  return node;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Number(value) || 0, minimum), Math.max(minimum, maximum));
}

function enableDialogMovement(dialog, header, resizeHandle, windowRef) {
  const margin = 12;
  let interaction = null;

  const clampRect = (left, top, width, height) => {
    const computed = windowRef.getComputedStyle(dialog);
    const minWidth = Math.max(320, Number.parseFloat(computed.minWidth) || 320);
    const minHeight = Math.max(280, Number.parseFloat(computed.minHeight) || 280);
    const maxWidth = Math.max(minWidth, windowRef.innerWidth - margin * 2);
    const maxHeight = Math.max(minHeight, windowRef.innerHeight - margin * 2);
    const nextWidth = clamp(width, Math.min(minWidth, maxWidth), maxWidth);
    const nextHeight = clamp(height, Math.min(minHeight, maxHeight), maxHeight);
    return {
      width: nextWidth,
      height: nextHeight,
      left: clamp(left, margin, windowRef.innerWidth - nextWidth - margin),
      top: clamp(top, margin, windowRef.innerHeight - nextHeight - margin),
    };
  };

  const applyRect = (rect) => {
    dialog.style.left = `${Math.round(rect.left)}px`;
    dialog.style.top = `${Math.round(rect.top)}px`;
    dialog.style.width = `${Math.round(rect.width)}px`;
    dialog.style.height = `${Math.round(rect.height)}px`;
  };

  const stopInteraction = () => {
    if (!interaction) return;
    interaction = null;
    dialog.classList.remove("dragging", "resizing");
    windowRef.removeEventListener("pointermove", onPointerMove, true);
    windowRef.removeEventListener("pointerup", stopInteraction, true);
    windowRef.removeEventListener("pointercancel", stopInteraction, true);
  };

  const onPointerMove = (event) => {
    if (!interaction) return;
    event.preventDefault();
    const deltaX = event.clientX - interaction.x;
    const deltaY = event.clientY - interaction.y;
    const next = interaction.kind === "resize"
      ? clampRect(interaction.left, interaction.top, interaction.width + deltaX, interaction.height + deltaY)
      : clampRect(interaction.left + deltaX, interaction.top + deltaY, interaction.width, interaction.height);
    applyRect(next);
  };

  const begin = (event, kind) => {
    if (event.button !== 0) return;
    if (kind === "drag" && event.target?.closest?.("button, input, label")) return;
    const rect = dialog.getBoundingClientRect();
    interaction = {
      kind,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    dialog.classList.add(kind === "resize" ? "resizing" : "dragging");
    windowRef.addEventListener("pointermove", onPointerMove, true);
    windowRef.addEventListener("pointerup", stopInteraction, true);
    windowRef.addEventListener("pointercancel", stopInteraction, true);
    event.preventDefault();
    event.stopPropagation();
  };

  const onHeaderPointerDown = (event) => begin(event, "drag");
  const onResizePointerDown = (event) => begin(event, "resize");
  const onWindowResize = () => {
    const rect = dialog.getBoundingClientRect();
    applyRect(clampRect(rect.left, rect.top, rect.width, rect.height));
  };
  header.addEventListener("pointerdown", onHeaderPointerDown);
  resizeHandle.addEventListener("pointerdown", onResizePointerDown);
  windowRef.addEventListener("resize", onWindowResize);

  return {
    center() {
      const rect = dialog.getBoundingClientRect();
      applyRect(clampRect(
        Math.round((windowRef.innerWidth - rect.width) / 2),
        Math.round((windowRef.innerHeight - rect.height) / 2),
        rect.width,
        rect.height,
      ));
    },
    destroy() {
      stopInteraction();
      header.removeEventListener("pointerdown", onHeaderPointerDown);
      resizeHandle.removeEventListener("pointerdown", onResizePointerDown);
      windowRef.removeEventListener("resize", onWindowResize);
    },
  };
}

// Host-neutral review surface: the message, search toolbar, selectable table,
// and footer actions without any dialog chrome. The modal dialog below and the
// Project Instance nested-window page both embed this panel, so selection,
// filtering, and completion semantics stay identical in every host.
export function createReviewTablePanel(options = {}, settings = {}) {
  const model = normalizeReviewTableOptions(options);
  const doc = settings.documentRef || document;
  const container = settings.container;
  if (!container) throw new Error("Review table panel requires a container.");
  const selectedIds = new Set(model.rows.filter((row) => row.selected).map((row) => row.id));
  let settled = false;
  let visibleRows = [...model.rows];

  const body = element(doc, "div", "reviewTableBody");
  const message = element(doc, "p", "reviewTableMessage", model.message);
  message.hidden = !model.message;
  const toolbar = element(doc, "div", "reviewTableToolbar");
  const search = element(doc, "input", "reviewTableSearch");
  search.type = "search";
  search.placeholder = model.searchPlaceholder;
  search.setAttribute("aria-label", model.searchPlaceholder);
  const count = element(doc, "span", "reviewTableCount");
  count.setAttribute("aria-live", "polite");
  toolbar.append(search, count);

  const frame = element(doc, "div", "reviewTableFrame");
  const table = element(doc, "table", "reviewTable");
  const head = element(doc, "thead");
  const headRow = element(doc, "tr");
  const selectHead = element(doc, "th", "reviewTableSelectColumn");
  selectHead.scope = "col";
  const selectAll = element(doc, "input", "reviewTableSelectAll");
  selectAll.type = "checkbox";
  selectAll.setAttribute("aria-label", "Select all visible actions");
  selectHead.appendChild(selectAll);
  headRow.appendChild(selectHead);
  model.columns.forEach((column) => {
    const cell = element(doc, "th", "", column.label);
    cell.scope = "col";
    cell.dataset.align = column.align;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  const tableBody = element(doc, "tbody");
  table.append(head, tableBody);
  const empty = element(doc, "div", "reviewTableEmpty", "No actions match the current search.");
  empty.hidden = true;
  frame.append(table, empty);
  body.append(message, toolbar, frame);

  const footer = element(doc, "div", "reviewTableFooter");
  const selectionStatus = element(doc, "span", "reviewTableSelectionStatus");
  selectionStatus.setAttribute("aria-live", "polite");
  const actions = element(doc, "div", "reviewTableActions");
  const cancelButton = element(doc, "button", "reviewTableButton", model.cancelLabel);
  cancelButton.type = "button";
  const acceptButton = element(doc, "button", "reviewTableButton primary", model.acceptLabel);
  acceptButton.type = "button";
  actions.append(cancelButton, acceptButton);
  footer.append(selectionStatus, actions);
  container.append(body, footer);

  function updateSelectionUi() {
    const summary = summarizeReviewTableSelection(model.rows, selectedIds, visibleRows);
    selectAll.checked = summary.allVisibleSelected;
    selectAll.indeterminate = summary.someVisibleSelected;
    selectAll.disabled = summary.visibleActionableCount === 0;
    count.textContent = `${summary.visibleCount} of ${model.rows.length} rows shown`;
    selectionStatus.textContent = `${summary.selectedCount} of ${summary.actionableCount} actions selected`;
    acceptButton.disabled = !model.allowEmptySelection && summary.selectedCount === 0;
  }

  function renderRows() {
    tableBody.replaceChildren();
    visibleRows = filterReviewTableRows(model.rows, search.value);
    visibleRows.forEach((row) => {
      const tableRow = element(doc, "tr");
      tableRow.dataset.rowId = row.id;
      if (row.disabled) tableRow.setAttribute("aria-disabled", "true");
      const actionCell = element(doc, "td", "reviewTableSelectColumn");
      const checkbox = element(doc, "input", "reviewTableRowSelect");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(row.id);
      checkbox.disabled = row.disabled;
      checkbox.setAttribute("aria-label", row.disabled ? `Action unavailable for ${row.id}` : `Select action for ${row.id}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedIds.add(row.id);
        else selectedIds.delete(row.id);
        updateSelectionUi();
      });
      actionCell.appendChild(checkbox);
      tableRow.appendChild(actionCell);
      row.cells.forEach((cellValue, columnIndex) => {
        const cell = element(doc, "td");
        cell.textContent = cellValue.text;
        cell.dataset.align = model.columns[columnIndex]?.align || "left";
        if (cellValue.tone) cell.dataset.tone = cellValue.tone;
        tableRow.appendChild(cell);
      });
      tableBody.appendChild(tableRow);
    });
    table.hidden = visibleRows.length === 0;
    empty.hidden = visibleRows.length !== 0;
    updateSelectionUi();
  }

  function finish(accepted, reason = "user") {
    if (settled) return;
    settled = true;
    settings.onComplete?.({
      accepted: !!accepted,
      selectedRowIds: accepted ? selectedReviewTableRowIds(model.rows, selectedIds) : [],
      reason,
    });
  }

  search.addEventListener("input", renderRows);
  selectAll.addEventListener("change", () => {
    visibleRows.filter((row) => !row.disabled).forEach((row) => {
      if (selectAll.checked) selectedIds.add(row.id);
      else selectedIds.delete(row.id);
    });
    renderRows();
  });
  cancelButton.addEventListener("click", () => finish(false, "cancel"));
  acceptButton.addEventListener("click", () => finish(true, "accept"));
  renderRows();

  return {
    title: model.title,
    body,
    footer,
    cancel(reason = "cancel") {
      finish(false, reason);
    },
    focusSearch() {
      try { search.focus(); } catch {}
    },
    get isOpen() {
      return !settled;
    },
  };
}

export function createReviewTableDialog(options = {}, settings = {}) {
  const doc = settings.documentRef || document;
  const windowRef = doc.defaultView || window;
  const domId = `reviewTable${++reviewTableSequence}`;
  const returnFocus = doc.activeElement;

  const overlay = element(doc, "div", "reviewTableOverlay host-nodrag");
  overlay.setAttribute("role", "presentation");
  const dialog = element(doc, "section", "reviewTableDialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${domId}Title`);

  const header = element(doc, "div", "reviewTableHeader");
  const title = element(doc, "h2", "reviewTableTitle", "");
  title.id = `${domId}Title`;
  const closeButton = element(doc, "button", "reviewTableClose");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Cancel review");
  closeButton.appendChild(createSvgCloseIcon(doc));
  header.append(title, closeButton);
  dialog.appendChild(header);

  const panel = createReviewTablePanel(options, {
    documentRef: doc,
    onComplete(result) {
      teardown();
      settings.onComplete?.(result);
    },
    container: dialog,
  });
  title.textContent = panel.title;

  const resizeHandle = element(doc, "div", "reviewTableResizeHandle");
  resizeHandle.setAttribute("role", "presentation");
  resizeHandle.setAttribute("aria-hidden", "true");
  dialog.appendChild(resizeHandle);
  overlay.appendChild(dialog);

  const inertSiblings = Array.from(doc.body.children)
    .filter((node) => node !== overlay)
    .map((node) => ({ node, inert: !!node.inert }));
  inertSiblings.forEach(({ node }) => { node.inert = true; });
  doc.body.appendChild(overlay);
  const movement = enableDialogMovement(dialog, header, resizeHandle, windowRef);
  movement.center();

  function focusableElements() {
    return Array.from(dialog.querySelectorAll(
      "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
    ));
  }

  function teardown() {
    doc.removeEventListener("keydown", onKeyDown, true);
    movement.destroy();
    overlay.remove();
    inertSiblings.forEach(({ node, inert }) => {
      if (node.isConnected) node.inert = inert;
    });
    if (returnFocus?.isConnected && typeof returnFocus.focus === "function") {
      windowRef.requestAnimationFrame(() => returnFocus.focus());
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      panel.cancel("escape");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  closeButton.addEventListener("click", () => panel.cancel("close"));
  doc.addEventListener("keydown", onKeyDown, true);
  windowRef.requestAnimationFrame(() => panel.focusSearch());

  return {
    close(reason = "automation") {
      panel.cancel(reason);
    },
    get isOpen() {
      return panel.isOpen;
    },
  };
}
