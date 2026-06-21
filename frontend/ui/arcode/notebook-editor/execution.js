// ---------------------------------------------------------------------------
// Cell execution
// ---------------------------------------------------------------------------

const pendingCellRunQueue = [];
const queuedCellRunSet = new Set();
let isDrainingPendingCellRuns = false;
let isSelectedRunQueueRunning = false;

function canQueueCellRun(cell) {
  if (!cell || !cell.editor || !isRunnableCellType(cell.type)) return false;
  if (normalizeCellType(cell.type) === CELL_TYPES.CODE) {
    const code = cell.editor.getValue().trim();
    if (!code) return false;
  }
  return true;
}

function queueCellRun(cellId) {
  const cell = getCellById(cellId);
  if (!canQueueCellRun(cell)) return false;
  if (queuedCellRunSet.has(cellId)) {
    setStatus("Cell already queued");
    return true;
  }

  pendingCellRunQueue.push(cellId);
  queuedCellRunSet.add(cellId);
  markQueuedCellsRunningLabel([cellId]);
  setStatus("Cell queued");
  return true;
}

function dequeueCellRun(cellId) {
  queuedCellRunSet.delete(cellId);
  const idx = pendingCellRunQueue.indexOf(cellId);
  if (idx >= 0) pendingCellRunQueue.splice(idx, 1);
}

async function drainPendingCellRuns() {
  if (isDrainingPendingCellRuns || isRunning || isSelectedRunQueueRunning) return;
  isDrainingPendingCellRuns = true;
  try {
    while (!isRunning && !isSelectedRunQueueRunning && pendingCellRunQueue.length) {
      const nextCellId = pendingCellRunQueue.shift();
      queuedCellRunSet.delete(nextCellId);
      const nextCell = getCellById(nextCellId);
      if (!canQueueCellRun(nextCell)) continue;
      await runCell(nextCellId, { queueIfRunning: false, skipQueueDrain: true });
    }
  } finally {
    isDrainingPendingCellRuns = false;
    if (!isRunning && !isSelectedRunQueueRunning && pendingCellRunQueue.length) {
      setTimeout(() => { void drainPendingCellRuns(); }, 0);
    }
  }
}

async function runCell(id, options = {}) {
  const queueIfRunning = options.queueIfRunning !== false;
  const skipQueueDrain = options.skipQueueDrain === true;
  const cell = getCellById(id);
  if (!cell || !cell.editor) return;

  const cellType = normalizeCellType(cell.type);
  if (cellType === CELL_TYPES.MARKDOWN) {
    if (isRunning) {
      if (queueIfRunning) queueCellRun(id);
      return;
    }
    dequeueCellRun(id);
    runMarkdownCell(cell);
    if (!skipQueueDrain) void drainPendingCellRuns();
    return;
  }
  if (!isRunnableCellType(cell.type)) {
    setStatus(`${cell.type} cells are not executable`);
    return;
  }

  const code = cell.editor.getValue().trim();
  if (!code) return;
  if (isRunning) {
    if (queueIfRunning) queueCellRun(id);
    return;
  }

  dequeueCellRun(id);

  const execStartTime = performance.now();
  const execStartDate = new Date();

  isRunning = true;
  setRunningUI(true);
  cell.cellEl.classList.add("running");
  if (cell.runBtn) {
    cell.runBtn.classList.add("running");
    cell.runBtn.disabled = true;
    cell.runBtn.setAttribute("aria-busy", "true");
  }
  cell.labelEl.textContent = "[*]";
  cell.labelEl.className = "sc-cell-label running";
  cell.labelEl.classList.remove("empty");
  cell.cellEl.classList.remove("success", "error");
  setStatus("Running...");
  renderToc();

  cell.outputEl.innerHTML = "";
  cell.outputs = [];
  let stdoutEl = null;
  let stderrEl = null;
  let stdoutText = "";
  let stderrText = "";

  const appendStreamOutput = (kind, text) => {
    const chunk = typeof text === "string" ? text : "";
    if (!chunk) return;

    if (kind === "stdout") {
      if (!stdoutEl) {
        stdoutEl = document.createElement("div");
        stdoutEl.className = "out-stdout";
        cell.outputEl.appendChild(stdoutEl);
      }
      stdoutText += chunk;
      stdoutEl.textContent = stdoutText;
    } else {
      if (!stderrEl) {
        stderrEl = document.createElement("div");
        stderrEl.className = "out-error";
        cell.outputEl.appendChild(stderrEl);
      }
      stderrText += chunk;
      stderrEl.textContent = stderrText;
    }

    setCellOutputVisible(cell, true);
    cell.outputEl.scrollTop = cell.outputEl.scrollHeight;
  };

  const makeRunRequestOptions = () => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  try {
    let result = null;
    const streamResp = await scriptingFetch("/scripting/run-stream", makeRunRequestOptions());
    const canStream = Boolean(streamResp.ok && streamResp.body && typeof streamResp.body.getReader === "function");

    if (canStream) {
      const reader = streamResp.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

      const consumeLine = (line) => {
        const payload = String(line || "").trim();
        if (!payload) return;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          return;
        }

        const type = String(event.type || "");
        if (type === "stdout") {
          appendStreamOutput("stdout", event.text);
          return;
        }
        if (type === "stderr") {
          appendStreamOutput("stderr", event.text);
          return;
        }
        if (type === "done") {
          result = event;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let splitAt = buffered.indexOf("\n");
        while (splitAt >= 0) {
          const line = buffered.slice(0, splitAt);
          buffered = buffered.slice(splitAt + 1);
          consumeLine(line);
          splitAt = buffered.indexOf("\n");
        }
      }

      buffered += decoder.decode();
      if (buffered.trim()) {
        const trailing = buffered.split("\n");
        trailing.forEach((line) => consumeLine(line));
      }
    } else {
      const resp = await scriptingFetch("/scripting/run", makeRunRequestOptions());
      result = await resp.json();
      appendStreamOutput("stdout", result.output);
      appendStreamOutput("stderr", result.error);
    }

    if (!result || typeof result !== "object") {
      result = {
        success: false,
        output: stdoutText,
        error: "Execution stream ended unexpectedly.",
        execution_count: cell.executionCount,
      };
    }

    if (result.error && !stderrText.includes(String(result.error))) {
      appendStreamOutput("stderr", String(result.error));
    }

    const nextExecutionCount = Number.isInteger(result.execution_count)
      ? result.execution_count
      : cell.executionCount;
    if (Number.isInteger(nextExecutionCount)) {
      cell.executionCount = nextExecutionCount;
    }
    cell.outputs = [
      buildStreamIpynbOutput("stdout", stdoutText),
      buildStreamIpynbOutput("stderr", stderrText),
    ].filter(Boolean);
    cell.labelEl.className = "sc-cell-label";
    cell.labelEl.textContent = Number.isInteger(cell.executionCount)
      ? `[${cell.executionCount}]`
      : "[ ]";
    cell.labelEl.classList.toggle("empty", cell.labelEl.textContent === "[ ]");

    setCellOutputVisible(cell, Boolean(stdoutText || stderrText));

    if (result.success) {
      cell.cellEl.classList.add("success");
      cell.cellEl.classList.remove("error");
      cell.labelEl.classList.add("ran");
      cell.labelEl.classList.remove("err");
      setStatus("Done");
    } else {
      cell.cellEl.classList.add("error");
      cell.cellEl.classList.remove("success");
      cell.labelEl.classList.add("err");
      cell.labelEl.classList.remove("ran");
      const errText = String(result.error || "");
      if (/cancelled|canceled|timeout/i.test(errText)) {
        setStatus("Cancelled");
      } else {
        setStatus("Error");
      }
    }

    // Refresh variables panel
    refreshVariables();
  } catch (err) {
    cell.labelEl.className = "sc-cell-label";
    cell.labelEl.textContent = Number.isInteger(cell.executionCount)
      ? `[${cell.executionCount}]`
      : "[ ]";
    cell.labelEl.classList.toggle("empty", cell.labelEl.textContent === "[ ]");
    const errorText = `Network error: ${err.message}`;
    cell.outputEl.innerHTML = `<div class="out-error">${escapeHtml(errorText)}</div>`;
    cell.outputs = [buildStreamIpynbOutput("stderr", errorText)].filter(Boolean);
    setCellOutputVisible(cell, true);
    cell.cellEl.classList.add("error");
    cell.labelEl.classList.add("err");
    setStatus("Error");
  } finally {
    updateCellExecTime(cell, performance.now() - execStartTime, execStartDate, new Date());
    cell.cellEl.classList.remove("running");
    if (cell.runBtn) {
      cell.runBtn.classList.remove("running");
      cell.runBtn.disabled = !isRunnableCellType(cell.type);
      cell.runBtn.removeAttribute("aria-busy");
    }
    isRunning = false;
    setRunningUI(false);
    renderToc();
    saveCellsToStorage();
    if (!skipQueueDrain) void drainPendingCellRuns();
  }
}

function appendImportedOutputLine(container, className, text) {
  const value = typeof text === "string" ? text : "";
  if (!value) return false;
  const line = document.createElement("div");
  line.className = className;
  line.textContent = value;
  container.appendChild(line);
  return true;
}

const IMPORTED_HTML_ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "li", "ol",
  "p", "pre", "small", "span", "strong", "sub", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);
const IMPORTED_HTML_DROPPED_TAGS = new Set([
  "script", "style", "template", "iframe", "object", "embed", "svg", "math",
  "form", "input", "button", "select", "textarea", "link", "meta",
]);

function isSafeImportedHtmlUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("#")) return text;
  try {
    const parsed = new URL(text, window.location.href);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function copyImportedHtmlAttributes(source, target, tagName) {
  const title = source.getAttribute("title");
  if (title) target.setAttribute("title", title);

  if (tagName === "a") {
    const href = isSafeImportedHtmlUrl(source.getAttribute("href"));
    if (href) {
      target.setAttribute("href", href);
      target.setAttribute("target", "_blank");
      target.setAttribute("rel", "noopener noreferrer");
    }
  }

  if (tagName === "td" || tagName === "th") {
    ["rowspan", "colspan"].forEach((name) => {
      const numeric = Number.parseInt(source.getAttribute(name) || "", 10);
      if (Number.isInteger(numeric) && numeric > 0 && numeric <= 1000) {
        target.setAttribute(name, String(numeric));
      }
    });
    const align = String(source.getAttribute("align") || "").trim().toLowerCase();
    if (["left", "center", "right", "justify"].includes(align)) {
      target.setAttribute("align", align);
    }
  }
}

function sanitizeImportedHtml(rawHtml) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(String(rawHtml || ""), "text/html");

  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tagName = node.tagName.toLowerCase();
    if (IMPORTED_HTML_DROPPED_TAGS.has(tagName)) return null;

    if (!IMPORTED_HTML_ALLOWED_TAGS.has(tagName)) {
      const fragment = document.createDocumentFragment();
      Array.from(node.childNodes).forEach((child) => {
        const cleanChild = sanitizeNode(child);
        if (cleanChild) fragment.appendChild(cleanChild);
      });
      return fragment;
    }

    const cleanNode = document.createElement(tagName);
    copyImportedHtmlAttributes(node, cleanNode, tagName);
    Array.from(node.childNodes).forEach((child) => {
      const cleanChild = sanitizeNode(child);
      if (cleanChild) cleanNode.appendChild(cleanChild);
    });
    return cleanNode;
  }

  const fragment = document.createDocumentFragment();
  Array.from(parsed.body.childNodes).forEach((child) => {
    const cleanChild = sanitizeNode(child);
    if (cleanChild) fragment.appendChild(cleanChild);
  });
  return fragment;
}

function appendImportedHtml(container, htmlBlocks) {
  if (!Array.isArray(htmlBlocks) || !htmlBlocks.length) return false;
  let appended = false;
  htmlBlocks.forEach((html) => {
    const value = typeof html === "string" ? html : "";
    if (!value.trim()) return;
    const wrap = document.createElement("div");
    wrap.className = "out-html";
    wrap.appendChild(sanitizeImportedHtml(value));
    if (!wrap.textContent.trim() && !wrap.querySelector("table, hr, br")) return;
    container.appendChild(wrap);
    appended = true;
  });
  return appended;
}

function appendImportedImages(container, images) {
  if (!Array.isArray(images) || !images.length) return false;
  let appended = false;
  images.forEach((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) return;
    const mime = String(image.mime || "").trim().toLowerCase();
    const data = String(image.data || "").replace(/\s+/g, "");
    if (mime !== "image/png" || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) return;
    const wrap = document.createElement("div");
    wrap.className = "out-image";
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data}`;
    img.alt = "Imported plot";
    img.loading = "lazy";
    wrap.appendChild(img);
    container.appendChild(wrap);
    appended = true;
  });
  return appended;
}

function applyImportedCellState(cell, loadedCell) {
  if (!cell || !loadedCell || typeof loadedCell !== "object") {
    return { hasUnsupported: false };
  }

  if (
    normalizeCellType(cell.type) === CELL_TYPES.CODE &&
    Number.isInteger(loadedCell.execution_count)
  ) {
    cell.executionCount = loadedCell.execution_count;
    cell.labelEl.className = "sc-cell-label";
    cell.labelEl.classList.add("ran");
    cell.labelEl.textContent = `[${loadedCell.execution_count}]`;
    cell.labelEl.classList.remove("empty");
  }

  if (typeof loadedCell.execution_time_ms === "number" && loadedCell.execution_time_ms >= 0) {
    const startT = loadedCell.exec_start_time ? new Date(loadedCell.exec_start_time) : null;
    const endT = loadedCell.exec_end_time ? new Date(loadedCell.exec_end_time) : null;
    updateCellExecTime(cell, loadedCell.execution_time_ms, startT, endT);
  }

  cell.outputs = normalizeIpynbOutputs(loadedCell.outputs);
  const imported = loadedCell.import_output;
  if (!imported || typeof imported !== "object") {
    return { hasUnsupported: false };
  }

  cell.outputEl.innerHTML = "";
  let hasOutput = false;

  hasOutput = appendImportedOutputLine(
    cell.outputEl,
    "out-stdout",
    typeof imported.stdout === "string" ? imported.stdout : ""
  ) || hasOutput;

  hasOutput = appendImportedOutputLine(
    cell.outputEl,
    "out-error",
    typeof imported.stderr === "string" ? imported.stderr : ""
  ) || hasOutput;

  const importedError = typeof imported.error === "string" ? imported.error : "";
  hasOutput = appendImportedOutputLine(cell.outputEl, "out-error", importedError) || hasOutput;
  hasOutput = appendImportedHtml(cell.outputEl, imported.html) || hasOutput;
  hasOutput = appendImportedImages(cell.outputEl, imported.images) || hasOutput;

  const unsupported = Array.isArray(imported.unsupported)
    ? imported.unsupported.filter((item) => typeof item === "string" && item.trim())
    : [];

  if (unsupported.length) {
    const note = document.createElement("div");
    note.className = "out-note";
    note.textContent =
      (typeof imported.unsupported_message === "string" && imported.unsupported_message.trim())
        ? imported.unsupported_message
        : `Imported output contains unsupported rich display types: ${unsupported.join(", ")}.`;
    cell.outputEl.appendChild(note);
    hasOutput = true;
  }

  setCellOutputVisible(cell, hasOutput);

  if (hasOutput) {
    if (importedError) {
      cell.cellEl.classList.add("error");
      cell.cellEl.classList.remove("success");
      cell.labelEl.classList.add("err");
      cell.labelEl.classList.remove("ran");
    } else {
      cell.cellEl.classList.add("success");
      cell.cellEl.classList.remove("error");
      cell.labelEl.classList.add("ran");
      cell.labelEl.classList.remove("err");
    }
  }

  return { hasUnsupported: unsupported.length > 0 };
}

function markQueuedCellsRunningLabel(queueCellIds) {
  if (!Array.isArray(queueCellIds) || queueCellIds.length === 0) return;
  queueCellIds.forEach((cellId) => {
    const cell = getCellById(cellId);
    if (!cell || !cell.labelEl) return;
    cell.labelEl.textContent = "[*]";
    cell.labelEl.classList.remove("empty");
    cell.labelEl.classList.remove("ran");
    cell.labelEl.classList.remove("err");
    cell.labelEl.classList.add("running");
  });
}

function restoreSelectionSnapshotAfterQueuedRun(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const existingIds = new Set(cells.map((cell) => cell.id));

  selectedCellIds.clear();
  const selectedIds = Array.isArray(snapshot.selectedIds) ? snapshot.selectedIds : [];
  selectedIds.forEach((cellId) => {
    if (existingIds.has(cellId)) selectedCellIds.add(cellId);
  });

  if (!selectedCellIds.size) {
    syncCellSelectionClasses();
    return;
  }

  addCollapsedSectionTargetsToSelection(selectedCellIds);

  const orderedSelectedIds = getOrderedSelectedCellIds();
  const fallbackFocusId = orderedSelectedIds.length ? orderedSelectedIds[0] : null;
  focusedCellId = selectedCellIds.has(snapshot.focusedId) ? snapshot.focusedId : fallbackFocusId;

  if (selectedCellIds.has(snapshot.anchorId)) {
    rangeSelectionAnchorId = snapshot.anchorId;
  } else {
    rangeSelectionAnchorId = focusedCellId;
  }

  syncCellSelectionClasses();
  const focusedCell = getCellById(focusedCellId);
  if (focusedCell) setTypeDropdownValue(focusedCell.type);
}

function runSelectedCellsSequentially(triggerCellId = null, options = {}) {
  if (isRunning) return false;
  if (!(selectedCellIds instanceof Set) || selectedCellIds.size <= 1) return false;
  if (triggerCellId !== null && !selectedCellIds.has(triggerCellId)) return false;
  const startFromTrigger = options?.startFromTrigger === true;

  let queue = getOrderedSelectedCellIds().filter((cellId) => {
    const cell = getCellById(cellId);
    return Boolean(cell && isRunnableCellType(cell.type));
  });

  if (startFromTrigger && triggerCellId !== null) {
    const triggerIndex = queue.indexOf(triggerCellId);
    if (triggerIndex < 0) return false;
    queue = queue.slice(triggerIndex);
  }
  if (!queue.length) return false;

  const selectionSnapshot = {
    selectedIds: Array.from(selectedCellIds),
    focusedId: focusedCellId,
    anchorId: rangeSelectionAnchorId,
  };
  markQueuedCellsRunningLabel(queue);

  (async () => {
    isSelectedRunQueueRunning = true;
    try {
      for (const cellId of queue) {
        await runCell(cellId, { queueIfRunning: false, skipQueueDrain: true });
      }
    } finally {
      isSelectedRunQueueRunning = false;
      restoreSelectionSnapshotAfterQueuedRun(selectionSnapshot);
      void drainPendingCellRuns();
    }
  })();

  return true;
}

async function runCellAndAdvance(id) {
  const cell = getCellById(id);
  if (!cell || !isRunnableCellType(cell.type) || isRunning) return;

  await runCell(id, { queueIfRunning: false, skipQueueDrain: true });

  const idx = cells.findIndex((c) => c.id === id);
  if (idx < 0) return;

  if (idx === cells.length - 1) {
    // Last cell — create a new one
    const newCell = addCell("", id, "after", CELL_TYPES.CODE);
    focusCellCommand(newCell);
  } else {
    // Focus next cell
    const next = cells[idx + 1];
    focusCellEditor(next);
  }
  void drainPendingCellRuns();
}

async function runAllCells() {
  if (isRunning) return;
  for (const cell of cells) {
    if (!isRunnableCellType(cell.type)) continue;
    await runCell(cell.id, { queueIfRunning: false, skipQueueDrain: true });
  }
  void drainPendingCellRuns();
}

function clearAllOutputs() {
  cells.forEach((c) => {
    if (normalizeCellType(c.type) === CELL_TYPES.MARKDOWN) {
      setMarkdownRenderedState(c, false);
    }
    c.outputEl.innerHTML = "";
    c.outputs = [];
    c.executionCount = null;
    updateCellExecTime(c, null, null, null);
    setCellOutputVisible(c, false);
    updateCellIdleState(c);
  });
  refreshToc();
  saveCellsToStorage();
}

function clearCellOutput(cell) {
  if (!cell) return false;
  if (normalizeCellType(cell.type) === CELL_TYPES.MARKDOWN) {
    setMarkdownRenderedState(cell, false);
  }
  cell.outputEl.innerHTML = "";
  cell.outputs = [];
  cell.executionCount = null;
  updateCellExecTime(cell, null, null, null);
  setCellOutputVisible(cell, false);
  updateCellIdleState(cell);
  refreshToc();
  saveCellsToStorage();
  return true;
}

async function restartSession() {
  if (isRunning) return;
  try {
    await scriptingFetch("/scripting/reset", { method: "POST" });
    clearAllOutputs();
    renderAllMarkdownCells({ setStatusMessage: false });
    refreshVariables();
    setStatus("Session restarted");
  } catch {
    setStatus("Restart failed");
  }
}


