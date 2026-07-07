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
  const focusProjectInstancePage = (...args) => api.focusProjectInstancePage(...args);
  const loadCachedDatasetFilterForSelectedPath = (...args) => api.loadCachedDatasetFilterForSelectedPath(...args);
  const normalizePath = (...args) => api.normalizePath(...args);
  const notifyProjectInstanceStateChanged = (...args) => api.notifyProjectInstanceStateChanged(...args);
  const renderDatasetTable = (...args) => api.renderDatasetTable(...args);
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

function wirePathTreeScrollbarActivity() {
  const wrap = els.pathTree?.querySelector?.(".ptree-window-embedded .ptree-body");
  if (!wrap || wrap.dataset.scrollbarActivityWired === "1") return;
  wrap.dataset.scrollbarActivityWired = "1";

  let idleTimer = null;
  const syncScrollbarHover = (event) => {
    const rect = wrap.getBoundingClientRect();
    const verticalScrollbarWidth = Math.max(0, wrap.offsetWidth - wrap.clientWidth);
    const horizontalScrollbarHeight = Math.max(0, wrap.offsetHeight - wrap.clientHeight);
    const hasVerticalScrollbar = wrap.scrollHeight > wrap.clientHeight && verticalScrollbarWidth > 0;
    const hasHorizontalScrollbar = wrap.scrollWidth > wrap.clientWidth && horizontalScrollbarHeight > 0;
    const nearVerticalScrollbar = hasVerticalScrollbar
      && event.clientX >= rect.right - Math.max(verticalScrollbarWidth, 16);
    const nearHorizontalScrollbar = hasHorizontalScrollbar
      && event.clientY >= rect.bottom - Math.max(horizontalScrollbarHeight, 16);

    wrap.classList.toggle("isScrollbarHover", nearVerticalScrollbar || nearHorizontalScrollbar);
  };

  wrap.addEventListener("scroll", () => {
    wrap.classList.add("isScrolling");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      wrap.classList.remove("isScrolling");
    }, 550);
  }, { passive: true });
  wrap.addEventListener("pointermove", syncScrollbarHover, { passive: true });
  wrap.addEventListener("pointerleave", () => {
    wrap.classList.remove("isScrollbarHover");
  }, { passive: true });
}

function getPathParts(path = state.selectedPath) {
  return normalizePath(path).split("\\").map((part) => toText(part)).filter(Boolean);
}

function getPathPartKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function getPathLevelLabel(levelIndex) {
  const labels = Array.isArray(state.pathPickerModel?.levelLabels) ? state.pathPickerModel.levelLabels : [];
  return toText(labels[levelIndex]) || `Level ${Number(levelIndex) + 1}`;
}

function closePathSegmentMenu() {
  const menu = state.pathSegmentMenu;
  if (!menu) return;
  menu.element?.remove?.();
  document.removeEventListener("mousedown", menu.onOutside, true);
  document.removeEventListener("keydown", menu.onKeyDown, true);
  window.removeEventListener("resize", menu.onClose, true);
  window.removeEventListener("scroll", menu.onScroll, true);
  state.pathSegmentMenu = null;
}

function getPathSegmentChildren(parentPath) {
  const model = state.pathPickerModel;
  if (!model || typeof model.getChildrenForPrefix !== "function") return [];
  return model.getChildrenForPrefix(parentPath).filter((item) => toText(item?.name) && toText(item?.path));
}

function findPathSegmentChild(parentPath, name) {
  const targetKey = getPathPartKey(name);
  if (!targetKey) return null;
  return getPathSegmentChildren(parentPath).find((item) => getPathPartKey(item?.name) === targetKey) || null;
}

function completePathToLeaf(path) {
  let nextPath = normalizePath(path);
  const seen = new Set();
  while (nextPath && !seen.has(nextPath.toLowerCase())) {
    seen.add(nextPath.toLowerCase());
    const children = getPathSegmentChildren(nextPath);
    if (!children.length) break;
    nextPath = normalizePath(children[0].path);
  }
  return nextPath;
}

function resolveSegmentChoicePath(levelIndex, choice) {
  const currentParts = getPathParts();
  const choicePath = normalizePath(choice?.path);
  if (!choicePath) return "";

  let nextPath = choicePath;
  let preservedSuffix = true;
  for (const suffixPart of currentParts.slice(Number(levelIndex) + 1)) {
    const child = findPathSegmentChild(nextPath, suffixPart);
    if (!child) {
      preservedSuffix = false;
      break;
    }
    nextPath = normalizePath(child.path);
  }
  return preservedSuffix ? completePathToLeaf(nextPath) : completePathToLeaf(choicePath);
}

function positionPathSegmentMenu(anchor, menu) {
  const rect = anchor?.getBoundingClientRect?.();
  if (!rect || !menu) return;
  const margin = 8;
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - menuRect.width - margin));
  const top = Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - margin));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function showPathSegmentMenu(levelIndex, anchor) {
  closePathSegmentMenu();
  const parts = getPathParts();
  if (!parts.length || !state.pathPickerModel) return;
  const numericLevel = Number(levelIndex);
  const parentPath = parts.slice(0, numericLevel).join("\\");
  const currentPart = parts[numericLevel] || "";
  const options = getPathSegmentChildren(parentPath);
  if (!options.length) return;

  const menu = document.createElement("div");
  menu.className = "pi-path-segment-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", `Change ${getPathLevelLabel(numericLevel)}`);

  const title = document.createElement("div");
  title.className = "pi-path-segment-title";
  title.textContent = getPathLevelLabel(numericLevel);
  menu.appendChild(title);

  const list = document.createElement("div");
  list.className = "pi-path-segment-list";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pi-path-segment-option";
    button.setAttribute("role", "option");
    const selected = getPathPartKey(option.name) === getPathPartKey(currentPart);
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.textContent = option.name;
    button.addEventListener("click", () => {
      const nextPath = resolveSegmentChoicePath(numericLevel, option);
      closePathSegmentMenu();
      if (!nextPath || normalizePath(nextPath).toLowerCase() === normalizePath(state.selectedPath).toLowerCase()) return;
      setSelectedPath(nextPath);
      markPathTreeActive(nextPath);
      setStatus(`Selected reserving class path ${nextPath}.`);
    });
    list.appendChild(button);
  }
  menu.appendChild(list);
  document.body.appendChild(menu);
  positionPathSegmentMenu(anchor, menu);

  const onClose = () => closePathSegmentMenu();
  const onOutside = (event) => {
    if (menu.contains(event.target) || anchor?.contains?.(event.target)) return;
    closePathSegmentMenu();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closePathSegmentMenu();
    anchor?.focus?.({ preventScroll: true });
  };
  const onScroll = (event) => {
    if (menu.contains(event.target) || anchor?.contains?.(event.target)) return;
    closePathSegmentMenu();
  };
  state.pathSegmentMenu = { element: menu, onOutside, onKeyDown, onClose, onScroll };
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onClose, true);
  window.addEventListener("scroll", onScroll, true);
}

function renderSelectedPathDisplay() {
  const target = els.selectedPathText;
  if (!target) return;
  const path = normalizePath(state.selectedPath);
  target.replaceChildren();
  target.title = path;
  target.classList.toggle("has-path", !!path);
  if (!path) {
    target.textContent = "Select a reserving class path.";
    return;
  }
  const parts = getPathParts(path);
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "pi-toolbar-path-separator";
      sep.textContent = "\\";
      target.appendChild(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pi-toolbar-path-segment";
    button.textContent = part;
    button.title = `${getPathLevelLabel(index)}: ${part}`;
    button.setAttribute("aria-haspopup", "listbox");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPathSegmentMenu(index, button);
    });
    target.appendChild(button);
  });
}


function setSelectedPath(path, options = {}) {
  state.selectedPath = normalizePath(path);
  datasetTableSelection.selectedKeys.clear();
  datasetTableSelection.anchorKey = "";
  closePathSegmentMenu();
  renderSelectedPathDisplay();
  markPathTreeActive(state.selectedPath);
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
  if (els.pathTree.dataset.focusWired !== "1") {
    els.pathTree.dataset.focusWired = "1";
    els.pathTree.addEventListener("mousedown", () => focusProjectInstancePage(), true);
  }
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
      ignoreSavedFilterSpec: true,
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
    state.pathPickerModel = result?.model || null;
    wirePathTreeScrollbarActivity();
    renderSelectedPathDisplay();
    markPathTreeActive(state.selectedPath);
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
    renderSelectedPathDisplay,
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
