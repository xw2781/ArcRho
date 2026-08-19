/**
 * Generic Arcode editor page runtime.
 *
 * Every Arcode editor surface that is "one Monaco editor plus a bottom panel"
 * is this module: the plain code editor, the Snowflake SQL editor, and the SQL
 * Server SQL editor. It owns the page chrome (command strip, disk-conflict
 * banner, editor host, resizable bottom panel), file open/save/revision
 * tracking, dirty and title reporting to the shell, the run/stop/restart
 * commands, the ArcBot context and replacement contract, and the shell
 * messages every editor page answers.
 *
 * A page supplies only a mode descriptor: what language it edits, what Run
 * does, what Restart does, and any extra controls its engine needs. No page
 * restates the chrome markup, the file lifecycle, or the assistant contract.
 */

const shared = window.ArcodeEditorShared;

/**
 * Toolbar glyphs, in the JupyterLab idiom: an outlined play triangle for Run, a
 * square for Stop, and a circular arrow for Restart. Defined once here so all
 * three editor pages carry the same command iconography.
 */
export const TOOLBAR_ICONS = {
  run: '<path d="M7 4.5 19 12 7 19.5Z"></path>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"></rect>',
  restart: '<path d="M20 12a8 8 0 1 1-8-8c2.24 0 4.38.94 5.99 2.44L20 8.5"></path><path d="M20 3.5v5h-5"></path>',
  clear: '<path d="M5 7h14"></path><path d="M9 7V5h6v2"></path><path d="M7 7l1 12h8l1-12"></path>',
};

const OUTPUT_PANEL_HIDE_THRESHOLD = 28;

function iconMarkup(name) {
  const glyph = TOOLBAR_ICONS[name] || "";
  return `<svg class="ce-btn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${glyph}</svg>`;
}

/** A labeled command button with its glyph, so every page draws them alike. */
function commandButton({ id, label, icon, variant = "", hidden = false, title = "" }) {
  const classes = ["ce-btn", "ce-icon-btn", variant].filter(Boolean).join(" ");
  return `
    <button class="${classes}" id="${id}" type="button"${hidden ? " hidden" : ""}${title ? ` title="${title}"` : ""}>
      ${iconMarkup(icon)}<span class="ce-btn-label">${label}</span>
    </button>`;
}

function renderChrome(mode) {
  const restart = mode.restart || null;
  return `
    <main class="ce-app">
      <header class="ce-toolbar">
        <div class="ce-toolbar-lead" id="toolbarLead"></div>
        ${commandButton({ id: "runBtn", label: mode.runLabel || "Run", icon: "run", variant: "primary" })}
        ${commandButton({ id: "stopBtn", label: "Stop", icon: "stop", variant: "danger", hidden: true })}
        ${restart ? commandButton({ id: "restartBtn", label: restart.label || "Restart", icon: "restart", title: restart.title || "" }) : ""}
        <div class="ce-toolbar-trail" id="toolbarTrail"></div>
      </header>

      <div class="ce-context-bar" id="contextBar" hidden></div>

      <div class="ce-file-banner" id="fileBanner" role="status" aria-live="polite">
        <span class="ce-file-banner-message" id="fileBannerMessage"></span>
        <span class="ce-file-banner-actions">
          <button class="ce-btn" id="reloadDiskBtn" type="button">Reload</button>
          <button class="ce-btn" id="saveCopyBtn" type="button">Save Copy</button>
          <button class="ce-btn primary" id="overwriteDiskBtn" type="button">Overwrite</button>
        </span>
      </div>

      <section class="ce-body">
        <div class="ce-main">
          <div id="editorHost" class="ce-editor-host" aria-label="Code editor"></div>
          <section class="ce-output-panel" id="outputPanel" aria-label="${mode.panelTitle || "Output"}">
            <div
              class="ce-output-resize-handle"
              id="outputResizeHandle"
              role="separator"
              aria-label="Resize ${(mode.panelTitle || "Output").toLowerCase()} panel"
              aria-orientation="horizontal"
              tabindex="0"
            ></div>
            <div class="ce-panel-header">
              <span class="ce-panel-title">${mode.panelTitle || "Output"}</span>
              <span id="runInfo" class="ce-run-info"></span>
              <button class="ce-panel-btn" id="clearOutputBtn" type="button" title="Clear ${mode.panelTitle || "Output"}" aria-label="Clear ${mode.panelTitle || "Output"}">
                <svg viewBox="0 0 24 24" aria-hidden="true">${TOOLBAR_ICONS.clear}</svg>
              </button>
            </div>
            <div class="ce-panel-body" id="panelBody">
              <pre id="outputText" class="ce-output-text"></pre>
            </div>
          </section>
        </div>
      </section>
    </main>`;
}

export function createEditorPage(mode) {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const tabInstanceId = shared.sanitizeStorageId(params.get("inst") || "");

  let currentPath = String(params.get("path") || "").trim();
  let editor = null;
  let savedText = "";
  let dirty = false;
  let lastDiskRevision = null;
  let diskConflict = "";
  let revisionPollTimer = 0;
  let isRunning = false;
  let runningMode = "";
  let lineNumbersVisible = true;
  let outputPanelHeight = 180;
  const messageHandlers = [];

  function filename() {
    return shared.filenameFromPath(currentPath) || mode.defaultTitle || "Untitled";
  }

  function language() {
    return typeof mode.language === "function"
      ? mode.language(currentPath)
      : (mode.language || shared.languageFromPath(currentPath));
  }

  function setStatus(text) {
    const value = String(text || "").trim() || "Ready";
    shared.postStatus(value);
  }

  function updateTitle() {
    shared.postTabTitle({ title: filename(), inst: tabInstanceId, path: currentPath });
  }

  function setDirty(nextDirty) {
    const value = !!nextDirty;
    if (dirty === value) return;
    dirty = value;
    shared.postDirty({ inst: tabInstanceId, dirty });
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

  function setRunInfo(text) {
    const info = $("runInfo");
    if (info) info.textContent = String(text || "");
  }

  /** Replace the panel body, so a mode can show a results grid instead of text. */
  function setPanelBody(html) {
    const body = $("panelBody");
    if (body) body.innerHTML = html;
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

  function canRun() {
    return typeof mode.canRun === "function" ? !!mode.canRun(api) : true;
  }

  /**
   * Run acts on the selection when there is one, so the button says which it
   * will be. The label stays put; only the tooltip changes, so the command
   * strip does not reflow as the caret moves.
   */
  function updateRunAffordance() {
    const runBtn = $("runBtn");
    if (!runBtn) return;
    const selectionOnly = getSelectionContext().selectionOnly;
    runBtn.title = selectionOnly
      ? `${mode.runLabel || "Run"} the selected code (Ctrl+Enter)`
      : `${mode.runLabel || "Run"} (Ctrl+Enter)`;
    runBtn.classList.toggle("selectionScoped", selectionOnly);
  }

  function updateCommandState() {
    const runnable = canRun();
    const runBtn = $("runBtn");
    if (runBtn) runBtn.disabled = !runnable || isRunning;
    updateRunAffordance();
    const restartBtn = $("restartBtn");
    if (restartBtn) restartBtn.disabled = !runnable || isRunning;
    const stopBtn = $("stopBtn");
    if (stopBtn) stopBtn.hidden = !isRunning || runningMode !== "local";
    mode.onCommandState?.(api);
  }

  function setRunning(nextRunning, runMode = "local") {
    isRunning = !!nextRunning;
    runningMode = isRunning ? String(runMode || "local") : "";
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

  async function checkDiskForChanges() {
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
      return false;
    }
    setEditorText(result.text || "", { path: result.path || filePath, revision: result.revision || null });
    const label = shared.filenameFromPath(result.path || filePath);
    setStatus(source === "external" ? `Reloaded ${label}` : `Opened ${label}`);
    return true;
  }

  function suggestedSaveName(copy = false) {
    const name = filename();
    const fallback = mode.suggestedFileName || "script.py";
    if (!copy) return shared.filenameFromPath(currentPath) ? name : fallback;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return `${name}.copy`;
    return `${name.slice(0, dot)}.copy${name.slice(dot)}`;
  }

  async function saveCurrentFile({ saveAs = false, ignoreRevisionConflict = false, copy = false } = {}) {
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
      filters: mode.fileFilters,
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
    setStatus(`Saved ${shared.filenameFromPath(savedPath)}`);
    return true;
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

  /**
   * What Run and ArcBot act on: the selection when the user made one, and the
   * whole document otherwise. One selection rule for every editor page.
   */
  function getSelectionContext() {
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

  async function runNow() {
    if (isRunning || !canRun()) return;
    const context = getSelectionContext();
    await mode.run({ code: context.text, selectionOnly: context.selectionOnly, page: api });
  }

  async function restartNow() {
    if (isRunning || !mode.restart) return;
    await mode.restart.run(api);
  }

  function buildAssistantContext() {
    const selected = getSelectionContext();
    return {
      available: true,
      tabType: mode.tabType || mode.id,
      pageType: mode.pageType,
      title: filename(),
      targetPath: currentPath || "",
      path: currentPath || "",
      dirty,
      fileState: diskConflict ? "changed-on-disk" : (dirty ? "unsaved-changes" : "saved"),
      language: language(),
      text: selected.text,
      fullText: editor?.getValue() || "",
      selection: selected.selection,
      selectionOnly: selected.selectionOnly,
      ...(mode.assistantContext?.(api) || {}),
    };
  }

  function initEditor() {
    return new Promise((resolve) => {
      window.require.config({ paths: { vs: "/ui/libs/monaco-editor/min/vs" } });
      window.require(["vs/editor/editor.main"], () => {
        const monacoTheme = window.ArcRhoColorTheme?.getMonacoTheme?.() || "vs";
        editor = window.monaco.editor.create($("editorHost"), {
          value: "",
          language: language(),
          theme: monacoTheme,
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
        editor.onDidChangeCursorSelection?.(updateRunAffordance);
        resolve();
      });
    });
  }

  function replyAssistant(requestId, payload) {
    shared.postParentMessage({
      type: "arcode:assistant-replace-text-result",
      requestId: requestId || "",
      ...payload,
    });
  }

  /**
   * ArcBot replacement contract. The reviewed text must still be the text on
   * screen, so every stale case is refused with a sentence the user can act on.
   */
  function handleAssistantReplaceText(msg) {
    const requestId = msg.requestId || "";
    if (
      typeof msg.expectedTargetPath === "string"
      && msg.expectedTargetPath !== (currentPath || "")
    ) {
      replyAssistant(requestId, {
        ok: false,
        error: "The reviewed SQL file is no longer active. Run the skill again before applying.",
      });
      return;
    }
    if (!editor) {
      replyAssistant(requestId, { ok: false, error: "The editor is not ready." });
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
        replyAssistant(requestId, {
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
        replyAssistant(requestId, {
          ok: false,
          error: "The selected SQL changed after the review opened. Run the skill again before applying.",
        });
        return;
      }
      editor.executeEdits("arcbot-sql-format", [{ range: monacoRange, text: String(msg.text ?? ""), forceMoveMarkers: true }]);
    } else {
      const current = editor.getValue() || "";
      if (typeof msg.expectedText === "string" && msg.expectedText !== current) {
        replyAssistant(requestId, {
          ok: false,
          error: "The editor changed after the SQL review opened. Run the skill again before applying.",
        });
        return;
      }
      editor.setValue(String(msg.text ?? ""));
    }
    updateDirtyFromEditor();
    setStatus(range ? "Applied ArcBot SQL formatting to selection." : "Applied ArcBot SQL formatting.");
    replyAssistant(requestId, { ok: true, dirty });
  }

  function initEvents() {
    $("runBtn")?.addEventListener("click", () => void runNow());
    $("stopBtn")?.addEventListener("click", () => void mode.stop?.(api));
    $("restartBtn")?.addEventListener("click", () => void restartNow());
    $("clearOutputBtn")?.addEventListener("click", () => {
      if (mode.clearPanel) mode.clearPanel(api);
      else setOutput("");
      setRunInfo("");
    });
    $("reloadDiskBtn")?.addEventListener("click", () => void openFilePath(currentPath));
    $("saveCopyBtn")?.addEventListener("click", () => void saveCurrentFile({ copy: true }));
    $("overwriteDiskBtn")?.addEventListener("click", () => void saveCurrentFile({ ignoreRevisionConflict: true }));

    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      // Both the code editor and the SQL editors answer the same open message;
      // the shell keeps the older SQL name for compatibility.
      if (msg.type === "arcode:scripting-open-path" || msg.type === "arcode:sql-console-open-path") {
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
        handleAssistantReplaceText(msg);
        return;
      }
      for (const handler of messageHandlers) handler(msg);
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
        void runNow();
      }
    }, true);
  }

  const api = {
    get editor() { return editor; },
    get path() { return currentPath; },
    get dirty() { return dirty; },
    get running() { return isRunning; },
    filename,
    language,
    setStatus,
    setOutput,
    setRunInfo,
    setPanelBody,
    setRunning,
    setEditorText,
    updateCommandState,
    updateDirtyFromEditor,
    getSelectionContext,
    openFilePath,
    saveCurrentFile,
    runNow,
    onMessage: (handler) => { if (typeof handler === "function") messageHandlers.push(handler); },
    $,
  };

  async function boot() {
    // The page markup lives here, not in each editor document, so all three
    // editor pages carry the same command strip, banner, and panel.
    const root = $("editorRoot") || document.body;
    root.innerHTML = renderChrome(mode);
    window.ArcodeZoomBridge?.wirePageZoomBridge();
    await initEditor();
    initOutputPanelControls();
    initEvents();
    updateTitle();
    await mode.onReady?.(api);
    if (currentPath) await openFilePath(currentPath);
    else setEditorText("", { path: "" });
    updateCommandState();
  }

  api.boot = boot;
  return api;
}
