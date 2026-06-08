export function installProjectInstanceWindows(ctx) {
  const { api, els, projectName, state } = ctx;
  const { DATASET_WINDOW_MIN_WIDTH, DATASET_WINDOW_MIN_HEIGHT, DATASET_WINDOW_DEFAULT_WIDTH_RATIO, DATASET_WINDOW_DEFAULT_HEIGHT_RATIO, DATASET_WINDOW_EDGE_VISIBLE_WIDTH, DATASET_WINDOW_TITLEBAR_HEIGHT } = ctx.constants;
  const { hiddenWindows, datasetWindows } = state;
  const activateDatasetWindow = (...args) => api.activateDatasetWindow(...args);
  const clampNumber = (...args) => api.clampNumber(...args);
  const closeActiveDatasetWindowFromShortcut = (...args) => api.closeActiveDatasetWindowFromShortcut(...args);
  const hideDatasetWindow = (...args) => api.hideDatasetWindow(...args);
  const isPointInHiddenDropZone = (...args) => api.isPointInHiddenDropZone(...args);
  const markPathTreeActive = (...args) => api.markPathTreeActive(...args);
  const normalizePath = (...args) => api.normalizePath(...args);
  const postZoomToDatasetFrame = (...args) => api.postZoomToDatasetFrame(...args);
  const recordSelectedDfmObject = (...args) => api.recordSelectedDfmObject(...args);
  const routeDfmRatioHotkey = (...args) => api.routeDfmRatioHotkey(...args);
  const routeDfmWindowCommand = (...args) => api.routeDfmWindowCommand(...args);
  const setHiddenDropActive = (...args) => api.setHiddenDropActive(...args);
  const setSelectedPath = (...args) => api.setSelectedPath(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);
  const updateHiddenTabsArea = (...args) => api.updateHiddenTabsArea(...args);
  const waitForPathTreeRender = (...args) => api.waitForPathTreeRender(...args);

function getDatasetWindowKey(datasetName, path = state.selectedPath) {
  return `${normalizePath(path)}\u0001${toText(datasetName).toLowerCase()}`;
}


function getDfmWindowKey(datasetName, path = state.selectedPath) {
  return `dfm\u0001${normalizePath(path)}\u0001${toText(datasetName).toLowerCase()}`;
}

function getWindowPath(frame) {
  return normalizePath(frame?.dataset?.windowPath || "");
}

function isWindowOnSelectedPath(frame) {
  const windowPath = getWindowPath(frame);
  const currentPath = normalizePath(state.selectedPath);
  return !!windowPath && !!currentPath && windowPath.toLowerCase() === currentPath.toLowerCase();
}

function getWindowFullTitle(frame) {
  return toText(frame?.dataset?.windowTitle || frame?.getAttribute?.("aria-label") || frame?.dataset?.windowDatasetName || "Dataset");
}

function getWindowShortTitle(frame) {
  return toText(frame?.dataset?.windowDatasetName || frame?.dataset?.windowItemName || getWindowFullTitle(frame));
}

function updateDatasetWindowTitle(frame) {
  if (!frame) return;
  const fullTitle = getWindowFullTitle(frame);
  const displayTitle = isWindowOnSelectedPath(frame) ? getWindowShortTitle(frame) : fullTitle;
  const titleEl = frame.querySelector?.(".pi-window-title");
  if (titleEl) {
    titleEl.textContent = displayTitle;
    titleEl.removeAttribute("title");
  }
  frame.dataset.windowDisplayTitle = displayTitle;
  frame.setAttribute("aria-label", fullTitle);
}

function syncDatasetWindowChrome() {
  const active = getActiveDatasetWindow();
  for (const frame of datasetWindows.values()) {
    if (!frame?.isConnected) continue;
    const visible = frame.dataset.hidden !== "1" && frame.style.display !== "none";
    frame.classList.toggle("active", visible && frame === active);
    updateDatasetWindowTitle(frame);
  }
}

function getFrameRect(frame) {
  return {
    x: Number.parseFloat(frame.style.left) || 0,
    y: Number.parseFloat(frame.style.top) || 0,
    width: Number.parseFloat(frame.style.width) || frame.getBoundingClientRect().width || DATASET_WINDOW_MIN_WIDTH,
    height: Number.parseFloat(frame.style.height) || frame.getBoundingClientRect().height || DATASET_WINDOW_MIN_HEIGHT,
  };
}

function getProjectInstanceWindowSnapshot(frame) {
  if (!frame?.isConnected) return null;
  const kind = isDfmWindow(frame) ? "dfm" : "dataset";
  const name = toText(frame.dataset.windowItemName || frame.dataset.windowDatasetName || "");
  if (!name) return null;
  const active = getActiveDatasetWindow() === frame;
  const hiddenItem = hiddenWindows.get(frame.dataset.windowId || "");
  return {
    kind,
    name,
    title: toText(frame.dataset.windowTitle || frame.getAttribute("aria-label") || name),
    hidden: frame.dataset.hidden === "1" || frame.style.display === "none",
    active,
    maximized: frame.dataset.maximized === "1",
    dirty: frame.dataset.dirty === "1",
    dfmTab: kind === "dfm" ? toText(frame.dataset.dfmTab || "") : "",
    rect: hiddenItem?.restoreRect || getFrameRect(frame),
  };
}

function buildProjectInstanceStateSnapshot() {
  const windows = [];
  for (const frame of datasetWindows.values()) {
    const snapshot = getProjectInstanceWindowSnapshot(frame);
    if (snapshot) windows.push(snapshot);
  }
  windows.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (b.active && !a.active) return 1;
    return a.title.localeCompare(b.title);
  });
  const active = windows.find((item) => item.active);
  const snapshotState = {
    selectedPath: state.selectedPath,
    windows,
  };
  if (active) snapshotState.activeWindow = { kind: active.kind, name: active.name };
  return snapshotState;
}

function notifyProjectInstanceStateChanged() {
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-state",
      state: buildProjectInstanceStateSnapshot(),
    }, "*");
  } catch {}
}


function getWindowBounds() {
  const rect = els.root?.getBoundingClientRect?.();
  return {
    width: Math.max(480, Number(rect?.width || window.innerWidth || 900)),
    height: Math.max(360, Number(rect?.height || window.innerHeight || 640)),
  };
}

function getWindowTopLimit() {
  const rootRect = els.root?.getBoundingClientRect?.();
  const toolbarRect = els.toolbar?.getBoundingClientRect?.();
  if (!rootRect || !toolbarRect) return 0;
  return Math.max(0, Math.round(toolbarRect.bottom - rootRect.top));
}

function getWindowHorizontalLimits(width, bounds = getWindowBounds()) {
  const visibleWidth = Math.min(DATASET_WINDOW_EDGE_VISIBLE_WIDTH, Math.max(1, Number(width) || 1));
  return {
    minX: Math.min(0, visibleWidth - width),
    maxX: Math.max(0, bounds.width - visibleWidth),
  };
}

function clampWindowRect(rect) {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  const maxHeight = Math.max(DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY);
  const width = Math.max(DATASET_WINDOW_MIN_WIDTH, Math.min(Number(rect.width) || 760, bounds.width));
  const height = Math.max(DATASET_WINDOW_MIN_HEIGHT, Math.min(Number(rect.height) || 500, maxHeight));
  const { minX, maxX } = getWindowHorizontalLimits(width, bounds);
  const maxY = Math.max(minY, bounds.height - DATASET_WINDOW_TITLEBAR_HEIGHT);
  const x = Math.max(minX, Math.min(Number(rect.x) || 0, maxX));
  const y = Math.max(minY, Math.min(Number(rect.y) || minY, maxY));
  return { x, y, width, height };
}

function rememberDatasetWindowSize(rect) {
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  state.lastDatasetWindowSize = {
    width: Math.max(DATASET_WINDOW_MIN_WIDTH, Math.round(width)),
    height: Math.max(DATASET_WINDOW_MIN_HEIGHT, Math.round(height)),
  };
}

function applyWindowRect(frame, rect, options = {}) {
  const next = clampWindowRect(rect);
  frame.style.left = `${Math.round(next.x)}px`;
  frame.style.top = `${Math.round(next.y)}px`;
  frame.style.width = `${Math.round(next.width)}px`;
  frame.style.height = `${Math.round(next.height)}px`;
  if (
    frame?.classList?.contains("pi-window")
    && frame.dataset.maximized !== "1"
    && options.rememberSize !== false
  ) {
    rememberDatasetWindowSize(next);
  }
  return next;
}

function isDatasetWindowMaximized(frame) {
  return frame?.dataset?.maximized === "1";
}

function getMaximizedWindowRect() {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  return {
    x: 0,
    y: minY,
    width: bounds.width,
    height: Math.max(DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY),
  };
}

function getPointerRestoreRect(frame, pointerEvent, restoreRect) {
  const rootRect = els.root?.getBoundingClientRect?.();
  const currentRect = frame?.getBoundingClientRect?.();
  if (!rootRect || !currentRect || !pointerEvent) return restoreRect;
  const pointerX = pointerEvent.clientX - rootRect.left;
  const pointerY = pointerEvent.clientY - rootRect.top;
  const ratioX = clampNumber(
    (pointerEvent.clientX - currentRect.left) / Math.max(1, currentRect.width),
    0.12,
    0.88
  );
  const titleOffsetY = clampNumber(pointerEvent.clientY - currentRect.top, 8, 24);
  return {
    ...restoreRect,
    x: pointerX - restoreRect.width * ratioX,
    y: pointerY - titleOffsetY,
  };
}

function maximizeDatasetWindow(frame) {
  if (!frame) return;
  if (!isDatasetWindowMaximized(frame)) {
    frame.__piRestoreRect = getFrameRect(frame);
  }
  frame.dataset.maximized = "1";
  applyWindowRect(frame, getMaximizedWindowRect(), { rememberSize: false });
  updateDatasetWindowMaximizeControl(frame);
  raiseWindow(frame);
  notifyProjectInstanceStateChanged();
}

function restoreDatasetWindow(frame, pointerEvent = null) {
  if (!frame) return;
  const stored = frame.__piRestoreRect || getNextDatasetWindowRect(0);
  const restoreRect = pointerEvent
    ? getPointerRestoreRect(frame, pointerEvent, stored)
    : stored;
  frame.dataset.maximized = "0";
  applyWindowRect(frame, restoreRect);
  updateDatasetWindowMaximizeControl(frame);
  raiseWindow(frame);
  notifyProjectInstanceStateChanged();
}

function toggleDatasetWindowMaximized(frame) {
  if (isDatasetWindowMaximized(frame)) {
    restoreDatasetWindow(frame);
  } else {
    maximizeDatasetWindow(frame);
  }
}

function syncMaximizedDatasetWindows() {
  for (const frame of datasetWindows.values()) {
    if (!frame?.isConnected || frame.dataset.hidden === "1" || !isDatasetWindowMaximized(frame)) continue;
    applyWindowRect(frame, getMaximizedWindowRect(), { rememberSize: false });
  }
}

function updateDatasetWindowMaximizeControl(frame) {
  const button = frame?.querySelector?.(".pi-window-maximize");
  if (!button) return;
  const maximized = isDatasetWindowMaximized(frame);
  button.title = maximized ? "Restore" : "Maximize";
  button.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
}

function getNextDatasetWindowRect(offset = 0) {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  const availableHeight = Math.max(DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY);
  const preferredWidth = state.lastDatasetWindowSize?.width
    || Math.round(bounds.width * DATASET_WINDOW_DEFAULT_WIDTH_RATIO);
  const preferredHeight = state.lastDatasetWindowSize?.height
    || Math.round(availableHeight * DATASET_WINDOW_DEFAULT_HEIGHT_RATIO);
  const width = Math.max(DATASET_WINDOW_MIN_WIDTH, Math.min(preferredWidth, bounds.width));
  const height = Math.max(DATASET_WINDOW_MIN_HEIGHT, Math.min(preferredHeight, availableHeight));
  return clampWindowRect({
    x: Math.round((bounds.width - width) / 2) + offset,
    y: Math.round(minY + (availableHeight - height) / 2) + offset,
    width,
    height,
  });
}

function raiseWindow(frame) {
  frame.style.zIndex = String(++state.nextWindowZ);
  if (frame?.classList?.contains("pi-window") && frame.dataset.hidden !== "1") {
    state.activeDatasetWindow = frame;
  }
  syncDatasetWindowChrome();
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
}

function getActiveDatasetWindow() {
  if (
    state.activeDatasetWindow?.isConnected
    && state.activeDatasetWindow.dataset.hidden !== "1"
    && state.activeDatasetWindow.style.display !== "none"
  ) {
    return state.activeDatasetWindow;
  }
  let nextActive = null;
  let topZ = -1;
  for (const frame of datasetWindows.values()) {
    if (!frame?.isConnected || frame.dataset.hidden === "1" || frame.style.display === "none") continue;
    const z = Number.parseInt(frame.style.zIndex || "0", 10);
    if (z >= topZ) {
      topZ = z;
      nextActive = frame;
    }
  }
  state.activeDatasetWindow = nextActive;
  return nextActive;
}

function closeDatasetWindow(frame, { status = true } = {}) {
  if (!frame?.isConnected) return false;
  const iframe = getWindowIframe(frame);
  if (iframe?.contentWindow) {
    try {
      const requestClose = iframe.contentWindow.__arcrho_request_close;
      if (typeof requestClose === "function" && requestClose() === true) return false;
    } catch {}
  }
  if (frame.dataset.dirty === "1") {
    const titleForPrompt = frame.dataset.windowDatasetName || frame.dataset.windowTitle || "Dataset window";
    const ok = window.confirm(`${titleForPrompt} has unsaved changes. Close it anyway?`);
    if (!ok) return false;
  }
  const title = frame.dataset.windowDatasetName || frame.dataset.windowTitle || frame.getAttribute("aria-label") || "dataset window";
  hiddenWindows.delete(frame.dataset.windowId || "");
  datasetWindows.delete(frame.dataset.windowKey || "");
  if (state.activeDatasetWindow === frame) state.activeDatasetWindow = null;
  frame.remove();
  syncDatasetWindowChrome();
  updateHiddenTabsArea();
  notifyProjectInstanceDirtyState();
  notifyActiveDfmWindowState();
  notifyProjectInstanceStateChanged();
  if (status) setStatus(`Closed ${title}`);
  return true;
}


function isDfmWindow(frame) {
  return frame?.dataset?.windowKind === "dfm";
}

function findWindowByInstance(inst) {
  const id = toText(inst);
  if (!id) return null;
  for (const frame of datasetWindows.values()) {
    if (frame?.dataset?.windowId === id) return frame;
  }
  return null;
}

function findWindowByMessageSource(source) {
  if (!source) return null;
  for (const frame of datasetWindows.values()) {
    const iframe = getWindowIframe(frame);
    if (iframe?.contentWindow === source) return frame;
  }
  return null;
}

function getWindowIframe(frame) {
  return frame?.querySelector?.(".pi-window-body iframe") || null;
}

function setWindowDirtyState(frame, dirty) {
  if (!frame) return;
  frame.dataset.dirty = dirty ? "1" : "0";
  frame.classList.toggle("dirty", !!dirty);
  const closeBtn = frame.querySelector(".pi-window-close");
  if (closeBtn) {
    closeBtn.title = dirty ? "Unsaved changes (close)" : "Close";
    closeBtn.setAttribute("aria-label", dirty ? "Unsaved changes (close)" : "Close");
  }
  if (frame.dataset.hidden === "1") updateHiddenTabsArea();
  notifyProjectInstanceDirtyState();
  notifyProjectInstanceStateChanged();
}

function hasDirtyDfmWindow() {
  for (const frame of datasetWindows.values()) {
    if (frame?.dataset?.dirty === "1") return true;
  }
  return false;
}

function notifyProjectInstanceDirtyState() {
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-dirty",
      dirty: hasDirtyDfmWindow(),
    }, "*");
  } catch {}
}

function notifyActiveDfmWindowState() {
  const frame = getActiveDfmWindow();
  try {
    window.parent?.postMessage({
      type: "arcrho:project-instance-dfm-active-state",
      active: !!frame,
      inst: frame?.dataset?.windowId || "",
      title: frame?.dataset?.windowTitle || "",
      tab: frame?.dataset?.dfmTab || "",
      canUndo: frame?.dataset?.dfmCanUndo === "1",
      canRedo: frame?.dataset?.dfmCanRedo === "1",
      editEnabled: frame?.dataset?.dfmEditEnabled === "1",
    }, "*");
  } catch {}
}

function getActiveDfmWindow() {
  const active = getActiveDatasetWindow();
  if (isDfmWindow(active)) return active;
  let topDfm = null;
  let topZ = -1;
  for (const frame of datasetWindows.values()) {
    if (!isDfmWindow(frame) || !frame?.isConnected || frame.dataset.hidden === "1" || frame.style.display === "none") continue;
    const z = Number.parseInt(frame.style.zIndex || "0", 10);
    if (z >= topZ) {
      topZ = z;
      topDfm = frame;
    }
  }
  return topDfm;
}


function resizeRectFromCorner(start, corner, dx, dy) {
  const bounds = getWindowBounds();
  const minY = getWindowTopLimit();
  const { minX } = getWindowHorizontalLimits(start.width, bounds);
  const next = {
    x: start.x,
    y: start.y,
    width: start.width,
    height: start.height,
  };

  if (corner.includes("e")) {
    next.width = clampNumber(start.width + dx, DATASET_WINDOW_MIN_WIDTH, bounds.width);
  }
  if (corner.includes("s")) {
    next.height = clampNumber(start.height + dy, DATASET_WINDOW_MIN_HEIGHT, bounds.height - minY);
  }
  if (corner.includes("w")) {
    const right = start.x + start.width;
    next.x = clampNumber(start.x + dx, minX, right - DATASET_WINDOW_MIN_WIDTH);
    next.width = right - next.x;
  }
  if (corner.includes("n")) {
    const bottom = start.y + start.height;
    next.y = clampNumber(start.y + dy, minY, bottom - DATASET_WINDOW_MIN_HEIGHT);
    next.height = bottom - next.y;
  }

  return next;
}

function lockDatasetViewerInputs(iframe, datasetName) {
  let doc = null;
  try {
    doc = iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch {
    return;
  }
  if (!doc) return;

  const projectInput = doc.getElementById("projectSelect");
  const pathInput = doc.getElementById("pathInput");
  const triInput = doc.getElementById("triInput");
  if (projectInput) {
    projectInput.value = projectName;
    projectInput.readOnly = true;
    projectInput.title = "Project is set by the project instance tab.";
  }
  if (pathInput) {
    pathInput.value = state.selectedPath;
    pathInput.readOnly = true;
    pathInput.title = "Reserving class path is set by the project instance tab.";
  }
  if (triInput && datasetName) {
    triInput.value = datasetName;
  }
  for (const id of ["projectTreeBtn", "pathTreeBtn"]) {
    const button = doc.getElementById(id);
    if (button) {
      button.disabled = true;
      button.title = "Set by the project instance tab";
    }
  }
}

function wireDatasetViewerWindowShortcuts(iframe, frame) {
  let doc = null;
  try {
    doc = iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch {
    return;
  }
  if (!doc || doc.__piWindowShortcutsWired) return;
  doc.__piWindowShortcutsWired = true;
  doc.addEventListener("mousedown", () => raiseWindow(frame), true);
  doc.addEventListener("focusin", () => raiseWindow(frame), true);
  doc.addEventListener("keydown", (event) => {
    if (isDfmWindow(frame) && routeDfmRatioHotkey(event)) return;
    if (
      isDfmWindow(frame)
      && event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && String(event.key || "").toLowerCase() === "s"
    ) {
      event.preventDefault();
      event.stopPropagation();
      routeDfmWindowCommand(event.shiftKey ? "arcrho:dfm-save-as" : "arcrho:dfm-save");
      return;
    }
    closeActiveDatasetWindowFromShortcut(event, frame);
  }, true);
}

function buildDatasetViewerUrl(datasetName, inst, options = {}) {
  const params = new URLSearchParams();
  params.set("project", projectName);
  params.set("path", state.selectedPath);
  if (toText(datasetName)) params.set("tri", datasetName);
  if (options?.originLen) params.set("origin_len", String(options.originLen));
  if (options?.devLen) params.set("dev_len", String(options.devLen));
  if (options?.dsId) params.set("ds", toText(options.dsId));
  if (options?.readOnly) params.set("readonly", "1");
  if (options?.generated) params.set("generated_dataset", "1");
  if (options?.draft) params.set("draft_instance", "1");
  if (options?.initialTab) params.set("tab", toText(options.initialTab));
  params.set("inst", inst);
  params.set("project_instance", "1");
  params.set("v", String(Date.now()));
  return `/ui/dataset/dataset_viewer.html?${params.toString()}`;
}

function buildDfmViewerUrl(datasetName, inst, initialTab = "ratios") {
  const params = new URLSearchParams();
  params.set("project", projectName);
  params.set("class", state.selectedPath);
  params.set("method_name", datasetName);
  params.set("output_type", datasetName);
  params.set("tab", toText(initialTab) || "ratios");
  params.set("inst", inst);
  params.set("project_instance", "1");
  params.set("v", String(Date.now()));
  return `/ui/dfm/dfm.html?${params.toString()}`;
}

function beginWindowDragCapture(mode) {
  const shield = document.createElement("div");
  shield.className = `pi-window-drag-shield ${mode || "moving"}`;
  els.windowLayer?.appendChild(shield);
  return () => {
    if (shield.parentNode) shield.parentNode.removeChild(shield);
  };
}

function startMove(frame, event) {
  if (event.button !== 0) return;
  raiseWindow(frame);
  const releaseDragCapture = beginWindowDragCapture("moving");
  const getStart = (sourceEvent) => {
    const startRect = frame.getBoundingClientRect();
    const rootRect = els.root.getBoundingClientRect();
    return {
      x: startRect.left - rootRect.left,
      y: startRect.top - rootRect.top,
      width: startRect.width,
      height: startRect.height,
      px: sourceEvent.clientX,
      py: sourceEvent.clientY,
    };
  };
  let start = getStart(event);

  const onMove = (e) => {
    if (isDatasetWindowMaximized(frame)) {
      restoreDatasetWindow(frame, e);
      start = getStart(e);
    }
    applyWindowRect(frame, {
      x: start.x + e.clientX - start.px,
      y: start.y + e.clientY - start.py,
      width: start.width,
      height: start.height,
    });
    setHiddenDropActive(isPointInHiddenDropZone(e.clientX, e.clientY), frame);
  };
  const onUp = (e) => {
    releaseDragCapture();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    if (isPointInHiddenDropZone(e.clientX, e.clientY)) {
      hideDatasetWindow(frame, {
        x: start.x,
        y: start.y,
        width: start.width,
        height: start.height,
      });
      return;
    }
    setHiddenDropActive(false, frame);
    notifyProjectInstanceStateChanged();
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  event.preventDefault();
}

function startResize(frame, event, corner = "se") {
  if (event.button !== 0) return;
  if (isDatasetWindowMaximized(frame)) {
    restoreDatasetWindow(frame);
  }
  raiseWindow(frame);
  const resizeCorner = String(corner || "se").toLowerCase();
  const releaseDragCapture = beginWindowDragCapture(`resizing-${resizeCorner}`);
  const startRect = frame.getBoundingClientRect();
  const rootRect = els.root.getBoundingClientRect();
  const start = {
    x: startRect.left - rootRect.left,
    y: startRect.top - rootRect.top,
    width: startRect.width,
    height: startRect.height,
    px: event.clientX,
    py: event.clientY,
  };

  const onMove = (e) => {
    applyWindowRect(
      frame,
      resizeRectFromCorner(start, resizeCorner, e.clientX - start.px, e.clientY - start.py)
    );
  };
  const onUp = () => {
    releaseDragCapture();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    notifyProjectInstanceStateChanged();
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  event.preventDefault();
}

function createFloatingContentWindow(options = {}) {
  const name = toText(options.name);
  const title = toText(options.title) || name;
  const windowKey = toText(options.windowKey);
  const inst = toText(options.inst) || `pi_window_${Date.now()}_${state.windowSeq++}`;
  const iframeSrc = toText(options.iframeSrc);
  if (!name || !title || !windowKey || !iframeSrc) return null;

  const existing = datasetWindows.get(windowKey);
  if (existing?.isConnected) {
    void activateDatasetWindow(existing);
    return existing;
  }
  datasetWindows.delete(windowKey);

  const frame = document.createElement("section");
  frame.className = "pi-window";
  frame.dataset.windowId = inst;
  frame.dataset.windowKey = windowKey;
  frame.dataset.windowDatasetName = name;
  frame.dataset.windowItemName = toText(options.itemName) || name;
  frame.dataset.windowPath = normalizePath(options.path || state.selectedPath);
  frame.dataset.windowTitle = title;
  frame.dataset.windowKind = toText(options.kind) || "dataset";
  if (frame.dataset.windowKind === "dfm") frame.dataset.dfmTab = "ratios";
  frame.setAttribute("aria-label", title);
  frame.innerHTML = `
    <header class="pi-window-titlebar">
      <span class="pi-window-title"></span>
      <span class="pi-window-dirty" title="Unsaved changes" aria-hidden="true"></span>
      <div class="pi-window-titlebar-controls">
        <button class="pi-window-titlebar-btn pi-window-minimize" type="button" title="Minimize" aria-label="Minimize">
          <svg class="pi-window-titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="2" y1="7" x2="8" y2="7"></line>
          </svg>
        </button>
        <button class="pi-window-titlebar-btn pi-window-maximize" type="button" title="Maximize" aria-label="Maximize">
          <svg class="pi-window-titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2" y="2" width="6" height="6" rx="0.6"></rect>
          </svg>
        </button>
        <button class="pi-window-titlebar-btn pi-window-close" type="button" title="Close" aria-label="Close">
          <svg class="pi-window-titlebar-icon" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="2" y1="2" x2="8" y2="8"></line>
            <line x1="8" y1="2" x2="2" y2="8"></line>
          </svg>
        </button>
      </div>
    </header>
    <div class="pi-window-body"></div>
    <div class="pi-window-resize pi-window-resize-nw" data-corner="nw" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-n" data-corner="n" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-ne" data-corner="ne" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-e" data-corner="e" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-se" data-corner="se" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-s" data-corner="s" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-sw" data-corner="sw" title="Resize"></div>
    <div class="pi-window-resize pi-window-resize-edge pi-window-resize-w" data-corner="w" title="Resize"></div>
  `;

  updateDatasetWindowTitle(frame);

  const body = frame.querySelector(".pi-window-body");
  const iframe = document.createElement("iframe");
  iframe.src = iframeSrc;
  iframe.addEventListener("load", () => {
    wireDatasetViewerWindowShortcuts(iframe, frame);
    postZoomToDatasetFrame(iframe);
    if (isDfmWindow(frame)) {
      try { iframe.contentWindow?.postMessage({ type: "arcrho:dfm-request-state" }, "*"); } catch {}
      notifyActiveDfmWindowState();
    }
    if (typeof options.onIframeLoad === "function") {
      options.onIframeLoad(iframe, frame);
    }
  });
  body.appendChild(iframe);

  const titlebar = frame.querySelector(".pi-window-titlebar");
  titlebar?.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    if (Number(e.detail) >= 2) {
      e.preventDefault();
      frame.__piLastTitlebarToggle = Date.now();
      toggleDatasetWindowMaximized(frame);
      return;
    }
    startMove(frame, e);
  });
  titlebar?.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    if (Number(frame.__piLastTitlebarToggle || 0) && Date.now() - frame.__piLastTitlebarToggle < 400) return;
    e.preventDefault();
    toggleDatasetWindowMaximized(frame);
  });
  for (const handle of frame.querySelectorAll(".pi-window-resize")) {
    handle.addEventListener("mousedown", (e) => {
      startResize(frame, e, handle.getAttribute("data-corner") || "se");
    });
  }
  frame.querySelector(".pi-window-minimize")?.addEventListener("click", () => {
    hideDatasetWindow(frame, getFrameRect(frame));
  });
  frame.querySelector(".pi-window-maximize")?.addEventListener("click", () => {
    toggleDatasetWindowMaximized(frame);
  });
  frame.querySelector(".pi-window-close")?.addEventListener("click", () => closeDatasetWindow(frame));
  frame.addEventListener("mousedown", () => raiseWindow(frame));

  const offset = ((state.windowSeq - 1) % 5) * 26;
  els.windowLayer.appendChild(frame);
  datasetWindows.set(windowKey, frame);
  applyWindowRect(frame, getNextDatasetWindowRect(offset));
  raiseWindow(frame);
  notifyProjectInstanceStateChanged();
  setStatus(`Opened ${title}`);
  return frame;
}

function openDatasetWindow(datasetName, options = {}) {
  const name = toText(datasetName);
  if (!name) return;
  if (!state.selectedPath) {
    setStatus("Select a reserving class path before opening a dataset.", true);
    return;
  }

  const windowKey = getDatasetWindowKey(name);
  const title = `${state.selectedPath}\\${name}`;
  const inst = `pi_ds_${Date.now()}_${state.windowSeq++}`;
  return createFloatingContentWindow({
    kind: "dataset",
    name,
    itemName: name,
    title,
    windowKey,
    inst,
    iframeSrc: buildDatasetViewerUrl(name, inst, {
      readOnly: options?.readOnly,
      generated: options?.generated,
    }),
    onIframeLoad: (iframe) => {
      lockDatasetViewerInputs(iframe, name);
      window.setTimeout(() => lockDatasetViewerInputs(iframe, name), 250);
    },
  });
}

function openNewDatasetDraftWindow(datasetName, options = {}) {
  const name = toText(datasetName);
  if (!name) return null;
  if (!state.selectedPath) {
    setStatus("Select a reserving class path before adding a dataset.", true);
    return null;
  }

  const windowKey = `${getDatasetWindowKey(name)}\u0001draft\u0001${Date.now()}`;
  const isDraft = options?.draft !== false;
  const title = isDraft ? `${state.selectedPath}\\New Dataset: ${name}` : `${state.selectedPath}\\${name}`;
  const inst = `pi_ds_new_${Date.now()}_${state.windowSeq++}`;
  return createFloatingContentWindow({
    kind: "dataset",
    name: isDraft ? `New: ${name}` : name,
    itemName: name,
    title,
    windowKey,
    inst,
    iframeSrc: buildDatasetViewerUrl(name, inst, {
      originLen: options?.originLen || 12,
      devLen: options?.devLen || 12,
      dsId: options?.dsId,
      readOnly: options?.readOnly,
      generated: options?.generated,
      draft: isDraft,
      initialTab: options?.initialTab || "details",
    }),
    onIframeLoad: (iframe) => {
      lockDatasetViewerInputs(iframe, name);
      window.setTimeout(() => lockDatasetViewerInputs(iframe, name), 250);
    },
  });
}

function openDfmWindow(datasetName, options = {}) {
  const name = toText(datasetName);
  if (!name) return;
  if (!state.selectedPath) {
    setStatus("Select a reserving class path before opening a DFM object.", true);
    return;
  }

  recordSelectedDfmObject(name);
  const windowKey = getDfmWindowKey(name);
  const title = `${state.selectedPath}\\DFM\\${name}`;
  const initialTab = toText(options.initialTab || options.dfmTab || "ratios") || "ratios";
  const inst = `pi_dfm_${Date.now()}_${state.windowSeq++}`;
  return createFloatingContentWindow({
    kind: "dfm",
    name: `DFM: ${name}`,
    itemName: name,
    title,
    windowKey,
    inst,
    iframeSrc: buildDfmViewerUrl(name, inst, initialTab),
  });
}

function applyRestoredWindowState(frame, item = {}) {
  if (!frame?.isConnected) return;
  const rect = item?.rect && typeof item.rect === "object" ? item.rect : null;
  if (!item?.maximized) {
    frame.dataset.maximized = "0";
    delete frame.__piRestoreRect;
    updateDatasetWindowMaximizeControl(frame);
  }
  if (rect) applyWindowRect(frame, rect);
  if (item?.maximized) maximizeDatasetWindow(frame);
  if (toText(item?.dfmTab) && isDfmWindow(frame)) {
    frame.dataset.dfmTab = toText(item.dfmTab);
  }
  const id = frame.dataset.windowId || "";
  if (item?.hidden) {
    hiddenWindows.set(id, {
      frame,
      title: frame.dataset.windowDatasetName || frame.dataset.windowTitle || "Dataset",
      fullTitle: frame.dataset.windowTitle || frame.getAttribute("aria-label") || "Dataset",
      restoreRect: rect || getFrameRect(frame),
    });
    frame.dataset.hidden = "1";
    frame.style.display = "none";
    if (state.activeDatasetWindow === frame) state.activeDatasetWindow = null;
  } else {
    hiddenWindows.delete(id);
    frame.dataset.hidden = "0";
    frame.style.display = "";
  }
}

async function applyProjectInstanceRestoreState(rawState) {
  const restoreState = rawState && typeof rawState === "object" ? rawState : {};
  const path = normalizePath(restoreState.selectedPath || restoreState.path || "");
  if (path) {
    setSelectedPath(path, { persist: false });
    await waitForPathTreeRender();
    markPathTreeActive(path);
  }
  const windows = Array.isArray(restoreState.windows) ? restoreState.windows : [];
  let activeTarget = null;
  for (const item of windows) {
    const kind = toText(item?.kind).toLowerCase() === "dfm" ? "dfm" : "dataset";
    const name = toText(item?.name || item?.datasetName || item?.methodName);
    if (!name) continue;
    const frame = kind === "dfm" ? openDfmWindow(name, { initialTab: item?.dfmTab }) : openDatasetWindow(name);
    applyRestoredWindowState(frame, item);
    if (item?.active) activeTarget = frame;
  }
  updateHiddenTabsArea();
  if (activeTarget?.isConnected && activeTarget.dataset.hidden !== "1") {
    raiseWindow(activeTarget);
  } else {
    notifyActiveDfmWindowState();
  }
  notifyProjectInstanceStateChanged();
}

  Object.assign(api, {
    applyProjectInstanceRestoreState,
    applyRestoredWindowState,
    applyWindowRect,
    beginWindowDragCapture,
    buildDatasetViewerUrl,
    buildDfmViewerUrl,
    buildProjectInstanceStateSnapshot,
    clampWindowRect,
    closeDatasetWindow,
    createFloatingContentWindow,
    findWindowByInstance,
    findWindowByMessageSource,
    getActiveDatasetWindow,
    getActiveDfmWindow,
    getDatasetWindowKey,
    getDfmWindowKey,
    getFrameRect,
    getMaximizedWindowRect,
    getNextDatasetWindowRect,
    getPointerRestoreRect,
    getProjectInstanceWindowSnapshot,
    getWindowBounds,
    getWindowFullTitle,
    getWindowHorizontalLimits,
    getWindowIframe,
    getWindowPath,
    getWindowShortTitle,
    getWindowTopLimit,
    hasDirtyDfmWindow,
    isDatasetWindowMaximized,
    isDfmWindow,
    isWindowOnSelectedPath,
    lockDatasetViewerInputs,
    maximizeDatasetWindow,
    notifyActiveDfmWindowState,
    notifyProjectInstanceDirtyState,
    notifyProjectInstanceStateChanged,
    openDatasetWindow,
    openNewDatasetDraftWindow,
    openDfmWindow,
    raiseWindow,
    rememberDatasetWindowSize,
    resizeRectFromCorner,
    restoreDatasetWindow,
    setWindowDirtyState,
    startMove,
    startResize,
    syncDatasetWindowChrome,
    syncMaximizedDatasetWindows,
    toggleDatasetWindowMaximized,
    updateDatasetWindowMaximizeControl,
    updateDatasetWindowTitle,
    wireDatasetViewerWindowShortcuts
  });
}
