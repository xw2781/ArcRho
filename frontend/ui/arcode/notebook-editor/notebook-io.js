// ---------------------------------------------------------------------------
// Notebook save / open
// ---------------------------------------------------------------------------

function getNotebookFilenameFromPath(pathLike) {
  return arcodeShared.filenameFromPath(pathLike);
}

function getNotebookDisplayTitle() {
  return currentNotebookFilename || DEFAULT_NOTEBOOK_TITLE;
}

function updateNotebookTitleUI() {
  const title = getNotebookDisplayTitle();
  arcodeShared.postTabTitle({ title, inst: scriptingTabInstanceId, path: currentNotebookPath || "" });
}

function setCurrentNotebookFilename(pathLike) {
  currentNotebookFilename = getNotebookFilenameFromPath(pathLike);
  currentNotebookPath = String(pathLike || "").trim();
  updateNotebookTitleUI();
}

function getNotebookDirectoryFromPath(pathLike) {
  return arcodeShared.directoryFromPath(pathLike);
}

function getNotebookHostApi() {
  return arcodeShared.getHostApi();
}

function getNotebookExtension(pathLike) {
  return arcodeShared.extensionFromPath(pathLike);
}

function isIpynbPath(pathLike) {
  return getNotebookExtension(pathLike).toLowerCase() === ".ipynb";
}

function isCodeTextFilePath(pathLike) {
  const extension = getNotebookExtension(pathLike).toLowerCase();
  return extension === ".py" || extension === ".sql" || extension === ".md" || extension === ".txt" || extension === ".json";
}

function getTextFileCellType(pathLike) {
  const extension = getNotebookExtension(pathLike).toLowerCase();
  if (extension === ".md") return CELL_TYPES.MARKDOWN;
  if (extension === ".txt") return CELL_TYPES.RAW;
  return CELL_TYPES.CODE;
}

function isJsonTextFilePath(pathLike) {
  return getNotebookExtension(pathLike).toLowerCase() === ".json";
}

function formatJsonText(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return "";
  try {
    return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  } catch {
    return raw;
  }
}

function formatTextFileForEditor(pathLike, text) {
  return isJsonTextFilePath(pathLike) ? formatJsonText(text) : String(text ?? "");
}

function isAbsoluteFilePath(pathLike) {
  return arcodeShared.isAbsoluteFilePath(pathLike);
}

function getNotebookCopyFilename(pathLike) {
  const name = getNotebookFilenameFromPath(pathLike) || "notebook.ipynb";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}.copy.ipynb`;
  return `${name.slice(0, dot)}.copy${name.slice(dot)}`;
}

function normalizeNotebookRenameInput(rawName) {
  const raw = String(rawName || "").trim();
  if (!raw) return { ok: false, error: "Enter a notebook name." };
  if (/[\\/:*?"<>|]/.test(raw)) {
    return { ok: false, error: "Notebook name cannot include path separators or Windows filename characters." };
  }
  const currentExt = getNotebookExtension(currentNotebookPath || currentNotebookFilename) || ".ipynb";
  const dot = raw.lastIndexOf(".");
  const nextName = dot > 0 ? raw : `${raw}${currentExt}`;
  const nextExt = getNotebookExtension(nextName).toLowerCase();
  if (nextExt !== ".ipynb" && nextExt !== ".arcnb" && nextExt !== ".py" && nextExt !== ".sql" && nextExt !== ".md" && nextExt !== ".txt" && nextExt !== ".json") {
    return { ok: false, error: "Notebook name must end with .ipynb, .arcnb, .py, .sql, .md, .txt, or .json." };
  }
  return { ok: true, name: nextName };
}

function revisionToken(revision) {
  if (!revision || typeof revision !== "object") return "";
  const hash = String(revision.hash || "").trim();
  if (hash) return hash;
  return `${Number(revision.size || 0)}:${Number(revision.mtimeMs || 0)}`;
}

function sameRevision(left, right) {
  return arcodeShared.sameRevision(left, right);
}

function getNotebookStateText() {
  try {
    return JSON.stringify(getNotebookSavePayload());
  } catch {
    return "";
  }
}

function setNotebookDirty(nextDirty) {
  const dirty = !!nextDirty;
  if (notebookDirty === dirty) return;
  notebookDirty = dirty;
  updateNotebookTitleUI();
  try {
    arcodeShared.postDirty({ inst: scriptingTabInstanceId, dirty });
  } catch {}
}

function updateNotebookDirtyState() {
  if (suppressNotebookDirtyTracking) return;
  setNotebookDirty(getNotebookStateText() !== savedNotebookText);
}

function markNotebookSavedBaseline(pathLike = currentNotebookPath, revision = lastNotebookDiskRevision) {
  savedNotebookText = getNotebookStateText();
  lastNotebookDiskRevision = revision || null;
  notebookDiskConflict = "";
  setNotebookDirty(false);
  hideNotebookFileBanner();
  if (pathLike) startNotebookRevisionPolling();
}

function withNotebookDirtyTrackingSuspended(fn) {
  const previous = suppressNotebookDirtyTracking;
  suppressNotebookDirtyTracking = true;
  try {
    return fn();
  } finally {
    suppressNotebookDirtyTracking = previous;
  }
}

function buildIpynbSource(source) {
  return String(source || "").match(/[^\n]*\n|[^\n]+/g) || [];
}

function cloneJsonValue(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeIpynbOutputText(value) {
  if (Array.isArray(value)) return value.map((part) => String(part ?? "")).join("");
  if (value == null) return "";
  return String(value);
}

function normalizeIpynbOutputData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const normalized = {};
  Object.entries(data).forEach(([key, value]) => {
    const mimeKey = String(key || "").trim();
    if (!mimeKey) return;
    normalized[mimeKey] = cloneJsonValue(value);
  });
  return normalized;
}

function normalizeIpynbOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const outputType = String(output.output_type || "").trim();
  if (outputType === "stream") {
    const name = String(output.name || "").toLowerCase() === "stderr" ? "stderr" : "stdout";
    const text = normalizeIpynbOutputText(output.text);
    return text ? { output_type: "stream", name, text } : null;
  }
  if (outputType === "error") {
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.map((line) => String(line ?? ""))
      : [];
    return {
      output_type: "error",
      ename: String(output.ename || "Error"),
      evalue: String(output.evalue || ""),
      traceback,
    };
  }
  if (outputType === "execute_result" || outputType === "display_data") {
    const normalized = {
      output_type: outputType,
      data: normalizeIpynbOutputData(output.data),
      metadata: (output.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata))
        ? cloneJsonValue(output.metadata) || {}
        : {},
    };
    if (outputType === "execute_result") {
      normalized.execution_count = Number.isInteger(output.execution_count) ? output.execution_count : null;
    }
    return normalized;
  }
  return null;
}

function normalizeIpynbOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  return outputs.map(normalizeIpynbOutput).filter(Boolean);
}

function buildStreamIpynbOutput(name, text) {
  const value = normalizeIpynbOutputText(text);
  if (!value) return null;
  return { output_type: "stream", name: name === "stderr" ? "stderr" : "stdout", text: value };
}

function buildNotebookFileData() {
  const extension = getNotebookExtension(currentNotebookPath || currentNotebookFilename);
  const cellsPayload = getNotebookSavePayload();
  if (extension === ".arcnb") {
    return { cells: cellsPayload.map((cell) => ({ type: normalizeCellType(cell.type), source: sourceToText(cell.source) })) };
  }
  return {
    cells: cellsPayload.map((cell) => {
      const cellType = normalizeCellType(cell.type);
      const entry = {
        cell_type: cellType,
        metadata: {},
        source: buildIpynbSource(cell.source),
      };
      if (cellType === CELL_TYPES.CODE) {
        entry.execution_count = Number.isInteger(cell.execution_count) ? cell.execution_count : null;
        entry.outputs = normalizeIpynbOutputs(cell.outputs);
      }
      return entry;
    }),
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function buildCodeTextFile(pathLike = currentNotebookPath || currentNotebookFilename) {
  const extension = getNotebookExtension(pathLike).toLowerCase();
  if (extension === ".json") {
    const jsonText = getNotebookSavePayload()
      .map((cell) => sourceToText(cell.source))
      .join("\n")
      .trim();
    return formatJsonText(jsonText || "");
  }
  const separator = extension === ".sql"
    ? "\n\n-- %%\n\n"
    : (extension === ".py" ? "\n\n# %%\n\n" : "\n\n");
  return getNotebookSavePayload()
    .map((cell) => sourceToText(cell.source))
    .join(separator)
    .trimEnd() + "\n";
}

async function readNotebookDiskRevision(pathLike = currentNotebookPath) {
  const hostApi = getNotebookHostApi();
  const filePath = String(pathLike || "").trim();
  if (!filePath || typeof hostApi?.getFileRevision !== "function") return null;
  const result = await hostApi.getFileRevision({ path: filePath });
  return result?.exists ? result.revision || null : null;
}

function showNotebookFileBanner(message, conflict = "changed") {
  notebookDiskConflict = conflict;
  if (notebookFileBannerMessage) notebookFileBannerMessage.textContent = message;
  notebookFileBanner?.classList.add("open");
  if (conflict) setStatus("Changed on disk");
}

function hideNotebookFileBanner() {
  notebookFileBanner?.classList.remove("open");
}

function setNotebookDiskConflict(message, conflict = "changed") {
  showNotebookFileBanner(message, conflict);
}

function buildScriptingAssistantContext() {
  const fileState = notebookDiskConflict
    ? "changed-on-disk"
    : notebookDirty ? "unsaved-changes" : "saved";
  return {
    available: true,
    tabType: "scripting",
    pageType: "scripting",
    title: getNotebookDisplayTitle(),
    targetPath: currentNotebookPath || "",
    path: currentNotebookPath || "",
    notebookFilename: currentNotebookFilename || "",
    dirty: notebookDirty,
    fileState,
    activeJson: buildNotebookFileData(),
  };
}

async function checkNotebookDiskForChanges({ force = false } = {}) {
  if (!currentNotebookPath) return;
  const revision = await readNotebookDiskRevision();
  if (!revision) {
    if (lastNotebookDiskRevision) {
      setNotebookDiskConflict(`${getNotebookDisplayTitle()} is no longer available on disk. Save a copy or choose Overwrite to recreate it.`, "deleted");
    }
    return;
  }
  if (!lastNotebookDiskRevision) {
    lastNotebookDiskRevision = revision;
    return;
  }
  if (!force && sameRevision(revision, lastNotebookDiskRevision)) return;
  if (sameRevision(revision, lastNotebookDiskRevision)) return;
  if (notebookDirty) {
    lastNotebookDiskRevision = lastNotebookDiskRevision || revision;
    setNotebookDiskConflict(`${getNotebookDisplayTitle()} changed on disk while this tab has unsaved edits.`, "changed");
    return;
  }
  await reloadCurrentNotebookFromDisk({ reason: "external" });
}

function startNotebookRevisionPolling() {
  clearInterval(notebookRevisionPollTimer);
  if (!currentNotebookPath) return;
  const hostApi = getNotebookHostApi();
  if (typeof hostApi?.getFileRevision !== "function") return;
  notebookRevisionPollTimer = setInterval(() => {
    void checkNotebookDiskForChanges();
  }, 3000);
}

function openSaveNbDialog(defaultName = "") {
  const overlay = document.getElementById("saveNbOverlay");
  const input = document.getElementById("saveNbName");
  const proposed = String(defaultName || currentNotebookFilename || DEFAULT_NOTEBOOK_FILENAME).trim();
  overlay.classList.add("open");
  input.value = proposed;
  input.focus();
  input.select();
}

function closeSaveNbDialog() {
  document.getElementById("saveNbOverlay").classList.remove("open");
}

function postShellStatus(text) {
  arcodeShared.postStatus(text);
}

function getNotebookSavePayload() {
  return cells.map((c) => {
    const entry = {
      type: normalizeCellType(c.type),
      source: c.editor ? c.editor.getValue() : "",
    };
    if (normalizeCellType(c.type) === CELL_TYPES.CODE) {
      entry.execution_count = Number.isInteger(c.executionCount) ? c.executionCount : null;
      entry.outputs = normalizeIpynbOutputs(c.outputs);
    }
    if (c.executionTimeMs != null) entry.execution_time_ms = Math.round(c.executionTimeMs);
    if (c.execStartTime) entry.exec_start_time = c.execStartTime instanceof Date ? c.execStartTime.toISOString() : c.execStartTime;
    if (c.execEndTime) entry.exec_end_time = c.execEndTime instanceof Date ? c.execEndTime.toISOString() : c.execEndTime;
    return entry;
  });
}

async function saveNotebookViaApi(filename, { closeDialog = true } = {}) {
  const nextName = String(filename || "").trim();
  if (!nextName) {
    setStatus("Enter a filename");
    return false;
  }

  try {
    const resp = await scriptingFetch("/scripting/save-notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: nextName, cells: getNotebookSavePayload() }),
    });
    const result = await resp.json();
    if (result && result.success === false) {
      const msg = result.message || "Save failed";
      setStatus(msg);
      return false;
    }

    const savedName = getNotebookFilenameFromPath(result?.path) || nextName;
    setCurrentNotebookFilename(result?.path || savedName);
    rememberLastOpenedIpynbPath(result?.path || savedName);
    try {
      lastNotebookDiskRevision = await readNotebookDiskRevision(result?.path || "");
    } catch {
      lastNotebookDiskRevision = null;
    }
    markNotebookSavedBaseline(result?.path || savedName, lastNotebookDiskRevision);
    const msg = result?.message || `Saved ${savedName}`;
    setStatus(msg);
    if (closeDialog) closeSaveNbDialog();
    return true;
  } catch {
    setStatus("Save failed");
    return false;
  }
}

async function confirmSaveNb() {
  const input = document.getElementById("saveNbName");
  const filename = input.value.trim();
  if (!filename) {
    setStatus("Enter a filename");
    return;
  }
  await saveNotebookByFilename(filename, { closeDialog: true });
}

async function requestNotebookSave(forcePrompt = false) {
  if (forcePrompt || !currentNotebookFilename) {
    postShellStatus("Save As...");
    openSaveNbDialog();
    return;
  }
  await saveNotebookByFilename(currentNotebookFilename, { closeDialog: false });
}

function rememberLastOpenedIpynbPath(pathLike) {
  const filePath = String(pathLike || "").trim();
  if (!filePath || !isIpynbPath(filePath) || !isAbsoluteFilePath(filePath)) return;
  const hostApi = getNotebookHostApi();
  if (typeof hostApi?.saveLastScriptingNotebook !== "function") return;
  try {
    Promise.resolve(hostApi.saveLastScriptingNotebook(filePath)).catch(() => {});
  } catch {
    // ignore persistence failures; notebook open/save should still succeed
  }
}

async function loadLastOpenedNotebookFromHost() {
  const hostApi = getNotebookHostApi();
  if (typeof hostApi?.loadLastScriptingNotebook !== "function") return false;
  try {
    const result = await hostApi.loadLastScriptingNotebook();
    const filePath = String(result?.path || "").trim();
    if (!result?.exists || !filePath || !isIpynbPath(filePath)) return false;
    return await openNotebookFilePath(filePath, { remember: false, source: "startup" });
  } catch {
    return false;
  }
}

async function renameCurrentNotebook() {
  const currentName = currentNotebookFilename || DEFAULT_NOTEBOOK_FILENAME;
  const proposed = window.prompt("Rename notebook", currentName);
  if (proposed == null) return false;

  const normalized = normalizeNotebookRenameInput(proposed);
  if (!normalized.ok) {
    setStatus(normalized.error);
    return false;
  }
  const nextName = normalized.name;
  if (nextName === currentName) return true;

  if (!currentNotebookPath) {
    currentNotebookFilename = nextName;
    updateNotebookTitleUI();
    setStatus(`Renamed ${nextName}`);
    return true;
  }

  if (notebookDiskConflict) {
    const msg = "Resolve the disk conflict before renaming this notebook.";
    setStatus(msg);
    return false;
  }

  const hostApi = getNotebookHostApi();
  if (typeof hostApi?.renameFile !== "function") {
    const msg = "Rename requires the Arcode desktop app.";
    setStatus(msg);
    return false;
  }

  try {
    const wasDirty = notebookDirty;
    const result = await hostApi.renameFile({ path: currentNotebookPath, newName: nextName });
    if (!result?.ok) {
      const msg = result?.error || "Rename failed";
      setStatus(msg);
      return false;
    }
    const nextPath = result.path || currentNotebookPath;
    setCurrentNotebookFilename(nextPath);
    rememberLastOpenedIpynbPath(nextPath);
    lastNotebookDiskRevision = result.revision || await readNotebookDiskRevision(nextPath);
    if (wasDirty) {
      notebookDiskConflict = "";
      hideNotebookFileBanner();
      startNotebookRevisionPolling();
      setNotebookDirty(true);
    } else {
      markNotebookSavedBaseline(nextPath, lastNotebookDiskRevision);
    }
    const msg = `Renamed ${getNotebookFilenameFromPath(nextPath)}`;
    setStatus(msg);
    postShellStatus(`${msg} (${nextPath})`);
    return true;
  } catch {
    setStatus("Rename failed");
    return false;
  }
}

async function openOpenNbDialog() {
  if (await openNotebookFromAnyFolder()) return;
  const overlay = document.getElementById("openNbOverlay");
  const list = document.getElementById("openNbList");
  overlay.classList.add("open");
  list.innerHTML = `<li style="color:#bbb;text-align:center">Loading...</li>`;
  try {
    const resp = await scriptingFetch("/scripting/notebooks");
    const notebooks = await resp.json();
    if (notebooks.length === 0) {
      list.innerHTML = `<li style="color:#bbb;text-align:center">No saved notebooks.</li>`;
      return;
    }
    list.innerHTML = "";
    notebooks.forEach((nb) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="nb-name">${escapeHtml(nb.name)}</span><span class="nb-meta">${escapeHtml(nb.size)}</span>`;
      li.addEventListener("click", () => loadNotebook(nb.name));
      list.appendChild(li);
    });
  } catch {
    list.innerHTML = `<li style="color:#bbb;text-align:center">Failed to load.</li>`;
  }
}

function closeOpenNbDialog() {
  document.getElementById("openNbOverlay").classList.remove("open");
}

function sourceToText(source) {
  if (Array.isArray(source)) return source.map((part) => String(part ?? "")).join("");
  if (source == null) return "";
  return String(source);
}

function normalizeImportedCellType(rawType) {
  const value = String(rawType || "").trim().toLowerCase();
  if (value === "markdown" || value === "raw") return value;
  return "code";
}

function extractPlainText(dataBundle) {
  if (!dataBundle || typeof dataBundle !== "object" || Array.isArray(dataBundle)) return "";
  return sourceToText(dataBundle["text/plain"]);
}

function normalizeImportedPngData(value) {
  const text = sourceToText(value).replace(/\s+/g, "");
  if (!text) return "";
  return /^[A-Za-z0-9+/=]+$/.test(text) ? text : "";
}

function normalizeImportedHtml(value) {
  const text = sourceToText(value).trim();
  return text || "";
}

function convertImportedOutputs(outputs) {
  if (!Array.isArray(outputs)) return {};
  const stdout = [];
  const stderr = [];
  const errors = [];
  const images = [];
  const html = [];
  const unsupported = new Set();

  outputs.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      unsupported.add("unknown-output");
      return;
    }
    const outputType = String(item.output_type || "").trim().toLowerCase();
    if (outputType === "stream") {
      const target = String(item.name || "").toLowerCase() === "stderr" ? stderr : stdout;
      const text = sourceToText(item.text);
      if (text) target.push(text);
      return;
    }
    if (outputType === "error") {
      if (Array.isArray(item.traceback) && item.traceback.length) {
        errors.push(item.traceback.map((line) => String(line ?? "")).join("\n"));
      } else {
        const ename = String(item.ename || "Error").trim();
        const evalue = String(item.evalue || "").trim();
        errors.push(evalue ? `${ename}: ${evalue}` : ename);
      }
      return;
    }
    if (outputType === "execute_result" || outputType === "display_data") {
      let hasPngImage = false;
      let htmlText = "";
      if (item.data && typeof item.data === "object" && !Array.isArray(item.data) && Object.prototype.hasOwnProperty.call(item.data, "image/png")) {
        const data = normalizeImportedPngData(item.data["image/png"]);
        if (data) {
          images.push({ mime: "image/png", data });
          hasPngImage = true;
        }
      }
      if (!hasPngImage && item.data && typeof item.data === "object" && !Array.isArray(item.data) && Object.prototype.hasOwnProperty.call(item.data, "text/html")) {
        htmlText = normalizeImportedHtml(item.data["text/html"]);
        if (htmlText) html.push(htmlText);
      }
      const text = hasPngImage || htmlText ? "" : extractPlainText(item.data);
      if (text) stdout.push(text);
      if (item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
        Object.keys(item.data).forEach((mimeKey) => {
          if (mimeKey === "text/plain") return;
          if (mimeKey === "text/html") {
            if (!htmlText && !hasPngImage) unsupported.add(mimeKey);
            return;
          }
          if (mimeKey === "image/png") {
            if (!hasPngImage) unsupported.add(mimeKey);
            return;
          }
          unsupported.add(mimeKey);
        });
      } else {
        unsupported.add(outputType);
      }
      return;
    }
    unsupported.add(outputType || "unknown-output");
  });

  const result = {};
  if (stdout.length) result.stdout = stdout.join("");
  if (stderr.length) result.stderr = stderr.join("");
  if (errors.length) result.error = errors.join("\n");
  if (images.length) result.images = images;
  if (html.length) result.html = html;
  if (unsupported.size) {
    result.unsupported = Array.from(unsupported).sort();
    result.unsupported_message = `Imported output contains unsupported rich display types: ${result.unsupported.join(", ")}.`;
  }
  return result;
}

function normalizeNotebookData(data, filename = "") {
  const lower = String(filename || "").toLowerCase();
  const rawCells = data && typeof data === "object" && Array.isArray(data.cells) ? data.cells : [];
  if (lower.endsWith(".arcnb")) {
    return rawCells
      .filter((cell) => cell && typeof cell === "object")
      .map((cell) => ({
        type: normalizeImportedCellType(cell.type),
        source: sourceToText(cell.source),
      }));
  }
  return rawCells
    .filter((cell) => cell && typeof cell === "object")
    .map((cell) => {
      const entry = {
        type: normalizeImportedCellType(cell.cell_type),
        source: sourceToText(cell.source),
      };
      if (entry.type === "code") {
        if (Number.isInteger(cell.execution_count)) entry.execution_count = cell.execution_count;
        entry.outputs = normalizeIpynbOutputs(cell.outputs);
        const importOutput = convertImportedOutputs(cell.outputs);
        if (Object.keys(importOutput).length) entry.import_output = importOutput;
      }
      return entry;
    });
}

function applyLoadedNotebookCells(loadedCells, filename, options = {}) {
  commitPendingEditUndoSnapshot();
  if (options.recordUndo !== false) recordNotebookUndoSnapshot();
  setCurrentNotebookFilename(filename);

  let unsupportedOutputCells = 0;
  const normalizedCells = Array.isArray(loadedCells) ? loadedCells : [];
  withNotebookDirtyTrackingSuspended(() => withNotebookUndoSuspended(() => {
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

    normalizedCells.forEach((c) => {
      const cell = addCell(c.source || "", null, "after", c.type || "code", { recordUndo: false, persist: false });
      const applied = applyImportedCellState(cell, c);
      if (applied.hasUnsupported) unsupportedOutputCells += 1;
    });

    if (cells.length === 0) {
      addCell("", null, "after", CELL_TYPES.CODE, { recordUndo: false, persist: false });
    }

    focusCell(cells[0]?.id);
    refreshToc();
    saveCellsToStorage();
  }));
  renderAllMarkdownCells({ setStatusMessage: false });
  markNotebookSavedBaseline(filename, options.revision || lastNotebookDiskRevision);
  return unsupportedOutputCells;
}

async function reloadCurrentNotebookFromDisk({ reason = "manual" } = {}) {
  const hostApi = getNotebookHostApi();
  if (!currentNotebookPath) return false;
  if (isCodeTextFilePath(currentNotebookPath)) {
    if (typeof hostApi?.readTextFile !== "function") return false;
    try {
      const result = await hostApi.readTextFile({ path: currentNotebookPath });
      if (!result?.ok) {
        const msg = result?.error || `File not found: ${currentNotebookPath}`;
        setNotebookDiskConflict(msg, "deleted");
        return false;
      }
      const revision = result.revision || await readNotebookDiskRevision(currentNotebookPath);
      applyLoadedNotebookCells([{ type: getTextFileCellType(currentNotebookPath), source: formatTextFileForEditor(currentNotebookPath, result.text || "") }], currentNotebookPath, {
        revision,
        recordUndo: reason !== "external",
      });
      const label = getNotebookFilenameFromPath(currentNotebookPath);
      const msg = reason === "external" ? `Reloaded disk changes for ${label}` : `Reloaded ${label}`;
      setStatus(msg);
      return true;
    } catch {
      setStatus("Reload failed");
      return false;
    }
  }
  if (typeof hostApi?.readJsonFile !== "function") return false;
  try {
    const result = await hostApi.readJsonFile({ path: currentNotebookPath });
    if (!result?.exists) {
      const msg = result?.error || `File not found: ${currentNotebookPath}`;
      setNotebookDiskConflict(msg, "deleted");
      return false;
    }
    const loadedCells = normalizeNotebookData(result.data, currentNotebookPath);
    const unsupportedOutputCells = applyLoadedNotebookCells(loadedCells, currentNotebookPath, {
      revision: result.revision || null,
      recordUndo: reason !== "external",
    });
    const label = getNotebookFilenameFromPath(currentNotebookPath);
    const suffix = unsupportedOutputCells > 0 ? ` (${unsupportedOutputCells} cells include unsupported rich outputs)` : "";
    const msg = reason === "external" ? `Reloaded disk changes for ${label}${suffix}` : `Reloaded ${label}${suffix}`;
    setStatus(msg);
    return true;
  } catch {
    setStatus("Reload failed");
    return false;
  }
}

async function openNotebookFromAnyFolder() {
  const hostApi = window.ADAHost || window.parent?.ADAHost || window.top?.ADAHost;
  if (!hostApi || typeof hostApi.pickOpenFile !== "function" || typeof hostApi.readJsonFile !== "function") {
    return false;
  }
  const startDir = getNotebookDirectoryFromPath(currentNotebookPath);
  let filePath = "";
  try {
    filePath = await hostApi.pickOpenFile({
      startDir,
      filters: [
        { name: "Scripting Files", extensions: ["ipynb", "arcnb", "py", "sql", "md", "txt", "json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
  } catch {
    setStatus("Open failed");
    return true;
  }
  if (!filePath) return true;

  await openNotebookFilePath(filePath);
  return true;
}

async function openNotebookFilePath(filePath, options = {}) {
  const hostApi = getNotebookHostApi();
  const targetPath = String(filePath || "").trim();
  const extension = getNotebookExtension(targetPath).toLowerCase();
  if (!targetPath) {
    setStatus("Open failed");
    return false;
  }
  if (extension !== ".ipynb" && extension !== ".arcnb" && extension !== ".py" && extension !== ".sql" && extension !== ".md" && extension !== ".txt" && extension !== ".json") {
    const msg = "Only .ipynb, .arcnb, .py, .sql, .md, .txt, and .json files can be opened in Arcode.";
    setStatus(msg);
    return false;
  }
  try {
    if (isCodeTextFilePath(targetPath)) {
      if (!hostApi || typeof hostApi.readTextFile !== "function") {
        return await loadNotebook(targetPath);
      }
      const result = await hostApi.readTextFile({ path: targetPath });
      if (!result?.ok) {
        const msg = result?.error || `File not found: ${targetPath}`;
        setStatus(msg);
        return false;
      }
      const revision = await readNotebookDiskRevision(targetPath);
      applyLoadedNotebookCells([{ type: getTextFileCellType(targetPath), source: formatTextFileForEditor(targetPath, result.text || "") }], targetPath, { revision });
      setStatus(`Opened ${getNotebookFilenameFromPath(targetPath)}`);
      postShellStatus(`Opened ${targetPath}`);
      return true;
    }
    if (!hostApi || typeof hostApi.readJsonFile !== "function") {
      if (isAbsoluteFilePath(targetPath)) {
        const msg = "Opening notebook files from disk requires the Arcode desktop app.";
        setStatus(msg);
        return false;
      }
      return await loadNotebook(targetPath);
    }
    const result = await hostApi.readJsonFile({ path: targetPath });
    if (!result || !result.exists) {
      const msg = result?.error || `File not found: ${targetPath}`;
      setStatus(msg);
      return false;
    }
    const loadedCells = normalizeNotebookData(result.data, targetPath);
    const unsupportedOutputCells = applyLoadedNotebookCells(loadedCells, targetPath, { revision: result.revision || null });
    if (unsupportedOutputCells > 0) {
      setStatus(`Opened ${getNotebookFilenameFromPath(targetPath)} (${unsupportedOutputCells} cells include unsupported rich outputs)`);
    } else {
      setStatus(`Opened ${getNotebookFilenameFromPath(targetPath)}`);
    }
    if (options.remember !== false) rememberLastOpenedIpynbPath(targetPath);
    postShellStatus(`Opened ${targetPath}`);
    return true;
  } catch {
    setStatus("Load failed");
    return false;
  }
}

async function saveCurrentNotebookFile({ closeDialog = true, ignoreRevisionConflict = false } = {}) {
  if (!currentNotebookPath) {
    return saveNotebookViaApi(currentNotebookFilename, { closeDialog });
  }

  const hostApi = getNotebookHostApi();
  const codeTextFile = isCodeTextFilePath(currentNotebookPath || currentNotebookFilename);
  const saveFnName = codeTextFile ? "saveTextFile" : "saveJsonFile";
  if (typeof hostApi?.[saveFnName] !== "function") {
    return saveNotebookViaApi(currentNotebookFilename, { closeDialog });
  }

  if (!ignoreRevisionConflict && lastNotebookDiskRevision) {
    let currentRevision = null;
    try {
      currentRevision = await readNotebookDiskRevision();
    } catch {
      currentRevision = null;
    }
    if (!currentRevision) {
      setNotebookDiskConflict(`${getNotebookDisplayTitle()} is no longer available on disk.`, "deleted");
      return false;
    }
    if (!sameRevision(currentRevision, lastNotebookDiskRevision)) {
      setNotebookDiskConflict(`${getNotebookDisplayTitle()} changed on disk. Resolve before saving.`, "changed");
      return false;
    }
  }

  try {
    const result = await hostApi[saveFnName]({
      path: currentNotebookPath,
      data: codeTextFile ? buildCodeTextFile(currentNotebookPath || currentNotebookFilename) : buildNotebookFileData(),
      filters: [
        { name: "Scripting Files", extensions: ["ipynb", "arcnb", "py", "sql", "md", "txt", "json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result?.error) {
      const msg = result.error || "Save failed";
      setStatus(msg);
      return false;
    }
    const savedPath = result?.path || currentNotebookPath;
    setCurrentNotebookFilename(savedPath);
    try {
      lastNotebookDiskRevision = await readNotebookDiskRevision(savedPath);
    } catch {
      lastNotebookDiskRevision = null;
    }
    markNotebookSavedBaseline(savedPath, lastNotebookDiskRevision);
    const savedName = getNotebookFilenameFromPath(savedPath);
    const msg = `Saved ${savedName}`;
    if (!codeTextFile) rememberLastOpenedIpynbPath(savedPath);
    setStatus(msg);
    postShellStatus(`${msg} (${savedPath})`);
    if (closeDialog) closeSaveNbDialog();
    return true;
  } catch {
    setStatus("Save failed");
    return false;
  }
}

async function saveNotebookByFilename(filename, { closeDialog = true } = {}) {
  if (currentNotebookPath && getNotebookFilenameFromPath(currentNotebookPath) === getNotebookFilenameFromPath(filename)) {
    return saveCurrentNotebookFile({ closeDialog });
  }
  return saveNotebookViaApi(filename, { closeDialog });
}

async function loadNotebook(filename) {
  try {
    const resp = await scriptingFetch("/scripting/load-notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    const result = await resp.json();
    if (!result.success) {
      setStatus(result.message || "Load failed");
      return false;
    }

    const loadedCells = Array.isArray(result.cells) ? result.cells : [];
    const openedPath = result.path || filename;
    let revision = null;
    try {
      revision = await readNotebookDiskRevision(openedPath);
    } catch {
      revision = null;
    }
    const unsupportedOutputCells = applyLoadedNotebookCells(loadedCells, openedPath, { revision });
    rememberLastOpenedIpynbPath(openedPath);

    closeOpenNbDialog();
    if (unsupportedOutputCells > 0) {
      setStatus(`Opened ${filename} (${unsupportedOutputCells} cells include unsupported rich outputs)`);
    } else {
      setStatus(`Opened ${filename}`);
    }
    return true;
  } catch {
    setStatus("Load failed");
    return false;
  }
}


// ---------------------------------------------------------------------------
// Persistence (localStorage)
// ---------------------------------------------------------------------------

function saveCellsToStorage() {
  try {
    const payload = getNotebookSavePayload();
    localStorage.setItem(CELLS_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
  updateNotebookDirtyState();
}

function parseStoredCells(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return null;

  // Backward compatibility: older saves used string[] only.
  return parsed.map((entry) => {
    if (typeof entry === "string") {
      return { type: CELL_TYPES.CODE, source: entry };
    }
    if (entry && typeof entry === "object") {
      const source = typeof entry.source === "string"
        ? entry.source
        : (typeof entry.code === "string" ? entry.code : "");
      const normalized = { type: normalizeCellType(entry.type), source };
      if (normalized.type === CELL_TYPES.CODE) {
        if (Number.isInteger(entry.execution_count)) normalized.execution_count = entry.execution_count;
        else if (Number.isInteger(entry.executionCount)) normalized.execution_count = entry.executionCount;
        normalized.outputs = normalizeIpynbOutputs(entry.outputs);
        const importOutput = entry.import_output && typeof entry.import_output === "object" && !Array.isArray(entry.import_output)
          ? cloneJsonValue(entry.import_output)
          : convertImportedOutputs(normalized.outputs);
        if (importOutput && Object.keys(importOutput).length) normalized.import_output = importOutput;
      }
      if (typeof entry.execution_time_ms === "number") normalized.execution_time_ms = entry.execution_time_ms;
      if (entry.exec_start_time) normalized.exec_start_time = entry.exec_start_time;
      if (entry.exec_end_time) normalized.exec_end_time = entry.exec_end_time;
      return normalized;
    }
    return { type: CELL_TYPES.CODE, source: "" };
  });
}

function loadCellsFromStorage() {
  const keys = [CELLS_STORAGE_KEY];
  if (CELLS_STORAGE_KEY !== LEGACY_CELLS_STORAGE_KEY) {
    keys.push(LEGACY_CELLS_STORAGE_KEY);
  }

  for (const key of keys) {
    try {
      const normalized = parseStoredCells(localStorage.getItem(key));
      if (normalized && normalized.length > 0) return normalized;
    } catch {
      // ignore malformed storage and continue fallback keys
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

// The Arcode shell status bar is the only status surface, so notebook messages
// go there instead of a second label inside the toolbar.
function setStatus(text) {
  postShellStatus(text);
}
