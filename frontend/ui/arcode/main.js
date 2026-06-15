import { getHostApi, registerShellApi } from "/ui/arcode/shared/host_context.js?v=20260614a";
import { initAiAssistant } from "/ui/ai-assistant/arcode.js?v=20260615a";
import { createFileIconResolver } from "/ui/arcode/shared/file-icons/fileIconResolver.js?v=20260614a";

const UI_VERSION_PARAM = new URLSearchParams(window.location.search).get("v") || String(Date.now());
const initialOpenPath = new URLSearchParams(window.location.search).get("path") || "";
const RECENT_KEY = "arcode_recent_files_v1";
const WORKSPACE_FOLDERS_KEY = "arcode_workspace_folders_v1";
const ACTIVE_WORKSPACE_FOLDER_KEY = "arcode_active_workspace_folder_v1";
const EXPANDED_EXPLORER_PATHS_KEY = "arcode_expanded_explorer_paths_v1";
const ZOOM_STORAGE_KEY = "arcode_ui_zoom_pct";
const ZOOM_MODE_KEY = "arcode_zoom_mode";
const STATUSBAR_H_KEY = "arcode_statusbar_h";
const DEFAULT_ZOOM_PERCENT = 100;
const MIN_ZOOM_PERCENT = 70;
const MAX_ZOOM_PERCENT = 160;
const ZOOM_STEP = 10;
const DROP_FILE_EXTENSIONS = new Set([".py", ".sql", ".ipynb"]);
const TAB_DRAG_THRESHOLD_PX = 6;
const FILE_ICON_BASE_PATH = "/ui/arcode/shared/file-icons/";
const FILE_ICON_MAP_URL = `${FILE_ICON_BASE_PATH}file-icon-map.json?v=20260614a`;
let resolveFileIconPath = null;

const state = {
  tabs: [],
  activeId: "home",
  nextId: 1,
  autoSaveEnabled: true,
  zoomPercent: DEFAULT_ZOOM_PERCENT,
  recentFiles: [],
  workspaceFolders: readWorkspaceFolders(),
  activeWorkspaceFolder: readActiveWorkspaceFolder(),
  expandedExplorerPaths: readExpandedExplorerPaths(),
  folderListings: {},
};

if (!state.expandedExplorerPaths && state.workspaceFolders.length) {
  state.expandedExplorerPaths = [state.activeWorkspaceFolder || state.workspaceFolders[0]];
} else if (!state.expandedExplorerPaths) {
  state.expandedExplorerPaths = [];
}

const $ = (id) => document.getElementById(id);

function filenameFromPath(pathLike) {
  const normalized = String(pathLike || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function normalizeRecentFiles(value) {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set();
  const files = [];
  for (const item of entries) {
    const filePath = String(item || "").trim();
    if (!filePath) continue;
    const key = filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(filePath);
    if (files.length >= 20) break;
  }
  return files;
}

function normalizeZoomPercent(value, fallback = DEFAULT_ZOOM_PERCENT) {
  const numeric = Math.round(Number(value));
  const safeFallback = Number.isFinite(Number(fallback)) ? Math.round(Number(fallback)) : DEFAULT_ZOOM_PERCENT;
  if (!Number.isFinite(numeric)) return Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, safeFallback));
  return Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, numeric));
}

function readRecentFilesFallback() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return normalizeRecentFiles(parsed);
  } catch {
    return [];
  }
}

function readRecentFiles() {
  return normalizeRecentFiles(state.recentFiles);
}

function currentUserSettingsPayload() {
  return {
    recentFiles: readRecentFiles(),
    windowScalePercent: normalizeZoomPercent(state.zoomPercent),
  };
}

async function saveArcodeUserSettings({ reportFailure = false } = {}) {
  const host = getHostApi();
  const payload = currentUserSettingsPayload();
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(payload.recentFiles));
  } catch {
    // Browser fallback only.
  }
  if (typeof host?.saveArcodeUserSettings !== "function") return { ok: true, fallback: true };
  try {
    const result = await host.saveArcodeUserSettings(payload);
    if (result?.ok) return result;
    if (reportFailure) updateStatus(`Unable to save Arcode settings: ${result?.error || "Unknown error"}`);
    return { ok: false, error: result?.error || "Unknown error" };
  } catch (err) {
    const error = String(err?.message || err);
    if (reportFailure) updateStatus(`Unable to save Arcode settings: ${error}`);
    return { ok: false, error };
  }
}

async function loadArcodeUserSettings() {
  const host = getHostApi();
  if (typeof host?.loadArcodeUserSettings === "function") {
    try {
      const result = await host.loadArcodeUserSettings();
      const settings = result?.settings && typeof result.settings === "object" ? result.settings : {};
      const recentFiles = normalizeRecentFiles(settings.recentFiles);
      state.recentFiles = recentFiles.length ? recentFiles : readRecentFilesFallback();
      state.zoomPercent = normalizeZoomPercent(settings.windowScalePercent, DEFAULT_ZOOM_PERCENT);
      if (!result?.exists || !recentFiles.length) await saveArcodeUserSettings();
      return;
    } catch (err) {
      updateStatus(`Unable to load Arcode settings: ${String(err?.message || err)}`);
    }
  }
  state.recentFiles = readRecentFilesFallback();
  state.zoomPercent = DEFAULT_ZOOM_PERCENT;
}

function saveRecentFile(pathLike) {
  const filePath = String(pathLike || "").trim();
  if (!filePath) return;
  const lower = filePath.toLowerCase();
  state.recentFiles = [filePath, ...readRecentFiles().filter((item) => item.toLowerCase() !== lower)].slice(0, 20);
  void saveArcodeUserSettings();
}

function readWorkspaceFolders() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(WORKSPACE_FOLDERS_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function readActiveWorkspaceFolder() {
  try {
    return String(sessionStorage.getItem(ACTIVE_WORKSPACE_FOLDER_KEY) || "").trim();
  } catch {
    return "";
  }
}

function normalizeExplorerPaths(value) {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set();
  const paths = [];
  for (const item of entries) {
    const pathLike = String(item || "").trim();
    if (!pathLike) continue;
    const key = pathLike.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(pathLike);
  }
  return paths;
}

function readExpandedExplorerPaths() {
  try {
    const raw = sessionStorage.getItem(EXPANDED_EXPLORER_PATHS_KEY);
    if (raw == null) return null;
    return normalizeExplorerPaths(JSON.parse(raw || "[]"));
  } catch {
    return [];
  }
}

function saveWorkspaceFolders() {
  try {
    sessionStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(state.workspaceFolders || []));
    sessionStorage.setItem(ACTIVE_WORKSPACE_FOLDER_KEY, state.activeWorkspaceFolder || "");
  } catch {
    // Workspace folders are scoped to this window and best-effort.
  }
}

function saveExpandedExplorerPaths() {
  try {
    sessionStorage.setItem(EXPANDED_EXPLORER_PATHS_KEY, JSON.stringify(normalizeExplorerPaths(state.expandedExplorerPaths)));
  } catch {
    // Explorer expansion is scoped to this window and best-effort.
  }
}

function isExplorerPathExpanded(pathLike) {
  const pathKey = String(pathLike || "").trim().toLowerCase();
  if (!pathKey) return false;
  return normalizeExplorerPaths(state.expandedExplorerPaths).some((item) => item.toLowerCase() === pathKey);
}

function setExplorerPathExpanded(pathLike, expanded, { rerender = true } = {}) {
  const folderPath = String(pathLike || "").trim();
  if (!folderPath) return;
  const folderKey = folderPath.toLowerCase();
  const existing = normalizeExplorerPaths(state.expandedExplorerPaths)
    .filter((item) => item.toLowerCase() !== folderKey);
  state.expandedExplorerPaths = expanded ? [folderPath, ...existing] : existing;
  saveExpandedExplorerPaths();
  if (rerender) render();
}

function addWorkspaceFolder(pathLike, { replace = false } = {}) {
  const folderPath = String(pathLike || "").trim();
  if (!folderPath) return;
  const lower = folderPath.toLowerCase();
  const existing = replace ? [] : state.workspaceFolders.filter((item) => item.toLowerCase() !== lower);
  state.workspaceFolders = [folderPath, ...existing];
  state.activeWorkspaceFolder = folderPath;
  setExplorerPathExpanded(folderPath, true, { rerender: false });
  saveWorkspaceFolders();
  render();
  updateStatus(replace ? `Selected workspace folder ${folderPath}.` : `Added workspace folder ${folderPath}.`);
}

async function pickWorkspaceFolder({ replace = false } = {}) {
  const host = getHostApi();
  if (typeof host?.pickFolder !== "function") {
    updateStatus("Folder selection requires the desktop app host.");
    return;
  }
  const folderPath = await host.pickFolder(state.activeWorkspaceFolder || "");
  if (folderPath) addWorkspaceFolder(folderPath, { replace });
}

function isSupportedCodeFile(pathLike) {
  return DROP_FILE_EXTENSIONS.has(getPathExtension(pathLike));
}

async function loadExplorerFileIcons() {
  try {
    const response = await fetch(FILE_ICON_MAP_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Icon map request failed: ${response.status}`);
    resolveFileIconPath = createFileIconResolver(await response.json());
  } catch (err) {
    console.warn("Arcode explorer file icon map could not load.", err);
    resolveFileIconPath = null;
  }
}

function getFallbackExplorerIconPath(pathLike, options = {}) {
  if (options.isDirectory) return "icons/folder-base.svg";
  const name = filenameFromPath(pathLike).toLowerCase();
  if (name === "package.json" || name === "package-lock.json") return "icons/npm.svg";
  if (name === "readme.md" || name === "readme") return "icons/readme.svg";
  if (name === ".gitignore") return "icons/git.svg";
  const extension = getPathExtension(pathLike);
  if (extension === ".py") return "icons/python.svg";
  if (extension === ".ipynb") return "icons/jupyter.svg";
  if (extension === ".html" || extension === ".htm") return "icons/html.svg";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "icons/javascript.svg";
  if (extension === ".json" || extension === ".jsonc") return "icons/json.svg";
  if (extension === ".css") return "icons/css.svg";
  if (extension === ".md") return "icons/markdown.svg";
  if (extension === ".sql") return "icons/database.svg";
  return "icons/document.svg";
}

function getExplorerIconAssetPath(pathLike, options = {}) {
  const relativePath = (typeof resolveFileIconPath === "function"
    ? resolveFileIconPath(pathLike, options)
    : "") || getFallbackExplorerIconPath(pathLike, options);
  return `${FILE_ICON_BASE_PATH}${String(relativePath).replace(/^\/+/, "")}`;
}

function getExplorerIconImg(pathLike, options = {}) {
  const src = getExplorerIconAssetPath(pathLike, options);
  return `<img src="${escapeHtml(src)}" alt="" aria-hidden="true" draggable="false">`;
}

function getExplorerIconSvg(kind) {
  if (kind === "chevron") {
    return [
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">',
      '<path d="M6 4l4 4-4 4"></path>',
      "</svg>",
    ].join("");
  }
  return "";
}

function explorerDepthAttr(depth) {
  const safeDepth = Math.max(0, Math.min(12, Number(depth) || 0));
  return ` style="--explorer-depth:${safeDepth}"`;
}

function renderExplorerRow({ path, name, kind, depth, supported = false, active = false }) {
  const isFolder = kind === "folder" || kind === "root-folder";
  const expanded = isFolder && isExplorerPathExpanded(path);
  const classes = [
    "arcodeExplorerEntry",
    isFolder ? "folder" : "file",
    kind === "root-folder" ? "root" : "",
    expanded ? "expanded" : "",
    supported ? "supported" : "",
    active ? "active" : "",
  ].filter(Boolean).join(" ");
  return `
    <button class="${classes}" type="button" data-path="${encodeURIComponent(path)}" data-kind="${kind}" role="treeitem"${isFolder ? ` aria-expanded="${expanded ? "true" : "false"}"` : ""} title="${escapeHtml(path)}"${explorerDepthAttr(depth)}>
      <span class="arcodeExplorerTwistie${isFolder ? "" : " placeholder"}" aria-hidden="true">${isFolder ? getExplorerIconSvg("chevron") : ""}</span>
      <span class="arcodeExplorerFileIcon" aria-hidden="true">${getExplorerIconImg(path, { isDirectory: isFolder, isOpen: expanded })}</span>
      <span class="arcodeExplorerEntryName">${escapeHtml(name || filenameFromPath(path) || path)}</span>
    </button>
  `;
}

async function loadWorkspaceFolder(folderPath) {
  const path = String(folderPath || "").trim();
  if (!path || state.folderListings[path]?.loading) return;
  const host = getHostApi();
  if (typeof host?.listFolder !== "function") {
    state.folderListings[path] = { ok: false, error: "Folder listing requires the desktop app host.", entries: [] };
    render();
    return;
  }
  state.folderListings[path] = { loading: true, entries: [] };
  render();
  try {
    const result = await host.listFolder({ path, limit: 200 });
    state.folderListings[path] = {
      ok: !!result?.ok,
      error: result?.ok ? "" : String(result?.error || "Could not list folder."),
      entries: Array.isArray(result?.entries) ? result.entries : [],
    };
  } catch (err) {
    state.folderListings[path] = { ok: false, error: String(err?.message || err || "Could not list folder."), entries: [] };
  }
  render();
}

function renderExplorerChildren(folderPath, depth = 1) {
  if (!isExplorerPathExpanded(folderPath)) return "";
  const listing = state.folderListings[folderPath];
  if (!listing) {
    void loadWorkspaceFolder(folderPath);
    return `<div class="arcodeExplorerLoading"${explorerDepthAttr(depth)}>Loading...</div>`;
  }
  if (listing.loading) return `<div class="arcodeExplorerLoading"${explorerDepthAttr(depth)}>Loading...</div>`;
  if (listing.error) return `<div class="arcodeExplorerLoading error"${explorerDepthAttr(depth)}>${escapeHtml(listing.error)}</div>`;
  const entries = Array.isArray(listing.entries) ? listing.entries.slice(0, 80) : [];
  if (!entries.length) return `<div class="arcodeExplorerLoading"${explorerDepthAttr(depth)}>Folder is empty.</div>`;
  return `
    <div class="arcodeExplorerChildren" role="group">
      ${entries.map((entry) => {
    const entryPath = String(entry.path || "");
    const supported = !entry.isDirectory && isSupportedCodeFile(entryPath);
    return [
      renderExplorerRow({
        path: entryPath,
        name: entry.name || filenameFromPath(entryPath) || entryPath,
        kind: entry.isDirectory ? "folder" : "file",
        depth,
        supported,
      }),
      entry.isDirectory ? renderExplorerChildren(entryPath, depth + 1) : "",
    ].join("");
  }).join("")}
    </div>
  `;
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
  const folders = state.workspaceFolders || [];
  const activeFolder = state.activeWorkspaceFolder || folders[0] || "";
  home.innerHTML = `
    <div class="arcodeHomeLayout">
      <aside class="arcodeHomeSidebar" aria-label="Explorer">
        <div class="arcodeExplorerWorkspace">
          <div class="arcodeExplorerWorkspaceName">Arcode Workspace</div>
        </div>
        <div class="arcodeExplorerFolders" role="tree" aria-label="Workspace folders">
          ${folders.length ? folders.map((folderPath) => `
            ${renderExplorerRow({
              path: folderPath,
              name: filenameFromPath(folderPath) || folderPath,
              kind: "root-folder",
              depth: 0,
              active: folderPath === activeFolder,
            })}
            ${renderExplorerChildren(folderPath)}
          `).join("") : `
            <div class="arcodeExplorerEmpty">
              <div>No folder selected.</div>
              <button id="arcodeExplorerEmptySelectBtn" class="arcodeHomeBtn primary" type="button">Select Folder</button>
            </div>
          `}
        </div>
        <div class="arcodeHomeActions">
          <button id="arcodeHomeOpenBtn" class="arcodeHomeBtn primary" type="button">Open File</button>
          <button id="arcodeHomeNewBtn" class="arcodeHomeBtn" type="button">New Notebook</button>
        </div>
      </aside>
      <section class="arcodeHomeContent">
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
  $("arcodeExplorerEmptySelectBtn")?.addEventListener("click", () => pickWorkspaceFolder({ replace: true }));
  home.querySelectorAll(".arcodeExplorerEntry").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const filePath = decodeURIComponent(button.getAttribute("data-path") || "");
      if (!filePath) return;
      if (button.dataset.kind === "folder" || button.dataset.kind === "root-folder") {
        state.activeWorkspaceFolder = button.dataset.kind === "root-folder" ? filePath : state.activeWorkspaceFolder;
        saveWorkspaceFolders();
        const expanded = button.getAttribute("aria-expanded") === "true";
        setExplorerPathExpanded(filePath, !expanded);
        updateStatus(`${expanded ? "Collapsed" : "Expanded"} folder ${filePath}.`);
        return;
      }
      if (isSupportedCodeFile(filePath)) openCodeTab({ path: filePath });
      else updateStatus("Only .py, .sql, and .ipynb files open in Arcode tabs right now.");
    });
  });
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

let tabPointerDrag = null;
let suppressNextTabClick = false;
let tabDragEl = null;
let tabPlaceholderEl = null;
let tabDropIndicatorEl = null;
let tabHostPrevStyle = null;
let tabDragPrevStyle = null;
let tabDragBaseLeft = 0;
let tabDragBaseTop = 0;
let tabDragPrevVisibility = null;
let tabLastPlaceholderIndex = -1;

function consumeSuppressedTabClick(event) {
  if (!suppressNextTabClick) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function codeTabElements() {
  return Array.from($("arcodeTabs")?.querySelectorAll(".arcodeTab[data-tab-id]:not(.arcodeHomeTab):not(.placeholder)") || []);
}

function ensureTabDropIndicator(host) {
  if (tabDropIndicatorEl && tabDropIndicatorEl.isConnected) return tabDropIndicatorEl;
  let el = $("arcodeDropIndicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "arcodeDropIndicator";
    host?.appendChild(el);
  }
  tabDropIndicatorEl = el;
  return el;
}

function showTabDropIndicator(host, x) {
  const indicator = ensureTabDropIndicator(host);
  const rect = host?.getBoundingClientRect?.();
  if (!indicator || !rect) return;
  const left = Math.max(0, Math.min(rect.width, x - rect.left));
  indicator.style.left = `${left}px`;
  indicator.style.display = "block";
}

function hideTabDropIndicator() {
  if (tabDropIndicatorEl) tabDropIndicatorEl.style.display = "none";
}

function lockTabHostLayout(host) {
  if (!host || tabHostPrevStyle) return;
  const rect = host.getBoundingClientRect();
  tabHostPrevStyle = {
    height: host.style.height,
    minHeight: host.style.minHeight,
    flexWrap: host.style.flexWrap,
    overflowX: host.style.overflowX,
    overflowY: host.style.overflowY,
    alignItems: host.style.alignItems,
  };
  host.style.height = `${Math.ceil(rect.height)}px`;
  host.style.minHeight = host.style.height;
  host.style.flexWrap = "nowrap";
  host.style.overflowX = "hidden";
  host.style.overflowY = "hidden";
  host.style.alignItems = "flex-end";
}

function unlockTabHostLayout() {
  const host = $("arcodeTabs");
  if (!host || !tabHostPrevStyle) return;
  host.style.height = tabHostPrevStyle.height;
  host.style.minHeight = tabHostPrevStyle.minHeight;
  host.style.flexWrap = tabHostPrevStyle.flexWrap;
  host.style.overflowX = tabHostPrevStyle.overflowX;
  host.style.overflowY = tabHostPrevStyle.overflowY;
  host.style.alignItems = tabHostPrevStyle.alignItems;
  tabHostPrevStyle = null;
}

function ensureTabPlaceholderFrom(el) {
  if (tabPlaceholderEl && tabPlaceholderEl.isConnected) return tabPlaceholderEl;
  const rect = el.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "arcodeTab placeholder";
  placeholder.innerHTML = "&nbsp;";
  placeholder.style.width = `${Math.ceil(rect.width)}px`;
  placeholder.style.height = `${Math.ceil(rect.height)}px`;
  tabPlaceholderEl = placeholder;
  return placeholder;
}

function flipAnimateArcodeTabs(host, beforeRects) {
  host.querySelectorAll(".arcodeTab[data-tab-id]:not(.arcodeHomeTab)").forEach((el) => {
    const id = el.dataset.tabId;
    if (!id || id === tabPointerDrag?.tabId || el.classList.contains("placeholder")) return;
    const before = beforeRects.get(id);
    const after = el.getBoundingClientRect();
    if (!before || !after) return;
    const dx = before.left - after.left;
    if (Math.abs(dx) < 0.5) return;
    if (el.__arcodeFlipAnim) {
      try { el.__arcodeFlipAnim.cancel(); } catch {}
      el.__arcodeFlipAnim = null;
    }
    el.__arcodeFlipAnim = el.animate(
      [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0px)" }],
      { duration: 140, easing: "ease-out" },
    );
  });
}

function startTabReorderDrag(host, el, pointerId) {
  if (!host || !el || tabDragPrevStyle) return;
  tabPointerDrag.dragging = true;
  tabDragEl = el;
  lockTabHostLayout(host);
  document.body.classList.add("tab-dragging");
  try { document.body.style.cursor = "grabbing"; } catch {}
  el.classList.add("dragging");
  const hostRect = host.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  tabDragPrevStyle = {
    position: el.style.position,
    left: el.style.left,
    top: el.style.top,
    width: el.style.width,
    height: el.style.height,
    zIndex: el.style.zIndex,
    pointerEvents: el.style.pointerEvents,
    transform: el.style.transform,
    visibility: el.style.visibility,
  };
  tabDragPrevVisibility = el.style.visibility;
  tabDragBaseLeft = (rect.left - hostRect.left) + host.scrollLeft;
  tabDragBaseTop = rect.top - hostRect.top;
  el.style.width = `${Math.ceil(rect.width)}px`;
  el.style.height = `${Math.ceil(rect.height)}px`;
  el.style.position = "absolute";
  el.style.left = `${Math.round(tabDragBaseLeft)}px`;
  el.style.top = `${Math.round(tabDragBaseTop)}px`;
  el.style.zIndex = "1000";
  el.style.pointerEvents = "none";
  el.style.transform = "translate3d(0px, 0px, 0px)";
  host.insertBefore(ensureTabPlaceholderFrom(el), el);
  closeTabContextMenu();
  try { el.setPointerCapture(pointerId); } catch {}
}

function updateTabReorderDrag(clientX) {
  const host = $("arcodeTabs");
  if (!host || !tabDragEl || !tabPlaceholderEl) return;
  const tabs = codeTabElements().filter((el) => el.dataset.tabId !== tabPointerDrag?.tabId);
  let targetNode = null;
  let indicatorX = null;
  for (const node of tabs) {
    const rect = node.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      targetNode = node;
      indicatorX = rect.left;
      break;
    }
  }
  const beforeRects = new Map();
  tabs.forEach((el) => {
    const id = el.dataset.tabId;
    if (id) beforeRects.set(id, el.getBoundingClientRect());
  });
  if (targetNode) {
    if (tabPlaceholderEl.nextSibling !== targetNode) host.insertBefore(tabPlaceholderEl, targetNode);
    showTabDropIndicator(host, indicatorX);
  } else {
    const insertBeforeNode = $("arcodeDropIndicator");
    if (tabPlaceholderEl.parentNode !== host || tabPlaceholderEl.nextSibling !== insertBeforeNode) {
      host.insertBefore(tabPlaceholderEl, insertBeforeNode);
    }
    showTabDropIndicator(host, host.getBoundingClientRect().right - 2);
  }
  const newIndex = Array.from(host.children).indexOf(tabPlaceholderEl);
  if (newIndex !== tabLastPlaceholderIndex) {
    tabLastPlaceholderIndex = newIndex;
    flipAnimateArcodeTabs(host, beforeRects);
  }
}

function commitTabOrderFromDom() {
  const host = $("arcodeTabs");
  if (!host || !tabPointerDrag?.tabId || !tabPlaceholderEl) return;
  const sequence = [];
  for (const child of host.children) {
    if (child === tabPlaceholderEl) {
      sequence.push("__PLACEHOLDER__");
      continue;
    }
    if (!child.classList?.contains("arcodeTab") || child.classList.contains("arcodeHomeTab")) continue;
    const id = child.dataset.tabId;
    if (!id || id === tabPointerDrag.tabId) continue;
    sequence.push(id);
  }
  const placeholderIndex = sequence.indexOf("__PLACEHOLDER__");
  if (placeholderIndex < 0) return;
  const ids = sequence.filter((id) => id !== "__PLACEHOLDER__");
  ids.splice(Math.max(0, Math.min(ids.length, placeholderIndex)), 0, tabPointerDrag.tabId);
  const map = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const reordered = ids.map((id) => map.get(id)).filter(Boolean);
  for (const tab of state.tabs) {
    if (!reordered.some((item) => item.id === tab.id)) reordered.push(tab);
  }
  state.tabs = reordered;
}

function clearTabPointerDrag({ suppressClick = false } = {}) {
  if (suppressClick) {
    suppressNextTabClick = true;
    window.setTimeout(() => {
      suppressNextTabClick = false;
    }, 0);
  }
  hideTabDropIndicator();
  if (tabDragEl) tabDragEl.classList.remove("dragging");
  if (tabPlaceholderEl?.parentNode) tabPlaceholderEl.parentNode.removeChild(tabPlaceholderEl);
  if (tabDragEl && tabDragPrevStyle) {
    tabDragEl.style.position = tabDragPrevStyle.position;
    tabDragEl.style.left = tabDragPrevStyle.left;
    tabDragEl.style.top = tabDragPrevStyle.top;
    tabDragEl.style.width = tabDragPrevStyle.width;
    tabDragEl.style.height = tabDragPrevStyle.height;
    tabDragEl.style.zIndex = tabDragPrevStyle.zIndex;
    tabDragEl.style.pointerEvents = tabDragPrevStyle.pointerEvents;
    tabDragEl.style.transform = tabDragPrevStyle.transform;
    tabDragEl.style.visibility = tabDragPrevStyle.visibility;
  } else if (tabDragEl && tabDragPrevVisibility != null) {
    tabDragEl.style.visibility = tabDragPrevVisibility;
  }
  tabPlaceholderEl = null;
  tabDragPrevStyle = null;
  tabDragPrevVisibility = null;
  tabDragBaseLeft = 0;
  tabDragBaseTop = 0;
  tabDragEl = null;
  tabLastPlaceholderIndex = -1;
  tabPointerDrag = null;
  document.body.classList.remove("tab-dragging");
  try { document.body.style.cursor = ""; } catch {}
  unlockTabHostLayout();
  window.removeEventListener("pointermove", handleTabPointerMove, true);
  window.removeEventListener("pointerup", handleTabPointerUp, true);
  window.removeEventListener("pointercancel", handleTabPointerCancel, true);
}

function handleTabPointerMove(event) {
  if (!tabPointerDrag || event.pointerId !== tabPointerDrag.pointerId) return;
  const dx = event.clientX - tabPointerDrag.startX;
  if (!tabPointerDrag.dragging) {
    if (Math.abs(dx) < TAB_DRAG_THRESHOLD_PX) return;
    startTabReorderDrag($("arcodeTabs"), tabPointerDrag.el, event.pointerId);
  }
  if (!tabPointerDrag.dragging || !tabDragEl) return;
  event.preventDefault();
  tabDragEl.style.transform = `translate3d(${dx}px, 0px, 0px)`;
  updateTabReorderDrag(event.clientX);
}

function handleTabPointerUp(event) {
  if (!tabPointerDrag || event.pointerId !== tabPointerDrag.pointerId) return;
  const wasDragging = !!tabPointerDrag.dragging;
  const tab = state.tabs.find((item) => item.id === tabPointerDrag.tabId);
  if (wasDragging) event.preventDefault();
  if (wasDragging) commitTabOrderFromDom();
  clearTabPointerDrag({ suppressClick: wasDragging });
  if (wasDragging) {
    render();
    if (tab) updateStatus(`Moved ${tabTitle(tab)}.`);
  }
}

function handleTabPointerCancel(event) {
  if (!tabPointerDrag || event.pointerId !== tabPointerDrag.pointerId) return;
  clearTabPointerDrag({ suppressClick: !!tabPointerDrag.dragging });
}

function startTabPointerDrag(event, tabId) {
  if (event.button !== 0 || event.target?.closest?.(".arcodeTabClose")) return;
  if (tabPointerDrag) clearTabPointerDrag();
  tabPointerDrag = {
    tabId,
    el: event.currentTarget,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
  };
  try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch {}
  window.addEventListener("pointermove", handleTabPointerMove, true);
  window.addEventListener("pointerup", handleTabPointerUp, true);
  window.addEventListener("pointercancel", handleTabPointerCancel, true);
}

function renderTabs() {
  const container = $("arcodeTabs");
  if (!container) return;
  container.textContent = "";
  const homeItem = document.createElement("div");
  homeItem.className = `arcodeTab arcodeHomeTab${state.activeId === "home" ? " active" : ""}`;
  homeItem.dataset.tabId = "home";
  homeItem.title = "Home";
  const homeTitle = document.createElement("div");
  homeTitle.className = "arcodeTabTitle";
  homeTitle.textContent = "Home";
  homeItem.appendChild(homeTitle);
  homeItem.addEventListener("click", (event) => {
    if (consumeSuppressedTabClick(event)) return;
    setActiveTab("home");
  });
  container.appendChild(homeItem);

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
    if (tab.dirty) {
      close.classList.add("dirty");
      close.title = "Unsaved changes (close tab)";
      const dot = document.createElement("span");
      dot.className = "dirtyDot";
      close.appendChild(dot);
    }
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    item.append(title, close);
    item.addEventListener("pointerdown", (event) => startTabPointerDrag(event, tab.id));
    item.addEventListener("click", (event) => {
      if (consumeSuppressedTabClick(event)) return;
      setActiveTab(tab.id);
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      setActiveTab(tab.id);
      openTabContextMenu(tab.id, event.clientX, event.clientY);
    });
    container.appendChild(item);
  }
  ensureTabDropIndicator(container);
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
  updateMenuState();
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
  return `/ui/arcode/scripting-console/?${params.toString()}`;
}

function createFrameForTab(tab) {
  const iframe = document.createElement("iframe");
  iframe.className = "arcodeFrame";
  iframe.dataset.tabId = tab.id;
  iframe.src = buildScriptingUrl(tab);
  iframe.addEventListener("load", () => {
    if (tab.path) {
      postToTab(tab, { type: "arcode:scripting-open-path", path: tab.path });
    }
    postToTab(tab, { type: "arcode:autosave-toggle", enabled: state.autoSaveEnabled });
    postToTab(tab, { type: "arcode:set-zoom", zoom: state.zoomPercent, statusBarHeight: 28 });
    wireFrameFileDropTarget(iframe);
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
  if (action === "file_save") return sendScriptingCommand("arcode:scripting-save");
  if (action === "file_save_as") return sendScriptingCommand("arcode:scripting-save-as");
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
    if (msg.type === "arcode:update-active-tab-title") {
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
    if (msg.type === "arcode:scripting-dirty") {
      const tab = updateTabFromMessage(msg, event.source);
      if (!tab) return;
      tab.dirty = !!msg.dirty;
      renderTabs();
      return;
    }
    if (msg.type === "arcode:status") {
      updateStatus(msg.text || "");
      return;
    }
    if (msg.type === "arcode:hotkey") {
      handleHotkey(String(msg.action || ""));
      return;
    }
    if (msg.type === "arcode:close-active-tab") {
      const tab = activeTab();
      if (tab) closeTab(tab.id);
      return;
    }
    if (msg.type === "arcode:open-file") {
      const filePath = String(msg.path || "").trim();
      if (filePath) openCodeTab({ path: filePath });
      return;
    }
    if (msg.type === "arcode:zoom") {
      adjustZoomByDelta(msg.deltaY, { quiet: true });
      return;
    }
    if (msg.type === "arcode:zoom-step") {
      const delta = Number(msg.delta || 0);
      if (Number.isFinite(delta) && delta) setZoomPercent(state.zoomPercent + delta * ZOOM_STEP, { quiet: true });
      return;
    }
    if (msg.type === "arcode:zoom-reset") {
      setZoomPercent(100, { quiet: true });
      return;
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

function closeAllShellMenus() {
  document.querySelectorAll(".menuDropdown.open").forEach((el) => el.classList.remove("open"));
  document.querySelectorAll(".menu.open").forEach((el) => el.classList.remove("open"));
  closeTabContextMenu();
}

function positionMenu(button, dropdown) {
  if (!button || !dropdown) return;
  const rect = button.getBoundingClientRect();
  dropdown.style.left = `${Math.round(rect.left)}px`;
  dropdown.style.top = `${Math.round(rect.bottom + 6)}px`;
}

function toggleMenu(menuName, forceOpen) {
  const button = document.querySelector(`.menu[data-menu="${menuName}"]`);
  const dropdown = $(`${menuName}MenuDropdown`);
  if (!button || !dropdown) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !dropdown.classList.contains("open");
  closeAllShellMenus();
  button.classList.toggle("open", shouldOpen);
  dropdown.classList.toggle("open", shouldOpen);
  if (shouldOpen) {
    updateMenuState();
    positionMenu(button, dropdown);
  }
}

function setMenuItemDisabled(action, disabled) {
  document.querySelectorAll(`.menuItem[data-action="${action}"], .tabCtxItem[data-action="${action}"]`).forEach((el) => {
    el.classList.toggle("disabled", !!disabled);
  });
}

function updateMenuState() {
  const hasTab = !!activeTab();
  const hasPath = !!activeTab()?.path;
  ["save", "save-as", "close-tab", "close-others", "close-all", "render-markdown", "toggle-line-numbers", "toggle-exec-time", "refresh-tab", "hard-refresh", "rename"].forEach((action) => {
    setMenuItemDisabled(action, !hasTab);
  });
  setMenuItemDisabled("open-file-location", !hasPath);
  setMenuItemDisabled("copy-file-path", !hasPath);
}

function closeTabsExcept(keepId) {
  const keep = state.tabs.find((tab) => tab.id === keepId) || null;
  const closing = state.tabs.filter((tab) => tab.id !== keepId);
  const dirty = closing.filter((tab) => tab.dirty);
  if (dirty.length) {
    const confirmed = window.confirm(`${dirty.length} file${dirty.length === 1 ? " has" : "s have"} unsaved changes. Close anyway?`);
    if (!confirmed) return;
  }
  for (const tab of closing) closeTab(tab.id, true);
  if (keep) setActiveTab(keep.id);
}

function closeAllTabs() {
  const dirty = state.tabs.filter((tab) => tab.dirty);
  if (dirty.length) {
    const confirmed = window.confirm(`${dirty.length} file${dirty.length === 1 ? " has" : "s have"} unsaved changes. Close anyway?`);
    if (!confirmed) return;
  }
  for (const tab of [...state.tabs]) closeTab(tab.id, true);
}

function reloadActiveTab({ hard = false } = {}) {
  const tab = activeTab();
  if (!tab?.iframe) return;
  if (hard) {
    tab.forceFresh = false;
    tab.scInst = `${tab.id}_${Date.now()}`;
    tab.iframe.src = buildScriptingUrl(tab);
  } else {
    tab.iframe.contentWindow?.location?.reload();
  }
  updateStatus(hard ? "Reloading tab without cache..." : "Reloading tab...");
}

function setAutoSaveEnabled(enabled, { quiet = false } = {}) {
  state.autoSaveEnabled = !!enabled;
  const button = $("arcodeAutoSaveSwitch");
  const label = $("arcodeAutoSaveState");
  button?.classList.toggle("on", state.autoSaveEnabled);
  button?.setAttribute("aria-checked", state.autoSaveEnabled ? "true" : "false");
  if (label) label.textContent = state.autoSaveEnabled ? "On" : "Off";
  for (const tab of state.tabs) postToTab(tab, { type: "arcode:autosave-toggle", enabled: state.autoSaveEnabled });
  if (!quiet) updateStatus(`AutoSave ${state.autoSaveEnabled ? "enabled" : "disabled"}.`);
}

function initAutoSaveControl() {
  $("arcodeAutoSaveSwitch")?.addEventListener("click", () => setAutoSaveEnabled(!state.autoSaveEnabled));
  setAutoSaveEnabled(state.autoSaveEnabled, { quiet: true });
}

function hostZoomAvailable() {
  return typeof window.ADAHost?.setZoomFactor === "function";
}

function updateZoomUI() {
  const range = $("zoomRange");
  const value = $("zoomValue");
  if (range) range.value = String(state.zoomPercent);
  if (value) value.textContent = `${state.zoomPercent}%`;
}

function broadcastZoom() {
  for (const tab of state.tabs) postToTab(tab, { type: "arcode:set-zoom", zoom: state.zoomPercent, statusBarHeight: 28 });
}

function setZoomPercent(value, { quiet = false } = {}) {
  const next = normalizeZoomPercent(value, DEFAULT_ZOOM_PERCENT);
  state.zoomPercent = Number.isFinite(next) ? next : DEFAULT_ZOOM_PERCENT;
  const scale = state.zoomPercent / 100;
  try { localStorage.setItem(ZOOM_STORAGE_KEY, String(state.zoomPercent)); } catch {}
  try { localStorage.setItem(STATUSBAR_H_KEY, "28"); } catch {}
  if (hostZoomAvailable()) {
    try { localStorage.setItem(ZOOM_MODE_KEY, "host"); } catch {}
    window.ADAHost.setZoomFactor(scale);
  } else {
    try { localStorage.setItem(ZOOM_MODE_KEY, "css"); } catch {}
    document.documentElement.style.zoom = String(scale);
  }
  updateZoomUI();
  broadcastZoom();
  void saveArcodeUserSettings();
  if (!quiet) updateStatus(`Zoom ${state.zoomPercent}%.`);
}

function adjustZoomByDelta(deltaY, options = {}) {
  const delta = Number(deltaY || 0);
  if (!Number.isFinite(delta) || !delta) return;
  setZoomPercent(state.zoomPercent + (delta > 0 ? -ZOOM_STEP : ZOOM_STEP), options);
}

function initZoomControls() {
  state.zoomPercent = normalizeZoomPercent(state.zoomPercent, DEFAULT_ZOOM_PERCENT);
  $("zoomOutBtn")?.addEventListener("click", () => setZoomPercent(state.zoomPercent - ZOOM_STEP));
  $("zoomInBtn")?.addEventListener("click", () => setZoomPercent(state.zoomPercent + ZOOM_STEP));
  $("zoomRange")?.addEventListener("input", (event) => {
    const value = $("zoomValue");
    if (value) value.textContent = `${event.target.value}%`;
  });
  $("zoomRange")?.addEventListener("change", (event) => setZoomPercent(event.target.value));
  setZoomPercent(state.zoomPercent, { quiet: true });
}

function activePath() {
  return String(activeTab()?.path || "").trim();
}

async function openActiveFileLocation() {
  const path = activePath();
  if (!path) return updateStatus("No file path for this tab.");
  const result = await window.ADAHost?.showItemInFolder?.({ path });
  updateStatus(result?.ok === false ? (result.error || "Could not reveal file.") : "Opened file location.");
}

async function copyActiveFilePath() {
  const path = activePath();
  if (!path) return updateStatus("No file path for this tab.");
  try {
    await navigator.clipboard.writeText(path);
    updateStatus("Copied file path.");
  } catch {
    updateStatus("Could not copy file path.");
  }
}

function requestActiveRename() {
  const tab = activeTab();
  if (!tab) return;
  postToTab(tab, { type: "arcode:scripting-rename-notebook" });
}

function toggleCreateMenu(forceOpen) {
  const button = $("arcodeNewBtn");
  const dropdown = $("arcodeCreateMenu");
  if (!button || !dropdown) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !dropdown.classList.contains("open");
  closeAllShellMenus();
  dropdown.classList.toggle("open", shouldOpen);
  if (shouldOpen) positionMenu(button, dropdown);
}
async function runShellAction(action) {
  if (!action) return;
  if (action === "new-notebook") return openCodeTab({ forceFresh: true });
  if (action === "create-notebook") return openCodeTab({ forceFresh: true });
  if (action === "create-python") return updateStatus("Python item creation is a placeholder.");
  if (action === "create-mssql") return updateStatus("MSSQL connection item is a placeholder.");
  if (action === "create-snowflake") return updateStatus("Snowflake connection item is a placeholder.");
  if (action === "open-file") return openFileDialog();
  if (action === "select-folder") return pickWorkspaceFolder({ replace: true });
  if (action === "add-folder") return pickWorkspaceFolder({ replace: false });
  if (action === "save") return sendScriptingCommand("arcode:scripting-save");
  if (action === "save-as") return sendScriptingCommand("arcode:scripting-save-as");
  if (action === "close-tab") return activeTab() ? closeTab(state.activeId) : undefined;
  if (action === "quit") {
    if (confirmWindowClose()) window.ADAHost?.closeWindow?.();
    return;
  }
  if (action === "render-markdown") return sendScriptingCommand("arcode:scripting-render-all-markdown");
  if (action === "toggle-line-numbers") return sendScriptingCommand("arcode:scripting-toggle-line-numbers");
  if (action === "toggle-exec-time") return sendScriptingCommand("arcode:scripting-toggle-exec-time");
  if (action === "zoom-in") return setZoomPercent(state.zoomPercent + ZOOM_STEP);
  if (action === "zoom-out") return setZoomPercent(state.zoomPercent - ZOOM_STEP);
  if (action === "zoom-reset") return setZoomPercent(100);
  if (action === "refresh-tab") return reloadActiveTab();
  if (action === "hard-refresh") return reloadActiveTab({ hard: true });
  if (action === "clear-cache-reload") {
    if (typeof window.ADAHost?.clearCacheAndReload !== "function") {
      updateStatus("Clear Cache & Reload requires the desktop app host.");
      return;
    }
    const saved = await saveArcodeUserSettings({ reportFailure: true });
    if (saved?.ok === false) {
      updateStatus(`Clear Cache & Reload canceled: ${saved.error || "Unable to save Arcode settings."}`);
      return;
    }
    updateStatus("Clearing cache and reloading...");
    return window.ADAHost.clearCacheAndReload({});
  }
  if (action === "new-window") return window.ADAHost?.openArcodeWindow?.({});
  if (action === "close-others") return activeTab() ? closeTabsExcept(state.activeId) : undefined;
  if (action === "close-all") return closeAllTabs();
  if (action === "minimize-window") return window.ADAHost?.minimizeWindow?.();
  if (action === "toggle-maximize") {
    const maximized = await window.ADAHost?.isMaximized?.();
    return maximized ? window.ADAHost?.restoreWindow?.() : window.ADAHost?.maximizeWindow?.();
  }
  if (action === "view-dev-panel") return window.ADAHost?.toggleDevPanel?.();
  if (action === "rename") return requestActiveRename();
  if (action === "open-file-location") return openActiveFileLocation();
  if (action === "copy-file-path") return copyActiveFilePath();
}

function initShellMenus() {
  document.querySelectorAll(".menu[data-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu(button.dataset.menu || "");
    });
  });
  document.querySelectorAll(".menuDropdown").forEach((dropdown) => {
    dropdown.addEventListener("click", (event) => {
      const item = event.target?.closest?.(".menuItem");
      if (!item || item.classList.contains("disabled")) return;
      closeAllShellMenus();
      void runShellAction(item.dataset.action || "");
    });
  });
  window.addEventListener("click", () => closeAllShellMenus());
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeAllShellMenus(); });
  updateMenuState();
}

let tabCtxId = "";

function closeTabContextMenu() {
  const menu = $("tabCtxMenu");
  menu?.classList.remove("open");
  tabCtxId = "";
}

function openTabContextMenu(tabId, x, y) {
  const menu = $("tabCtxMenu");
  if (!menu) return;
  tabCtxId = tabId;
  updateMenuState();
  const tab = state.tabs.find((item) => item.id === tabId);
  menu.querySelectorAll(".tabCtxItem").forEach((item) => {
    const action = item.dataset.action || "";
    const disabled = !tab || ((action === "open-file-location" || action === "copy-file-path") && !tab.path);
    item.classList.toggle("disabled", disabled);
  });
  menu.classList.add("open");
  const pad = 8;
  const maxX = window.innerWidth - menu.offsetWidth - pad;
  const maxY = window.innerHeight - menu.offsetHeight - pad;
  menu.style.left = `${Math.max(pad, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(pad, Math.min(y, maxY))}px`;
}

function initTabContextMenu() {
  $("tabCtxMenu")?.addEventListener("click", (event) => {
    const item = event.target?.closest?.(".tabCtxItem");
    if (!item || item.classList.contains("disabled")) return;
    const tab = state.tabs.find((entry) => entry.id === tabCtxId);
    if (tab) setActiveTab(tab.id);
    closeAllShellMenus();
    void runShellAction(item.dataset.action || "");
  });
}

function shouldIgnoreHotkey(event) {
  const tag = event.target?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable;
}

function initHotkeys() {
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && !event.altKey && (event.key === "-" || event.key === "_")) { event.preventDefault(); setZoomPercent(state.zoomPercent - ZOOM_STEP); return; }
    if (event.ctrlKey && !event.altKey && (event.key === "=" || event.key === "+")) { event.preventDefault(); setZoomPercent(state.zoomPercent + ZOOM_STEP); return; }
    if (event.ctrlKey && !event.altKey && event.key === "0") { event.preventDefault(); setZoomPercent(100); return; }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "i") { event.preventDefault(); window.ADAHost?.toggleDevPanel?.(); return; }
    if (shouldIgnoreHotkey(event)) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.shiftKey && key === "n") { event.preventDefault(); openCodeTab({ forceFresh: true }); return; }
    if (event.ctrlKey && event.shiftKey && key === "n") { event.preventDefault(); window.ADAHost?.openArcodeWindow?.({}); return; }
    if (event.ctrlKey && !event.shiftKey && key === "o") { event.preventDefault(); openFileDialog(); return; }
    if (event.ctrlKey && !event.shiftKey && key === "s") { event.preventDefault(); sendScriptingCommand("arcode:scripting-save"); return; }
    if (event.ctrlKey && event.shiftKey && key === "s") { event.preventDefault(); sendScriptingCommand("arcode:scripting-save-as"); return; }
    if ((event.ctrlKey && key === "w") || (event.altKey && key === "w")) { event.preventDefault(); if (activeTab()) closeTab(state.activeId); return; }
    if (event.ctrlKey && !event.shiftKey && key === "r") { event.preventDefault(); reloadActiveTab(); return; }
    if (event.ctrlKey && event.shiftKey && key === "r") { event.preventDefault(); reloadActiveTab({ hard: true }); return; }
    if (event.ctrlKey && event.shiftKey && key === "l") { event.preventDefault(); sendScriptingCommand("arcode:scripting-toggle-line-numbers"); return; }
    if (event.ctrlKey && event.shiftKey && key === "e") { event.preventDefault(); sendScriptingCommand("arcode:scripting-toggle-exec-time"); return; }
    if (event.ctrlKey && key === "q") { event.preventDefault(); if (confirmWindowClose()) window.ADAHost?.closeWindow?.(); }
  }, { capture: true });
  window.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    adjustZoomByDelta(event.deltaY || event.deltaX, { quiet: true });
  }, { capture: true, passive: false });
}
function initToolbarControls() {
  $("arcodeOpenBtn")?.addEventListener("click", openFileDialog);
  $("arcodeNewBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCreateMenu();
  });
}

let arcodeFileDropsWired = false;
let arcodeDropOverlayTimer = 0;
const arcodeFrameDropTargets = new WeakSet();

function getPathExtension(pathLike) {
  const value = String(pathLike || "").trim().toLowerCase();
  const dot = value.lastIndexOf(".");
  return dot >= 0 ? value.slice(dot) : "";
}

function hasExternalFiles(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return false;
  const types = Array.from(transfer.types || []);
  if (types.includes("Files")) return true;
  return Array.from(transfer.items || []).some((item) => item?.kind === "file");
}

function getDroppedFilePath(file) {
  if (!file) return "";
  const host = getHostApi();
  if (typeof host?.getPathForFile === "function") {
    try {
      const resolved = host.getPathForFile(file);
      if (resolved) return String(resolved);
    } catch {
      // Fall through to Electron's legacy file.path when available.
    }
  }
  return typeof file.path === "string" ? file.path : "";
}

function getDroppedEntries(event) {
  return Array.from(event?.dataTransfer?.files || []).map((file) => {
    const path = getDroppedFilePath(file);
    const name = String(file?.name || filenameFromPath(path) || "").trim();
    const extension = getPathExtension(path || name);
    return { file, path, name, extension, supported: DROP_FILE_EXTENSIONS.has(extension) };
  });
}

function getSupportedDroppedPaths(event) {
  const seen = new Set();
  const paths = [];
  for (const entry of getDroppedEntries(event)) {
    if (!entry.supported || !entry.path) continue;
    const key = entry.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(entry.path);
  }
  return paths;
}

function ensureDropOverlay() {
  let overlay = $("arcodeFileDropOverlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "arcodeFileDropOverlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = `
    <div class="arcodeFileDropPanel">
      <div id="arcodeFileDropTitle" class="arcodeFileDropTitle">Drop to open in Arcode</div>
      <div id="arcodeFileDropDetail" class="arcodeFileDropDetail">.py, .sql, and .ipynb files are supported.</div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function showDropOverlay(event) {
  const overlay = ensureDropOverlay();
  const entries = getDroppedEntries(event);
  const supported = entries.filter((entry) => entry.supported);
  const unsupported = entries.length > 0 && supported.length === 0;
  const title = $("arcodeFileDropTitle");
  const detail = $("arcodeFileDropDetail");
  if (title) {
    title.textContent = unsupported
      ? "Drop a supported Arcode file"
      : supported.length > 1
        ? `Drop to open ${supported.length} files in Arcode`
        : "Drop to open in Arcode";
  }
  if (detail) {
    detail.textContent = unsupported
      ? "Only .py, .sql, and .ipynb files are supported."
      : supported.length === 1
        ? (supported[0].name || supported[0].path || ".py, .sql, and .ipynb files are supported.")
        : ".py, .sql, and .ipynb files are supported.";
  }
  overlay.classList.toggle("unsupported", unsupported);
  overlay.classList.add("open");
  window.clearTimeout(arcodeDropOverlayTimer);
  arcodeDropOverlayTimer = window.setTimeout(hideDropOverlay, 350);
}

function hideDropOverlay() {
  window.clearTimeout(arcodeDropOverlayTimer);
  arcodeDropOverlayTimer = 0;
  $("arcodeFileDropOverlay")?.classList.remove("open", "unsupported");
}

function handleArcodeFileDragOver(event) {
  if (!hasExternalFiles(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  showDropOverlay(event);
  return true;
}

function handleArcodeFileDrop(event) {
  if (!hasExternalFiles(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  hideDropOverlay();
  const paths = getSupportedDroppedPaths(event);
  if (!paths.length) {
    updateStatus("Drop a .py, .sql, or .ipynb file to open it in Arcode.");
    return true;
  }
  for (const path of paths) openCodeTab({ path });
  updateStatus(paths.length === 1 ? `Opened ${filenameFromPath(paths[0])}.` : `Opened ${paths.length} files.`);
  return true;
}

function wireFrameFileDropTarget(iframe) {
  const frameWindow = iframe?.contentWindow;
  if (!frameWindow || arcodeFrameDropTargets.has(frameWindow)) return;
  try {
    frameWindow.addEventListener("dragover", handleArcodeFileDragOver, true);
    frameWindow.addEventListener("drop", handleArcodeFileDrop, true);
    frameWindow.addEventListener("dragleave", () => {
      window.clearTimeout(arcodeDropOverlayTimer);
      arcodeDropOverlayTimer = window.setTimeout(hideDropOverlay, 120);
    }, true);
    arcodeFrameDropTargets.add(frameWindow);
  } catch {
    // If a frame is unavailable during navigation, the next load event will wire it.
  }
}

function initArcodeFileDrops() {
  if (arcodeFileDropsWired) return;
  arcodeFileDropsWired = true;
  window.addEventListener("dragover", handleArcodeFileDragOver, true);
  window.addEventListener("drop", handleArcodeFileDrop, true);
  window.addEventListener("dragleave", () => {
    window.clearTimeout(arcodeDropOverlayTimer);
    arcodeDropOverlayTimer = window.setTimeout(hideDropOverlay, 120);
  }, true);
  window.addEventListener("blur", hideDropOverlay);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideDropOverlay();
  }, true);
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

async function boot() {
  initShellApi();
  await loadArcodeUserSettings();
  initAppFrameStyle();
  initWindowControls();
  initShellMenus();
  initTabContextMenu();
  initToolbarControls();
  initAutoSaveControl();
  initZoomControls();
  initHotkeys();
  initArcodeFileDrops();
  initMessages();
  window.__arcode_confirm_window_close = confirmWindowClose;
  await loadExplorerFileIcons();
  render();
  initAiAssistant();
  if (initialOpenPath) openCodeTab({ path: initialOpenPath });
}

void boot();
