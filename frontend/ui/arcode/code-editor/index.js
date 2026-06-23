const shared = window.ArcodeEditorShared;
const params = new URLSearchParams(window.location.search);
const tabInstanceId = shared.sanitizeStorageId(params.get("inst") || "");
const scriptingSessionId = shared.getOrCreateScriptingSessionId();

let currentPath = String(params.get("path") || "").trim();
let editor = null;
let savedText = "";
let dirty = false;
let lastDiskRevision = null;
let diskConflict = "";
let autoSaveEnabled = true;
let autoSaveTimer = 0;
let revisionPollTimer = 0;
let isRunning = false;
let lineNumbersVisible = true;
let outputPanelHeight = 180;
const OUTPUT_PANEL_HIDE_THRESHOLD = 28;

const $ = (id) => document.getElementById(id);

const TEXT_FILE_FILTERS = [
  { name: "Code and Text Files", extensions: ["py", "r", "sql", "js", "ts", "json", "md", "txt", "css", "html"] },
  { name: "All Files", extensions: ["*"] },
];

function filename() {
  return shared.filenameFromPath(currentPath) || "Untitled";
}

function language() {
  return shared.languageFromPath(currentPath);
}

function isPythonFile() {
  return language() === "python";
}

function setStatus(text) {
  const value = String(text || "").trim() || "Ready";
  const el = $("statusText");
  if (el) el.textContent = value;
  shared.postStatus(value);
}

function updateTitle() {
  $("fileLabel").textContent = filename();
  shared.postTabTitle({ title: filename(), inst: tabInstanceId, path: currentPath });
}

function setDirty(nextDirty) {
  const value = !!nextDirty;
  if (dirty === value) return;
  dirty = value;
  shared.postDirty({ inst: tabInstanceId, dirty });
  scheduleAutoSave();
}

function updateDirtyFromEditor() {
  setDirty((editor?.getValue() || "") !== savedText);
}

function setOutput(text, { error = false, append = false } = {}) {
  const output = $("outputText");
  if (!output) return;
  output.classList.toggle("error", !!error);
  output.textContent = append ? `${output.textContent}${text}` : String(text || "");
  output.scrollTop = output.scrollHeight;
}

function getOutputPanelBounds() {
  const main = document.querySelector(".ce-main");
  const mainHeight = main?.getBoundingClientRect?.().height || window.innerHeight || 0;
  const min = 0;
  const max = Math.max(min, Math.floor(mainHeight - 190));
  return { min, max };
}

function applyOutputPanelHeight(height) {
  const panel = $("outputPanel");
  const handle = $("outputResizeHandle");
  if (!panel) return;
  const { min, max } = getOutputPanelBounds();
  const nextHeight = Number(height);
  const rawHeight = Number.isFinite(nextHeight) ? nextHeight : outputPanelHeight;
  const boundedHeight = Math.max(min, Math.min(max, Math.round(rawHeight)));
  const minVisibleHeight = Math.min(88, max);
  outputPanelHeight = boundedHeight <= OUTPUT_PANEL_HIDE_THRESHOLD ? 0 : Math.max(minVisibleHeight, boundedHeight);
  panel.style.setProperty("--ce-output-height", `${outputPanelHeight}px`);
  panel.classList.toggle("hidden", outputPanelHeight <= OUTPUT_PANEL_HIDE_THRESHOLD);
  handle?.setAttribute("aria-valuemin", String(min));
  handle?.setAttribute("aria-valuemax", String(max));
  handle?.setAttribute("aria-valuenow", String(outputPanelHeight));
  editor?.layout?.();
}

function initOutputPanelControls() {
  const panel = $("outputPanel");
  const handle = $("outputResizeHandle");
  if (!panel) return;

  const initialHeight = panel.getBoundingClientRect?.().height || outputPanelHeight;
  applyOutputPanelHeight(initialHeight);

  handle?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height || outputPanelHeight;
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add("ce-resizing-output");

    const move = (moveEvent) => {
      applyOutputPanelHeight(startHeight + startY - moveEvent.clientY);
    };
    const stop = (upEvent) => {
      if (handle.hasPointerCapture?.(upEvent.pointerId)) {
        handle.releasePointerCapture?.(upEvent.pointerId);
      }
      document.body.classList.remove("ce-resizing-output");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });

  handle?.addEventListener("keydown", (event) => {
    const { min, max } = getOutputPanelBounds();
    if (event.key === "ArrowUp") {
      event.preventDefault();
      applyOutputPanelHeight(outputPanelHeight <= OUTPUT_PANEL_HIDE_THRESHOLD ? 88 : outputPanelHeight + 12);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      applyOutputPanelHeight(outputPanelHeight - 12);
    } else if (event.key === "Home") {
      event.preventDefault();
      applyOutputPanelHeight(min);
    } else if (event.key === "End") {
      event.preventDefault();
      applyOutputPanelHeight(max);
    }
  });

  window.addEventListener("resize", () => {
    applyOutputPanelHeight(outputPanelHeight);
  });
}

function updateCommandState() {
  const canRun = isPythonFile();
  $("runBtn").disabled = !canRun || isRunning;
  $("runSelectionBtn").disabled = !canRun || isRunning;
  $("restartBtn").disabled = !canRun || isRunning;
  $("formatBtn").disabled = !editor;
  $("stopBtn").hidden = !isRunning;
}

function setRunning(nextRunning) {
  isRunning = !!nextRunning;
  updateCommandState();
}

function hideFileBanner() {
  diskConflict = "";
  $("fileBanner")?.classList.remove("open");
}

function showFileBanner(message, conflict = "changed") {
  diskConflict = conflict;
  const messageEl = $("fileBannerMessage");
  if (messageEl) messageEl.textContent = message;
  $("fileBanner")?.classList.add("open");
  setStatus("Changed on disk");
}

async function readDiskRevision(path = currentPath) {
  return shared.getFileRevision(path);
}

async function checkDiskForChanges({ force = false } = {}) {
  if (!currentPath) return;
  const revision = await readDiskRevision();
  if (!revision) {
    if (lastDiskRevision) showFileBanner(`${filename()} is no longer available on disk.`, "deleted");
    return;
  }
  if (!lastDiskRevision) {
    lastDiskRevision = revision;
    return;
  }
  if (!force && shared.sameRevision(revision, lastDiskRevision)) return;
  if (shared.sameRevision(revision, lastDiskRevision)) return;
  if (dirty) {
    showFileBanner(`${filename()} changed on disk while this tab has unsaved edits.`, "changed");
    return;
  }
  await openFilePath(currentPath, { source: "external" });
}

function startRevisionPolling() {
  clearInterval(revisionPollTimer);
  if (!currentPath) return;
  revisionPollTimer = setInterval(() => {
    void checkDiskForChanges();
  }, 3000);
}

function markSavedBaseline(path, text, revision) {
  currentPath = String(path || currentPath || "").trim();
  savedText = String(text ?? editor?.getValue() ?? "");
  lastDiskRevision = revision || null;
  hideFileBanner();
  updateTitle();
  setDirty(false);
  startRevisionPolling();
}

function setEditorText(text, { path = currentPath, revision = null } = {}) {
  const value = String(text ?? "");
  currentPath = String(path || "").trim();
  if (editor) {
    editor.setValue(value);
    const model = editor.getModel();
    if (model && window.monaco?.editor?.setModelLanguage) {
      window.monaco.editor.setModelLanguage(model, language());
    }
  }
  markSavedBaseline(currentPath, value, revision);
  updateCommandState();
}

async function openFilePath(path, { source = "manual" } = {}) {
  const filePath = String(path || "").trim();
  if (!filePath) return false;
  const result = await shared.readTextFile(filePath);
  if (!result?.ok) {
    const message = result?.error || `Could not open ${filePath}.`;
    setStatus(message);
    shared.postStatus(message);
    return false;
  }
  setEditorText(result.text || "", { path: result.path || filePath, revision: result.revision || null });
  const label = shared.filenameFromPath(result.path || filePath);
  setStatus(source === "external" ? `Reloaded ${label}` : `Opened ${label}`);
  return true;
}

function suggestedSaveName(copy = false) {
  const name = filename();
  if (!copy) return name === "Untitled" ? "script.py" : name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}.copy`;
  return `${name.slice(0, dot)}.copy${name.slice(dot)}`;
}

async function saveCurrentFile({ saveAs = false, ignoreRevisionConflict = false, source = "manual", copy = false } = {}) {
  const text = editor?.getValue() || "";
  const targetPath = saveAs || copy ? "" : currentPath;

  if (currentPath && !ignoreRevisionConflict && !saveAs && !copy && lastDiskRevision) {
    const revision = await readDiskRevision();
    if (!revision) {
      showFileBanner(`${filename()} is no longer available on disk.`, "deleted");
      return false;
    }
    if (!shared.sameRevision(revision, lastDiskRevision)) {
      showFileBanner(`${filename()} changed on disk. Resolve before saving.`, "changed");
      return false;
    }
  }

  const result = await shared.saveTextFile({
    path: targetPath,
    data: text,
    filters: TEXT_FILE_FILTERS,
    suggestedName: suggestedSaveName(copy),
    startDir: shared.directoryFromPath(currentPath),
  });

  if (result?.canceled) return false;
  if (result?.error) {
    setStatus(result.error || "Save failed");
    return false;
  }
  const savedPath = result?.path || currentPath;
  const revision = await readDiskRevision(savedPath);
  if (!copy) {
    markSavedBaseline(savedPath, text, revision);
  }
  setStatus(source === "auto" ? `Auto-saved ${shared.filenameFromPath(savedPath)}` : `Saved ${shared.filenameFromPath(savedPath)}`);
  return true;
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  if (!autoSaveEnabled || !dirty || diskConflict || !currentPath) return;
  autoSaveTimer = setTimeout(() => {
    void saveCurrentFile({ source: "auto" });
  }, 1500);
}

function formatDocument() {
  if (!editor) return;
  if (language() === "json") {
    const raw = editor.getValue();
    try {
      editor.setValue(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      setStatus("Formatted JSON");
    } catch {
      setStatus("JSON is not valid");
    }
    return;
  }
  const action = editor.getAction?.("editor.action.formatDocument");
  if (action) {
    void action.run().then(() => setStatus("Formatted")).catch(() => setStatus("No formatter available"));
  }
}

function selectedTextOrAll() {
  if (!editor) return "";
  const selection = editor.getSelection();
  const model = editor.getModel();
  const selected = selection && model ? model.getValueInRange(selection) : "";
  return selected.trim() ? selected : editor.getValue();
}

function serializeRange(range) {
  if (!range) return null;
  return {
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn,
  };
}

function getSelectedTextContext() {
  if (!editor) return { text: "", selection: null, selectionOnly: false };
  const model = editor.getModel();
  const selection = editor.getSelection();
  const selected = selection && model ? model.getValueInRange(selection) : "";
  if (!selected.trim()) {
    return { text: editor.getValue(), selection: null, selectionOnly: false };
  }
  return {
    text: selected,
    selection: serializeRange(selection),
    selectionOnly: true,
  };
}

async function runPython(code) {
  const source = String(code || "").trim();
  if (!source || !isPythonFile() || isRunning) return;
  const started = performance.now();
  setRunning(true);
  setOutput("");
  $("runInfo").textContent = "Running";
  setStatus("Running...");
  let donePayload = null;

  try {
    const response = await shared.scriptingFetch("/scripting/run-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: source }),
    }, scriptingSessionId);

    if (!response.ok || !response.body || typeof response.body.getReader !== "function") {
      const fallback = await shared.scriptingFetch("/scripting/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: source }),
      }, scriptingSessionId).then((r) => r.json());
      if (fallback.output) setOutput(fallback.output, { append: true });
      if (fallback.error) setOutput(fallback.error, { append: true, error: true });
      donePayload = fallback;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    function consumeLine(line) {
      const payload = String(line || "").trim();
      if (!payload) return;
      let event = null;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (event.type === "stdout") setOutput(event.text || "", { append: true });
      if (event.type === "stderr") setOutput(event.text || "", { append: true, error: true });
      if (event.type === "done") donePayload = event;
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let splitAt = buffered.indexOf("\n");
      while (splitAt >= 0) {
        consumeLine(buffered.slice(0, splitAt));
        buffered = buffered.slice(splitAt + 1);
        splitAt = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    buffered.split("\n").forEach(consumeLine);
  } catch (err) {
    donePayload = { success: false, error: String(err?.message || err) };
    setOutput(`Network error: ${String(err?.message || err)}`, { error: true });
  } finally {
    const elapsed = Math.max(1, Math.round(performance.now() - started));
    $("runInfo").textContent = `${elapsed} ms`;
    setStatus(donePayload?.success === false ? "Error" : "Done");
    setRunning(false);
  }
}

async function restartSession() {
  if (!isPythonFile() || isRunning) return;
  try {
    await shared.scriptingFetch("/scripting/reset", { method: "POST" }, scriptingSessionId);
    setOutput("");
    setStatus("Session restarted");
  } catch {
    setStatus("Restart failed");
  }
}

async function interruptExecution() {
  try {
    await shared.scriptingFetch("/scripting/interrupt", { method: "POST" }, scriptingSessionId);
    setStatus("Interrupt sent");
  } catch {
    setStatus("Interrupt failed");
  }
}

function buildAssistantContext() {
  const selected = getSelectedTextContext();
  return {
    available: true,
    tabType: "code-editor",
    pageType: "code-editor",
    title: filename(),
    targetPath: currentPath || "",
    path: currentPath || "",
    dirty,
    autoSaveEnabled,
    fileState: diskConflict ? "changed-on-disk" : (dirty ? "unsaved-changes" : "saved"),
    language: language(),
    text: selected.text,
    fullText: editor?.getValue() || "",
    selection: selected.selection,
    selectionOnly: selected.selectionOnly,
  };
}

function initEditor() {
  return new Promise((resolve) => {
    window.require.config({ paths: { vs: "/ui/libs/monaco-editor/min/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      editor = window.monaco.editor.create($("editorHost"), {
        value: "",
        language: language(),
        theme: "vs",
        fontSize: 13,
        fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
        minimap: { enabled: false },
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        tabSize: 4,
        insertSpaces: true,
        automaticLayout: true,
        renderWhitespace: "selection",
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
      });
      editor.onDidChangeModelContent(updateDirtyFromEditor);
      resolve();
    });
  });
}

function initEvents() {
  $("saveBtn")?.addEventListener("click", () => void saveCurrentFile());
  $("saveAsBtn")?.addEventListener("click", () => void saveCurrentFile({ saveAs: true }));
  $("runBtn")?.addEventListener("click", () => void runPython(editor?.getValue() || ""));
  $("runSelectionBtn")?.addEventListener("click", () => void runPython(selectedTextOrAll()));
  $("stopBtn")?.addEventListener("click", () => void interruptExecution());
  $("restartBtn")?.addEventListener("click", () => void restartSession());
  $("formatBtn")?.addEventListener("click", formatDocument);
  $("clearOutputBtn")?.addEventListener("click", () => {
    setOutput("");
    $("runInfo").textContent = "";
  });
  $("reloadDiskBtn")?.addEventListener("click", () => void openFilePath(currentPath));
  $("saveCopyBtn")?.addEventListener("click", () => void saveCurrentFile({ copy: true }));
  $("overwriteDiskBtn")?.addEventListener("click", () => void saveCurrentFile({ ignoreRevisionConflict: true }));

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "arcode:scripting-open-path") {
      void openFilePath(msg.path || "");
      return;
    }
    if (msg.type === "arcode:scripting-save") {
      void saveCurrentFile();
      return;
    }
    if (msg.type === "arcode:scripting-save-as") {
      void saveCurrentFile({ saveAs: true });
      return;
    }
    if (msg.type === "arcode:scripting-toggle-line-numbers") {
      lineNumbersVisible = !lineNumbersVisible;
      editor?.updateOptions({ lineNumbers: lineNumbersVisible ? "on" : "off" });
      setStatus(lineNumbersVisible ? "Line numbers shown" : "Line numbers hidden");
      return;
    }
    if (msg.type === "arcode:autosave-toggle") {
      autoSaveEnabled = !!msg.enabled;
      scheduleAutoSave();
      return;
    }
    if (msg.type === "arcode:set-zoom") {
      window.ArcodeZoomBridge?.applyPageZoomValue?.(Number(msg.zoom) || 100, Number(msg.statusBarHeight) || 28);
      return;
    }
    if (msg.type === "arcode:assistant-context-request") {
      shared.postParentMessage({
        type: "arcode:assistant-context-result",
        requestId: msg.requestId || "",
        context: buildAssistantContext(),
      });
      return;
    }
    if (msg.type === "arcode:assistant-replace-text") {
      const requestId = msg.requestId || "";
      if (!editor) {
        shared.postParentMessage({
          type: "arcode:assistant-replace-text-result",
          requestId,
          ok: false,
          error: "The editor is not ready.",
        });
        return;
      }
      const model = editor.getModel();
      const range = msg.range || msg.selection || null;
      if (range && model && window.monaco?.Range) {
        const rangeValues = [
          Number(range.startLineNumber),
          Number(range.startColumn),
          Number(range.endLineNumber),
          Number(range.endColumn),
        ];
        if (!rangeValues.every(Number.isFinite)) {
          shared.postParentMessage({
            type: "arcode:assistant-replace-text-result",
            requestId,
            ok: false,
            error: "The selected SQL range is no longer valid. Run the skill again before applying.",
          });
          return;
        }
        const monacoRange = new window.monaco.Range(
          rangeValues[0],
          rangeValues[1],
          rangeValues[2],
          rangeValues[3],
        );
        const currentSelectionText = model.getValueInRange(monacoRange);
        if (typeof msg.expectedText === "string" && msg.expectedText !== currentSelectionText) {
          shared.postParentMessage({
            type: "arcode:assistant-replace-text-result",
            requestId,
            ok: false,
            error: "The selected SQL changed after the review opened. Run the skill again before applying.",
          });
          return;
        }
        editor.executeEdits("arcbot-sql-format", [{ range: monacoRange, text: String(msg.text ?? ""), forceMoveMarkers: true }]);
      } else {
        const current = editor.getValue() || "";
        if (typeof msg.expectedText === "string" && msg.expectedText !== current) {
          shared.postParentMessage({
            type: "arcode:assistant-replace-text-result",
            requestId,
            ok: false,
            error: "The editor changed after the SQL review opened. Run the skill again before applying.",
          });
          return;
        }
        editor.setValue(String(msg.text ?? ""));
      }
      updateDirtyFromEditor();
      setStatus(range ? "Applied ArcBot SQL formatting to selection." : "Applied ArcBot SQL formatting.");
      shared.postParentMessage({
        type: "arcode:assistant-replace-text-result",
        requestId,
        ok: true,
        dirty,
      });
    }
  });

  window.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "s") {
      event.preventDefault();
      void saveCurrentFile({ saveAs: event.shiftKey });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "enter") {
      event.preventDefault();
      void runPython(event.shiftKey ? selectedTextOrAll() : editor?.getValue() || "");
    }
  }, true);
}

async function boot() {
  window.ArcodeZoomBridge?.wirePageZoomBridge();
  await initEditor();
  initOutputPanelControls();
  initEvents();
  updateTitle();
  if (currentPath) await openFilePath(currentPath);
  else setEditorText("", { path: "" });
  updateCommandState();
}

void boot();
