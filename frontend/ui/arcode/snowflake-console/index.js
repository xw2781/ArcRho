import {
  inferSqlDialect,
  isSqlFormatPreviewCurrent,
  isSqlFormatTargetCurrent,
  requestSqlFormatPreview,
} from "../../ai-assistant/skills.js?v=20260726a";

const API_BASE = "";
const urlParams = new URLSearchParams(window.location.search);
let currentPath = String(urlParams.get("path") || "").trim();
let editor = null;
let savedText = "";
let dirty = false;
let isFormattingSql = false;
let connections = {};
let activeConnection = "";

const $ = (id) => document.getElementById(id);

function getHostApi() {
  return window.ADAHost || window.parent?.ADAHost || window.top?.ADAHost || null;
}

function filenameFromPath(pathLike) {
  const normalized = String(pathLike || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function setStatus(text) {
  const value = String(text || "").trim() || "Ready";
  const el = $("statusText");
  if (el) el.textContent = value;
  try {
    window.parent?.postMessage({ type: "arcode:status", text: value }, "*");
  } catch {
    // Parent may be unavailable in browser fallback mode.
  }
}

function postTitle() {
  try {
    window.parent?.postMessage({
      type: "arcode:update-active-tab-title",
      title: filenameFromPath(currentPath) || "Snowflake SQL",
      path: currentPath,
    }, "*");
  } catch {
    // ignore
  }
}

function setDirty(nextDirty) {
  dirty = !!nextDirty;
  try {
    window.parent?.postMessage({ type: "arcode:scripting-dirty", dirty }, "*");
  } catch {
    // ignore
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Request failed: ${response.status}`);
  return payload;
}

function renderConnectionDetails() {
  const profile = connections[activeConnection] || {};
  $("roleChip").textContent = `Role: ${profile.role || "-"}`;
  $("warehouseChip").textContent = `Warehouse: ${profile.warehouse || "-"}`;
  $("databaseChip").textContent = `Database: ${profile.database || "-"}`;
  $("schemaChip").textContent = `Schema: ${profile.schema || profile.schema_name || "-"}`;
}

function renderConnections() {
  const select = $("connectionSelect");
  if (!select) return;
  select.textContent = "";
  const names = Object.keys(connections);
  if (!names.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No connections";
    select.appendChild(option);
    renderConnectionDetails();
    return;
  }
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
  if (!activeConnection || !connections[activeConnection]) activeConnection = names[0];
  select.value = activeConnection;
  renderConnectionDetails();
}

async function loadConnections() {
  try {
    const result = await fetchJson("/snowflake/connections");
    connections = result?.connections && typeof result.connections === "object" ? result.connections : {};
    activeConnection = result?.defaultConnection || Object.keys(connections)[0] || "";
    renderConnections();
    if (!result?.connectorAvailable) {
      setStatus("Snowflake connector is not installed in this runtime.");
    }
  } catch (err) {
    setStatus(`Could not load Snowflake connections: ${String(err?.message || err)}`);
  }
}

function setEditorText(text) {
  const value = String(text || "");
  if (editor) {
    editor.setValue(value);
  }
  savedText = value;
  setDirty(false);
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

function buildAssistantContext() {
  const selected = getSelectedTextContext();
  return {
    available: true,
    tabType: "snowflake",
    pageType: "snowflake",
    title: filenameFromPath(currentPath) || "Snowflake SQL",
    targetPath: currentPath || "",
    path: currentPath || "",
    dirty,
    fileState: dirty ? "unsaved-changes" : "saved",
    language: "sql",
    sqlDialect: inferSqlDialect({ pageType: "snowflake" }),
    text: selected.text,
    fullText: editor?.getValue() || "",
    selection: selected.selection,
    selectionOnly: selected.selectionOnly,
  };
}

async function loadSqlFile(pathLike) {
  const path = String(pathLike || "").trim();
  if (!path) return;
  currentPath = path;
  postTitle();
  const host = getHostApi();
  if (!host || typeof host.readTextFile !== "function") {
    setStatus("Opening SQL files requires the desktop app host.");
    return;
  }
  try {
    const result = await host.readTextFile({ path });
    if (!result?.ok) throw new Error(result?.error || "Could not read file.");
    setEditorText(result.text || "");
    setStatus(`Opened ${filenameFromPath(path)}.`);
  } catch (err) {
    setStatus(`Open failed: ${String(err?.message || err)}`);
  }
}

async function saveSqlFile() {
  if (!currentPath) {
    setStatus("No SQL file path is available.");
    return false;
  }
  const host = getHostApi();
  if (!host || typeof host.saveTextFile !== "function") {
    setStatus("Saving SQL files requires the desktop app host.");
    return false;
  }
  const text = editor?.getValue() || "";
  try {
    const result = await host.saveTextFile({ path: currentPath, data: text });
    if (result?.error) throw new Error(result.error);
    savedText = text;
    setDirty(false);
    postTitle();
    setStatus(`Saved ${filenameFromPath(currentPath)}.`);
    return true;
  } catch (err) {
    setStatus(`Save failed: ${String(err?.message || err)}`);
    return false;
  }
}

function renderMessage(message, { error = false } = {}) {
  const box = $("messageBox");
  const wrap = $("tableWrap");
  if (wrap) wrap.textContent = "";
  if (!box) return;
  box.classList.toggle("error", !!error);
  box.style.display = "block";
  box.textContent = message;
}

function renderResults(result) {
  const box = $("messageBox");
  const wrap = $("tableWrap");
  const info = $("queryInfo");
  if (info) {
    const parts = [];
    if (result?.queryId) parts.push(`Query ${result.queryId}`);
    if (typeof result?.rowCount === "number") parts.push(`${result.rowCount} row${result.rowCount === 1 ? "" : "s"}`);
    if (result?.truncated) parts.push("truncated");
    info.textContent = parts.join(" | ");
  }
  if (!result?.ok) {
    renderMessage(result?.error || "Query failed.", { error: true });
    return;
  }
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (!columns.length) {
    renderMessage("Query completed with no result set.");
    return;
  }
  if (box) box.style.display = "none";
  if (!wrap) return;
  wrap.innerHTML = `
    <table class="sfTable">
      <thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>${columns.map((_, index) => `<td title="${escapeHtml(row?.[index])}">${escapeHtml(row?.[index])}</td>`).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function runQuery() {
  const sql = editor?.getValue() || "";
  if (!sql.trim()) {
    renderMessage("SQL is empty.", { error: true });
    return;
  }
  setStatus("Running Snowflake query...");
  $("runBtn").disabled = true;
  try {
    const result = await fetchJson("/snowflake/query", {
      method: "POST",
      body: JSON.stringify({ sql, connection: activeConnection, limit: 1000 }),
    });
    renderResults(result);
    setStatus(result?.ok ? "Query completed." : "Query failed.");
  } catch (err) {
    renderMessage(String(err?.message || err), { error: true });
    setStatus("Query failed.");
  } finally {
    $("runBtn").disabled = false;
  }
}

async function testConnection() {
  setStatus("Testing Snowflake connection...");
  $("testConnectionBtn").disabled = true;
  try {
    const result = await fetchJson("/snowflake/test-connection", {
      method: "POST",
      body: JSON.stringify({ sql: "select 1", connection: activeConnection, limit: 1 }),
    });
    renderResults(result);
    setStatus(result?.ok ? "Connection test completed." : "Connection test failed.");
  } catch (err) {
    renderMessage(String(err?.message || err), { error: true });
    setStatus("Connection test failed.");
  } finally {
    $("testConnectionBtn").disabled = false;
  }
}

async function formatSqlDocument() {
  if (isFormattingSql) return;
  const sourceText = editor?.getValue() || "";
  const sourcePath = currentPath;
  const sourceModel = editor?.getModel();
  if (!sourceText.trim()) {
    setStatus("SQL is empty.");
    return;
  }
  const dialect = inferSqlDialect({ pageType: "snowflake" });
  const button = $("formatBtn");
  isFormattingSql = true;
  if (button) {
    button.disabled = true;
    button.textContent = "Formatting...";
    button.setAttribute("aria-busy", "true");
  }
  setStatus("Formatting Snowflake SQL...");
  try {
    const preview = await requestSqlFormatPreview({ sql: sourceText, dialect });
    if (!preview.safety.safe_to_apply) {
      const diagnostic = preview.diagnostics.find((entry) => entry && typeof entry.message === "string");
      setStatus(diagnostic?.message || "SQL formatting was blocked by a safety check.");
      return;
    }
    const previewMatchesSource = await isSqlFormatPreviewCurrent(preview, sourceText);
    const sourceIsCurrent = isSqlFormatTargetCurrent({
      previewMatchesSource,
      sourceText,
      currentText: editor?.getValue() || "",
      sourcePath,
      currentPath,
      sourceModel,
      currentModel: editor?.getModel(),
    });
    if (!sourceIsCurrent) {
      setStatus("SQL changed while formatting. Run Format again.");
      return;
    }
    if (!preview.changed) {
      setStatus("Snowflake SQL formatting is already clean.");
      return;
    }
    const model = editor?.getModel();
    if (!model) {
      setStatus("The editor is not ready.");
      return;
    }
    editor.pushUndoStop?.();
    editor.executeEdits("arcode-sql-format-toolbar", [{
      range: model.getFullModelRange(),
      text: preview.formatted_sql,
      forceMoveMarkers: true,
    }]);
    editor.pushUndoStop?.();
    setDirty((editor.getValue() || "") !== savedText);
    setStatus("Formatted Snowflake SQL.");
  } catch (error) {
    setStatus(`SQL formatting failed: ${String(error?.message || error)}`);
  } finally {
    isFormattingSql = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Format";
      button.setAttribute("aria-busy", "false");
    }
  }
}

function initEditor() {
  return new Promise((resolve) => {
    window.require.config({ paths: { vs: "/ui/libs/monaco-editor/min/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      const monacoTheme = window.ArcRhoColorTheme?.getMonacoTheme?.() || "vs";
      editor = window.monaco.editor.create($("editorHost"), {
        value: "",
        language: "sql",
        theme: monacoTheme,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
      });
      editor.onDidChangeModelContent(() => {
        setDirty((editor.getValue() || "") !== savedText);
      });
      resolve();
    });
  });
}

function initEvents() {
  $("saveBtn")?.addEventListener("click", () => void saveSqlFile());
  $("formatBtn")?.addEventListener("click", () => void formatSqlDocument());
  $("runBtn")?.addEventListener("click", () => void runQuery());
  $("testConnectionBtn")?.addEventListener("click", () => void testConnection());
  $("connectionSelect")?.addEventListener("change", (event) => {
    activeConnection = event.target.value || "";
    renderConnectionDetails();
  });
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "arcode:snowflake-open-path") {
      void loadSqlFile(msg.path || "");
    }
    if (msg.type === "arcode:scripting-save") {
      void saveSqlFile();
    }
    if (msg.type === "arcode:scripting-save-as") {
      void saveSqlFile();
    }
    if (msg.type === "arcode:set-zoom") {
      window.ArcodeZoomBridge?.applyPageZoomValue?.(Number(msg.zoom) || 100, Number(msg.statusBarHeight) || 28);
    }
    if (msg.type === "arcode:assistant-context-request") {
      window.parent?.postMessage({
        type: "arcode:assistant-context-result",
        requestId: msg.requestId || "",
        context: buildAssistantContext(),
      }, "*");
    }
    if (msg.type === "arcode:assistant-replace-text") {
      const requestId = msg.requestId || "";
      if (
        typeof msg.expectedTargetPath === "string"
        && msg.expectedTargetPath !== (currentPath || "")
      ) {
        window.parent?.postMessage({
          type: "arcode:assistant-replace-text-result",
          requestId,
          ok: false,
          error: "The reviewed SQL file is no longer active. Run the skill again before applying.",
        }, "*");
        return;
      }
      if (!editor) {
        window.parent?.postMessage({
          type: "arcode:assistant-replace-text-result",
          requestId,
          ok: false,
          error: "The editor is not ready.",
        }, "*");
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
          window.parent?.postMessage({
            type: "arcode:assistant-replace-text-result",
            requestId,
            ok: false,
            error: "The selected SQL range is no longer valid. Run the skill again before applying.",
          }, "*");
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
          window.parent?.postMessage({
            type: "arcode:assistant-replace-text-result",
            requestId,
            ok: false,
            error: "The selected SQL changed after the review opened. Run the skill again before applying.",
          }, "*");
          return;
        }
        editor.executeEdits("arcbot-sql-format", [{ range: monacoRange, text: String(msg.text ?? ""), forceMoveMarkers: true }]);
      } else {
        const current = editor.getValue() || "";
        if (typeof msg.expectedText === "string" && msg.expectedText !== current) {
          window.parent?.postMessage({
            type: "arcode:assistant-replace-text-result",
            requestId,
            ok: false,
            error: "The editor changed after the SQL review opened. Run the skill again before applying.",
          }, "*");
          return;
        }
        editor.setValue(String(msg.text ?? ""));
      }
      setDirty((editor.getValue() || "") !== savedText);
      setStatus(range ? "Applied ArcBot SQL formatting to selection." : "Applied ArcBot SQL formatting.");
      window.parent?.postMessage({
        type: "arcode:assistant-replace-text-result",
        requestId,
        ok: true,
        dirty,
      }, "*");
    }
  });
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.shiftKey && key === "s") {
      event.preventDefault();
      void saveSqlFile();
    }
    if ((event.ctrlKey || event.metaKey) && key === "enter") {
      event.preventDefault();
      void runQuery();
    }
  });
}

async function boot() {
  window.ArcodeZoomBridge?.wirePageZoomBridge();
  await initEditor();
  initEvents();
  await loadConnections();
  postTitle();
  if (currentPath) await loadSqlFile(currentPath);
  else setEditorText("");
}

void boot();
