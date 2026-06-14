import { getHostApi, registerShellApi } from "/ui/shell/shell_context.js?v=20260510a";
import { initAiAssistant } from "/ui/shell/ai_assistant.js?v=20260515b";

const UI_VERSION_PARAM = new URLSearchParams(window.location.search).get("v") || String(Date.now());
const initialOpenPath = new URLSearchParams(window.location.search).get("path") || "";
const RECENT_KEY = "arcode_recent_files_v1";

const state = {
  tabs: [],
  activeId: "home",
  nextId: 1,
};

const $ = (id) => document.getElementById(id);

function filenameFromPath(pathLike) {
  const normalized = String(pathLike || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function readRecentFiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function saveRecentFile(pathLike) {
  const filePath = String(pathLike || "").trim();
  if (!filePath) return;
  const lower = filePath.toLowerCase();
  const next = [filePath, ...readRecentFiles().filter((item) => item.toLowerCase() !== lower)].slice(0, 20);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recent files are a convenience only.
  }
}

function updateStatus(text) {
  const value = String(text || "").trim() || "Ready";
  const status = $("arcodeStatusText");
  if (status) status.textContent = value;
}

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeId) || null;
}

function postToTab(tab, message) {
  if (!tab?.iframe?.contentWindow) return;
  try {
    tab.iframe.contentWindow.postMessage(message, "*");
  } catch {
    // Stale frames can disappear during close.
  }
}

function tabTitle(tab) {
  return tab?.title || filenameFromPath(tab?.path) || "Untitled Notebook";
}

function renderHome() {
  const home = $("arcodeHome");
  if (!home) return;
  const recent = readRecentFiles();
  home.innerHTML = `
    <div class="arcodeHomeLayout">
      <aside class="arcodeHomeSidebar">
        <div class="arcodeHomeActions">
          <button id="arcodeHomeOpenBtn" class="arcodeHomeBtn primary" type="button">Open File</button>
          <button id="arcodeHomeNewBtn" class="arcodeHomeBtn" type="button">New Notebook</button>
        </div>
      </aside>
      <section>
        <h2 class="arcodeHomeSectionTitle">Recent Files</h2>
        <div class="arcodeRecentList">
          ${recent.length ? recent.map((filePath) => `
            <button class="arcodeRecentItem" type="button" data-path="${encodeURIComponent(filePath)}">
              <span>
                <span class="arcodeRecentName">${escapeHtml(filenameFromPath(filePath) || filePath)}</span>
                <span class="arcodeRecentPath">${escapeHtml(filePath)}</span>
              </span>
              <span>Open</span>
            </button>
          `).join("") : `<div class="arcodeEmpty">No recent files yet.</div>`}
        </div>
      </section>
    </div>
  `;
  $("arcodeHomeOpenBtn")?.addEventListener("click", openFileDialog);
  $("arcodeHomeNewBtn")?.addEventListener("click", () => openCodeTab({ forceFresh: true }));
  home.querySelectorAll(".arcodeRecentItem").forEach((button) => {
    button.addEventListener("click", () => {
      const filePath = decodeURIComponent(button.getAttribute("data-path") || "");
      if (filePath) openCodeTab({ path: filePath });
    });
  });
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function renderTabs() {
  const container = $("arcodeTabs");
  if (!container) return;
  container.textContent = "";
  for (const tab of state.tabs) {
    const item = document.createElement("div");
    item.className = `arcodeTab${tab.id === state.activeId ? " active" : ""}${tab.dirty ? " dirty" : ""}`;
    item.title = tab.path || tabTitle(tab);
    item.dataset.tabId = tab.id;

    const title = document.createElement("div");
    title.className = "arcodeTabTitle";
    title.textContent = tabTitle(tab);

    const close = document.createElement("button");
    close.className = "arcodeTabClose";
    close.type = "button";
    close.title = "Close";
    close.setAttribute("aria-label", `Close ${tabTitle(tab)}`);
    close.textContent = "x";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    item.append(title, close);
    item.addEventListener("click", () => setActiveTab(tab.id));
    container.appendChild(item);
  }
  const count = $("arcodeTabCount");
  if (count) {
    count.textContent = state.tabs.length === 1
      ? "1 file open"
      : `${state.tabs.length} files open`;
  }
}

function renderFrames() {
  const home = $("arcodeHome");
  const host = $("arcodeFrameHost");
  const hasActiveTab = !!activeTab();
  home?.classList.toggle("open", !hasActiveTab);
  host?.classList.toggle("open", hasActiveTab);
  for (const tab of state.tabs) {
    tab.iframe?.classList.toggle("active", tab.id === state.activeId);
  }
  document.title = hasActiveTab ? `${tabTitle(activeTab())} - Arcode` : "Arcode";
}

function render() {
  renderHome();
  renderTabs();
  renderFrames();
}

function setActiveTab(id) {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) {
    state.activeId = "home";
  } else {
    state.activeId = tab.id;
  }
  render();
}

function buildScriptingUrl(tab) {
  const params = new URLSearchParams();
  params.set("inst", tab.scInst);
  if (tab.forceFresh) params.set("fresh", "1");
  if (tab.path) params.set("skipLast", "1");
  params.set("v", UI_VERSION_PARAM);
  return `/ui/scripting_console/scripting_console.html?${params.toString()}`;
}

function createFrameForTab(tab) {
  const iframe = document.createElement("iframe");
  iframe.className = "arcodeFrame";
  iframe.dataset.tabId = tab.id;
  iframe.src = buildScriptingUrl(tab);
  iframe.addEventListener("load", () => {
    if (tab.path) {
      postToTab(tab, { type: "arcrho:scripting-open-path", path: tab.path });
    }
    postToTab(tab, { type: "arcrho:autosave-toggle", enabled: true });
  });
  $("arcodeFrameHost")?.appendChild(iframe);
  tab.iframe = iframe;
}

function openCodeTab(options = {}) {
  const filePath = String(options.path || options.openPath || "").trim();
  const existing = filePath
    ? state.tabs.find((tab) => String(tab.path || "").toLowerCase() === filePath.toLowerCase())
    : null;
  if (existing) {
    setActiveTab(existing.id);
    updateStatus(`Opened ${tabTitle(existing)}.`);
    return existing;
  }

  const id = `arcode_${state.nextId++}`;
  const tab = {
    id,
    title: filenameFromPath(filePath) || "Untitled Notebook",
    type: "scripting",
    path: filePath,
    scInst: `${id}_${Date.now()}`,
    dirty: false,
    forceFresh: !!options.forceFresh || !filePath,
    iframe: null,
  };
  state.tabs.push(tab);
  createFrameForTab(tab);
  if (filePath) saveRecentFile(filePath);
  setActiveTab(tab.id);
  updateStatus(filePath ? `Opening ${filePath}...` : "New notebook opened.");
  return tab;
}

function closeTab(id, skipConfirm = false) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tab = state.tabs[index];
  if (!skipConfirm && tab.dirty) {
    const confirmed = window.confirm(`${tabTitle(tab)} has unsaved changes. Close it anyway?`);
    if (!confirmed) return;
  }
  tab.iframe?.remove();
  state.tabs.splice(index, 1);
  if (state.activeId === id) {
    const fallback = state.tabs[Math.max(0, index - 1)] || state.tabs[0] || null;
    state.activeId = fallback?.id || "home";
  }
  render();
}

async function openFileDialog() {
  const host = getHostApi();
  if (!host?.pickOpenFile) {
    updateStatus("Open file requires the desktop app host.");
    return;
  }
  const filePath = await host.pickOpenFile({
    filters: [
      { name: "Scripting Files", extensions: ["ipynb", "arcnb", "py", "r", "sql", "js", "ts", "json", "md", "txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (filePath) openCodeTab({ path: filePath });
}

function sendScriptingCommand(type) {
  const tab = activeTab();
  if (!tab) return;
  postToTab(tab, { type });
}

function handleHotkey(action) {
  if (action === "file_save") return sendScriptingCommand("arcrho:scripting-save");
  if (action === "file_save_as") return sendScriptingCommand("arcrho:scripting-save-as");
  if (action === "file_import") return openFileDialog();
  if (action === "custom_refresh" || action === "custom_hard_refresh") {
    const tab = activeTab();
    if (tab?.iframe) tab.iframe.contentWindow?.location?.reload();
    return;
  }
  if (action === "app_shutdown") {
    window.ADAHost?.shutdownApp?.();
  }
}

function updateTabFromMessage(msg, source) {
  const inst = String(msg.inst || "").trim();
  return state.tabs.find((tab) => (
    (inst && tab.scInst === inst) || tab.iframe?.contentWindow === source
  ));
}

function initMessages() {
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "arcrho:update-active-tab-title") {
      const tab = updateTabFromMessage(msg, event.source);
      if (!tab) return;
      tab.title = String(msg.title || "").trim() || tab.title;
      const path = String(msg.path || "").trim();
      if (path) {
        tab.path = path;
        saveRecentFile(path);
      }
      render();
      return;
    }
    if (msg.type === "arcrho:scripting-dirty") {
      const tab = updateTabFromMessage(msg, event.source);
      if (!tab) return;
      tab.dirty = !!msg.dirty;
      renderTabs();
      return;
    }
    if (msg.type === "arcrho:status") {
      updateStatus(msg.text || "");
      return;
    }
    if (msg.type === "arcrho:hotkey") {
      handleHotkey(String(msg.action || ""));
      return;
    }
    if (msg.type === "arcrho:close-active-tab") {
      const tab = activeTab();
      if (tab) closeTab(tab.id);
      return;
    }
    if (msg.type === "arcode:open-file") {
      const filePath = String(msg.path || "").trim();
      if (filePath) openCodeTab({ path: filePath });
      return;
    }
    if (msg.type === "arcrho:zoom" || msg.type === "arcrho:zoom-step" || msg.type === "arcrho:zoom-reset") {
      const tab = activeTab();
      if (tab) postToTab(tab, msg);
    }
  });
}

function initWindowControls() {
  const host = window.ADAHost;
  const toggleMaximize = async () => {
    if (!host) return;
    const maximized = await host.isMaximized?.();
    if (maximized) host.restoreWindow?.();
    else host.maximizeWindow?.();
  };
  $("titlebarMinBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    host?.minimizeWindow?.();
  });
  $("titlebarMaxBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMaximize().catch(() => host?.maximizeWindow?.());
  });
  $("titlebarCloseBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    host?.closeWindow?.();
  });
  $("customTitlebar")?.addEventListener("dblclick", (event) => {
    if (event.target?.closest?.(".host-nodrag")) return;
    toggleMaximize().catch(() => host?.maximizeWindow?.());
  });
  $("customTitlebar")?.addEventListener("mousedown", async (event) => {
    if (event.target?.closest?.(".host-nodrag")) return;
    try {
      if (!(await host?.isMaximized?.())) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const onMove = (moveEvent) => {
        if (Math.abs(moveEvent.clientX - startX) < 5 && Math.abs(moveEvent.clientY - startY) < 5) return;
        window.removeEventListener("mousemove", onMove);
        host?.restoreWindow?.();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, { once: true });
    } catch {
      // Native drag behavior still works when maximize state cannot be read.
    }
  });
}

function initToolbarControls() {
  $("arcodeOpenBtn")?.addEventListener("click", openFileDialog);
  $("arcodeNewBtn")?.addEventListener("click", () => openCodeTab({ forceFresh: true }));
}

function initAppFrameStyle() {
  if (!window.ADAHost?.isWindows11) return;
  window.ADAHost.isWindows11()
    .then((isWin11) => {
      document.body.classList.toggle("win11-frame", !!isWin11);
      document.body.classList.toggle("win10-borders", !isWin11);
    })
    .catch(() => {});
}

function confirmWindowClose() {
  const dirty = state.tabs.filter((tab) => tab.dirty);
  if (!dirty.length) return true;
  const label = dirty.length === 1 ? tabTitle(dirty[0]) : `${dirty.length} files`;
  return window.confirm(`${label} have unsaved changes. Close Arcode anyway?`);
}

function initShellApi() {
  registerShellApi({
    state,
    getHostApi,
    updateStatusBar: updateStatus,
    render,
    saveState: () => {},
    ensureIframe: () => {},
  });
}

function boot() {
  initShellApi();
  initAppFrameStyle();
  initWindowControls();
  initToolbarControls();
  initMessages();
  window.__arcode_confirm_window_close = confirmWindowClose;
  render();
  initAiAssistant();
  if (initialOpenPath) openCodeTab({ path: initialOpenPath });
}

boot();
