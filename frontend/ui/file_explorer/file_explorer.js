import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js?v=20260715a";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260715a";
import { createFileIconResolver } from "/ui/shared/file-icons/fileIconResolver.js?v=20260722a";
import { pushWorkspaceHistoryEntry } from "/ui/shared/services/workspace_history.js?v=20260726a";
import { isExcelWorkbookPath } from "/ui/shared/tabs/notes/notes_paths.js?v=20260722a";
import {
  FILE_EXPLORER_FAVORITES_SCHEMA_VERSION,
  defaultHomeFolderNickname,
  filterAndSortHomeFileEntries,
  formatHomeFileDate,
  formatHomeFileSize,
  getHomeFileTypeLabel,
  homeFolderPathKey,
  normalizeHomeFileEntries,
  normalizeHomeFolderShortcuts,
  normalizeHomeFoldersDocument,
  parentFolderPath,
} from "./file_explorer_model.js?v=20260723a";

const HOME_FOLDERS_STORAGE_KEY = "arcrho_home_folder_preferences_v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "arcrho_file_explorer_sidebar_width_v1";
const FILE_ICON_BASE_PATH = "/ui/shared/file-icons/";
const FILE_ICON_MAP_URL = `${FILE_ICON_BASE_PATH}file-icon-map.json?v=20260722a`;
const WATCH_REFRESH_DELAY_MS = 220;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

const svgIcon = (name) => {
  const paths = {
    add: '<path d="M8 3v10M3 8h10"></path>',
    back: '<path d="M10.5 3.5L6 8l4.5 4.5"></path>',
    forward: '<path d="M5.5 3.5L10 8l-4.5 4.5"></path>',
    up: '<path d="M3.5 10.5L8 6l4.5 4.5"></path>',
    refresh: '<path d="M12.5 6A5 5 0 1 0 13 9"></path><path d="M10.5 3.5H13V6"></path>',
    search: '<circle cx="7" cy="7" r="4"></circle><path d="M10 10l3.5 3.5"></path>',
    location: '<path d="M2.5 5.5h4l1.5 1.5h5.5v6h-11z"></path><path d="M2.5 5.5v-2h4l1.5 2"></path>',
    more: '<circle cx="3.5" cy="8" r=".8"></circle><circle cx="8" cy="8" r=".8"></circle><circle cx="12.5" cy="8" r=".8"></circle>',
    close: '<path d="M4 4l8 8M12 4l-8 8"></path>',
  };
  return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
};

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const encodePath = (value) => encodeURIComponent(String(value || ""));
const decodePath = (value) => {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
};

function readLocalPreferences() {
  try {
    return JSON.parse(localStorage.getItem(HOME_FOLDERS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLocalPreferences(preferences) {
  try {
    localStorage.setItem(HOME_FOLDERS_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

function visibleMenuItems(menu) {
  return Array.from(menu?.querySelectorAll?.('[role="menuitem"]') || [])
    .filter((item) => !item.hidden && !item.disabled);
}

function readSidebarWidth() {
  try {
    const width = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(width) ? Math.round(width) : 220;
  } catch {
    return 220;
  }
}

export function createFileExplorerController(homeView, options = {}) {
  if (!homeView) return null;

  const state = {
    folders: normalizeHomeFoldersDocument(readLocalPreferences()).folders,
    activeShortcutPath: "",
    currentPath: "",
    history: [],
    historyIndex: -1,
    entries: [],
    visibleEntries: [],
    selectedPath: "",
    query: "",
    sortKey: "name",
    sortDirection: "asc",
    loading: false,
    error: "",
    listingRequest: 0,
    preferencesRevision: 0,
    preferencesSaveChain: Promise.resolve(),
    resolveFileIconPath: null,
    watchId: "",
    watchPath: "",
    watchRefreshTimer: 0,
    unsubscribeWatch: null,
    dialogPath: "",
    dialogMode: "add",
    dialogReturnFocus: null,
    fileMenuEntry: null,
    shortcutMenuPath: "",
    menuReturnFocus: null,
    hostVisible: window.parent === window,
    favoritesReady: false,
    sidebarWidth: readSidebarWidth(),
  };

  const get = (selector) => homeView.querySelector(selector);
  const hostApi = () => window.ADAHost || window.parent?.ADAHost || window.top?.ADAHost || null;

  function setStatus(message, tone = "") {
    const text = String(message || "").trim();
    if (!text) return;
    if (typeof options.onStatus === "function") {
      options.onStatus(text, tone);
      return;
    }
    window.parent?.postMessage({
      type: "arcrho:status",
      text: `File Explorer: ${text}`,
      ...(tone ? { tone } : {}),
    }, "*");
  }

  function ensureMarkup() {
    const sidebarHost = get("#homeFoldersNav");
    const explorerPage = get("#homeFoldersPage");
    if (sidebarHost && !sidebarHost.dataset.rendered) {
      sidebarHost.innerHTML = `
        <div class="homeNavGroup homeFoldersNavGroup">
          <div class="homeNavGroupHeading">
            <div class="homeNavLabel">Favorites</div>
            <button id="homeAddFolderBtn" class="homeNavAddButton" type="button" aria-label="Add favorite folder" data-home-tooltip="Add favorite folder">
              ${svgIcon("add")}
            </button>
          </div>
          <div id="homeFolderShortcuts" class="homeFolderShortcuts" aria-label="Favorite folders"></div>
        </div>
      `;
      sidebarHost.dataset.rendered = "1";
    }
    if (explorerPage && !explorerPage.dataset.rendered) {
      explorerPage.innerHTML = `
        <header class="homeExplorerHeader">
          <div class="homeExplorerHeadingText">
            <h1 id="homeExplorerTitle" class="homeTitle">File Explorer</h1>
            <div id="homeExplorerSubtitle" class="homeSubtitle">Choose a favorite folder to browse its files.</div>
          </div>
        </header>
        <div class="homeExplorerCommandStrip" role="toolbar" aria-label="Folder navigation">
          <div class="homeExplorerNavButtons">
            <button id="homeExplorerBackBtn" class="homeExplorerIconButton" type="button" aria-label="Back" data-home-tooltip="Back">${svgIcon("back")}</button>
            <button id="homeExplorerForwardBtn" class="homeExplorerIconButton" type="button" aria-label="Forward" data-home-tooltip="Forward">${svgIcon("forward")}</button>
            <button id="homeExplorerUpBtn" class="homeExplorerIconButton" type="button" aria-label="Up one level" data-home-tooltip="Up one level">${svgIcon("up")}</button>
            <button id="homeExplorerRefreshBtn" class="homeExplorerIconButton" type="button" aria-label="Refresh" data-home-tooltip="Refresh">${svgIcon("refresh")}</button>
          </div>
          <label class="homeExplorerAddressField">
            <span class="homeExplorerFieldIcon" aria-hidden="true">${svgIcon("location")}</span>
            <span class="srOnly">Folder path</span>
            <input id="homeExplorerAddress" type="text" spellcheck="false" autocomplete="off" aria-label="Folder path" />
          </label>
          <label class="homeExplorerSearchField">
            <span class="homeExplorerFieldIcon" aria-hidden="true">${svgIcon("search")}</span>
            <span class="srOnly">Search this folder</span>
            <input id="homeExplorerSearch" type="search" spellcheck="false" autocomplete="off" aria-label="Search this folder" placeholder="Search this folder" />
          </label>
        </div>
        <div class="homeExplorerTableFrame">
          <table id="homeExplorerTable" class="homeExplorerTable" role="grid" aria-label="Files" aria-multiselectable="false" tabindex="0">
            <colgroup><col class="homeExplorerNameColumn" /><col class="homeExplorerDateColumn" /><col class="homeExplorerTypeColumn" /><col class="homeExplorerSizeColumn" /></colgroup>
            <thead>
              <tr role="row">
                <th scope="col" data-sort-key="name" aria-sort="ascending"><button type="button">Name<span class="homeExplorerSortMark" aria-hidden="true"></span></button></th>
                <th scope="col" data-sort-key="date" aria-sort="none"><button type="button">Date modified<span class="homeExplorerSortMark" aria-hidden="true"></span></button></th>
                <th scope="col" data-sort-key="type" aria-sort="none"><button type="button">Type<span class="homeExplorerSortMark" aria-hidden="true"></span></button></th>
                <th scope="col" data-sort-key="size" aria-sort="none"><button type="button">Size<span class="homeExplorerSortMark" aria-hidden="true"></span></button></th>
              </tr>
            </thead>
            <tbody id="homeExplorerTableBody"></tbody>
          </table>
        </div>
        <footer class="homeExplorerFooter" aria-live="polite">
          <span id="homeExplorerItemCount">No folder selected</span>
          <span id="homeExplorerSelectionStatus"></span>
        </footer>
      `;
      explorerPage.dataset.rendered = "1";
    }
    if (!get("#homeFolderNicknameOverlay")) {
      homeView.insertAdjacentHTML("beforeend", `
        <div id="homeFolderNicknameOverlay" class="homeFolderDialogOverlay" hidden>
          <form id="homeFolderNicknameDialog" class="homeFolderDialog" role="dialog" aria-modal="true" aria-labelledby="homeFolderDialogTitle">
            <div class="homeFolderDialogHeader">
              <h2 id="homeFolderDialogTitle">Add Favorite Folder</h2>
              <button id="homeFolderDialogCloseBtn" class="homeFolderDialogClose" type="button" aria-label="Close">${svgIcon("close")}</button>
            </div>
            <div class="homeFolderDialogBody">
              <label for="homeFolderNicknameInput">Nickname</label>
              <input id="homeFolderNicknameInput" type="text" maxlength="80" autocomplete="off" />
              <label for="homeFolderPathDisplay">Folder</label>
              <input id="homeFolderPathDisplay" type="text" readonly />
            </div>
            <div class="homeFolderDialogActions">
              <button id="homeFolderDialogCancelBtn" type="button">Cancel</button>
              <button id="homeFolderDialogSaveBtn" class="primary" type="submit">Add Favorite</button>
            </div>
          </form>
        </div>
        <div id="homeFileContextMenu" class="ctx-menu homeContextMenu" role="menu" aria-label="File actions" hidden>
          <div class="ctx-menu-inner">
            <button class="ctx-item" type="button" role="menuitem" data-home-file-action="open">Open</button>
            <button class="ctx-item" type="button" role="menuitem" data-home-file-action="open-read-only">Open Read-Only</button>
            <button class="ctx-item" type="button" role="menuitem" data-home-file-action="add-sidebar">Add to Favorites</button>
            <div class="ctx-sep" data-home-file-separator></div>
            <button class="ctx-item" type="button" role="menuitem" data-home-file-action="reveal">Show in File Explorer</button>
            <button class="ctx-item" type="button" role="menuitem" data-home-file-action="copy-path">Copy Path</button>
          </div>
        </div>
        <div id="homeFolderContextMenu" class="ctx-menu homeContextMenu" role="menu" aria-label="Folder shortcut actions" hidden>
          <div class="ctx-menu-inner">
            <button class="ctx-item" type="button" role="menuitem" data-home-shortcut-action="open">Open</button>
            <button class="ctx-item" type="button" role="menuitem" data-home-shortcut-action="rename">Rename Nickname</button>
            <button class="ctx-item" type="button" role="menuitem" data-home-shortcut-action="open-explorer">Open in File Explorer</button>
            <button class="ctx-item" type="button" role="menuitem" data-home-shortcut-action="copy-path">Copy Path</button>
            <div class="ctx-sep"></div>
            <button class="ctx-item danger" type="button" role="menuitem" data-home-shortcut-action="remove">Remove from Favorites</button>
          </div>
        </div>
      `);
    }
  }

  function preferencesDocument() {
    return normalizeHomeFoldersDocument({
      version: FILE_EXPLORER_FAVORITES_SCHEMA_VERSION,
      folders: state.folders,
    });
  }

  function persistFolders() {
    state.preferencesRevision += 1;
    const preferences = preferencesDocument();
    const localSaved = writeLocalPreferences(preferences);
    const host = hostApi();
    if (typeof host?.saveHomeFolderPreferences !== "function") {
      if (!localSaved) setStatus("Favorite folders could not be saved.", "error");
      return;
    }
    state.preferencesSaveChain = state.preferencesSaveChain
      .catch(() => null)
      .then(() => host.saveHomeFolderPreferences(preferences))
      .then((result) => {
        if (result?.ok === false) {
          setStatus(`Favorite folders were saved only in this browser: ${result.error || "desktop preference save failed."}`, "warn");
        }
      })
      .catch((error) => {
        setStatus(`Favorite folders were saved only in this browser: ${String(error?.message || error)}`, "warn");
      });
  }

  async function hydrateFoldersFromHost() {
    const host = hostApi();
    if (typeof host?.loadHomeFolderPreferences !== "function") return;
    const revisionAtStart = state.preferencesRevision;
    try {
      const result = await host.loadHomeFolderPreferences();
      if (revisionAtStart !== state.preferencesRevision) return;
      if (result?.ok === false) {
        setStatus(`Using browser favorite folders: ${result.error || "desktop preferences could not be loaded."}`, "warn");
        return;
      }
      if (result?.exists) {
        state.folders = normalizeHomeFoldersDocument(result.preferences).folders;
        writeLocalPreferences(preferencesDocument());
        renderFolderShortcuts();
      } else if (state.folders.length) {
        persistFolders();
      }
    } catch (error) {
      setStatus(`Using browser favorite folders: ${String(error?.message || error)}`, "warn");
    }
  }

  async function loadFileIcons() {
    try {
      const response = await fetch(FILE_ICON_MAP_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Icon map request failed: ${response.status}`);
      state.resolveFileIconPath = createFileIconResolver(await response.json());
    } catch (error) {
      console.warn("File Explorer icon map could not load.", error);
      state.resolveFileIconPath = null;
    }
    renderFolderShortcuts();
    renderExplorerRows();
  }

  function iconAssetPath(pathLike, options = {}) {
    const relative = state.resolveFileIconPath?.(pathLike, options)
      || (options.isDirectory ? "icons/folder-base.svg" : "icons/document.svg");
    return `${FILE_ICON_BASE_PATH}${String(relative).replace(/^\/+/, "")}`;
  }

  function folderForPath(pathLike) {
    const key = homeFolderPathKey(pathLike);
    return state.folders.find((folder) => homeFolderPathKey(folder.path) === key) || null;
  }

  function activeFolder() {
    return folderForPath(state.activeShortcutPath);
  }

  function attachRenderedTooltips(root = homeView) {
    root.querySelectorAll?.("[data-home-tooltip]").forEach((target) => {
      const text = target.getAttribute("data-home-tooltip");
      if (!text || target.dataset.homeTooltipWired) return;
      target.dataset.homeTooltipWired = "1";
      attachArcrhoTooltip(target, text);
    });
  }

  function renderFolderShortcuts() {
    const container = get("#homeFolderShortcuts");
    if (!container) return;
    if (!state.folders.length) {
      container.innerHTML = '<button class="homeFolderEmptyButton" type="button" data-home-add-folder>Add favorite folder</button>';
      return;
    }
    container.innerHTML = state.folders.map((folder) => {
      const active = homeFolderPathKey(folder.path) === homeFolderPathKey(state.activeShortcutPath);
      return `
        <div class="homeFolderShortcutRow${active ? " active" : ""}" data-home-shortcut-path="${encodePath(folder.path)}">
          <button class="homeNavItem homeFolderShortcut${active ? " active" : ""}" type="button" aria-pressed="${active ? "true" : "false"}" aria-label="Open ${escapeHtml(folder.nickname)}" data-home-tooltip="${escapeHtml(folder.path)}">
            <img class="homeFolderShortcutIcon" src="${escapeHtml(iconAssetPath(folder.path, { isDirectory: true }))}" alt="" aria-hidden="true" draggable="false" />
            <span class="homeFolderShortcutName">${escapeHtml(folder.nickname)}</span>
          </button>
        </div>
      `;
    }).join("");
    attachRenderedTooltips(container);
  }

  function updateExplorerChrome() {
    const folder = activeFolder();
    const title = get("#homeExplorerTitle");
    const subtitle = get("#homeExplorerSubtitle");
    const address = get("#homeExplorerAddress");
    const search = get("#homeExplorerSearch");
    const back = get("#homeExplorerBackBtn");
    const forward = get("#homeExplorerForwardBtn");
    const up = get("#homeExplorerUpBtn");
    const refresh = get("#homeExplorerRefreshBtn");
    if (title) title.textContent = folder?.nickname || defaultHomeFolderNickname(state.currentPath) || "File Explorer";
    if (subtitle) subtitle.textContent = state.currentPath || "Choose a favorite folder to browse its files.";
    if (address && document.activeElement !== address) address.value = state.currentPath;
    if (search) {
      search.value = state.query;
      search.placeholder = folder?.nickname ? `Search ${folder.nickname}` : "Search this folder";
    }
    if (back) back.disabled = state.historyIndex <= 0;
    if (forward) forward.disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
    if (up) up.disabled = !parentFolderPath(state.currentPath);
    if (refresh) refresh.disabled = !state.currentPath || state.loading;
    updateSortHeaders();
  }

  function setSidebarWidth(width, { persist = false } = {}) {
    const next = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(Number(width) || 220)));
    state.sidebarWidth = next;
    homeView.style.setProperty("--file-explorer-sidebar-width", `${next}px`);
    const handle = get("#homeSidebarResizeHandle");
    handle?.setAttribute("aria-valuenow", String(next));
    if (!persist) return;
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next)); } catch {}
  }

  function updateSortHeaders() {
    get("#homeFoldersPage")?.querySelectorAll?.("th[data-sort-key]").forEach((header) => {
      const active = header.dataset.sortKey === state.sortKey;
      header.setAttribute("aria-sort", active ? (state.sortDirection === "desc" ? "descending" : "ascending") : "none");
      header.classList.toggle("activeSort", active);
      header.classList.toggle("descending", active && state.sortDirection === "desc");
    });
  }

  function renderExplorerStateRow(message, options = {}) {
    const action = options.action
      ? `<button class="homeExplorerStateButton" type="button" data-home-state-action="${escapeHtml(options.action)}">${escapeHtml(options.actionLabel || "Try again")}</button>`
      : "";
    return `
      <tr class="homeExplorerStateRow" role="row">
        <td colspan="4">
          <div class="homeExplorerState${options.error ? " error" : ""}" role="${options.error ? "alert" : "status"}">
            <div>${escapeHtml(message)}</div>${action}
          </div>
        </td>
      </tr>
    `;
  }

  function renderExplorerRows() {
    const body = get("#homeExplorerTableBody");
    const count = get("#homeExplorerItemCount");
    if (!body) return;
    if (!state.currentPath) {
      state.visibleEntries = [];
      body.innerHTML = renderExplorerStateRow("Choose a favorite folder, or add one to get started.", { action: "add-folder", actionLabel: "Add Favorite" });
      if (count) count.textContent = "No folder selected";
      updateSelectionStatus();
      return;
    }
    if (state.loading) {
      state.visibleEntries = [];
      body.innerHTML = renderExplorerStateRow("Loading folder contents...");
      if (count) count.textContent = "Loading...";
      updateSelectionStatus();
      return;
    }
    if (state.error) {
      state.visibleEntries = [];
      body.innerHTML = renderExplorerStateRow(state.error, { error: true, action: "retry", actionLabel: "Retry" });
      if (count) count.textContent = "Folder unavailable";
      updateSelectionStatus();
      return;
    }
    state.visibleEntries = filterAndSortHomeFileEntries(state.entries, {
      query: state.query,
      sortKey: state.sortKey,
      sortDirection: state.sortDirection,
    });
    if (!state.visibleEntries.some((entry) => homeFolderPathKey(entry.path) === homeFolderPathKey(state.selectedPath))) {
      state.selectedPath = "";
    }
    if (!state.visibleEntries.length) {
      const message = state.query ? `No items match “${state.query}”.` : "This folder is empty.";
      body.innerHTML = renderExplorerStateRow(message);
      if (count) count.textContent = state.query ? "0 matching items" : "0 items";
      updateSelectionStatus();
      return;
    }
    body.innerHTML = state.visibleEntries.map((entry, index) => {
      const selected = homeFolderPathKey(entry.path) === homeFolderPathKey(state.selectedPath);
      const rowId = `homeExplorerRow_${index}`;
      return `
        <tr id="${rowId}" role="row" data-home-entry-index="${index}" data-home-entry-path="${encodePath(entry.path)}" aria-selected="${selected ? "true" : "false"}">
          <td role="gridcell" class="homeExplorerNameCell">
            <span class="homeExplorerNameContent">
              <img class="homeExplorerFileIcon" src="${escapeHtml(iconAssetPath(entry.path, { isDirectory: entry.isDirectory }))}" alt="" aria-hidden="true" draggable="false" />
              <span class="homeExplorerFileName" aria-description="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span>
            </span>
          </td>
          <td role="gridcell">${escapeHtml(formatHomeFileDate(entry.mtimeMs))}</td>
          <td role="gridcell">${escapeHtml(getHomeFileTypeLabel(entry))}</td>
          <td role="gridcell" class="homeExplorerSizeCell">${escapeHtml(formatHomeFileSize(entry.size, { isDirectory: entry.isDirectory }))}</td>
        </tr>
      `;
    }).join("");
    const total = state.entries.length;
    const visible = state.visibleEntries.length;
    if (count) count.textContent = state.query
      ? `${visible} of ${total} item${total === 1 ? "" : "s"}`
      : `${total} item${total === 1 ? "" : "s"}`;
    updateSelectionStatus();
  }

  function selectedEntry() {
    return state.visibleEntries.find((entry) => homeFolderPathKey(entry.path) === homeFolderPathKey(state.selectedPath)) || null;
  }

  function updateSelectionStatus() {
    const table = get("#homeExplorerTable");
    const status = get("#homeExplorerSelectionStatus");
    let activeRowId = "";
    get("#homeExplorerTableBody")?.querySelectorAll?.("tr[data-home-entry-index]").forEach((row) => {
      const selected = homeFolderPathKey(decodePath(row.dataset.homeEntryPath)) === homeFolderPathKey(state.selectedPath);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) activeRowId = row.id;
    });
    if (table) {
      if (activeRowId) table.setAttribute("aria-activedescendant", activeRowId);
      else table.removeAttribute("aria-activedescendant");
    }
    const entry = selectedEntry();
    if (status) status.textContent = entry
      ? `${entry.name}${entry.isDirectory ? " — File folder" : entry.size == null ? "" : ` — ${formatHomeFileSize(entry.size)}`}`
      : "";
  }

  function selectEntry(entry) {
    state.selectedPath = entry?.path || "";
    updateSelectionStatus();
  }

  function ensureExplorerRowVisible(row) {
    const frame = get(".homeExplorerTableFrame");
    if (!row || !frame) return;
    const frameRect = frame.getBoundingClientRect();
    const headerRect = get(".homeExplorerTable thead")?.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const visibleTop = Math.max(frameRect.top, headerRect?.bottom || frameRect.top);
    const visibleBottom = frameRect.bottom;
    if (rowRect.top < visibleTop) {
      frame.scrollTop -= visibleTop - rowRect.top;
    } else if (rowRect.bottom > visibleBottom) {
      frame.scrollTop += rowRect.bottom - visibleBottom;
    }
  }

  async function stopFolderWatch() {
    if (state.watchRefreshTimer) window.clearTimeout(state.watchRefreshTimer);
    state.watchRefreshTimer = 0;
    const watchId = state.watchId;
    state.watchId = "";
    state.watchPath = "";
    if (watchId && typeof hostApi()?.stopArcodeFolderWatch === "function") {
      try {
        await hostApi().stopArcodeFolderWatch({ watchId });
      } catch {
        // Manual refresh remains available if watcher cleanup fails.
      }
    }
  }

  async function startFolderWatch(folderPath) {
    await stopFolderWatch();
    const host = hostApi();
    if (!state.hostVisible || typeof host?.startArcodeFolderWatch !== "function") return;
    try {
      const result = await host.startArcodeFolderWatch({ path: folderPath });
      if (!state.hostVisible || homeFolderPathKey(state.currentPath) !== homeFolderPathKey(folderPath) || result?.ok === false) {
        if (result?.ok && result?.watchId) {
          try {
            await host.stopArcodeFolderWatch?.({ watchId: result.watchId });
          } catch {
            // A stale watcher will be released with its BrowserWindow.
          }
        }
        return;
      }
      state.watchId = String(result.watchId || "");
      state.watchPath = String(result.path || folderPath);
    } catch {
      // Folder browsing stays functional with the visible Refresh command.
    }
  }

  async function loadCurrentFolder({ announce = false } = {}) {
    const path = String(state.currentPath || "").trim();
    const requestId = ++state.listingRequest;
    if (!path) {
      state.entries = [];
      state.error = "";
      state.loading = false;
      renderExplorerRows();
      return;
    }
    const host = hostApi();
    if (typeof host?.listFolder !== "function") {
      state.entries = [];
      state.loading = false;
      state.error = "Folder browsing requires the ArcRho desktop app.";
      renderExplorerRows();
      updateExplorerChrome();
      return;
    }
    state.loading = true;
    state.error = "";
    renderExplorerRows();
    updateExplorerChrome();
    try {
      const result = await host.listFolder({ path, includeHidden: true, includeMetadata: true });
      if (requestId !== state.listingRequest) return;
      state.loading = false;
      if (!result?.ok) {
        state.entries = [];
        state.error = String(result?.error || "Could not read this folder.");
        await stopFolderWatch();
      } else {
        state.currentPath = String(result.path || path);
        state.entries = normalizeHomeFileEntries(result.entries);
        state.error = "";
        pushWorkspaceHistoryEntry({ path: state.currentPath });
        try { window.parent?.postMessage({ type: "arcrho:browsing-history-updated", workspacePath: state.currentPath }, "*"); } catch {}
        try { window.parent?.postMessage({ type: "arcrho:update-active-tab-title", title: folderForPath(state.currentPath)?.nickname || defaultHomeFolderNickname(state.currentPath) || "My Workspace" }, "*"); } catch {}
        if (announce) setStatus(`Refreshed ${state.currentPath}.`);
        void startFolderWatch(state.currentPath);
      }
    } catch (error) {
      if (requestId !== state.listingRequest) return;
      state.loading = false;
      state.entries = [];
      state.error = String(error?.message || error || "Could not read this folder.");
      await stopFolderWatch();
    }
    renderExplorerRows();
    updateExplorerChrome();
  }

  function navigateTo(pathLike, options = {}) {
    const targetPath = String(pathLike || "").trim();
    if (!targetPath) return;
    closeMenus();
    state.currentPath = targetPath;
    state.selectedPath = "";
    state.query = "";
    state.error = "";
    if (options.resetHistory) {
      state.history = [targetPath];
      state.historyIndex = 0;
    } else if (options.historyIndex != null) {
      state.historyIndex = Number(options.historyIndex);
    } else if (homeFolderPathKey(state.history[state.historyIndex]) !== homeFolderPathKey(targetPath)) {
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(targetPath);
      state.historyIndex = state.history.length - 1;
    }
    renderFolderShortcuts();
    updateExplorerChrome();
    void loadCurrentFolder();
  }

  function activateShortcut(pathLike) {
    const folder = folderForPath(pathLike);
    if (!folder) return;
    state.activeShortcutPath = folder.path;
    navigateTo(folder.path, { resetHistory: true });
  }

  function moveHistory(delta) {
    const nextIndex = state.historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= state.history.length) return;
    navigateTo(state.history[nextIndex], { historyIndex: nextIndex });
  }

  function moveUp() {
    const parent = parentFolderPath(state.currentPath);
    if (parent) navigateTo(parent);
  }

  async function openEntry(entry, options = {}) {
    if (!entry) return;
    if (entry.isDirectory && !options.readOnly) {
      navigateTo(entry.path);
      return;
    }
    if (options.readOnly && !isExcelWorkbookPath(entry.path)) return;
    const host = hostApi();
    if (typeof host?.openPath !== "function") {
      setStatus("Opening files requires the ArcRho desktop app.", "error");
      return;
    }
    const actionLabel = options.readOnly ? "Opening read-only" : "Opening";
    setStatus(`${actionLabel} ${entry.name}...`);
    try {
      const result = await host.openPath({ path: entry.path, readOnly: !!options.readOnly });
      if (result?.ok === false) {
        setStatus(`${actionLabel} failed: ${result.error || entry.path}`, "error");
        return;
      }
      setStatus(options.readOnly ? `Opened ${entry.name} read-only.` : `Opened ${entry.name}.`);
    } catch (error) {
      setStatus(`${actionLabel} failed: ${String(error?.message || error)}`, "error");
    }
  }

  async function revealPath(pathLike) {
    const path = String(pathLike || "").trim();
    if (!path || typeof hostApi()?.showItemInFolder !== "function") {
      setStatus("Showing files in Explorer requires the ArcRho desktop app.", "error");
      return;
    }
    try {
      const result = await hostApi().showItemInFolder({ path });
      if (result?.ok === false) throw new Error(result.error || "File Explorer could not open.");
      setStatus(`Shown in File Explorer: ${path}`);
    } catch (error) {
      setStatus(`Show in File Explorer failed: ${String(error?.message || error)}`, "error");
    }
  }

  async function openFolderInExplorer(pathLike) {
    const path = String(pathLike || "").trim();
    if (!path || typeof hostApi()?.openPath !== "function") {
      setStatus("Opening folders requires the ArcRho desktop app.", "error");
      return;
    }
    try {
      const result = await hostApi().openPath({ path });
      if (result?.ok === false) throw new Error(result.error || "File Explorer could not open.");
      setStatus(`Opened ${path} in File Explorer.`);
    } catch (error) {
      setStatus(`Open folder failed: ${String(error?.message || error)}`, "error");
    }
  }

  async function copyPath(pathLike) {
    const path = String(pathLike || "").trim();
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setStatus(`Copied path: ${path}`);
    } catch (error) {
      setStatus(`Copy path failed: ${String(error?.message || error)}`, "error");
    }
  }

  async function pickFolder() {
    const host = hostApi();
    if (typeof host?.pickFolder !== "function") {
      setStatus("Adding folders requires the ArcRho desktop app.", "error");
      return;
    }
    try {
      const selected = await host.pickFolder(state.currentPath || state.activeShortcutPath || "");
      if (selected) openNicknameDialog(selected, { mode: folderForPath(selected) ? "rename" : "add" });
    } catch (error) {
      setStatus(`Folder selection failed: ${String(error?.message || error)}`, "error");
    }
  }

  function openNicknameDialog(pathLike, options = {}) {
    const path = String(pathLike || "").trim();
    if (!path) return;
    closeMenus();
    const existing = folderForPath(path);
    state.dialogPath = path;
    state.dialogMode = options.mode === "rename" || existing ? "rename" : "add";
    state.dialogReturnFocus = options.returnFocus || document.activeElement;
    const overlay = get("#homeFolderNicknameOverlay");
    const title = get("#homeFolderDialogTitle");
    const input = get("#homeFolderNicknameInput");
    const pathDisplay = get("#homeFolderPathDisplay");
    const save = get("#homeFolderDialogSaveBtn");
    if (title) title.textContent = state.dialogMode === "rename" ? "Rename Favorite" : "Add Favorite Folder";
    if (input) input.value = existing?.nickname || defaultHomeFolderNickname(path);
    if (pathDisplay) pathDisplay.value = path;
    if (save) save.textContent = state.dialogMode === "rename" ? "Save" : "Add Favorite";
    if (overlay) overlay.hidden = false;
    window.setTimeout(() => {
      input?.focus();
      input?.select();
    }, 0);
  }

  function closeNicknameDialog({ restoreFocus = true } = {}) {
    const overlay = get("#homeFolderNicknameOverlay");
    if (overlay) overlay.hidden = true;
    state.dialogPath = "";
    if (restoreFocus) state.dialogReturnFocus?.focus?.();
    state.dialogReturnFocus = null;
  }

  function saveNicknameDialog() {
    const path = state.dialogPath;
    if (!path) return;
    const nickname = String(get("#homeFolderNicknameInput")?.value || "").trim() || defaultHomeFolderNickname(path);
    const existing = folderForPath(path);
    state.folders = existing
      ? normalizeHomeFolderShortcuts(state.folders.map((folder) => homeFolderPathKey(folder.path) === homeFolderPathKey(path) ? { path, nickname } : folder))
      : normalizeHomeFolderShortcuts([...state.folders, { path, nickname }]);
    state.activeShortcutPath = path;
    persistFolders();
    renderFolderShortcuts();
    closeNicknameDialog({ restoreFocus: false });
    activateShortcut(path);
    setStatus(`${existing ? "Updated" : "Added"} folder ${nickname}.`);
  }

  function removeShortcut(pathLike) {
    const folder = folderForPath(pathLike);
    if (!folder) return;
    state.folders = state.folders.filter((item) => homeFolderPathKey(item.path) !== homeFolderPathKey(folder.path));
    const removedActive = homeFolderPathKey(state.activeShortcutPath) === homeFolderPathKey(folder.path);
    if (removedActive) {
      state.activeShortcutPath = "";
    }
    persistFolders();
    renderFolderShortcuts();
    if (removedActive && state.folders.length) {
      activateShortcut(state.folders[0].path);
    } else if (removedActive) {
      state.currentPath = "";
      state.history = [];
      state.historyIndex = -1;
      state.entries = [];
      state.visibleEntries = [];
      state.selectedPath = "";
      state.query = "";
      state.error = "";
      state.listingRequest += 1;
      void stopFolderWatch();
      renderExplorerRows();
      updateExplorerChrome();
    }
    setStatus(`Removed ${folder.nickname} from Favorites.`);
  }

  function closeMenu(menu, { restoreFocus = false } = {}) {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (restoreFocus) state.menuReturnFocus?.focus?.();
  }

  function closeMenus(options = {}) {
    closeMenu(get("#homeFileContextMenu"), options);
    closeMenu(get("#homeFolderContextMenu"), options);
    state.fileMenuEntry = null;
    state.shortcutMenuPath = "";
    state.menuReturnFocus = null;
  }

  function showMenu(menu, eventLike, anchorEl = null, returnFocusEl = anchorEl) {
    closeMenus();
    state.menuReturnFocus = returnFocusEl || document.activeElement;
    menu.hidden = false;
    const hasPointer = Number.isFinite(eventLike?.clientX) && Number.isFinite(eventLike?.clientY);
    openContextMenu(menu, {
      anchorEl,
      clientX: hasPointer ? eventLike.clientX : null,
      clientY: hasPointer ? eventLike.clientY : null,
      preferPointer: hasPointer,
    });
    visibleMenuItems(menu)[0]?.focus();
  }

  function openFileMenu(entry, event, anchorEl, returnFocusEl = anchorEl) {
    if (!entry) return;
    selectEntry(entry);
    const menu = get("#homeFileContextMenu");
    const readOnly = menu?.querySelector('[data-home-file-action="open-read-only"]');
    const addSidebar = menu?.querySelector('[data-home-file-action="add-sidebar"]');
    if (readOnly) readOnly.hidden = entry.isDirectory || !isExcelWorkbookPath(entry.path);
    if (addSidebar) addSidebar.hidden = !entry.isDirectory;
    if (menu) {
      showMenu(menu, event, anchorEl, returnFocusEl);
      state.fileMenuEntry = entry;
    }
  }

  function openShortcutMenu(pathLike, event, anchorEl) {
    const folder = folderForPath(pathLike);
    if (!folder) return;
    const menu = get("#homeFolderContextMenu");
    if (menu) {
      showMenu(menu, event, anchorEl);
      state.shortcutMenuPath = folder.path;
    }
  }

  function wireMenuKeyboard(menu) {
    menu?.addEventListener("keydown", (event) => {
      const items = visibleMenuItems(menu);
      if (!items.length) return;
      const currentIndex = Math.max(0, items.indexOf(document.activeElement));
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenus({ restoreFocus: true });
      } else if (event.key === "Tab") {
        closeMenus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(currentIndex + delta + items.length) % items.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      }
    });
  }

  function wireSidebar() {
    const sidebar = get("#homeFoldersNav");
    sidebar?.addEventListener("click", (event) => {
      const add = event.target.closest?.("#homeAddFolderBtn, [data-home-add-folder]");
      if (add) {
        void pickFolder();
        return;
      }
      const row = event.target.closest?.("[data-home-shortcut-path]");
      if (!row) return;
      const path = decodePath(row.dataset.homeShortcutPath);
      if (event.target.closest?.(".homeFolderShortcut")) {
        activateShortcut(path);
      }
    });
    sidebar?.addEventListener("contextmenu", (event) => {
      const row = event.target.closest?.("[data-home-shortcut-path]");
      if (!row) return;
      event.preventDefault();
      openShortcutMenu(decodePath(row.dataset.homeShortcutPath), event, row.querySelector(".homeFolderShortcut"));
    });
  }

  function wireSidebarResize() {
    const handle = get("#homeSidebarResizeHandle");
    if (!handle) return;
    setSidebarWidth(state.sidebarWidth);
    let startX = 0;
    let startWidth = 0;
    const endResize = () => {
      handle.classList.remove("isResizing");
      document.body.style.cursor = "";
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      startX = event.clientX;
      startWidth = state.sidebarWidth;
      handle.classList.add("isResizing");
      document.body.style.cursor = "col-resize";
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture?.(event.pointerId)) return;
      setSidebarWidth(startWidth + event.clientX - startX);
    });
    handle.addEventListener("pointerup", (event) => {
      if (!handle.hasPointerCapture?.(event.pointerId)) return;
      setSidebarWidth(state.sidebarWidth, { persist: true });
      handle.releasePointerCapture?.(event.pointerId);
      endResize();
    });
    handle.addEventListener("pointercancel", endResize);
    handle.addEventListener("keydown", (event) => {
      const delta = event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0;
      if (!delta) return;
      event.preventDefault();
      setSidebarWidth(state.sidebarWidth + delta, { persist: true });
    });
  }

  function wireExplorer() {
    const page = get("#homeFoldersPage");
    const table = get("#homeExplorerTable");
    const body = get("#homeExplorerTableBody");
    get("#homeExplorerBackBtn")?.addEventListener("click", () => moveHistory(-1));
    get("#homeExplorerForwardBtn")?.addEventListener("click", () => moveHistory(1));
    get("#homeExplorerUpBtn")?.addEventListener("click", moveUp);
    get("#homeExplorerRefreshBtn")?.addEventListener("click", () => void loadCurrentFolder({ announce: true }));
    get("#homeExplorerAddress")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.currentTarget.value = state.currentPath;
        table?.focus?.({ preventScroll: true });
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      navigateTo(event.currentTarget.value);
    });
    get("#homeExplorerAddress")?.addEventListener("focus", (event) => event.currentTarget.select());
    get("#homeExplorerAddress")?.addEventListener("blur", (event) => {
      event.currentTarget.value = state.currentPath;
    });
    get("#homeExplorerSearch")?.addEventListener("input", (event) => {
      state.query = String(event.currentTarget.value || "");
      renderExplorerRows();
    });
    page?.querySelectorAll?.("th[data-sort-key] button").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.closest("th")?.dataset.sortKey || "name";
        if (state.sortKey === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
        else {
          state.sortKey = key;
          state.sortDirection = "asc";
        }
        updateSortHeaders();
        renderExplorerRows();
      });
    });
    body?.addEventListener("click", (event) => {
      const stateAction = event.target.closest?.("[data-home-state-action]")?.dataset.homeStateAction;
      if (stateAction === "add-folder") {
        void pickFolder();
        return;
      }
      if (stateAction === "retry") {
        void loadCurrentFolder({ announce: true });
        return;
      }
      const row = event.target.closest?.("tr[data-home-entry-index]");
      if (!row) return;
      selectEntry(state.visibleEntries[Number(row.dataset.homeEntryIndex)]);
      table?.focus?.({ preventScroll: true });
    });
    body?.addEventListener("dblclick", (event) => {
      const row = event.target.closest?.("tr[data-home-entry-index]");
      const entry = row ? state.visibleEntries[Number(row.dataset.homeEntryIndex)] : null;
      if (entry) void openEntry(entry);
    });
    body?.addEventListener("contextmenu", (event) => {
      const row = event.target.closest?.("tr[data-home-entry-index]");
      const entry = row ? state.visibleEntries[Number(row.dataset.homeEntryIndex)] : null;
      if (!entry) return;
      event.preventDefault();
      openFileMenu(entry, event, table);
    });
    table?.addEventListener("keydown", (event) => {
      if (event.target !== table) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        get("#homeExplorerAddress")?.focus();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        get("#homeExplorerSearch")?.focus();
        return;
      }
      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        moveHistory(-1);
        return;
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        moveHistory(1);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        moveUp();
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        const entry = selectedEntry();
        if (entry) {
          event.preventDefault();
          const index = state.visibleEntries.indexOf(entry);
          openFileMenu(entry, null, get(`#homeExplorerRow_${index}`) || table, table);
        }
        return;
      }
      if (event.key === "Enter") {
        const entry = selectedEntry();
        if (entry) {
          event.preventDefault();
          void openEntry(entry);
        }
        return;
      }
      if (!state.visibleEntries.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const selectedIndex = state.visibleEntries.findIndex((entry) => homeFolderPathKey(entry.path) === homeFolderPathKey(state.selectedPath));
      let nextIndex = selectedIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = state.visibleEntries.length - 1;
      else if (event.key === "ArrowDown") nextIndex = Math.min(state.visibleEntries.length - 1, selectedIndex < 0 ? 0 : selectedIndex + 1);
      else nextIndex = Math.max(0, selectedIndex < 0 ? 0 : selectedIndex - 1);
      selectEntry(state.visibleEntries[nextIndex]);
      ensureExplorerRowVisible(get(`#homeExplorerRow_${nextIndex}`));
    });
  }

  function wireDialogsAndMenus() {
    const overlay = get("#homeFolderNicknameOverlay");
    get("#homeFolderNicknameDialog")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveNicknameDialog();
    });
    get("#homeFolderNicknameDialog")?.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll("button:not(:disabled), input:not(:disabled)"));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    get("#homeFolderDialogCancelBtn")?.addEventListener("click", () => closeNicknameDialog());
    get("#homeFolderDialogCloseBtn")?.addEventListener("click", () => closeNicknameDialog());
    overlay?.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) closeNicknameDialog();
    });
    const fileMenu = get("#homeFileContextMenu");
    const shortcutMenu = get("#homeFolderContextMenu");
    fileMenu?.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-home-file-action]")?.dataset.homeFileAction;
      const entry = state.fileMenuEntry;
      if (!action || !entry) return;
      const returnFocus = state.menuReturnFocus;
      closeMenus({ restoreFocus: action !== "add-sidebar" });
      if (action === "open") void openEntry(entry);
      else if (action === "open-read-only") void openEntry(entry, { readOnly: true });
      else if (action === "add-sidebar") openNicknameDialog(entry.path, {
        mode: folderForPath(entry.path) ? "rename" : "add",
        returnFocus,
      });
      else if (action === "reveal") void revealPath(entry.path);
      else if (action === "copy-path") void copyPath(entry.path);
    });
    shortcutMenu?.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-home-shortcut-action]")?.dataset.homeShortcutAction;
      const path = state.shortcutMenuPath;
      if (!action || !path) return;
      const returnFocus = state.menuReturnFocus;
      closeMenus({ restoreFocus: action !== "rename" });
      if (action === "open") activateShortcut(path);
      else if (action === "rename") openNicknameDialog(path, { mode: "rename", returnFocus });
      else if (action === "open-explorer") void openFolderInExplorer(path);
      else if (action === "copy-path") void copyPath(path);
      else if (action === "remove") removeShortcut(path);
    });
    wireMenuKeyboard(fileMenu);
    wireMenuKeyboard(shortcutMenu);
    document.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.("#homeFileContextMenu, #homeFolderContextMenu")) return;
      closeMenus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!get("#homeFolderNicknameOverlay")?.hidden) {
        event.preventDefault();
        closeNicknameDialog();
      } else {
        closeMenus({ restoreFocus: true });
      }
    });
  }

  function wireFolderWatch() {
    const host = hostApi();
    if (typeof host?.onArcodeFolderChanged !== "function") return;
    state.unsubscribeWatch = host.onArcodeFolderChanged((payload) => {
      if (!state.watchId || String(payload?.watchId || "") !== state.watchId) return;
      if (payload?.error) {
        setStatus(`Folder auto-refresh stopped: ${payload.error}`, "warn");
        state.watchId = "";
        return;
      }
      if (state.watchRefreshTimer) window.clearTimeout(state.watchRefreshTimer);
      state.watchRefreshTimer = window.setTimeout(() => {
        state.watchRefreshTimer = 0;
        if (state.hostVisible) void loadCurrentFolder();
      }, WATCH_REFRESH_DELAY_MS);
    });
  }

  function setHostVisible(isVisible) {
    const nextVisible = !!isVisible;
    if (state.hostVisible === nextVisible) return;
    state.hostVisible = nextVisible;
    if (!nextVisible) {
      closeMenus();
      void stopFolderWatch();
    } else if (state.favoritesReady && !state.currentPath && state.folders.length) {
      activateShortcut(state.folders[0].path);
    } else if (state.currentPath) {
      void loadCurrentFolder();
    }
  }

  async function initializeFavorites() {
    await hydrateFoldersFromHost();
    state.favoritesReady = true;
    renderFolderShortcuts();
    if (state.hostVisible && !state.currentPath && state.folders.length) {
      activateShortcut(state.folders[0].path);
    }
  }

  function wireShellLifecycle() {
    window.addEventListener("message", (event) => {
      const message = event?.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "arcrho:file-explorer-visibility") {
        setHostVisible(!!message.visible);
      } else if (message.type === "arcrho:file-explorer-open-path") {
        navigateTo(message.path, { resetHistory: true });
      }
    });
    window.addEventListener("pagehide", () => {
      state.unsubscribeWatch?.();
      state.unsubscribeWatch = null;
      void stopFolderWatch();
    }, { once: true });
  }

  ensureMarkup();
    wireSidebar();
    wireSidebarResize();
  wireExplorer();
  wireDialogsAndMenus();
  wireFolderWatch();
  wireShellLifecycle();
  renderFolderShortcuts();
  updateExplorerChrome();
  renderExplorerRows();
  attachRenderedTooltips();
  void initializeFavorites();
  void loadFileIcons();

  return {
    activateShortcut,
    pickFolder,
    setHostVisible,
  };
}

const fileExplorerRoot = document.querySelector("#fileExplorerApp");
if (fileExplorerRoot) createFileExplorerController(fileExplorerRoot);
