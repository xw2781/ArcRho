import { shell } from "../shell/shell_context.js?v=20260510a";

const API_BASE = window.location.origin;
const macroWindow = document.getElementById("macroWindow");
const macroCloseBtn = document.getElementById("macroCloseBtn");
const macroRefreshBtn = document.getElementById("macroRefreshBtn");
const macroRunBtn = document.getElementById("macroRunBtn");
const macroEditBtn = document.getElementById("macroEditBtn");
const macroList = document.getElementById("macroList");
const macroDescription = document.getElementById("macroDescription");
const macroStatus = document.getElementById("macroStatus");
const macroHeader = document.getElementById("macroHeader");
const macroContent = document.getElementById("macroContent");
const macroSplitHandle = document.getElementById("macroSplitHandle");

const MACRO_WINDOW_POSITION_KEY = "arcrho_macro_window_position";
const MACRO_SPLIT_HEIGHT_KEY = "arcrho_macro_window_split_height";
const MACRO_MIN_LIST_HEIGHT = 100;
const MACRO_MIN_DESCRIPTION_HEIGHT = 76;
const DEMO_MACROS = [
  {
    id: "demo_loss_ratio_review",
    name: "Loss Ratio Review",
    description: "Demo placeholder: review selected DFM rows for large loss-ratio shifts and summarize the accident years that may need actuarial notes.",
    demo: true,
  },
  {
    id: "demo_growth_factor_smoothing",
    name: "Growth Factor Smoothing",
    description: "Demo placeholder: scan growth and trend selections, flag abrupt factor changes, and draft smoother alternatives for the active method.",
    demo: true,
  },
  {
    id: "demo_triangle_quality_check",
    name: "Triangle Quality Check",
    description: "Demo placeholder: inspect the active DFM triangle for missing diagonals, negative values, and unusual development pattern breaks.",
    demo: true,
  },
  {
    id: "demo_summary_commentary",
    name: "Summary Commentary Draft",
    description: "Demo placeholder: turn selected method assumptions and summary statistics into first-draft commentary for review.",
    demo: true,
  },
];

let macros = [];
let selectedMacroId = "";
let macroWindowWired = false;
let macroSplitCustomized = false;
let macroSplitContextMenu = null;

function setMacroStatus(text, tone = "", options = {}) {
  const message = String(text || "");
  if (macroStatus) {
    macroStatus.textContent = message;
    macroStatus.dataset.tone = tone || "";
  }
  if (options.statusBar && message) {
    shell.updateStatusBar?.(message, { tone: tone || "" });
  }
}

function getSelectedMacro() {
  return macros.find((macro) => macro.id === selectedMacroId) || null;
}

function isDemoMacro(macro) {
  return !!macro?.demo;
}

function canDeleteMacro(macro) {
  return !!macro?.path && !isDemoMacro(macro);
}

function buildMacroDisplayList(loadedMacros) {
  return [...(Array.isArray(loadedMacros) ? loadedMacros : []), ...DEMO_MACROS];
}

function renderMacroList() {
  if (!macroList) return;
  macroList.textContent = "";
  if (!macros.length) {
    const empty = document.createElement("div");
    empty.className = "macroEmpty";
    empty.textContent = "No macros found.";
    macroList.appendChild(empty);
    return;
  }
  if (!selectedMacroId || !macros.some((macro) => macro.id === selectedMacroId)) {
    selectedMacroId = macros[0]?.id || "";
  }
  macros.forEach((macro) => {
    const item = document.createElement("button");
    item.className = "macroListItem";
    item.type = "button";
    item.dataset.id = macro.id;
    item.classList.toggle("active", macro.id === selectedMacroId);
    item.setAttribute("aria-selected", macro.id === selectedMacroId ? "true" : "false");
    if (isDemoMacro(macro)) item.classList.add("demo");
    const title = document.createElement("span");
    title.className = "macroListItemName";
    title.textContent = macro.name || macro.id;
    item.appendChild(title);
    item.title = macro.description || macro.path || macro.id;
    item.addEventListener("click", () => {
      selectedMacroId = macro.id;
      renderMacroList();
      renderMacroDescription();
    });
    macroList.appendChild(item);
  });
}

function renderMacroDescription() {
  const macro = getSelectedMacro();
  if (!macroDescription) return;
  if (!macro) {
    macroDescription.textContent = "Select a macro to view its description.";
    if (macroRunBtn) macroRunBtn.disabled = true;
    if (macroEditBtn) macroEditBtn.disabled = true;
    return;
  }
  macroDescription.textContent = macro.description || "This macro has no description section yet.";
  if (macroRunBtn) macroRunBtn.disabled = isDemoMacro(macro);
  if (macroEditBtn) macroEditBtn.disabled = isDemoMacro(macro) || !macro.path;
}

async function loadMacros() {
  setMacroStatus("Loading macros...");
  try {
    const response = await fetch(`${API_BASE}/scripting/macros`);
    const loadedMacros = await response.json();
    const liveMacros = Array.isArray(loadedMacros) ? loadedMacros : [];
    macros = buildMacroDisplayList(liveMacros);
    renderMacroList();
    renderMacroDescription();
    setMacroStatus(`${liveMacros.length} macro(s) available. ${DEMO_MACROS.length} demo example(s) shown.`);
  } catch (err) {
    macros = buildMacroDisplayList([]);
    renderMacroList();
    renderMacroDescription();
    const message = String(err?.message || err || "Failed to load macros.");
    setMacroStatus(`Failed to load macros; showing demo examples. ${message}`, "error");
  }
}

function getActiveDfmTab() {
  return shell.state?.tabs?.find?.((tab) => (
    tab.id === shell.state.activeId
    && (tab.type === "dfm" || (tab.type === "project_instance" && tab.piDfmActive))
  )) || null;
}

function requestActiveDfmContext() {
  const tab = getActiveDfmTab();
  if (!tab) return Promise.resolve({ available: false, error: "Open or activate a DFM tab/window before running a macro." });
  shell.ensureIframe?.(tab);
  const iframe = tab.iframe;
  if (!iframe?.contentWindow) {
    return Promise.resolve({ available: false, error: "The active DFM target is not ready yet." });
  }
  return new Promise((resolve) => {
    const requestId = `macro_context_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (context) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(context || { available: false, error: "DFM context failed." });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data || {};
      if (msg.type !== "arcrho:assistant-context-result" || msg.requestId !== requestId) return;
      finish(msg.context || {});
    };
    window.addEventListener("message", onMessage);
    try {
      iframe.contentWindow.postMessage({ type: "arcrho:assistant-context-request", requestId }, "*");
    } catch {
      finish({ available: false, error: "Could not request DFM context." });
      return;
    }
    setTimeout(() => finish({ available: false, error: "Timed out reading active DFM context." }), 1500);
  });
}

function applyPayloadToActiveDfm(payload) {
  const tab = getActiveDfmTab();
  if (!tab) return Promise.resolve({ ok: false, error: "Open or activate a DFM tab/window before running a macro." });
  shell.ensureIframe?.(tab);
  const iframe = tab.iframe;
  if (!iframe?.contentWindow) {
    return Promise.resolve({ ok: false, error: "The active DFM target is not ready yet." });
  }
  return new Promise((resolve) => {
    const requestId = `macro_apply_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(result || { ok: false, error: "DFM apply failed." });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data || {};
      if (msg.type !== "arcrho:dfm-apply-method-payload-result" || msg.requestId !== requestId) return;
      finish({ ok: !!msg.ok, error: String(msg.error || "") });
    };
    window.addEventListener("message", onMessage);
    try {
      iframe.contentWindow.postMessage({ type: "arcrho:dfm-apply-method-payload", requestId, payload }, "*");
    } catch {
      finish({ ok: false, error: "Could not apply macro result to the DFM tab." });
      return;
    }
    setTimeout(() => finish({ ok: false, error: "Timed out applying macro result." }), 3000);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function ensureMacroPreviewStyles() {
  if (document.getElementById("macro-notes-preview-style")) return;
  const style = document.createElement("style");
  style.id = "macro-notes-preview-style";
  style.textContent = `
    .macroNotesPreviewOverlay {
      position: fixed;
      inset: 0;
      z-index: 13000;
      background: rgba(15, 23, 42, 0.18);
      box-sizing: border-box;
    }
    .macroNotesPreviewWindow {
      position: fixed;
      width: min(980px, calc(100vw - 32px));
      min-width: min(620px, calc(100vw - 32px));
      height: min(720px, calc(100vh - 96px));
      min-height: 360px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 96px);
      display: flex;
      flex-direction: column;
      border: 1px solid #c8d0dc;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 22px 54px rgba(15, 23, 42, 0.24);
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      color: #172033;
      overflow: hidden;
      resize: both;
    }
    .macroNotesPreviewHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 32px;
      padding: 3px 12px;
      border-bottom: 1px solid #e2e7ef;
      background: #f7f9fc;
      cursor: move;
      user-select: none;
    }
    .macroNotesPreviewTitle {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
    }
    .macroNotesPreviewClose {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      box-sizing: border-box;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      color: #5b6678;
    }
    .macroNotesPreviewClose:hover { background: #edf1f7; color: #1f2937; }
    .macroNotesPreviewBody {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      padding: 16px;
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .macroNotesPreviewStatus {
      margin: 0 0 14px;
      padding: 12px 14px;
      border-radius: 7px;
      border: 1px solid #c9d9f7;
      background: #eef5ff;
      color: #244a86;
      font-size: 13px;
      line-height: 1.4;
    }
    .macroNotesPreviewGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      min-height: 0;
    }
    .macroNotesPreviewCard {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border: 1px solid #d9e0ea;
      border-radius: 7px;
      background: #fbfcff;
      padding: 12px;
    }
    .macroNotesPreviewCard.newest {
      border-color: #78b997;
      box-shadow: inset 0 0 0 1px #a8d9bd;
      background: #f3fbf6;
    }
    .macroNotesPreviewSourceLabel {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      width: fit-content;
      padding: 2px 9px;
      border: 1px solid #2457a6;
      border-radius: 6px;
      background: #e8f0ff;
      color: #173d78;
      font-weight: 800;
      font-size: 13px;
      line-height: 1.2;
      white-space: nowrap;
      margin-bottom: 9px;
    }
    .macroNotesPreviewText {
      flex: 1 1 auto;
      min-height: 0;
      max-height: 470px;
      margin: 0;
      padding: 10px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #fff;
      overflow: auto;
      white-space: pre-wrap;
      font: 12px Consolas, "Courier New", monospace;
      color: #172033;
    }
    .macroNotesDeleted {
      background: #ffe3e3;
      color: #8f1d1d;
      border-radius: 2px;
    }
    .macroNotesAdded {
      background: #dcfce7;
      color: #14532d;
      border-radius: 2px;
    }
    .macroNotesPreviewActions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid #e2e7ef;
      background: #fbfcff;
    }
    .macroNotesPreviewBtn {
      min-width: 82px;
      height: 28px;
      padding: 0 12px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: #fff;
      color: #172033;
      cursor: pointer;
      font-size: 12px;
    }
    .macroNotesPreviewBtn.primary {
      border-color: #9bbcf7;
      background: #eff6ff;
      color: #1d4ed8;
      font-weight: 700;
    }
  `;
  document.head.appendChild(style);
}

function tokenizeDiffText(text) {
  return String(text || "").match(/\s+|[^\s]+/g) || [];
}

function buildTextDiff(oldText, newText) {
  const oldTokens = tokenizeDiffText(oldText);
  const newTokens = tokenizeDiffText(newText);
  const dp = Array.from({ length: oldTokens.length + 1 }, () => new Array(newTokens.length + 1).fill(0));
  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const deleted = new Array(oldTokens.length).fill(false);
  const added = new Array(newTokens.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deleted[i] = true;
      i += 1;
    } else {
      added[j] = true;
      j += 1;
    }
  }
  while (i < oldTokens.length) {
    deleted[i] = true;
    i += 1;
  }
  while (j < newTokens.length) {
    added[j] = true;
    j += 1;
  }
  return { oldTokens, newTokens, deleted, added };
}

function renderDiffTokens(tokens, flags, className) {
  let html = "";
  let buffer = "";
  let highlighted = false;
  const flush = () => {
    if (!buffer) return;
    const text = escapeHtml(buffer);
    html += highlighted ? `<span class="${className}">${text}</span>` : text;
    buffer = "";
  };
  tokens.forEach((token, index) => {
    const isWhitespace = /^\s+$/.test(String(token || ""));
    const nextHighlighted = !!flags[index] && !isWhitespace;
    if (nextHighlighted !== highlighted) {
      flush();
      highlighted = nextHighlighted;
    }
    buffer += token;
  });
  flush();
  return html;
}

function placeMacroPreviewWindow(dialogWindow) {
  const rect = dialogWindow.getBoundingClientRect();
  const top = Math.min(64, Math.max(16, Math.floor(window.innerHeight * 0.08)));
  const left = Math.max(8, Math.round((window.innerWidth - rect.width) / 2));
  dialogWindow.style.left = `${left}px`;
  dialogWindow.style.top = `${top}px`;
}

function enableMacroPreviewDrag(dialogWindow, header) {
  if (!dialogWindow || !header) return;
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    const rect = dialogWindow.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    header.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    const onMove = (moveEvent) => {
      dialogWindow.style.left = `${startLeft + moveEvent.clientX - startX}px`;
      dialogWindow.style.top = `${startTop + moveEvent.clientY - startY}px`;
    };
    const onUp = () => {
      header.releasePointerCapture?.(event.pointerId);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

function showMacroNotesPreview(preview) {
  ensureMacroPreviewStyles();
  const oldText = String(preview?.original_notes || "");
  const newText = String(preview?.suggested_notes || "");
  const diff = buildTextDiff(oldText, newText);
  const overlay = document.createElement("div");
  overlay.className = "macroNotesPreviewOverlay";
  const summary = String(preview?.summary || "Review the suggested Notes correction.");
  overlay.innerHTML = `
    <div class="macroNotesPreviewWindow" role="dialog" aria-modal="true" aria-labelledby="macroNotesPreviewTitle">
      <div class="macroNotesPreviewHeader">
        <h2 class="macroNotesPreviewTitle" id="macroNotesPreviewTitle">${escapeHtml(preview?.title || "Validate Notes")}</h2>
        <button class="macroNotesPreviewClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="macroNotesPreviewBody">
        <div class="macroNotesPreviewStatus">${escapeHtml(summary)}</div>
        <div class="macroNotesPreviewGrid">
          <div class="macroNotesPreviewCard">
            <span class="macroNotesPreviewSourceLabel">Current Notes</span>
            <pre class="macroNotesPreviewText">${renderDiffTokens(diff.oldTokens, diff.deleted, "macroNotesDeleted") || "No notes"}</pre>
          </div>
          <div class="macroNotesPreviewCard newest">
            <span class="macroNotesPreviewSourceLabel">Suggested Notes</span>
            <pre class="macroNotesPreviewText">${renderDiffTokens(diff.newTokens, diff.added, "macroNotesAdded") || "No notes"}</pre>
          </div>
        </div>
      </div>
      <div class="macroNotesPreviewActions">
        <button class="macroNotesPreviewBtn primary" type="button" data-action="accept">Accept Corrected Notes</button>
        <button class="macroNotesPreviewBtn" type="button" data-action="cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const dialogWindow = overlay.querySelector(".macroNotesPreviewWindow");
  const header = overlay.querySelector(".macroNotesPreviewHeader");
  placeMacroPreviewWindow(dialogWindow);
  enableMacroPreviewDrag(dialogWindow, header);
  return new Promise((resolve) => {
    const finish = (accepted) => {
      overlay.remove();
      resolve(!!accepted);
    };
    overlay.querySelector(".macroNotesPreviewClose")?.addEventListener("click", () => finish(false));
    overlay.querySelector("[data-action='cancel']")?.addEventListener("click", () => finish(false));
    overlay.querySelector("[data-action='accept']")?.addEventListener("click", () => finish(true));
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(false);
    });
    overlay.tabIndex = -1;
    overlay.focus();
  });
}

async function runSelectedMacro() {
  const macro = getSelectedMacro();
  if (!macro) return;
  if (isDemoMacro(macro)) {
    setMacroStatus("Demo macro examples are placeholders and cannot be run yet.", "error", { statusBar: true });
    return;
  }
  if (!getActiveDfmTab()) {
    setMacroStatus("Open or activate a DFM tab/window before running a macro.", "error", { statusBar: true });
    return;
  }
  setMacroStatus(`Running macro: ${macro.name || macro.id}...`, "", { statusBar: true });
  if (macroRunBtn) macroRunBtn.disabled = true;
  try {
    const activeContext = await requestActiveDfmContext();
    if (!activeContext?.available || !activeContext?.activeJson) {
      throw new Error(activeContext?.error || "Active DFM JSON is not available.");
    }
    const response = await fetch(`${API_BASE}/scripting/run-macro`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macro_id: macro.id, active_context: activeContext }),
    });
    const result = await response.json();
    if (!result?.success) throw new Error(result?.message || "Macro failed.");
    const preview = result.preview || null;
    if (preview?.type === "notes_diff") {
      if (!preview.has_changes) {
        const message = String(preview.summary || "Validate Notes found no required changes.");
        setMacroStatus(message, "", { statusBar: true });
        return;
      }
      const accepted = await showMacroNotesPreview(preview);
      if (!accepted) {
        setMacroStatus("Validate Notes suggestion was not applied.", "", { statusBar: true });
        return;
      }
    }
    const applied = await applyPayloadToActiveDfm(result.payload);
    if (!applied?.ok) throw new Error(applied?.error || "Macro ran, but the DFM tab did not accept the result.");
    const output = String(result.stdout || "").trim();
    const message = output ? `Macro applied. ${output}` : "Macro applied to the active DFM.";
    setMacroStatus(message, "", { statusBar: true });
  } catch (err) {
    const message = String(err?.message || err || "Macro failed.");
    setMacroStatus(`Macro failed: ${message}`, "error", { statusBar: true });
  } finally {
    if (macroRunBtn) macroRunBtn.disabled = false;
  }
}

function editSelectedMacro() {
  const macro = getSelectedMacro();
  if (!macro?.path || isDemoMacro(macro)) return;
  shell.openScriptingTab?.({ forceNew: true, notebookPath: macro.path });
  setMacroStatus(`Opened ${macro.name || macro.id} in Arcode.`, "", { statusBar: true });
}

async function deleteSelectedMacro() {
  const macro = getSelectedMacro();
  if (!canDeleteMacro(macro)) {
    setMacroStatus("Select a real macro before deleting.", "error", { statusBar: true });
    return;
  }
  const name = String(macro.name || macro.id);
  const confirmed = window.confirm(`Delete macro "${name}"?\n\nThis removes the Python file from the scripting folder.`);
  if (!confirmed) return;
  setMacroStatus(`Deleting macro: ${name}...`);
  try {
    const response = await fetch(`${API_BASE}/scripting/delete-macro`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macro_id: macro.id }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result?.success) {
      throw new Error(result?.message || "Macro delete failed.");
    }
    selectedMacroId = "";
    await loadMacros();
    setMacroStatus(`Deleted macro: ${name}.`, "", { statusBar: true });
  } catch (err) {
    const message = String(err?.message || err || "Macro delete failed.");
    setMacroStatus(`Macro delete failed: ${message}`, "error", { statusBar: true });
  }
}

function syncMacroSplitContextMenu() {
  if (!macroSplitContextMenu) return;
  const macro = getSelectedMacro();
  const isDemo = isDemoMacro(macro);
  const canUseRealMacro = !!macro && !isDemo;
  const runItem = macroSplitContextMenu.querySelector("[data-action='run']");
  const editItem = macroSplitContextMenu.querySelector("[data-action='edit']");
  const deleteItem = macroSplitContextMenu.querySelector("[data-action='delete']");
  if (runItem) runItem.disabled = !canUseRealMacro;
  if (editItem) editItem.disabled = !canUseRealMacro || !macro?.path;
  if (deleteItem) deleteItem.disabled = !canDeleteMacro(macro);
}

function hideMacroSplitContextMenu() {
  if (!macroSplitContextMenu) return;
  macroSplitContextMenu.classList.remove("open");
  macroSplitContextMenu.setAttribute("aria-hidden", "true");
}

function ensureMacroSplitContextMenu() {
  if (macroSplitContextMenu) return macroSplitContextMenu;
  const menu = document.createElement("div");
  menu.className = "macroSplitContextMenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-hidden", "true");
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="run">Run</button>
    <button type="button" role="menuitem" data-action="edit">Edit</button>
    <button type="button" role="menuitem" class="danger" data-action="delete">Delete</button>
  `;
  menu.addEventListener("click", (event) => {
    const item = event.target?.closest?.("[data-action]");
    if (!item || item.disabled) return;
    const action = item.dataset.action;
    hideMacroSplitContextMenu();
    if (action === "run") void runSelectedMacro();
    else if (action === "edit") editSelectedMacro();
    else if (action === "delete") void deleteSelectedMacro();
  });
  document.body.appendChild(menu);
  macroSplitContextMenu = menu;
  return menu;
}

function showMacroSplitContextMenu(x, y) {
  const menu = ensureMacroSplitContextMenu();
  syncMacroSplitContextMenu();
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  const rect = menu.getBoundingClientRect();
  const margin = 6;
  const left = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin));
  const top = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.querySelector("button:not(:disabled)")?.focus?.();
}

function getMacroWindowBounds() {
  const margin = 8;
  const styles = macroWindow ? getComputedStyle(macroWindow) : null;
  const minWidth = Number.parseFloat(styles?.minWidth || "") || 360;
  const minHeight = Number.parseFloat(styles?.minHeight || "") || 320;
  const statusbarHeight = Number(shell.getStatusBarHeight?.() || 0);
  return {
    margin,
    minWidth,
    minHeight,
    maxRight: Math.max(margin + minWidth, window.innerWidth - margin),
    maxBottom: Math.max(margin + minHeight, window.innerHeight - statusbarHeight - margin),
  };
}

function clampMacroWindowRect(left, top, width, height) {
  const bounds = getMacroWindowBounds();
  const maxWidth = Math.max(bounds.minWidth, bounds.maxRight - bounds.margin);
  const maxHeight = Math.max(bounds.minHeight, bounds.maxBottom - bounds.margin);
  const nextWidth = Math.min(Math.max(bounds.minWidth, Number(width) || bounds.minWidth), maxWidth);
  const nextHeight = Math.min(Math.max(bounds.minHeight, Number(height) || bounds.minHeight), maxHeight);
  const maxLeft = Math.max(bounds.margin, bounds.maxRight - nextWidth);
  const maxTop = Math.max(bounds.margin, bounds.maxBottom - nextHeight);
  return {
    left: Math.min(Math.max(bounds.margin, Number(left) || bounds.margin), maxLeft),
    top: Math.min(Math.max(bounds.margin, Number(top) || bounds.margin), maxTop),
    width: nextWidth,
    height: nextHeight,
  };
}

function clampMacroWindowPosition(left, top) {
  const rect = macroWindow?.getBoundingClientRect?.();
  const width = rect?.width || 430;
  const height = rect?.height || 420;
  return clampMacroWindowRect(left, top, width, height);
}

function applyMacroWindowPosition(left, top) {
  if (!macroWindow) return;
  const next = clampMacroWindowPosition(left, top);
  macroWindow.style.left = `${Math.round(next.left)}px`;
  macroWindow.style.top = `${Math.round(next.top)}px`;
  macroWindow.style.right = "auto";
}

function applyMacroWindowRect(left, top, width, height) {
  if (!macroWindow) return;
  const next = clampMacroWindowRect(left, top, width, height);
  macroWindow.style.left = `${Math.round(next.left)}px`;
  macroWindow.style.top = `${Math.round(next.top)}px`;
  macroWindow.style.width = `${Math.round(next.width)}px`;
  macroWindow.style.height = `${Math.round(next.height)}px`;
  macroWindow.style.right = "auto";
  macroWindow.style.bottom = "auto";
  clampMacroSplitHeight();
}

function readMacroWindowPosition() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MACRO_WINDOW_POSITION_KEY) || "null");
    if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed;
  } catch {}
  return null;
}

function saveMacroWindowPosition() {
  if (!macroWindow) return;
  const rect = macroWindow.getBoundingClientRect();
  try {
    localStorage.setItem(MACRO_WINDOW_POSITION_KEY, JSON.stringify({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }));
  } catch {}
}

function restoreMacroWindowPosition() {
  const saved = readMacroWindowPosition();
  if (!saved) return;
  if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    applyMacroWindowRect(saved.left, saved.top, saved.width, saved.height);
  } else {
    applyMacroWindowPosition(saved.left, saved.top);
  }
}

function clampOpenMacroWindow() {
  if (!macroWindow?.classList.contains("open")) return;
  const rect = macroWindow.getBoundingClientRect();
  applyMacroWindowRect(rect.left, rect.top, rect.width, rect.height);
  saveMacroWindowPosition();
}

function getMacroSplitMetrics() {
  if (!macroContent || !macroSplitHandle) return null;
  const contentRect = macroContent.getBoundingClientRect();
  const handleRect = macroSplitHandle.getBoundingClientRect();
  if (!contentRect.height) return null;
  const contentStyles = getComputedStyle(macroContent);
  const rowGap = Number.parseFloat(contentStyles.rowGap || contentStyles.gap || "0") || 0;
  const handleHeight = handleRect.height || 8;
  const available = Math.max(0, contentRect.height - handleHeight - (rowGap * 2));
  const minList = Math.min(MACRO_MIN_LIST_HEIGHT, available);
  const minDescription = Math.min(MACRO_MIN_DESCRIPTION_HEIGHT, Math.max(0, available - minList));
  const maxList = Math.max(minList, available - minDescription);
  return { available, handleHeight, minList, maxList };
}

function updateMacroSplitAccessibility(height, metrics) {
  if (!macroSplitHandle || !metrics) return;
  macroSplitHandle.setAttribute("aria-valuemin", String(Math.round(metrics.minList)));
  macroSplitHandle.setAttribute("aria-valuemax", String(Math.round(metrics.maxList)));
  macroSplitHandle.setAttribute("aria-valuenow", String(Math.round(height)));
}

function applyMacroSplitHeight(height, options = {}) {
  if (!macroContent) return null;
  const metrics = getMacroSplitMetrics();
  if (!metrics) return null;
  const nextHeight = Math.min(Math.max(metrics.minList, Number(height) || metrics.minList), metrics.maxList);
  macroContent.style.gridTemplateRows = `${Math.round(nextHeight)}px ${Math.round(metrics.handleHeight)}px minmax(0, 1fr)`;
  updateMacroSplitAccessibility(nextHeight, metrics);
  if (options.markCustom) macroSplitCustomized = true;
  if (options.save) {
    try { localStorage.setItem(MACRO_SPLIT_HEIGHT_KEY, String(Math.round(nextHeight))); } catch {}
  }
  return nextHeight;
}

function clampMacroSplitHeight() {
  if (!macroSplitCustomized || !macroList) return;
  applyMacroSplitHeight(macroList.getBoundingClientRect().height);
}

function restoreMacroSplitHeight() {
  try {
    const saved = Number(localStorage.getItem(MACRO_SPLIT_HEIGHT_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      macroSplitCustomized = true;
      applyMacroSplitHeight(saved);
      return;
    }
  } catch {}
  const metrics = getMacroSplitMetrics();
  if (macroList && metrics) updateMacroSplitAccessibility(macroList.getBoundingClientRect().height, metrics);
}

function initMacroContentSplit() {
  if (!macroContent || !macroSplitHandle || !macroList) return;
  let splitState = null;

  const cleanupSplitListeners = () => {
    document.removeEventListener("pointermove", moveSplit);
    document.removeEventListener("pointerup", stopSplit);
    document.removeEventListener("pointercancel", stopSplit);
    window.removeEventListener("blur", stopSplit);
  };

  const startSplit = (event) => {
    if (event.button !== 0) return;
    hideMacroSplitContextMenu();
    splitState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      listHeight: macroList.getBoundingClientRect().height,
    };
    document.body.classList.add("macroSplitResizeActive");
    try { macroSplitHandle.setPointerCapture(event.pointerId); } catch {}
    document.addEventListener("pointermove", moveSplit);
    document.addEventListener("pointerup", stopSplit);
    document.addEventListener("pointercancel", stopSplit);
    window.addEventListener("blur", stopSplit);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveSplit = (event) => {
    if (!splitState || splitState.pointerId !== event.pointerId) return;
    applyMacroSplitHeight(splitState.listHeight + event.clientY - splitState.startY, { markCustom: true });
  };

  const stopSplit = (event) => {
    if (!splitState || (event?.pointerId != null && splitState.pointerId !== event.pointerId)) return;
    try { macroSplitHandle.releasePointerCapture(splitState.pointerId); } catch {}
    document.body.classList.remove("macroSplitResizeActive");
    const applied = applyMacroSplitHeight(macroList.getBoundingClientRect().height, { markCustom: true, save: true });
    if (applied == null) {
      try { localStorage.removeItem(MACRO_SPLIT_HEIGHT_KEY); } catch {}
    }
    cleanupSplitListeners();
    splitState = null;
  };

  macroSplitHandle.addEventListener("pointerdown", startSplit);
  macroSplitHandle.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showMacroSplitContextMenu(event.clientX, event.clientY);
  });
  macroSplitHandle.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const rect = macroSplitHandle.getBoundingClientRect();
      event.preventDefault();
      showMacroSplitContextMenu(rect.left + rect.width / 2, rect.bottom);
      return;
    }
    const metrics = getMacroSplitMetrics();
    if (!metrics) return;
    const current = macroList.getBoundingClientRect().height;
    let next = current;
    if (event.key === "ArrowUp") next = current - 16;
    else if (event.key === "ArrowDown") next = current + 16;
    else if (event.key === "Home") next = metrics.minList;
    else if (event.key === "End") next = metrics.maxList;
    else return;
    event.preventDefault();
    applyMacroSplitHeight(next, { markCustom: true, save: true });
  });
  document.addEventListener("mousedown", (event) => {
    if (!macroSplitContextMenu?.classList.contains("open")) return;
    if (event.target?.closest?.(".macroSplitContextMenu")) return;
    hideMacroSplitContextMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideMacroSplitContextMenu();
  }, true);
}

function initMacroWindowResize() {
  if (!macroWindow) return;
  const handles = Array.from(macroWindow.querySelectorAll(".macroResizeHandle"));
  if (!handles.length) return;
  let resizeState = null;

  const startResize = (event) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const rect = macroWindow.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      edge: String(handle?.dataset?.resizeEdge || "se"),
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    try { handle.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopPropagation();
  };

  const moveResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const dx = event.clientX - resizeState.startX;
    const dy = event.clientY - resizeState.startY;
    const edge = resizeState.edge;
    let left = resizeState.left;
    let top = resizeState.top;
    let width = resizeState.width;
    let height = resizeState.height;
    if (edge.includes("e")) width = resizeState.width + dx;
    if (edge.includes("s")) height = resizeState.height + dy;
    if (edge.includes("w")) {
      left = resizeState.left + dx;
      width = resizeState.width - dx;
    }
    if (edge.includes("n")) {
      top = resizeState.top + dy;
      height = resizeState.height - dy;
    }
    if (edge.includes("w")) {
      const right = resizeState.left + resizeState.width;
      const minWidth = getMacroWindowBounds().minWidth;
      if (width < minWidth) {
        width = minWidth;
        left = right - minWidth;
      }
    }
    if (edge.includes("n")) {
      const bottom = resizeState.top + resizeState.height;
      const minHeight = getMacroWindowBounds().minHeight;
      if (height < minHeight) {
        height = minHeight;
        top = bottom - minHeight;
      }
    }
    applyMacroWindowRect(left, top, width, height);
  };

  const stopResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch {}
    saveMacroWindowPosition();
    resizeState = null;
  };

  handles.forEach((handle) => {
    handle.addEventListener("pointerdown", startResize);
    handle.addEventListener("pointermove", moveResize);
    handle.addEventListener("pointerup", stopResize);
    handle.addEventListener("pointercancel", stopResize);
  });
}

function initMacroWindowDrag() {
  if (!macroWindow || !macroHeader) return;
  let dragState = null;

  macroHeader.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button")) return;
    const rect = macroWindow.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    try { macroHeader.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  });

  macroHeader.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    applyMacroWindowPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  });

  const stopDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    try { macroHeader.releasePointerCapture(event.pointerId); } catch {}
    saveMacroWindowPosition();
    dragState = null;
  };

  macroHeader.addEventListener("pointerup", stopDrag);
  macroHeader.addEventListener("pointercancel", stopDrag);
  window.addEventListener("resize", clampOpenMacroWindow);
}

export function openMacroWindow() {
  restoreMacroWindowPosition();
  macroWindow?.classList.add("open");
  restoreMacroSplitHeight();
  void loadMacros();
}

export function closeMacroWindow() {
  macroWindow?.classList.remove("open");
}

export function initMacroWindow() {
  if (macroWindowWired) return;
  macroWindowWired = true;
  macroCloseBtn?.addEventListener("click", closeMacroWindow);
  macroRefreshBtn?.addEventListener("click", () => loadMacros());
  macroRunBtn?.addEventListener("click", runSelectedMacro);
  macroEditBtn?.addEventListener("click", editSelectedMacro);
  initMacroWindowDrag();
  initMacroWindowResize();
  initMacroContentSplit();
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && macroWindow?.classList.contains("open")) closeMacroWindow();
  }, true);
}
