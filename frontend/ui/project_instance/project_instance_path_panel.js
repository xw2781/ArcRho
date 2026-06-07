export function installProjectInstancePathPanel(ctx) {
  const { api, els, projectName, state } = ctx;
  const {
    loadProjectUserPreferences,
    openLazyReservingClassPicker,
    scheduleProjectUserPreferencesSave,
  } = ctx;
  const { LEFT_PANEL_DEFAULT_WIDTH, LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH, LEFT_PANEL_COLLAPSE_THRESHOLD, LEFT_PANEL_RIGHT_MIN_WIDTH, LEFT_PANEL_KEYBOARD_STEP } = ctx.constants;
  const { datasetTableSelection } = state;
  const beginPageLoading = (...args) => api.beginPageLoading(...args);
  const finishPageLoading = (...args) => api.finishPageLoading(...args);
  const loadCachedDatasetFilterForSelectedPath = (...args) => api.loadCachedDatasetFilterForSelectedPath(...args);
  const normalizePath = (...args) => api.normalizePath(...args);
  const notifyProjectInstanceStateChanged = (...args) => api.notifyProjectInstanceStateChanged(...args);
  const renderDatasetTable = (...args) => api.renderDatasetTable(...args);
  const resetActivePathFolderWatch = (...args) => api.resetActivePathFolderWatch(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const syncDatasetWindowChrome = (...args) => api.syncDatasetWindowChrome(...args);
  const toText = (...args) => api.toText(...args);

function saveLastSelectedPath(path) {
  const normalized = normalizePath(path);
  if (!projectName || !normalized) return;
  scheduleProjectUserPreferencesSave(projectName, {
    lastReservingClassPath: normalized,
  });
}

async function loadLastSelectedPath() {
  if (!projectName) return "";
  try {
    const prefs = await loadProjectUserPreferences(projectName);
    const path = normalizePath(prefs?.lastReservingClassPath || prefs?.last_reserving_class_path || "");
    return path;
  } catch (err) {
    console.warn("Failed to load last project instance path:", err);
    return "";
  }
}


function setSelectedPath(path, options = {}) {
  state.selectedPath = normalizePath(path);
  datasetTableSelection.selectedKeys.clear();
  datasetTableSelection.anchorKey = "";
  resetActivePathFolderWatch(state.selectedPath, { skipInitialCheck: true });
  if (els.selectedPathText) {
    els.selectedPathText.textContent = state.selectedPath || "Select a reserving class path.";
    els.selectedPathText.title = state.selectedPath;
  }
  syncDatasetWindowChrome();
  void loadCachedDatasetFilterForSelectedPath();
  renderDatasetTable();
  if (options?.persist !== false) saveLastSelectedPath(state.selectedPath);
  notifyProjectInstanceStateChanged();
}

function waitForPathTreeRender() {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => resolve());
    }, 0);
  });
}

function markPathTreeActive(path) {
  const normalized = normalizePath(path);
  if (!els.pathTree || !normalized) return;
  const candidates = els.pathTree.querySelectorAll(".ptree-favorite-row, .ptree-leaf, .ptree-folder");
  for (const el of candidates) {
    const elPath = normalizePath(el.getAttribute("title") || el.dataset?.path || "");
    el.classList.toggle("active-path", !!elPath && elPath.toLowerCase() === normalized.toLowerCase());
  }
}

function getFirstShortcutPath() {
  if (!els.pathTree) return "";
  const shortcutRows = els.pathTree.querySelectorAll(".ptree-section-favorites .ptree-favorite-row[title]");
  for (const row of shortcutRows) {
    const path = normalizePath(row.getAttribute("title") || "");
    if (path) return path;
  }
  return "";
}

async function selectStartupFallbackPath() {
  await waitForPathTreeRender();
  if (state.selectedPath) {
    markPathTreeActive(state.selectedPath);
    return;
  }
  const shortcutPath = getFirstShortcutPath();
  if (!shortcutPath) {
    return;
  }
  setSelectedPath(shortcutPath, { persist: false });
  markPathTreeActive(shortcutPath);
}

function getLeftPanelMaxWidth() {
  const layoutWidth = Math.max(0, Number(els.layout?.clientWidth || 0));
  const splitterWidth = Math.max(0, Number(els.leftPanelResizer?.offsetWidth || 0));
  if (!layoutWidth) return LEFT_PANEL_MAX_WIDTH;
  const availableWidth = layoutWidth - splitterWidth - LEFT_PANEL_RIGHT_MIN_WIDTH;
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(LEFT_PANEL_MAX_WIDTH, availableWidth));
}

function getCurrentLeftPanelWidth() {
  const width = Number(els.leftPanel?.getBoundingClientRect?.().width || 0);
  return Number.isFinite(width) && width > 0 ? width : 0;
}

function clampLeftPanelWidth(width) {
  const raw = Number(width);
  const maxWidth = getLeftPanelMaxWidth();
  if (!Number.isFinite(raw)) return Math.min(state.lastExpandedLeftWidth, maxWidth);
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(raw, maxWidth));
}

function setLeftPanelCollapsed(collapsed) {
  if (!els.layout) return;
  els.layout.classList.toggle("left-collapsed", !!collapsed);
  els.layout.style.setProperty("--pi-left-width", collapsed ? "0px" : `${Math.round(state.lastExpandedLeftWidth)}px`);
  if (els.leftPanelResizer) {
    els.leftPanelResizer.setAttribute("aria-valuenow", collapsed ? "0" : String(Math.round(state.lastExpandedLeftWidth)));
    els.leftPanelResizer.setAttribute("aria-expanded", collapsed ? "false" : "true");
    els.leftPanelResizer.title = collapsed
      ? "Drag right or double-click to expand reserving class panel"
      : "Drag to resize or double-click to collapse reserving class panel";
  }
}

function setLeftPanelWidth(width) {
  const next = clampLeftPanelWidth(width);
  state.lastExpandedLeftWidth = next;
  setLeftPanelCollapsed(false);
}

function resizeLeftPanel(width) {
  const raw = Number(width);
  if (!Number.isFinite(raw) || raw <= LEFT_PANEL_COLLAPSE_THRESHOLD) {
    setLeftPanelCollapsed(true);
    return;
  }
  setLeftPanelWidth(raw);
}

function toggleLeftPanelCollapsed() {
  const collapsed = !!els.layout?.classList.contains("left-collapsed");
  if (collapsed) setLeftPanelWidth(state.lastExpandedLeftWidth);
  else setLeftPanelCollapsed(true);
}

function initLeftPanelResizer() {
  const { layout, leftPanel, leftPanelResizer } = els;
  if (!layout || !leftPanel || !leftPanelResizer || leftPanelResizer.dataset.wired === "1") return;
  leftPanelResizer.dataset.wired = "1";
  state.lastExpandedLeftWidth = clampLeftPanelWidth(getCurrentLeftPanelWidth() || LEFT_PANEL_DEFAULT_WIDTH);
  setLeftPanelWidth(state.lastExpandedLeftWidth);

  const startDrag = (event) => {
    if (event.button !== 0) return;
    const layoutRect = layout.getBoundingClientRect();
    const leftEdge = Number(layoutRect?.left || 0);
    leftPanelResizer.classList.add("dragging");
    document.body.classList.add("resizing-left-panel");
    let pendingWidth = getCurrentLeftPanelWidth() || state.lastExpandedLeftWidth;
    let resizeFrame = 0;

    const flushResize = () => {
      resizeFrame = 0;
      resizeLeftPanel(pendingWidth);
    };

    const scheduleResize = (width) => {
      pendingWidth = width;
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(flushResize);
    };

    const onMove = (moveEvent) => {
      scheduleResize(Number(moveEvent.clientX || 0) - leftEdge);
    };
    const onUp = () => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
        flushResize();
      }
      leftPanelResizer.classList.remove("dragging");
      document.body.classList.remove("resizing-left-panel");
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    event.preventDefault();
  };

  leftPanelResizer.addEventListener("mousedown", startDrag);
  leftPanelResizer.addEventListener("dblclick", (event) => {
    event.preventDefault();
    toggleLeftPanelCollapsed();
  });
  leftPanelResizer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleLeftPanelCollapsed();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const baseWidth = layout.classList.contains("left-collapsed")
      ? LEFT_PANEL_COLLAPSE_THRESHOLD
      : getCurrentLeftPanelWidth();
    resizeLeftPanel(baseWidth + direction * LEFT_PANEL_KEYBOARD_STEP);
  });
  window.addEventListener("resize", () => {
    if (layout.classList.contains("left-collapsed")) return;
    setLeftPanelWidth(state.lastExpandedLeftWidth);
  });
}

async function loadPathTree() {
  if (!els.pathTree) return;
  beginPageLoading("paths");
  if (!projectName) {
    els.pathTree.innerHTML = '<div class="ptree-empty">Project name is missing.</div>';
    finishPageLoading("paths");
    return;
  }

  try {
    const initialPath = await loadLastSelectedPath();
    if (initialPath) {
      setSelectedPath(initialPath, { persist: false });
    }
    const result = await openLazyReservingClassPicker({
      projectName,
      inlineContainer: els.pathTree,
      initialPath,
      setStatus: (message) => setStatus(message),
      title: "Reserving Class",
      onProjectMissing: (name) => {
        els.pathTree.innerHTML = `<div class="ptree-empty">Project "${name}" does not exist.</div>`;
        setStatus(`Project "${name}" does not exist.`, true);
      },
      onError: (err) => {
        console.error("Failed to load reserving class paths:", err);
        els.pathTree.innerHTML = '<div class="ptree-empty">Failed to load reserving class paths.</div>';
        setStatus(toText(err?.message) || "Failed to load reserving class paths.", true);
      },
      onSelect: (path) => setSelectedPath(path),
    });
    if (!result?.ok && !els.pathTree.querySelector(".ptree-window")) {
      els.pathTree.innerHTML = '<div class="ptree-empty">No reserving class paths found.</div>';
    }
    await selectStartupFallbackPath();
  } catch (err) {
    console.error("Failed to load reserving class paths:", err);
    els.pathTree.innerHTML = '<div class="ptree-empty">Failed to load reserving class paths.</div>';
    setStatus(toText(err?.message) || "Failed to load reserving class paths.", true);
  } finally {
    finishPageLoading("paths");
  }
}

  Object.assign(api, {
    clampLeftPanelWidth,
    getCurrentLeftPanelWidth,
    getFirstShortcutPath,
    getLeftPanelMaxWidth,
    initLeftPanelResizer,
    loadLastSelectedPath,
    loadPathTree,
    markPathTreeActive,
    resizeLeftPanel,
    saveLastSelectedPath,
    selectStartupFallbackPath,
    setLeftPanelCollapsed,
    setLeftPanelWidth,
    setSelectedPath,
    toggleLeftPanelCollapsed,
    waitForPathTreeRender
  });
}
