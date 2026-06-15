// ---------------------------------------------------------------------------
// Cell types
// ---------------------------------------------------------------------------

function normalizeCellType(rawType) {
  const type = String(rawType || "").toLowerCase();
  if (type === CELL_TYPES.MARKDOWN) return CELL_TYPES.MARKDOWN;
  if (type === CELL_TYPES.RAW) return CELL_TYPES.RAW;
  return CELL_TYPES.CODE;
}

function getSelectedNewCellType() {
  return normalizeCellType(newCellTypeSelect?.value);
}

function getCellEditorLanguage(cellType) {
  const type = normalizeCellType(cellType);
  if (type === CELL_TYPES.MARKDOWN) return "markdown";
  if (type === CELL_TYPES.RAW) return "plaintext";
  return "python";
}

function getCellLineHighlightMode(cellType, isEditing) {
  return normalizeCellType(cellType) === CELL_TYPES.CODE && Boolean(isEditing)
    ? "line"
    : "none";
}

function getCellOccurrencesHighlightMode(isEditing) {
  return isEditing ? "singleFile" : "off";
}

function getCellIdleLabel(cellType) {
  const type = normalizeCellType(cellType);
  if (type === CELL_TYPES.MARKDOWN) return "[ ]";
  if (type === CELL_TYPES.RAW) return "[ ]";
  return "[ ]";
}

function formatExecTime(ms) {
  if (ms == null || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${min}m ${sec}s`;
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = ts instanceof Date ? ts : new Date(ts);
  const yyyy = d.getFullYear();
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mon}-${dd} ${hh}:${mm}:${ss}`;
}

function updateCellExecTime(cell, ms, startTime, endTime) {
  if (!cell) return;
  cell.executionTimeMs = ms != null ? ms : null;
  cell.execStartTime = startTime || null;
  cell.execEndTime = endTime || null;
  if (cell.execTimeEl) {
    cell.execTimeEl.textContent = ms != null ? formatExecTime(ms) : "";
    if (ms != null) {
      const lines = [`Duration: ${formatExecTime(ms)}`];
      if (startTime) lines.push(`Start: ${formatTimestamp(startTime)}`);
      if (endTime) lines.push(`End: ${formatTimestamp(endTime)}`);
      cell.execTimeEl.title = lines.join("\n");
    } else {
      cell.execTimeEl.title = "";
    }
  }
}

function setCellOutputVisible(cell, visible) {
  if (!cell || !cell.outputEl) return;
  const nextVisible = Boolean(visible);
  cell.outputEl.classList.toggle("visible", nextVisible);
  if (cell.outputFrameEl) {
    cell.outputFrameEl.classList.toggle("visible", nextVisible);
  }
  if (cell.bottomRowEl) {
    cell.bottomRowEl.classList.toggle("visible", nextVisible);
  }
  // Clear user-collapsed when new output is shown
  if (nextVisible && cell.bottomRowEl) {
    cell.bottomRowEl.classList.remove("output-collapsed");
  }
}

function clampOutputHeight(height) {
  return Math.max(96, Math.min(1600, Math.round(height)));
}

function getOutputResizeStartHeight(outputEl) {
  const rectHeight = outputEl?.getBoundingClientRect?.().height || 0;
  if (rectHeight > 0) return rectHeight;
  const computed = window.getComputedStyle(outputEl);
  const maxHeight = Number.parseFloat(computed.maxHeight);
  if (Number.isFinite(maxHeight) && maxHeight > 0) return maxHeight;
  return 600;
}

function setOutputResizeHeight(outputEl, handleEl, height) {
  const nextHeight = clampOutputHeight(height);
  outputEl.style.height = `${nextHeight}px`;
  outputEl.style.maxHeight = `${nextHeight}px`;
  handleEl?.setAttribute("aria-valuenow", String(nextHeight));
}

function bindCellOutputResize(outputEl, handleEl) {
  if (!outputEl || !handleEl) return;
  let state = null;

  function finishResize(event) {
    if (!state || event.pointerId !== state.pointerId) return;
    try {
      handleEl.releasePointerCapture(state.pointerId);
    } catch {
      // Pointer capture may already be gone if the window lost focus.
    }
    state = null;
    document.body.classList.remove("sc-output-resizing");
  }

  handleEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    state = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: getOutputResizeStartHeight(outputEl),
    };
    handleEl.setPointerCapture(event.pointerId);
    document.body.classList.add("sc-output-resizing");
  });

  handleEl.addEventListener("pointermove", (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    setOutputResizeHeight(outputEl, handleEl, state.startHeight + event.clientY - state.startY);
  });

  handleEl.addEventListener("pointerup", finishResize);
  handleEl.addEventListener("pointercancel", finishResize);
  handleEl.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    setOutputResizeHeight(outputEl, handleEl, getOutputResizeStartHeight(outputEl) + direction * 32);
  });
}

function toggleCellOutputCollapse(cell) {
  if (!cell || !cell.bottomRowEl) return;
  const hasOutput = cell.outputEl?.classList.contains("visible");
  const isCollapsed = cell.bottomRowEl.classList.contains("output-collapsed");

  if (isCollapsed) {
    // Restore: show full output
    cell.bottomRowEl.classList.remove("output-collapsed");
    cell.outputEl?.classList.add("visible");
    cell.outputFrameEl?.classList.add("visible");
    if (cell.collapsePreviewEl) cell.collapsePreviewEl.style.display = "none";
  } else if (hasOutput) {
    // Collapse: hide output content but keep bottom row visible with preview
    cell.outputEl?.classList.remove("visible");
    cell.outputFrameEl?.classList.remove("visible");
    cell.bottomRowEl.classList.add("output-collapsed");
    // Extract first line of output text for preview
    if (cell.collapsePreviewEl) {
      const raw = cell.outputEl?.textContent || "";
      const firstLine = raw.split("\n").find((l) => l.trim() !== "") || "";
      const preview = firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;
      cell.collapsePreviewEl.firstChild.textContent = preview || "Output Collapsed";
      cell.collapsePreviewEl.style.display = "flex";
    }
  }
}

function isRunnableCellType(cellType) {
  const type = normalizeCellType(cellType);
  return type === CELL_TYPES.CODE || type === CELL_TYPES.MARKDOWN;
}

function getCellRunButtonTitle(cellType) {
  const type = normalizeCellType(cellType);
  if (type === CELL_TYPES.CODE) return getRunButtonTitle();
  if (type === CELL_TYPES.MARKDOWN) {
    return `Render markdown (${shortcutBindings.runCellPrimary} / ${shortcutBindings.runCellAlternate})`;
  }
  return `Run unavailable for ${type} cells`;
}

function updateCellIdleState(cell) {
  if (!cell) return;
  const normalizedType = normalizeCellType(cell.type);
  cell.cellEl.classList.toggle("code", normalizedType === CELL_TYPES.CODE);
  cell.cellEl.classList.toggle("raw", normalizedType === CELL_TYPES.RAW);
  cell.cellEl.classList.toggle("markdown", normalizedType === CELL_TYPES.MARKDOWN);
  cell.cellEl.classList.remove("success", "error");
  cell.labelEl.classList.remove("ran", "err");
  cell.labelEl.textContent = getCellIdleLabel(cell.type);
  cell.labelEl.classList.toggle("empty", cell.labelEl.textContent === "[ ]");
  if (normalizedType !== CELL_TYPES.MARKDOWN) {
    cell.markdownRendered = false;
    cell.cellEl.classList.remove("markdown-rendered");
  } else if (!cell.markdownRendered) {
    cell.cellEl.classList.remove("markdown-rendered");
  }

  if (cell.runBtn) {
    const runnable = isRunnableCellType(cell.type);
    cell.runBtn.disabled = !runnable;
    cell.runBtn.title = getCellRunButtonTitle(cell.type);
  }

  if (!isRunnableCellType(cell.type)) {
    cell.outputs = [];
    cell.outputEl.innerHTML = "";
    setCellOutputVisible(cell, false);
  }
}

function appendIfMissing(parent, child) {
  if (!parent || !child) return;
  if (child.parentElement !== parent) parent.appendChild(child);
}

function applyCellLayoutStructure(cell, cellType = cell?.type) {
  if (!cell || !cell.cellEl || !cell.bodyEl || !cell.sidePanel) return;
  const normalizedType = normalizeCellType(cellType);
  const useCodeLayout = normalizedType === CELL_TYPES.CODE;

  if (useCodeLayout) {
    appendIfMissing(cell.topRowEl, cell.sidePanel);
    appendIfMissing(cell.topRowEl, cell.inputFrameEl);
    appendIfMissing(cell.bottomRowEl, cell.outputSidePlaceholderEl);
    appendIfMissing(cell.bottomRowEl, cell.outputFrameEl);
    appendIfMissing(cell.bodyEl, cell.topRowEl);
    appendIfMissing(cell.bodyEl, cell.bottomRowEl);
    appendIfMissing(cell.cellEl, cell.bodyEl);
    return;
  }

  if (cell.topRowEl?.parentElement === cell.bodyEl) {
    cell.bodyEl.removeChild(cell.topRowEl);
  }
  if (cell.bottomRowEl?.parentElement === cell.bodyEl) {
    cell.bodyEl.removeChild(cell.bottomRowEl);
  }

  appendIfMissing(cell.bodyEl, cell.inputFrameEl);
  appendIfMissing(cell.bodyEl, cell.outputFrameEl);
  appendIfMissing(cell.cellEl, cell.bodyEl);
  if (cell.sidePanel.parentElement !== cell.cellEl) {
    cell.sidePanel.parentElement?.removeChild(cell.sidePanel);
  }
  cell.cellEl.insertBefore(cell.sidePanel, cell.bodyEl);
}

function getCellById(id) {
  return cells.find((c) => c.id === id);
}

function setTypeDropdownValue(cellType) {
  if (!newCellTypeSelect) return;
  const normalized = normalizeCellType(cellType);
  if (newCellTypeSelect.value !== normalized) {
    newCellTypeSelect.value = normalized;
  }
  if (typeof syncCellTypeDropdownUI === "function") {
    syncCellTypeDropdownUI(normalized);
  }
}

function setCellType(cellId, cellType, options = {}) {
  const cell = getCellById(cellId);
  if (!cell) return false;
  if (isRunning) {
    setStatus("Cannot change cell type while running");
    setTypeDropdownValue(cell.type);
    return false;
  }

  const nextType = normalizeCellType(cellType);
  const prevType = normalizeCellType(cell.type);
  if (nextType === prevType) {
    setTypeDropdownValue(nextType);
    return false;
  }

  const recordUndo = options.recordUndo !== false;
  const persist = options.persist !== false;
  if (recordUndo) {
    commitPendingEditUndoSnapshot();
    recordNotebookUndoSnapshot();
  }

  const wasEditing = isCellEditing(cell.id);
  cell.type = nextType;
  applyCellLayoutStructure(cell, nextType);
  cell.executionCount = null;
  cell.outputs = [];
  setMarkdownRenderedState(cell, false);
  cell.outputEl.innerHTML = "";
  setCellOutputVisible(cell, false);

  if (cell.editor) {
    const model = cell.editor.getModel();
    if (model && typeof monaco !== "undefined" && monaco.editor?.setModelLanguage) {
      monaco.editor.setModelLanguage(model, getCellEditorLanguage(nextType));
    }
    cell.editor.updateOptions({
      lineNumbers: nextType === CELL_TYPES.CODE ? getCodeCellLineNumbersMode() : EDITOR_OPTIONS.lineNumbers,
      readOnly: !wasEditing,
      renderLineHighlight: getCellLineHighlightMode(nextType, wasEditing),
      selectionHighlight: Boolean(wasEditing),
      occurrencesHighlight: getCellOccurrencesHighlightMode(wasEditing),
    });
    cell.editor.layout();
  }

  updateCellIdleState(cell);
  syncCellEditStates();
  refreshToc();
  if (persist) saveCellsToStorage();
  setTypeDropdownValue(nextType);
  return true;
}

function cloneNotebookSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.map((entry) => ({
    type: normalizeCellType(entry?.type),
    source: typeof entry?.source === "string" ? entry.source : "",
  }));
}

function getNotebookSnapshot() {
  return cells.map((cell) => ({
    type: normalizeCellType(cell.type),
    source: cell.editor ? cell.editor.getValue() : "",
  }));
}

function notebookSnapshotsEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const aType = normalizeCellType(a[i]?.type);
    const bType = normalizeCellType(b[i]?.type);
    const aSource = typeof a[i]?.source === "string" ? a[i].source : "";
    const bSource = typeof b[i]?.source === "string" ? b[i].source : "";
    if (aType !== bType || aSource !== bSource) return false;
  }
  return true;
}

function withNotebookUndoSuspended(callback) {
  const previous = suppressNotebookUndo;
  suppressNotebookUndo = true;
  try {
    return callback();
  } finally {
    suppressNotebookUndo = previous;
  }
}

function clearNotebookUndoHistory() {
  notebookUndoStack = [];
  notebookRedoStack = [];
  pendingEditUndoSnapshot = null;
}

function pushSnapshotToStack(stack, snapshot) {
  const cloned = cloneNotebookSnapshot(snapshot);
  if (!cloned.length) return;

  const last = stack[stack.length - 1];
  if (last && notebookSnapshotsEqual(last, cloned)) return;

  stack.push(cloned);
  if (stack.length > NOTEBOOK_UNDO_LIMIT) {
    stack.splice(0, stack.length - NOTEBOOK_UNDO_LIMIT);
  }
}

function clearNotebookRedoHistory() {
  notebookRedoStack = [];
}

function recordNotebookUndoSnapshot(snapshot = getNotebookSnapshot(), { clearRedo = true } = {}) {
  if (suppressNotebookUndo) return;
  pushSnapshotToStack(notebookUndoStack, snapshot);
  if (clearRedo) {
    clearNotebookRedoHistory();
  }
}

function recordNotebookRedoSnapshot(snapshot = getNotebookSnapshot()) {
  if (suppressNotebookUndo) return;
  pushSnapshotToStack(notebookRedoStack, snapshot);
}

function beginPendingEditUndoSnapshot() {
  if (suppressNotebookUndo) return;
  pendingEditUndoSnapshot = cloneNotebookSnapshot(getNotebookSnapshot());
}

function commitPendingEditUndoSnapshot() {
  if (!pendingEditUndoSnapshot) return;
  const baseline = pendingEditUndoSnapshot;
  pendingEditUndoSnapshot = null;
  if (notebookSnapshotsEqual(baseline, getNotebookSnapshot())) return;
  recordNotebookUndoSnapshot(baseline);
}

function discardPendingEditUndoSnapshot() {
  pendingEditUndoSnapshot = null;
}

function applyNotebookSnapshot(snapshot, preferredFocusIndex = 0) {
  const normalized = cloneNotebookSnapshot(snapshot);
  const safeSnapshot = normalized.length
    ? normalized
    : [{ type: CELL_TYPES.CODE, source: "" }];

  withNotebookUndoSuspended(() => {
    discardPendingEditUndoSnapshot();
    editingCellId = null;
    focusedCellId = null;
    selectedCellIds.clear();
    rangeSelectionAnchorId = null;
    resetSectionCollapseState();

    cells.forEach((cell) => {
      if (cell.editor) cell.editor.dispose();
      cell.cellEl.remove();
    });
    cells = [];
    nextCellId = 1;

    safeSnapshot.forEach((entry) => {
      addCell(entry.source, null, "after", entry.type, { recordUndo: false, persist: false });
    });

    const index = Math.max(0, Math.min(preferredFocusIndex, cells.length - 1));
    const focusTarget = cells[index] || cells[0];
    if (focusTarget) focusCellCommand(focusTarget);
    saveCellsToStorage();
    refreshToc();
  });
}

function undoNotebookChange() {
  if (isRunning) {
    setStatus("Cannot undo while running");
    return true;
  }

  commitPendingEditUndoSnapshot();
  if (!notebookUndoStack.length) {
    setStatus("Nothing to undo");
    return true;
  }

  const currentSnapshot = getNotebookSnapshot();
  const focusedIndex = Math.max(0, cells.findIndex((c) => c.id === focusedCellId));
  const snapshot = notebookUndoStack.pop();
  recordNotebookRedoSnapshot(currentSnapshot);
  applyNotebookSnapshot(snapshot, focusedIndex);
  setStatus("Undo");
  return true;
}

function redoNotebookChange() {
  if (isRunning) {
    setStatus("Cannot redo while running");
    return true;
  }

  commitPendingEditUndoSnapshot();
  if (!notebookRedoStack.length) {
    setStatus("Nothing to redo");
    return true;
  }

  const currentSnapshot = getNotebookSnapshot();
  const focusedIndex = Math.max(0, cells.findIndex((c) => c.id === focusedCellId));
  const snapshot = notebookRedoStack.pop();
  recordNotebookUndoSnapshot(currentSnapshot, { clearRedo: false });
  applyNotebookSnapshot(snapshot, focusedIndex);
  setStatus("Redo");
  return true;
}

function setMarkdownRenderedState(cell, rendered) {
  if (!cell) return;
  if (normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) {
    cell.markdownRendered = false;
    cell.cellEl.classList.remove("markdown-rendered");
    return;
  }

  const nextRendered = Boolean(rendered);
  cell.markdownRendered = nextRendered;
  cell.cellEl.classList.toggle("markdown-rendered", nextRendered);
  if (!nextRendered) {
    setCellOutputVisible(cell, false);
  }
  if (cell.editor) {
    cell.editor.layout();
  }
}

function reopenRenderedMarkdownForEdit(cellId) {
  const cell = getCellById(cellId);
  if (!cell) return;
  if (normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
  if (!cell.markdownRendered) return;

  setMarkdownRenderedState(cell, false);
  enterCellEditMode(cell.id, true);
}

function isCellEditing(id) {
  return editingCellId !== null && editingCellId === id;
}

function applyCellEditState(cell, isEditing) {
  if (!cell) return;
  cell.cellEl.classList.toggle("editing", isEditing);
  if (cell.editor) {
    if (!isEditing) {
      const selection = cell.editor.getSelection();
      if (selection && (
        selection.startLineNumber !== selection.endLineNumber
        || selection.startColumn !== selection.endColumn
      )) {
        const lineNumber = selection.selectionStartLineNumber || selection.startLineNumber;
        const column = selection.selectionStartColumn || selection.startColumn;
        cell.editor.setSelection({
          startLineNumber: lineNumber,
          startColumn: column,
          endLineNumber: lineNumber,
          endColumn: column,
        });
      }
    }
    cell.editor.updateOptions({
      readOnly: !isEditing,
      renderLineHighlight: getCellLineHighlightMode(cell.type, isEditing),
      selectionHighlight: Boolean(isEditing),
      occurrencesHighlight: getCellOccurrencesHighlightMode(isEditing),
    });
  }
}

function syncCellEditStates() {
  if (!cells.some((c) => c.id === editingCellId)) {
    editingCellId = null;
  }
  cells.forEach((cell) => applyCellEditState(cell, isCellEditing(cell.id)));
}

function enterCellEditMode(cellId, focusEditor = true) {
  const cell = getCellById(cellId);
  if (!cell || !cell.editor) return;
  if (normalizeCellType(cell.type) === CELL_TYPES.MARKDOWN && cell.markdownRendered) {
    setMarkdownRenderedState(cell, false);
    refreshToc();
  }

  if (editingCellId !== null && editingCellId !== cell.id) {
    commitPendingEditUndoSnapshot();
  }
  if (editingCellId !== cell.id) {
    beginPendingEditUndoSnapshot();
  }

  editingCellId = cell.id;
  syncCellEditStates();
  focusCell(cell.id);
  if (focusEditor) cell.editor.focus();
}

function exitCellEditMode() {
  if (editingCellId === null) return;

  commitPendingEditUndoSnapshot();

  editingCellId = null;
  syncCellEditStates();

  const activeEl = document.activeElement;
  if (activeEl instanceof HTMLElement && activeEl.closest(".sc-cell-editor")) {
    activeEl.blur();
  }
}



// ---------------------------------------------------------------------------
// Cell management
// ---------------------------------------------------------------------------

function addCell(
  initialCode = "",
  relativeCellId = null,
  insertWhere = "after",
  cellType = getSelectedNewCellType(),
  options = {}
) {
  const recordUndo = options.recordUndo !== false;
  const persist = options.persist !== false;
  if (recordUndo) {
    commitPendingEditUndoSnapshot();
    recordNotebookUndoSnapshot();
  }

  const id = nextCellId++;
  const normalizedType = normalizeCellType(cellType);
  const cellEl = document.createElement("div");
  cellEl.className = "sc-cell";
  cellEl.dataset.cellId = id;

  // Left panel
  const sidePanel = document.createElement("div");
  sidePanel.className = "sc-cell-side";
  sidePanel.draggable = true;

  const label = document.createElement("span");
  label.className = "sc-cell-label";
  label.textContent = getCellIdleLabel(normalizedType);

  const actions = document.createElement("div");
  actions.className = "sc-cell-actions";

  const runBtn = document.createElement("button");
  runBtn.className = "sc-cell-btn run-btn";
  runBtn.title = getRunButtonTitle();
  runBtn.draggable = false;
  runBtn.innerHTML = `<svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><polygon points="0,0 8,5 0,10"/></svg>`;
  runBtn.addEventListener("click", () => {
    if (isRunning) {
      runCell(id, { queueIfRunning: true });
      return;
    }
    if (runSelectedCellsSequentially(id, { startFromTrigger: true })) return;
    runCell(id);
  });

  const sectionToggleBtn = document.createElement("button");
  sectionToggleBtn.className = "sc-cell-btn section-toggle-btn";
  sectionToggleBtn.type = "button";
  sectionToggleBtn.title = "No collapsible section";
  sectionToggleBtn.innerHTML = getSectionToggleIconSvg(false);
  sectionToggleBtn.tabIndex = -1;
  sectionToggleBtn.disabled = true;
  sectionToggleBtn.setAttribute("aria-hidden", "true");
  sectionToggleBtn.setAttribute("aria-expanded", "false");
  sectionToggleBtn.setAttribute("aria-label", "No collapsible section");
  sectionToggleBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMarkdownSectionCollapse(id);
  });
  sectionToggleBtn.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    toggleMarkdownSectionCollapse(id);
  });

  const sectionCodeCountBadge = document.createElement("span");
  sectionCodeCountBadge.className = "sc-cell-collapse-count";
  sectionCodeCountBadge.textContent = "";
  sectionCodeCountBadge.title = "";
  sectionCodeCountBadge.setAttribute("aria-hidden", "true");
  sectionCodeCountBadge.setAttribute("aria-label", "");

  actions.appendChild(runBtn);
  sidePanel.appendChild(actions);
  sidePanel.appendChild(sectionToggleBtn);
  sidePanel.appendChild(sectionCodeCountBadge);
  sidePanel.appendChild(label);

  // Body container
  const bodyEl = document.createElement("div");
  bodyEl.className = "sc-cell-body";
  const topRowEl = document.createElement("div");
  topRowEl.className = "sc-cell-top-row";
  const bottomRowEl = document.createElement("div");
  bottomRowEl.className = "sc-cell-bottom-row";

  // Input frame + editor container
  const inputFrameEl = document.createElement("div");
  inputFrameEl.className = "sc-cell-input-frame";
  const editorEl = document.createElement("div");
  editorEl.className = "sc-cell-editor";

  const outputSidePlaceholderEl = document.createElement("div");
  outputSidePlaceholderEl.className = "sc-cell-output-side-placeholder";
  outputSidePlaceholderEl.title = "Double-click to toggle output";
  outputSidePlaceholderEl.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const c = getCellById(id);
    if (c) toggleCellOutputCollapse(c);
  });
  bottomRowEl.addEventListener("dblclick", (e) => {
    if (!bottomRowEl.classList.contains("output-collapsed")) return;
    e.preventDefault();
    e.stopPropagation();
    const c = getCellById(id);
    if (c) toggleCellOutputCollapse(c);
  });

  // Collapse preview (shown when output is collapsed)
  const collapsePreviewEl = document.createElement("div");
  collapsePreviewEl.className = "sc-cell-collapse-preview";
  collapsePreviewEl.style.display = "none";
  const collapsePreviewText = document.createElement("span");
  collapsePreviewText.className = "sc-cell-collapse-preview-text";
  const collapsePreviewDots = document.createElement("span");
  collapsePreviewDots.className = "sc-cell-collapse-preview-dots";
  collapsePreviewDots.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>`;
  collapsePreviewEl.appendChild(collapsePreviewText);
  collapsePreviewEl.appendChild(collapsePreviewDots);

  // Output frame + output
  const outputFrameEl = document.createElement("div");
  outputFrameEl.className = "sc-cell-output-frame";
  const outputEl = document.createElement("div");
  outputEl.className = "sc-cell-output";
  const outputResizeHandleEl = document.createElement("div");
  outputResizeHandleEl.className = "sc-cell-output-resize-handle";
  outputResizeHandleEl.tabIndex = 0;
  outputResizeHandleEl.setAttribute("role", "separator");
  outputResizeHandleEl.setAttribute("aria-orientation", "vertical");
  outputResizeHandleEl.setAttribute("aria-valuemin", "96");
  outputResizeHandleEl.setAttribute("aria-valuemax", "1600");
  outputResizeHandleEl.setAttribute("aria-label", "Resize cell output");
  outputResizeHandleEl.title = "Drag to resize output";
  bindCellOutputResize(outputEl, outputResizeHandleEl);

  const execTimeEl = document.createElement("div");
  execTimeEl.className = "sc-cell-exec-time";

  inputFrameEl.appendChild(editorEl);
  inputFrameEl.appendChild(execTimeEl);
  topRowEl.appendChild(sidePanel);
  topRowEl.appendChild(inputFrameEl);
  bottomRowEl.appendChild(outputSidePlaceholderEl);
  bottomRowEl.appendChild(collapsePreviewEl);
  outputFrameEl.appendChild(outputEl);
  outputFrameEl.appendChild(outputResizeHandleEl);
  bottomRowEl.appendChild(outputFrameEl);
  bodyEl.appendChild(topRowEl);
  bodyEl.appendChild(bottomRowEl);
  cellEl.appendChild(bodyEl);

  const referenceCell = relativeCellId !== null ? cells.find((c) => c.id === relativeCellId) : null;

  // Insert into DOM
  if (referenceCell) {
    if (insertWhere === "before") {
      cellsArea.insertBefore(cellEl, referenceCell.cellEl);
    } else if (referenceCell.cellEl.nextSibling) {
      cellsArea.insertBefore(cellEl, referenceCell.cellEl.nextSibling);
    } else {
      cellsArea.insertBefore(cellEl, addCellBottom);
    }
  } else {
    cellsArea.insertBefore(cellEl, addCellBottom);
  }

  // Create Monaco editor
  let editor = null;
  if (monacoReady) {
    editor = createEditorForCell(id, editorEl, initialCode, normalizedType);
  }

  const cell = {
    id,
    type: normalizedType,
    editor,
    sidePanel,
    bodyEl,
    editorEl,
    topRowEl,
    inputFrameEl,
    bottomRowEl,
    outputSidePlaceholderEl,
    collapsePreviewEl,
    execTimeEl,
    outputEl,
    outputFrameEl,
    outputResizeHandleEl,
    labelEl: label,
    cellEl,
    runBtn,
    sectionToggleBtn,
    sectionCodeCountBadge,
    executionCount: null,
    outputs: [],
    executionTimeMs: null,
    execStartTime: null,
    execEndTime: null,
    markdownRendered: false,
    hiddenByControllers: new Set(),
  };

  applyCellLayoutStructure(cell, normalizedType);

  if (referenceCell) {
    const idx = cells.findIndex((c) => c.id === referenceCell.id);
    const insertIdx = insertWhere === "before" ? idx : idx + 1;
    cells.splice(insertIdx, 0, cell);
  } else {
    cells.push(cell);
  }

  // Focus events
  cellEl.addEventListener("mousedown", (event) => handleCellMouseSelection(event, id));
  cellEl.addEventListener("click", (event) => handleCellClickSelection(event, id));
  editorEl.addEventListener("mousedown", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      handleCellMouseSelection(event, id);
      return;
    }
    enterCellEditMode(id, false);
  }, true);
  outputEl.addEventListener("dblclick", () => reopenRenderedMarkdownForEdit(id));
  sidePanel.addEventListener("dragstart", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest(".sc-cell-btn")) {
      e.preventDefault();
      return;
    }
    beginCellDrag(id, e);
  });
  sidePanel.addEventListener("dragend", () => endCellDrag());

  updateCellIdleState(cell);
  syncCellEditStates();
  refreshSectionCollapses({ animate: false });
  if (persist) saveCellsToStorage();
  return cell;
}

function focusCellEditor(cell) {
  if (!cell) return;
  if (cell.editor) {
    enterCellEditMode(cell.id, true);
  } else {
    focusCell(cell.id);
  }
}

function focusCellCommand(cell) {
  if (!cell) return;
  focusCell(cell.id);
  exitCellEditMode();
}

function addCellAdjacentToFocused(insertWhere = "after", cellType = getSelectedNewCellType()) {
  if (cells.length === 0) {
    const cell = addCell("", null, "after", cellType);
    focusCellCommand(cell);
    return;
  }

  const hasFocused = cells.some((c) => c.id === focusedCellId);
  const fallbackId = insertWhere === "before" ? cells[0].id : cells[cells.length - 1].id;
  const anchorId = hasFocused ? focusedCellId : fallbackId;
  const cell = addCell("", anchorId, insertWhere, cellType);
  focusCellCommand(cell);
}

function getOrderedSelectedCellIds() {
  return cells.filter((cell) => selectedCellIds.has(cell.id)).map((cell) => cell.id);
}

function isContinuousCellBlock(cellIds) {
  if (!Array.isArray(cellIds) || cellIds.length <= 1) return true;
  const ordered = cells.map((cell) => cell.id);
  const indexes = cellIds
    .map((id) => ordered.indexOf(id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (indexes.length !== cellIds.length) return false;
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i] !== indexes[i - 1] + 1) return false;
  }
  return true;
}

function getDragCellIdsForStart(startCellId) {
  if (selectedCellIds.has(startCellId) && selectedCellIds.size > 1) {
    return getOrderedSelectedCellIds();
  }
  return [startCellId];
}

function beginCellDrag(id, event) {
  if (draggingCellId !== null) return;
  const cell = cells.find((c) => c.id === id);
  if (!cell || !event.dataTransfer) return;

  const dragIds = getDragCellIdsForStart(id);
  if (dragIds.length > 1 && !isContinuousCellBlock(dragIds)) {
    event.preventDefault();
    setStatus("Select a continuous block to move together");
    return;
  }

  draggingCellId = id;
  draggingCellIds = dragIds;
  cellsArea.classList.add("reordering");
  draggingCellIds.forEach((cellId) => {
    const dragCell = getCellById(cellId);
    if (dragCell) dragCell.cellEl.classList.add("dragging");
  });

  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(CELL_DRAG_MIME, JSON.stringify(draggingCellIds));

  const ghost = document.createElement("div");
  ghost.style.width = "1px";
  ghost.style.height = "1px";
  ghost.style.opacity = "0";
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 0, 0);
  requestAnimationFrame(() => ghost.remove());

  updateDropPlaceholder(event.clientY);
}

function updateDropPlaceholder(clientY) {
  if (draggingCellId === null || !draggingCellIds.length) return;
  const dragIds = new Set(draggingCellIds);
  const candidateEls = cells
    .map((c) => c.cellEl)
    .filter((el) => !dragIds.has(Number(el.dataset.cellId)) && !el.classList.contains("section-hidden"));

  let inserted = false;
  for (const el of candidateEls) {
    const rect = el.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      cellsArea.insertBefore(dropPlaceholderEl, el);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    cellsArea.insertBefore(dropPlaceholderEl, addCellBottom);
  }
}

function reorderCellsFromDom() {
  const orderedIds = Array.from(cellsArea.querySelectorAll(".sc-cell")).map((el) => Number(el.dataset.cellId));
  const positionById = new Map(orderedIds.map((id, index) => [id, index]));
  cells.sort((a, b) => {
    const aPos = positionById.get(a.id);
    const bPos = positionById.get(b.id);
    return (aPos ?? 0) - (bPos ?? 0);
  });
}

function dropDraggedCell() {
  if (draggingCellId === null || !draggingCellIds.length || !dropPlaceholderEl.parentElement) {
    endCellDrag();
    return;
  }

  const draggedCells = draggingCellIds
    .map((cellId) => getCellById(cellId))
    .filter(Boolean);
  if (!draggedCells.length) {
    endCellDrag();
    return;
  }

  commitPendingEditUndoSnapshot();
  const beforeOrder = cells.map((c) => c.id);
  const beforeSnapshot = getNotebookSnapshot();

  draggedCells.forEach((cell) => {
    cellsArea.insertBefore(cell.cellEl, dropPlaceholderEl);
  });
  reorderCellsFromDom();
  const orderChanged = beforeOrder.some((id, index) => id !== cells[index]?.id);
  if (orderChanged) {
    recordNotebookUndoSnapshot(beforeSnapshot);
  }
  saveCellsToStorage();
  refreshToc();

  if (draggingCellId !== null) {
    focusCell(draggingCellId, { preserveSelection: true, updateAnchor: false, includeCollapsedDescendants: false });
  }
  draggedCells.forEach((cell) => {
    if (cell.editor) cell.editor.layout();
  });

  endCellDrag();
}

function endCellDrag() {
  if (draggingCellId === null && !draggingCellIds.length) return;
  draggingCellIds.forEach((cellId) => {
    const draggedCell = cells.find((c) => c.id === cellId);
    if (draggedCell) draggedCell.cellEl.classList.remove("dragging");
  });
  cellsArea.classList.remove("reordering");

  if (dropPlaceholderEl.parentElement) {
    dropPlaceholderEl.remove();
  }

  draggingCellId = null;
  draggingCellIds = [];
}

function markdownInlineToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return html;
}

function renderMarkdownToHtml(source, options = {}) {
  const cellId = Number(options?.cellId);
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let listMode = "";
  let inCodeBlock = false;
  let codeLines = [];
  let headingIndex = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map((l) => markdownInlineToHtml(l)).join("<br>")}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listMode) return;
    out.push(listMode === "ul" ? "</ul>" : "</ol>");
    listMode = "";
  };

  const closeCodeBlock = () => {
    if (!inCodeBlock) return;
    out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    inCodeBlock = false;
    codeLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const trimmed = line.trim();

    if (inCodeBlock) {
      if (trimmed.startsWith("```")) {
        closeCodeBlock();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      closeList();
      inCodeBlock = true;
      codeLines = [];
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1].length;
      const label = typeof getRenderedMarkdownHeadingNumberLabel === "function"
        ? getRenderedMarkdownHeadingNumberLabel(cellId, headingIndex)
        : "";
      const numberHtml = label
        ? `<span class="sc-markdown-heading-number" aria-hidden="true">${escapeHtml(label)}.</span>`
        : "";
      out.push(`<h${level}>${numberHtml}${markdownInlineToHtml(headingMatch[2])}</h${level}>`);
      headingIndex += 1;
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      if (listMode !== "ul") {
        closeList();
        listMode = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${markdownInlineToHtml(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      if (listMode !== "ol") {
        closeList();
        listMode = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${markdownInlineToHtml(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeCodeBlock();
  flushParagraph();
  closeList();
  return out.join("\n");
}

function clearSectionCollapseTimer(cellId) {
  const timer = sectionCollapseTimers.get(cellId);
  if (timer) {
    clearTimeout(timer);
    sectionCollapseTimers.delete(cellId);
  }
}

function resetSectionCollapseState() {
  sectionCollapseTimers.forEach((timer) => clearTimeout(timer));
  sectionCollapseTimers.clear();
  collapsedSectionControllers.clear();
}

function getMarkdownHeadingLevel(cell) {
  if (!cell || normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN || !cell.editor) return null;
  const source = String(cell.editor.getValue() || "");
  const lines = source.split("\n");
  for (const line of lines) {
    const match = line.trim().match(/^(#{1,6})\s+.+$/);
    if (match) return match[1].length;
  }
  return null;
}

function getMarkdownSectionTargets(controllerCell) {
  const result = {
    allTargets: [],
    codeTargetCount: 0,
  };
  if (!controllerCell || normalizeCellType(controllerCell.type) !== CELL_TYPES.MARKDOWN) return result;
  const headingLevel = getMarkdownHeadingLevel(controllerCell);
  if (!headingLevel) return result;

  const startIndex = cells.findIndex((c) => c.id === controllerCell.id);
  if (startIndex < 0) return result;

  for (let i = startIndex + 1; i < cells.length; i += 1) {
    const cell = cells[i];
    const type = normalizeCellType(cell.type);
    if (type === CELL_TYPES.MARKDOWN) {
      const level = getMarkdownHeadingLevel(cell);
      if (level !== null && level <= headingLevel) break;
    }
    result.allTargets.push(cell);
    if (type === CELL_TYPES.CODE) {
      result.codeTargetCount += 1;
    }
  }
  return result;
}

function getSectionToggleIconSvg(isCollapsed) {
  if (isCollapsed) {
    return [
      '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">',
      '<path d="M7.2 5.6L13.6 10L7.2 14.4Z"></path>',
      "</svg>",
    ].join("");
  }
  return [
    '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">',
    '<path d="M5.6 7.2L10 13.6L14.4 7.2Z"></path>',
    "</svg>",
  ].join("");
}

function updateSectionToggleButton(cell, canCollapse, isCollapsed, codeTargetCount, totalTargetCount) {
  if (!cell?.sectionToggleBtn || !cell?.cellEl) return;
  const btn = cell.sectionToggleBtn;
  const badge = cell.sectionCodeCountBadge;

  cell.cellEl.classList.toggle("has-collapsible-section", Boolean(canCollapse));
  btn.classList.toggle("collapsed", Boolean(isCollapsed));
  btn.innerHTML = getSectionToggleIconSvg(Boolean(isCollapsed));
  btn.tabIndex = canCollapse ? 0 : -1;
  btn.disabled = !canCollapse;
  btn.setAttribute("aria-hidden", canCollapse ? "false" : "true");
  if (!canCollapse) {
    btn.title = "No collapsible section";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "No collapsible section");
    if (badge) {
      badge.textContent = "";
      badge.classList.remove("visible");
      badge.removeAttribute("title");
      badge.setAttribute("aria-hidden", "true");
      badge.setAttribute("aria-label", "");
    }
    return;
  }

  btn.title = isCollapsed
    ? `Expand section (${totalTargetCount} cells, ${codeTargetCount} code cells hidden)`
    : `Collapse section (${totalTargetCount} cells, ${codeTargetCount} code cells)`;
  btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  btn.setAttribute("aria-label", btn.title);
  if (badge) {
    const showBadge = Boolean(isCollapsed && codeTargetCount > 0);
    badge.textContent = showBadge ? String(codeTargetCount) : "";
    badge.classList.toggle("visible", showBadge);
    badge.setAttribute("aria-hidden", showBadge ? "false" : "true");
    badge.title = showBadge ? `${codeTargetCount} cells hidden` : "";
    badge.setAttribute("aria-label", showBadge ? `${codeTargetCount} cells hidden` : "");
  }
}

function setSectionCellHidden(cell, hidden, { animate = true } = {}) {
  if (!cell?.cellEl) return;
  const el = cell.cellEl;
  clearSectionCollapseTimer(cell.id);

  const applyImmediate = () => {
    el.classList.toggle("section-hidden", hidden);
    el.classList.remove("section-hide-transition", "section-hide-active");
  };

  if (!animate) {
    applyImmediate();
    return;
  }

  if (hidden) {
    if (el.classList.contains("section-hidden")) return;
    el.classList.remove("section-hidden");
    el.classList.add("section-hide-transition");
    el.classList.remove("section-hide-active");
    void el.offsetHeight;
    el.classList.add("section-hide-active");
    const timer = setTimeout(() => {
      el.classList.add("section-hidden");
      el.classList.remove("section-hide-transition", "section-hide-active");
      sectionCollapseTimers.delete(cell.id);
    }, SECTION_COLLAPSE_ANIM_MS);
    sectionCollapseTimers.set(cell.id, timer);
    return;
  }

  const wasHidden = el.classList.contains("section-hidden");
  if (!wasHidden && !el.classList.contains("section-hide-active")) return;
  el.classList.remove("section-hidden");
  el.classList.add("section-hide-transition", "section-hide-active");
  void el.offsetHeight;
  el.classList.remove("section-hide-active");
  const timer = setTimeout(() => {
    el.classList.remove("section-hide-transition");
    sectionCollapseTimers.delete(cell.id);
  }, SECTION_COLLAPSE_ANIM_MS);
  sectionCollapseTimers.set(cell.id, timer);
}

function refreshSectionCollapses({ animate = false } = {}) {
  const staleControllers = [];

  cells.forEach((cell) => {
    if (!cell.hiddenByControllers) {
      cell.hiddenByControllers = new Set();
    } else {
      cell.hiddenByControllers.clear();
    }
  });

  for (const controllerId of collapsedSectionControllers) {
    const controllerCell = getCellById(controllerId);
    if (
      !controllerCell
      || normalizeCellType(controllerCell.type) !== CELL_TYPES.MARKDOWN
      || !controllerCell.markdownRendered
    ) {
      staleControllers.push(controllerId);
      continue;
    }
    const section = getMarkdownSectionTargets(controllerCell);
    if (!section.allTargets.length) {
      staleControllers.push(controllerId);
      continue;
    }
    section.allTargets.forEach((targetCell) => {
      targetCell.hiddenByControllers?.add(controllerId);
    });
  }

  staleControllers.forEach((id) => collapsedSectionControllers.delete(id));

  cells.forEach((cell) => {
    if (normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) {
      updateSectionToggleButton(cell, false, false, 0, 0);
      return;
    }
    const section = getMarkdownSectionTargets(cell);
    const canCollapse = Boolean(cell.markdownRendered && section.allTargets.length);
    const isCollapsed = canCollapse && collapsedSectionControllers.has(cell.id);
    if (!canCollapse) {
      collapsedSectionControllers.delete(cell.id);
    }
    updateSectionToggleButton(
      cell,
      canCollapse,
      isCollapsed,
      section.codeTargetCount,
      section.allTargets.length
    );
  });

  let hiddenFocusedCell = false;
  let hiddenEditingCell = false;
  cells.forEach((cell) => {
    const shouldHide = Boolean(cell.hiddenByControllers && cell.hiddenByControllers.size > 0);
    setSectionCellHidden(cell, shouldHide, { animate });
    if (shouldHide && focusedCellId === cell.id) {
      hiddenFocusedCell = true;
    }
    if (shouldHide && editingCellId === cell.id) {
      hiddenEditingCell = true;
    }
  });

  if (hiddenEditingCell) {
    editingCellId = null;
    syncCellEditStates();
  }

  if (hiddenFocusedCell) {
    const focusTarget = cells.find((cell) => !cell.cellEl.classList.contains("section-hidden"));
    if (focusTarget) focusCell(focusTarget.id, { preserveSelection: true, updateAnchor: false });
  }
}

function toggleMarkdownSectionCollapse(cellId) {
  const cell = getCellById(cellId);
  if (!cell || normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
  const section = getMarkdownSectionTargets(cell);
  if (!cell.markdownRendered || !section.allTargets.length) {
    refreshSectionCollapses({ animate: false });
    renderToc();
    return;
  }

  if (collapsedSectionControllers.has(cellId)) {
    collapsedSectionControllers.delete(cellId);
    refreshSectionCollapses({ animate: true });
    setStatus("Section expanded");
  } else {
    collapsedSectionControllers.add(cellId);
    refreshSectionCollapses({ animate: true });
    if (selectedCellIds.has(cellId)) {
      addCollapsedSectionTargetsToSelection(selectedCellIds);
      syncCellSelectionClasses();
    }
    setStatus("Section collapsed");
  }
  renderToc();
}

function runMarkdownCell(cell, options = {}) {
  const silent = options.silent === true;
  const refresh = options.refresh !== false;
  const markdown = cell.editor ? cell.editor.getValue() : "";
  const html = renderMarkdownToHtml(markdown, { cellId: cell.id });
  const hasHtml = Boolean(html);

  cell.outputEl.innerHTML = hasHtml ? `<div class="sc-markdown-render">${html}</div>` : "";
  setCellOutputVisible(cell, hasHtml);
  cell.cellEl.classList.remove("success", "error");
  cell.labelEl.className = "sc-cell-label";
  cell.labelEl.textContent = getCellIdleLabel(cell.type);
  cell.labelEl.classList.toggle("empty", cell.labelEl.textContent === "[ ]");

  if (hasHtml && editingCellId === cell.id) {
    exitCellEditMode();
  }
  setMarkdownRenderedState(cell, hasHtml);
  if (refresh) refreshToc();
  if (!silent) {
    setStatus(hasHtml ? "Markdown rendered" : "Markdown is empty");
  }
  return hasHtml;
}

function refreshRenderedMarkdownCells(options = {}) {
  const refresh = options.refresh !== false;
  cells.forEach((cell) => {
    if (normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
    if (!cell.markdownRendered) return;
    runMarkdownCell(cell, { silent: true, refresh: false });
  });
  if (refresh) refreshToc();
}

function renderAllMarkdownCells(options = {}) {
  const setStatusMessage = options.setStatusMessage !== false;
  if (isRunning) {
    if (setStatusMessage) setStatus("Cannot render markdown while code is running");
    return 0;
  }

  let markdownCellCount = 0;
  let renderedCount = 0;
  cells.forEach((cell) => {
    if (normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
    markdownCellCount += 1;
    if (runMarkdownCell(cell, { silent: true, refresh: false })) {
      renderedCount += 1;
    }
  });
  refreshToc();

  if (setStatusMessage) {
    if (markdownCellCount === 0) {
      setStatus("No markdown cells to render");
    } else {
      setStatus(`Rendered ${renderedCount}/${markdownCellCount} markdown cells`);
    }
  }
  return renderedCount;
}

function createEditorForCell(cellId, container, code, cellType = CELL_TYPES.CODE) {
  const normalizedType = normalizeCellType(cellType);
  const editor = monaco.editor.create(container, {
    ...EDITOR_OPTIONS,
    language: getCellEditorLanguage(normalizedType),
    lineNumbers: normalizedType === CELL_TYPES.CODE ? getCodeCellLineNumbersMode() : EDITOR_OPTIONS.lineNumbers,
    renderLineHighlight: getCellLineHighlightMode(normalizedType, false),
    renderLineHighlightOnlyWhenFocus: true,
    selectionHighlight: false,
    occurrencesHighlight: "off",
    readOnly: true,
    value: code,
  });

  // Auto-height: resize editor to fit content
  const updateHeight = () => {
    const contentHeight = Math.max(38, Math.ceil(editor.getContentHeight()));
    container.style.height = `${contentHeight}px`;
    editor.layout();
  };
  editor.onDidContentSizeChange(updateHeight);
  updateHeight();

  // Keybindings
  editor.onKeyDown((event) => {
    const browserEvent = event?.browserEvent;

    // Ctrl+Shift+Space -> introspection tooltip. Plain Shift+Tab is left to Monaco for outdent.
    const isInspectShortcut =
      (browserEvent?.ctrlKey || browserEvent?.metaKey) &&
      browserEvent?.shiftKey &&
      !browserEvent?.altKey &&
      (browserEvent?.key === " " || browserEvent?.key === "Spacebar" || browserEvent?.code === "Space");
    if (isInspectShortcut) {
      const cell = getCellById(cellId);
      if (cell && normalizeCellType(cell.type) === CELL_TYPES.CODE) {
        event.preventDefault();
        event.stopPropagation();
        showIntrospectionTooltip(editor);
        return;
      }
    }

    if (browserEvent?.key === "Escape") {
      // Dismiss introspection tooltip if visible — do NOT exit edit mode
      if (_activeInspectEl) {
        event.preventDefault();
        event.stopPropagation();
        browserEvent.preventDefault();
        browserEvent.stopPropagation();
        browserEvent.stopImmediatePropagation();
        dismissIntrospectionTooltip();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const cell = getCellById(cellId);
      if (cell && normalizeCellType(cell.type) === CELL_TYPES.MARKDOWN) {
        runMarkdownCell(cell, { silent: true });
      }
      exitCellEditMode();
      return;
    }

    if (!handleEditorShortcutKeydown(event, cellId)) return;
    event.preventDefault();
    event.stopPropagation();
  });

  // Focus tracking
  editor.onDidFocusEditorWidget(() => {
    focusCell(cellId);
    enterCellEditMode(cellId, false);
  });

  // Auto-save on change
  editor.onDidChangeModelContent(() => {
    saveCellsToStorage();
    if (normalizedType === CELL_TYPES.MARKDOWN) refreshToc();
  });

  return editor;
}

function deleteCell(id, options = {}) {
  const recordUndo = options.recordUndo !== false;
  const persist = options.persist !== false;
  const refresh = options.refresh !== false;
  if (cells.length <= 1) return; // Keep at least one cell
  const idx = cells.findIndex((c) => c.id === id);
  if (idx < 0) return;
  if (recordUndo) {
    commitPendingEditUndoSnapshot();
    recordNotebookUndoSnapshot();
  }

  const cell = cells[idx];
  clearSectionCollapseTimer(id);
  collapsedSectionControllers.delete(id);
  if (cell.editor) cell.editor.dispose();
  cell.cellEl.remove();
  cells.splice(idx, 1);
  if (editingCellId === id) editingCellId = null;
  selectedCellIds.delete(id);
  if (rangeSelectionAnchorId === id) {
    rangeSelectionAnchorId = focusedCellId !== null && focusedCellId !== id ? focusedCellId : null;
  }

  // Focus adjacent cell
  const newFocus = cells[Math.min(idx, cells.length - 1)];
  if (newFocus) focusCell(newFocus.id);

  syncCellEditStates();
  if (persist) saveCellsToStorage();
  if (refresh) refreshToc();
}

function addCollapsedSectionTargetsToSelection(selectionSet) {
  if (!(selectionSet instanceof Set) || selectionSet.size === 0) return;

  let changed = true;
  while (changed) {
    changed = false;
    const selectedIds = Array.from(selectionSet);
    selectedIds.forEach((id) => {
      const cell = getCellById(id);
      if (!cell || normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
      if (!collapsedSectionControllers.has(id)) return;
      const section = getMarkdownSectionTargets(cell);
      section.allTargets.forEach((targetCell) => {
        if (!selectionSet.has(targetCell.id)) {
          selectionSet.add(targetCell.id);
          changed = true;
        }
      });
    });
  }
}

function removeCollapsedSectionTargetsFromSelection(selectionSet, markdownCellId) {
  if (!(selectionSet instanceof Set)) return;
  const cell = getCellById(markdownCellId);
  if (!cell || normalizeCellType(cell.type) !== CELL_TYPES.MARKDOWN) return;
  if (!collapsedSectionControllers.has(markdownCellId)) return;
  const section = getMarkdownSectionTargets(cell);
  section.allTargets.forEach((targetCell) => selectionSet.delete(targetCell.id));
}

function syncCellSelectionClasses() {
  cells.forEach((cell) => {
    cell.cellEl.classList.toggle("focused", cell.id === focusedCellId);
    cell.cellEl.classList.toggle("selected", selectedCellIds.has(cell.id));
  });
}

function focusCell(id, options = {}) {
  if (!cells.some((c) => c.id === id)) return;
  const preserveSelection = options.preserveSelection === true;
  const updateAnchor = options.updateAnchor !== false;
  const includeCollapsedDescendants = options.includeCollapsedDescendants !== false;
  focusedCellId = id;

  if (!preserveSelection) {
    selectedCellIds.clear();
  }
  selectedCellIds.add(id);
  if (includeCollapsedDescendants) {
    addCollapsedSectionTargetsToSelection(selectedCellIds);
  }
  if (updateAnchor) {
    rangeSelectionAnchorId = id;
  }

  syncCellSelectionClasses();
  const focused = getCellById(id);
  if (focused) setTypeDropdownValue(focused.type);
}

function toggleCellSelection(id, options = {}) {
  if (!cells.some((c) => c.id === id)) return;
  const updateAnchor = options.updateAnchor !== false;
  focusedCellId = id;
  if (selectedCellIds.has(id)) {
    selectedCellIds.delete(id);
    removeCollapsedSectionTargetsFromSelection(selectedCellIds, id);
  } else {
    selectedCellIds.add(id);
    addCollapsedSectionTargetsToSelection(selectedCellIds);
  }
  if (updateAnchor) rangeSelectionAnchorId = id;
  syncCellSelectionClasses();
  const focused = getCellById(id);
  if (focused) setTypeDropdownValue(focused.type);
}

function selectCellRangeTo(id, options = {}) {
  if (!cells.some((c) => c.id === id)) return;
  const additive = options.additive === true;
  const orderedIds = cells.map((c) => c.id);
  let anchorId = rangeSelectionAnchorId;
  if (!orderedIds.includes(anchorId)) {
    anchorId = focusedCellId !== null && orderedIds.includes(focusedCellId) ? focusedCellId : id;
    rangeSelectionAnchorId = anchorId;
  }

  const startIdx = orderedIds.indexOf(anchorId);
  const endIdx = orderedIds.indexOf(id);
  if (startIdx < 0 || endIdx < 0) return;
  const from = Math.min(startIdx, endIdx);
  const to = Math.max(startIdx, endIdx);

  if (!additive) selectedCellIds.clear();
  for (let idx = from; idx <= to; idx += 1) {
    selectedCellIds.add(orderedIds[idx]);
  }
  addCollapsedSectionTargetsToSelection(selectedCellIds);

  focusedCellId = id;
  syncCellSelectionClasses();
  const focused = getCellById(id);
  if (focused) setTypeDropdownValue(focused.type);
}

function handleCellMouseSelection(event, id) {
  const mouseEvent = event instanceof MouseEvent ? event : null;
  if (mouseEvent && mouseEvent.button !== 0) return;

  const shiftKey = Boolean(mouseEvent?.shiftKey);
  const toggleKey = Boolean(mouseEvent?.ctrlKey || mouseEvent?.metaKey);
  const targetEl = mouseEvent?.target instanceof Element ? mouseEvent.target : null;
  const onSidePanel = Boolean(targetEl?.closest(".sc-cell-side"));

  if (shiftKey) {
    selectCellRangeTo(id, { additive: toggleKey });
    return;
  }
  if (toggleKey) {
    toggleCellSelection(id, { updateAnchor: true });
    return;
  }
  if (onSidePanel && selectedCellIds.size > 1 && selectedCellIds.has(id)) {
    focusCell(id, { preserveSelection: true, updateAnchor: false, includeCollapsedDescendants: false });
    return;
  }
  focusCell(id);
}

function handleCellClickSelection(event, id) {
  const mouseEvent = event instanceof MouseEvent ? event : null;
  if (mouseEvent && mouseEvent.button !== 0) return;
  if (mouseEvent?.shiftKey || mouseEvent?.ctrlKey || mouseEvent?.metaKey) return;
  if (!selectedCellIds.has(id) || selectedCellIds.size <= 1) return;
  focusCell(id, { preserveSelection: false, updateAnchor: true, includeCollapsedDescendants: false });
}


// ---------------------------------------------------------------------------
// Introspection tooltip (Ctrl+Shift+Space)
// ---------------------------------------------------------------------------

let _activeInspectEl = null;
let _activeInspectEditor = null;
let _inspectDismissTimer = null;
let _inspectCursorDisposable = null;
let _inspectClickHandler = null;
let _inspectScrollHandler = null;

function dismissIntrospectionTooltip() {
  if (_inspectDismissTimer) {
    clearTimeout(_inspectDismissTimer);
    _inspectDismissTimer = null;
  }
  if (_inspectCursorDisposable) {
    _inspectCursorDisposable.dispose();
    _inspectCursorDisposable = null;
  }
  if (_inspectClickHandler) {
    document.removeEventListener("mousedown", _inspectClickHandler, true);
    _inspectClickHandler = null;
  }
  if (_inspectScrollHandler) {
    cellsArea?.removeEventListener("scroll", _inspectScrollHandler, true);
    _inspectScrollHandler = null;
  }
  if (_activeInspectEl) {
    _activeInspectEl.remove();
  }
  _activeInspectEl = null;
  _activeInspectEditor = null;
}

function _escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _splitTopLevelParams(paramsStr) {
  const params = [];
  let depth = 0;
  let current = "";
  for (const ch of paramsStr) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function _colorizeParam(p) {
  // Parse "param: type = default" or "param=default" or just "param"
  const eqIdx = p.indexOf("=");
  const colonIdx = p.indexOf(":");
  let paramName = p;
  let annotation = "";
  let defaultVal = "";

  if (colonIdx > 0 && (eqIdx < 0 || colonIdx < eqIdx)) {
    paramName = p.slice(0, colonIdx).trim();
    const rest = p.slice(colonIdx + 1).trim();
    const restEq = rest.indexOf("=");
    if (restEq >= 0) {
      annotation = rest.slice(0, restEq).trim();
      defaultVal = rest.slice(restEq + 1).trim();
    } else {
      annotation = rest;
    }
  } else if (eqIdx > 0) {
    paramName = p.slice(0, eqIdx).trim();
    defaultVal = p.slice(eqIdx + 1).trim();
  }

  // Special tokens like * or /
  if (paramName === "*" || paramName === "/") {
    return `<span class="sc-sig-punct">${_escHtml(paramName)}</span>`;
  }
  // **kwargs, *args
  let prefix = "";
  if (paramName.startsWith("**")) { prefix = "**"; paramName = paramName.slice(2); }
  else if (paramName.startsWith("*")) { prefix = "*"; paramName = paramName.slice(1); }

  let html = "";
  if (prefix) html += `<span class="sc-sig-punct">${prefix}</span>`;
  html += `<span class="sc-sig-param">${_escHtml(paramName)}</span>`;
  if (annotation) html += `<span class="sc-sig-punct">: </span><span class="sc-sig-type">${_escHtml(annotation)}</span>`;
  if (defaultVal) html += `<span class="sc-sig-punct"> = </span><span class="sc-sig-default">${_escHtml(defaultVal)}</span>`;
  return html;
}

function _colorizeSignature(sig) {
  // Match name( ... ) with optional -> return_type suffix
  const m = sig.match(/^([^(]+)\(([^]*)\)\s*(->\s*.*)?$/);
  if (!m) return `<span class="sc-sig-name">${_escHtml(sig)}</span>`;
  const name = m[1];
  const params = _splitTopLevelParams(m[2]);
  const returnType = m[3] ? m[3].trim() : "";

  const retHtml = returnType
    ? ` <span class="sc-sig-punct">${_escHtml(returnType.slice(0, 2))}</span> <span class="sc-sig-type">${_escHtml(returnType.slice(2).trim())}</span>`
    : "";

  // One param per line with indent
  if (params.length <= 1) {
    const inner = params.length === 1 ? _colorizeParam(params[0]) : "";
    return `<span class="sc-sig-name">${_escHtml(name)}</span><span class="sc-sig-punct">(</span>${inner}<span class="sc-sig-punct">)</span>${retHtml}`;
  }

  const lines = params.map((p, i) => {
    const comma = i < params.length - 1 ? `<span class="sc-sig-punct">,</span>` : "";
    return `    ${_colorizeParam(p)}${comma}`;
  });

  return `<span class="sc-sig-name">${_escHtml(name)}</span><span class="sc-sig-punct">(</span>\n${lines.join("\n")}\n<span class="sc-sig-punct">)</span>${retHtml}`;
}

function _colorizeDetail(detail) {
  // Colorize "Key: value" lines
  return _escHtml(detail).replace(/^([A-Za-z][\w ]*?):(.*)/gm, (_, key, val) => {
    return `<span class="sc-detail-key">${key}:</span><span class="sc-detail-val">${val}</span>`;
  });
}

function _renderInspectContent(data) {
  const container = document.createElement("div");
  container.className = "sc-inspect-tooltip";

  // Header: name + type
  const header = document.createElement("div");
  header.className = "sc-inspect-header";
  header.innerHTML = `<span class="sc-inspect-name">${_escHtml(data.name)}</span>`
    + (data.type ? ` <span class="sc-inspect-type-badge">${_escHtml(data.type)}</span>` : "");
  container.appendChild(header);

  // Signature
  if (data.signature) {
    const sigLabel = document.createElement("div");
    sigLabel.className = "sc-inspect-section-label";
    sigLabel.textContent = "Signature:";
    container.appendChild(sigLabel);
    const sig = document.createElement("div");
    sig.className = "sc-inspect-sig";
    sig.innerHTML = _colorizeSignature(data.signature);
    container.appendChild(sig);
  }

  // Docstring
  if (data.docstring) {
    const docLabel = document.createElement("div");
    docLabel.className = "sc-inspect-section-label";
    docLabel.textContent = "Docstring:";
    container.appendChild(docLabel);
    const doc = document.createElement("div");
    doc.className = "sc-inspect-doc";
    doc.textContent = data.docstring;
    container.appendChild(doc);
  }

  // Detail
  if (data.detail) {
    const detail = document.createElement("div");
    detail.className = "sc-inspect-detail";
    detail.innerHTML = _colorizeDetail(data.detail);
    container.appendChild(detail);
  }

  // Close button
  const closeBtn = document.createElement("span");
  closeBtn.className = "sc-inspect-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.title = "Close (Esc)";
  closeBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissIntrospectionTooltip();
  });
  container.appendChild(closeBtn);

  return container;
}

function _positionInspectTooltip(editor, position, el, wordStartColumn) {
  // Get pixel coordinates of the cursor within the editor viewport
  const scrollTop = editor.getScrollTop();
  const scrollLeft = editor.getScrollLeft();
  const top = editor.getTopForLineNumber(position.lineNumber) - scrollTop;
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);

  // Get editor DOM node bounding rect to convert to page coordinates
  const editorDom = editor.getDomNode();
  if (!editorDom) return;
  const editorRect = editorDom.getBoundingClientRect();

  // Use Monaco's layout engine for accurate X position of the word start
  const col = wordStartColumn || position.column;
  const layoutInfo = editor.getOption(monaco.editor.EditorOption.layoutInfo);
  const contentLeft = layoutInfo ? layoutInfo.contentLeft : 40;
  const charWidth = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
  const cursorX = editorRect.left + contentLeft + (col - 1) * charWidth - scrollLeft;
  const cursorY = editorRect.top + top;

  // Position tooltip below the cursor line; fall above if not enough space
  const gap = 4;
  el.style.position = "fixed";
  el.style.visibility = "hidden";
  document.body.appendChild(el);

  const ttRect = el.getBoundingClientRect();
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;

  // Vertical: prefer below
  let posY = cursorY + lineHeight + gap;
  if (posY + ttRect.height > viewH - 4) {
    // Fall above if no room below
    const aboveY = cursorY - ttRect.height - gap;
    if (aboveY >= 4) {
      posY = aboveY;
    } else {
      posY = Math.max(4, viewH - 4 - ttRect.height);
    }
  }

  // Horizontal: align left to cursor, clamp to viewport
  let posX = cursorX;
  if (posX + ttRect.width > viewW - 8) {
    posX = viewW - 8 - ttRect.width;
  }
  if (posX < 4) posX = 4;

  el.style.left = `${posX}px`;
  el.style.top = `${posY}px`;
  el.style.visibility = "";
}

async function showIntrospectionTooltip(editor) {
  dismissIntrospectionTooltip();

  const model = editor.getModel();
  if (!model) return;
  const position = editor.getPosition();
  if (!position) return;

  const code = model.getValue();
  const offset = model.getOffsetAt(position);

  let data;
  try {
    const resp = await scriptingFetch("/scripting/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, cursor_pos: offset }),
    });
    data = await resp.json();
  } catch {
    return;
  }

  if (!data?.found) return;

  // Find the start column of the expression on the current line
  const lineContent = model.getLineContent(position.lineNumber);
  let wordStartCol = position.column;
  // Walk backwards from cursor to find start of the dotted identifier
  let ci = position.column - 2; // 0-based index into lineContent
  while (ci >= 0 && (/[A-Za-z0-9_.]/).test(lineContent[ci])) ci--;
  wordStartCol = ci + 2; // back to 1-based column

  // Build and position the tooltip on document.body
  const el = _renderInspectContent(data);
  _positionInspectTooltip(editor, position, el, wordStartCol);

  _activeInspectEl = el;
  _activeInspectEditor = editor;

  // Auto-dismiss after 15s
  _inspectDismissTimer = setTimeout(dismissIntrospectionTooltip, 15000);

  // Dismiss on cursor move
  _inspectCursorDisposable = editor.onDidChangeCursorPosition(() => {
    dismissIntrospectionTooltip();
  });

  // Dismiss on click outside tooltip
  _inspectClickHandler = (e) => {
    if (!el.contains(e.target)) dismissIntrospectionTooltip();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", _inspectClickHandler, true);
  }, 0);

  // Dismiss on scroll
  _inspectScrollHandler = () => dismissIntrospectionTooltip();
  cellsArea?.addEventListener("scroll", _inspectScrollHandler, true);
}
