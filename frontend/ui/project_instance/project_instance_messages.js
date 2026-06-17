export function installProjectInstanceMessages(ctx) {
  const { api, els, projectName, state } = ctx;
  const activateDatasetWindow = (...args) => api.activateDatasetWindow(...args);
  const applyProjectInstanceRestoreState = (...args) => api.applyProjectInstanceRestoreState(...args);
  const closeDatasetWindow = (...args) => api.closeDatasetWindow(...args);
  const findWindowByInstance = (...args) => api.findWindowByInstance(...args);
  const findWindowByMessageSource = (...args) => api.findWindowByMessageSource(...args);
  const fetchCachedDatasetSnapshot = (...args) => api.fetchCachedDatasetSnapshot(...args);
  const getActiveDatasetWindow = (...args) => api.getActiveDatasetWindow(...args);
  const getActiveDfmWindow = (...args) => api.getActiveDfmWindow(...args);
  const getFrameRect = (...args) => api.getFrameRect(...args);
  const getProjectInstanceAssistantContextSummary = (...args) => api.getProjectInstanceAssistantContextSummary(...args);
  const getWindowIframe = (...args) => api.getWindowIframe(...args);
  const getWindowMethodType = (...args) => api.getWindowMethodType(...args);
  const getWindowPath = (...args) => api.getWindowPath(...args);
  const hideDatasetWindow = (...args) => api.hideDatasetWindow(...args);
  const isDatasetWindowMaximized = (...args) => api.isDatasetWindowMaximized(...args);
  const isDfmWindow = (...args) => api.isDfmWindow(...args);
  const loadCachedDatasetFilterForSelectedPath = (...args) => api.loadCachedDatasetFilterForSelectedPath(...args);
  const maximizeDatasetWindow = (...args) => api.maximizeDatasetWindow(...args);
  const notifyActiveDfmWindowState = (...args) => api.notifyActiveDfmWindowState(...args);
  const notifyProjectInstanceStateChanged = (...args) => api.notifyProjectInstanceStateChanged(...args);
  const openDatasetWindow = (...args) => api.openDatasetWindow(...args);
  const postMessageToDatasetWindows = (...args) => api.postMessageToDatasetWindows(...args);
  const restoreDatasetWindow = (...args) => api.restoreDatasetWindow(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const setWindowDirtyState = (...args) => api.setWindowDirtyState(...args);
  const toText = (...args) => api.toText(...args);

function getReservingClassFolderPathFromSnapshot(payload) {
  const folderPaths = payload?.folder_paths && typeof payload.folder_paths === "object"
    ? payload.folder_paths
    : payload?.folderPaths && typeof payload.folderPaths === "object"
      ? payload.folderPaths
      : null;
  return toText(folderPaths?.data || payload?.folder_path || payload?.folderPath);
}

function requestShellOpenPath(targetPath) {
  const path = toText(targetPath);
  if (!path) return Promise.resolve({ ok: false, error: "Empty path." });
  const requestId = `pi_reveal_path_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(payload);
    };
    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type !== "arcrho:open-path-result" || toText(msg.requestId) !== requestId) return;
      finish({ ok: !!msg.ok, error: toText(msg.error) });
    };
    window.addEventListener("message", onMessage);
    window.setTimeout(() => finish({ ok: false, error: "Timed out opening path." }), 6000);
    try {
      window.parent?.postMessage({ type: "arcrho:open-path", requestId, path }, "*");
    } catch (err) {
      finish({ ok: false, error: toText(err?.message) || "Failed to send open-path request." });
    }
  });
}

function forwardOpenPathRequestToShell(message, sourceWindow) {
  const source = sourceWindow || null;
  const sourceFrame = findWindowByMessageSource(source);
  if (!sourceFrame) return false;

  const requestId = toText(message?.requestId);
  const path = toText(message?.path);
  const preferredApp = toText(message?.preferredApp);
  const readOnly = !!message?.readOnly;
  if (!requestId) return true;

  const replyToSource = (payload) => {
    try {
      source?.postMessage({ type: "arcrho:open-path-result", requestId, ...payload }, "*");
    } catch {}
  };
  if (!path) {
    replyToSource({ ok: false, error: "Empty path." });
    return true;
  }

  let done = false;
  let timeoutId = null;
  const finish = (payload) => {
    if (done) return;
    done = true;
    if (timeoutId != null) window.clearTimeout(timeoutId);
    window.removeEventListener("message", onMessage);
    replyToSource(payload || { ok: false, error: "Open path failed." });
  };
  const onMessage = (event) => {
    const msg = event.data || {};
    if (msg.type !== "arcrho:open-path-result" || toText(msg.requestId) !== requestId) return;
    finish({ ok: !!msg.ok, error: toText(msg.error) });
  };
  window.addEventListener("message", onMessage);
  timeoutId = window.setTimeout(() => finish({ ok: false, error: "Open path timed out." }), 6000);
  try {
    window.parent?.postMessage({
      type: "arcrho:open-path",
      requestId,
      path,
      preferredApp,
      readOnly,
    }, "*");
  } catch (err) {
    finish({ ok: false, error: toText(err?.message) || "Failed to send open-path request." });
  }
  return true;
}

async function revealSelectedReservingClassFolder() {
  const selectedPath = toText(state.selectedPath);
  if (!projectName || !selectedPath) {
    setStatus("Select a reserving-class path before revealing it.", true);
    return false;
  }
  setStatus("Resolving reserving-class folder...");
  try {
    const payload = await fetchCachedDatasetSnapshot(selectedPath);
    const folderPath = getReservingClassFolderPathFromSnapshot(payload);
    if (!folderPath) {
      setStatus("Could not resolve the reserving-class folder.", true);
      return false;
    }
    setStatus("Opening reserving-class folder...");
    const result = await requestShellOpenPath(folderPath);
    if (result?.ok) {
      setStatus("Opened reserving-class folder.");
      return true;
    }
    setStatus(toText(result?.error) || "Could not open the reserving-class folder.", true);
  } catch (err) {
    setStatus(toText(err?.message) || "Could not resolve the reserving-class folder.", true);
  }
  return false;
}

function routeDfmWindowCommand(type) {
  let command = toText(type);
  const frame = getActiveDfmWindow();
  if (!frame) {
    setStatus("No active DFM window.", true);
    return false;
  }
  if (command === "arcrho:dfm-save-as" && toText(frame.dataset.dfmTab).toLowerCase() === "details") {
    command = "arcrho:dfm-save-template";
  }
  const iframe = getWindowIframe(frame);
  try {
    iframe?.contentWindow?.postMessage({ type: command }, "*");
    const statusByCommand = {
      "arcrho:dfm-save": "Saving DFM...",
      "arcrho:dfm-save-as": "Saving DFM as...",
      "arcrho:dfm-save-template": "Saving DFM template...",
      "arcrho:dfm-open-method-json": "Opening DFM JSON...",
      "arcrho:dfm-undo": "Undoing ratio change...",
      "arcrho:dfm-redo": "Redoing ratio change...",
      "arcrho:dfm-exclude-high": "Excluding highest ratio...",
      "arcrho:dfm-exclude-low": "Excluding lowest ratio...",
      "arcrho:dfm-include-all": "Including ratios...",
    };
    setStatus(statusByCommand[command] || "Sent DFM command.");
    return true;
  } catch {
    setStatus("Failed to send command to the DFM window.", true);
    return false;
  }
}

function routeDatasetWindowCommand(type = "arcrho:dataset-save") {
  const frame = getActiveDatasetWindow();
  if (!frame || isDfmWindow(frame)) {
    setStatus("No active dataset window.", true);
    return false;
  }
  const iframe = getWindowIframe(frame);
  try {
    iframe?.contentWindow?.postMessage({ type: toText(type) || "arcrho:dataset-save" }, "*");
    setStatus("Saving dataset...");
    return true;
  } catch {
    setStatus("Failed to send save command to the dataset window.", true);
    return false;
  }
}

function replyAutomationResult(sourceWindow, requestId, payload) {
  if (!requestId) return;
  try {
    sourceWindow?.postMessage({
      type: "arcrho:automation-command-result",
      requestId,
      ...payload,
    }, "*");
  } catch {}
}

function getAutomationWindowInfo(frame) {
  if (!frame?.isConnected) return null;
  const windowId = toText(frame.dataset.windowId);
  const name = toText(frame.dataset.windowItemName || frame.dataset.windowDatasetName);
  const title = toText(frame.dataset.windowTitle || frame.getAttribute("aria-label") || name);
  return {
    windowId,
    id: windowId,
    windowKey: toText(frame.dataset.windowKey),
    kind: toText(frame.dataset.windowKind || "dataset"),
    name,
    datasetName: toText(frame.dataset.windowDatasetName || name),
    itemName: toText(frame.dataset.windowItemName || name),
    title,
    projectName,
    selectedPath: toText(state.selectedPath),
    path: toText(getWindowPath(frame) || frame.dataset.windowPath || state.selectedPath),
    methodType: toText(getWindowMethodType(frame)),
    active: getActiveDatasetWindow() === frame,
    hidden: frame.dataset.hidden === "1" || frame.style.display === "none",
    maximized: !!isDatasetWindowMaximized(frame),
    dirty: frame.dataset.dirty === "1",
    connected: true,
    rect: getFrameRect(frame),
  };
}

function findAutomationWindow(args = {}) {
  const id = toText(args.windowId || args.window_id || args.id || args.inst);
  if (id) return findWindowByInstance(id);
  const key = toText(args.windowKey || args.window_key);
  if (key) {
    for (const frame of state.datasetWindows.values()) {
      if (frame?.dataset?.windowKey === key) return frame;
    }
  }
  return getActiveDatasetWindow();
}

function handleAutomationOpenDataset(message, sourceWindow) {
  const requestId = toText(message?.requestId);
  const args = message?.args && typeof message.args === "object" ? message.args : {};
  const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
  if (!requestId) return true;
  const datasetName = toText(args.datasetName || args.dataset_name || args.name);
  if (!datasetName) {
    reply({ ok: false, error: "Dataset name is required." });
    return true;
  }
  if (!state.selectedPath) {
    reply({ ok: false, error: "Select a reserving class path before opening a dataset." });
    return true;
  }
  const frame = openDatasetWindow(datasetName, {
    datasetTypeName: toText(args.datasetTypeName || args.dataset_type_name) || datasetName,
    readOnly: args.readOnly,
    generated: args.generated,
    methodType: toText(args.methodType || args.method_type),
  });
  if (!frame) {
    reply({ ok: false, error: `Could not open dataset: ${datasetName}` });
    return true;
  }
  setStatus(`Automation opened ${datasetName}.`);
  const windowInfo = getAutomationWindowInfo(frame);
  reply({
    ok: true,
    result: {
      ...windowInfo,
      datasetName,
      window: windowInfo,
    },
  });
  return true;
}

function handleAutomationWindowCommand(message, sourceWindow) {
  const requestId = toText(message?.requestId);
  const args = message?.args && typeof message.args === "object" ? message.args : {};
  const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
  if (!requestId) return true;
  const frame = findAutomationWindow(args);
  if (!frame?.isConnected) {
    reply({ ok: false, error: "Project Instance window was not found." });
    return true;
  }

  const action = toText(args.action || "properties").toLowerCase();
  const sendInfo = () => {
    const windowInfo = getAutomationWindowInfo(frame);
    reply({ ok: true, result: { ...windowInfo, window: windowInfo } });
  };

  if (action === "properties" || action === "get" || action === "info") {
    sendInfo();
    return true;
  }
  if (action === "activate" || action === "focus") {
    void activateDatasetWindow(frame).then(sendInfo);
    return true;
  }
  if (action === "maximize") {
    maximizeDatasetWindow(frame);
    sendInfo();
    return true;
  }
  if (action === "restore") {
    if (frame.dataset.hidden === "1" || frame.style.display === "none") {
      void activateDatasetWindow(frame).then(() => {
        restoreDatasetWindow(frame);
        sendInfo();
      });
    } else {
      restoreDatasetWindow(frame);
      sendInfo();
    }
    return true;
  }
  if (action === "minimize" || action === "hide") {
    void hideDatasetWindow(frame, getFrameRect(frame)).then(sendInfo);
    return true;
  }
  if (action === "close") {
    const windowId = toText(frame.dataset.windowId);
    const closed = closeDatasetWindow(frame);
    reply({
      ok: true,
      result: {
        closed,
        windowId,
        id: windowId,
        connected: frame.isConnected,
      },
      error: "",
    });
    return true;
  }

  reply({ ok: false, error: `Unsupported Project Instance window action: ${action}` });
  return true;
}

function routeActiveWindowSaveCommand(saveAs = false) {
  const frame = getActiveDatasetWindow();
  if (!frame) {
    setStatus("No active dataset or DFM window.", true);
    return false;
  }
  if (isDfmWindow(frame)) {
    return routeDfmWindowCommand(saveAs ? "arcrho:dfm-save-as" : "arcrho:dfm-save");
  }
  return routeDatasetWindowCommand("arcrho:dataset-save");
}

function forwardRequestToActiveDfm(message, resultType, fallbackContext, timeoutMs = 3000) {
  const requestId = toText(message?.requestId) || `pi_dfm_request_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const frame = getActiveDfmWindow();
  const iframe = getWindowIframe(frame);
  if (!frame || !iframe?.contentWindow) {
    try {
      window.parent?.postMessage({ type: resultType, requestId, ...fallbackContext }, "*");
    } catch {}
    return false;
  }
  let done = false;
  const finish = (payload) => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    try {
      window.parent?.postMessage(payload, "*");
    } catch {}
  };
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data || {};
    if (msg.type !== resultType || toText(msg.requestId) !== requestId) return;
    finish(msg);
  };
  window.addEventListener("message", onMessage);
  try {
    iframe.contentWindow.postMessage({ ...message, requestId }, "*");
  } catch {
    finish({ type: resultType, requestId, ...fallbackContext });
    return false;
  }
  window.setTimeout(() => finish({ type: resultType, requestId, ...fallbackContext }), timeoutMs);
  return true;
}

function createProjectInstanceAssistantContext(extra = {}) {
  const summary = getProjectInstanceAssistantContextSummary();
  const activeWindow = summary.activeNestedWindow || null;
  const activeTitle = toText(activeWindow?.title || activeWindow?.name);
  return {
    available: !!activeWindow,
    pageType: "project_instance",
    tabType: "project_instance",
    title: activeTitle ? `${projectName}: ${activeTitle}` : (projectName || "Project Instance"),
    targetPath: toText(activeWindow?.path || summary.selectedPath),
    fileState: activeWindow?.dirty ? "unsaved-changes" : "",
    projectInstance: summary,
    activeNestedWindow: activeWindow,
    openNestedWindows: summary.openNestedWindows,
    ignoredMinimizedWindowCount: summary.ignoredMinimizedWindowCount,
    ...extra,
  };
}

function requestActiveNestedWindowAssistantContext(message, timeoutMs = 1000) {
  const requestId = toText(message?.requestId) || `pi_assistant_context_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const frame = getActiveDatasetWindow();
  const iframe = getWindowIframe(frame);
  const fallbackContext = createProjectInstanceAssistantContext(
    frame ? {} : { error: "No visible nested window is available in the Project Instance page." }
  );
  if (!frame || !iframe?.contentWindow) {
    try {
      window.parent?.postMessage({ type: "arcrho:assistant-context-result", requestId, context: fallbackContext }, "*");
    } catch {}
    return false;
  }

  let done = false;
  const finish = (context = null) => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    const base = createProjectInstanceAssistantContext();
    const childContext = context && typeof context === "object" ? context : {};
    const childPageType = toText(childContext.pageType || childContext.tabType);
    const nestedPageType = childPageType && childPageType !== "project_instance"
      ? childPageType
      : (isDfmWindow(frame) ? "dfm" : "dataset");
    const mergedContext = {
      ...childContext,
      available: childContext.available !== false || !!base.activeNestedWindow,
      pageType: "project_instance",
      tabType: "project_instance",
      nestedPageType,
      activeDfmTab: childContext.activeDfmTab || base.activeNestedWindow?.dfmTab || "",
      title: base.title,
      targetPath: childContext.targetPath || childContext.methodPath || childContext.path || base.targetPath,
      fileState: base.fileState || childContext.fileState || (childContext.dirty ? "unsaved-changes" : ""),
      projectInstance: base.projectInstance,
      activeNestedWindow: base.activeNestedWindow,
      openNestedWindows: base.openNestedWindows,
      ignoredMinimizedWindowCount: base.ignoredMinimizedWindowCount,
    };
    try {
      window.parent?.postMessage({ type: "arcrho:assistant-context-result", requestId, context: mergedContext }, "*");
    } catch {}
  };
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data || {};
    if (msg.type !== "arcrho:assistant-context-result" || toText(msg.requestId) !== requestId) return;
    finish(msg.context || {});
  };
  window.addEventListener("message", onMessage);
  try {
    iframe.contentWindow.postMessage({ ...message, requestId }, "*");
  } catch {
    finish(fallbackContext);
    return false;
  }
  window.setTimeout(() => finish(fallbackContext), timeoutMs);
  return true;
}

function isCloseActiveWindowShortcut(event) {
  return !!event?.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.shiftKey
    && String(event.key || "").toLowerCase() === "w";
}

function routeDfmRatioHotkey(event) {
  if (!event?.ctrlKey || event.altKey || event.metaKey) return false;
  const tag = event.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) return false;
  const key = String(event.key || "").toLowerCase();
  const commandByKey = {
    h: "arcrho:dfm-exclude-high",
    l: "arcrho:dfm-exclude-low",
    i: "arcrho:dfm-include-all",
    z: "arcrho:dfm-undo",
    y: "arcrho:dfm-redo",
  };
  const command = commandByKey[key];
  if (!command) return false;
  event.preventDefault();
  event.stopPropagation();
  return routeDfmWindowCommand(command);
}

function closeActiveDatasetWindowFromShortcut(event, frame = getActiveDatasetWindow()) {
  if (!isCloseActiveWindowShortcut(event) || !frame?.isConnected) return false;
  event.preventDefault();
  event.stopPropagation();
  state.lastDatasetWindowShortcutCloseAt = Date.now();
  closeDatasetWindow(frame);
  return true;
}

function consumeCloseShortcutFromShell() {
  if (Date.now() - state.lastDatasetWindowShortcutCloseAt < 900) return true;
  const frame = getActiveDatasetWindow();
  if (!frame?.isConnected) return false;
  state.lastDatasetWindowShortcutCloseAt = Date.now();
  closeDatasetWindow(frame);
  return true;
}


function initDatasetWindowShortcuts() {
  if (document.body.dataset.piWindowShortcutsWired === "1") return;
  document.body.dataset.piWindowShortcutsWired = "1";
  window.__arcrho_consume_close_shortcut = consumeCloseShortcutFromShell;
  document.addEventListener("keydown", (event) => {
    if (routeDfmRatioHotkey(event)) return;
    if (
      event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && String(event.key || "").toLowerCase() === "s"
    ) {
      event.preventDefault();
      event.stopPropagation();
      routeActiveWindowSaveCommand(event.shiftKey);
      return;
    }
    closeActiveDatasetWindowFromShortcut(event);
  }, true);
}


window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "arcrho:project-instance-restore-state") {
    state.pendingProjectInstanceRestoreState = msg.state && typeof msg.state === "object" ? msg.state : null;
    if (state.projectInstanceBootComplete && state.pendingProjectInstanceRestoreState) {
      const restoreState = state.pendingProjectInstanceRestoreState;
      state.pendingProjectInstanceRestoreState = null;
      void applyProjectInstanceRestoreState(restoreState);
    }
    return;
  }
  if (msg.type === "arcrho:project-instance-request-state") {
    notifyActiveDfmWindowState();
    notifyProjectInstanceStateChanged();
    return;
  }
  if (msg.type === "arcrho:project-instance-reveal-selected-path") {
    void revealSelectedReservingClassFolder();
    return;
  }
  if (msg.type === "arcrho:open-path") {
    if (forwardOpenPathRequestToShell(msg, event.source)) return;
  }
  if (msg.type === "arcrho:tab-activated") {
    notifyActiveDfmWindowState();
    notifyProjectInstanceStateChanged();
    const frame = getActiveDfmWindow();
    const iframe = getWindowIframe(frame);
    try { iframe?.contentWindow?.postMessage({ type: "arcrho:dfm-tab-activated" }, "*"); } catch {}
    return;
  }
  if (
    msg.type === "arcrho:dfm-save"
    || msg.type === "arcrho:dfm-save-as"
  ) {
    routeActiveWindowSaveCommand(msg.type === "arcrho:dfm-save-as");
    return;
  }
  if (
    msg.type === "arcrho:dfm-save-template"
    || msg.type === "arcrho:dfm-open-method-json"
    || msg.type === "arcrho:dfm-exclude-high"
    || msg.type === "arcrho:dfm-exclude-low"
    || msg.type === "arcrho:dfm-include-all"
    || msg.type === "arcrho:dfm-undo"
    || msg.type === "arcrho:dfm-redo"
  ) {
    routeDfmWindowCommand(msg.type);
    return;
  }
  if (msg.type === "arcrho:assistant-context-request") {
    requestActiveNestedWindowAssistantContext(msg);
    return;
  }
  if (msg.type === "arcrho:dfm-apply-method-payload") {
    forwardRequestToActiveDfm(msg, "arcrho:dfm-apply-method-payload-result", {
      ok: false,
      error: "No active DFM window is available in the Project Instance page.",
    }, 3000);
    return;
  }
  if (msg.type === "arcrho:assistant-dfm-edit-approval") {
    forwardRequestToActiveDfm(msg, "arcrho:assistant-dfm-edit-approval-result", {
      ok: false,
      error: "No active DFM window is available in the Project Instance page.",
    }, 120000);
    return;
  }
  if (msg.type === "arcrho:automation-open-dataset") {
    handleAutomationOpenDataset(msg, event.source);
    return;
  }
  if (msg.type === "arcrho:automation-window-command") {
    handleAutomationWindowCommand(msg, event.source);
    return;
  }
  if (msg.type === "arcrho:dfm-edit-state") {
    const frame = findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      frame.dataset.dfmEditEnabled = msg.enabled ? "1" : "0";
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dfm-history-state") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      frame.dataset.dfmCanUndo = msg.canUndo ? "1" : "0";
      frame.dataset.dfmCanRedo = msg.canRedo ? "1" : "0";
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dfm-history-session") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      frame.dataset.dfmHistoryDir = toText(msg.dir);
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dfm-dirty") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      setWindowDirtyState(frame, !!msg.dirty);
      notifyActiveDfmWindowState();
    }
    return;
  }
  if (msg.type === "arcrho:dataset-dirty") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame) setWindowDirtyState(frame, !!msg.dirty);
    return;
  }
  if (msg.type === "arcrho:dataset-close-confirmed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame) {
      setWindowDirtyState(frame, false);
      closeDatasetWindow(frame, { skipChildCloseRequest: true });
    }
    return;
  }
  if (msg.type === "arcrho:dfm-close-confirmed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      setWindowDirtyState(frame, false);
      closeDatasetWindow(frame, { skipChildCloseRequest: true });
    }
    return;
  }
  if (msg.type === "arcrho:calculated-datasets-updated") {
    const relay = { type: msg.type, report: msg?.report || null, source: msg?.source || "" };
    if (event.source === window.parent) {
      postMessageToDatasetWindows(relay);
    } else {
      try { window.parent?.postMessage(relay, "*"); } catch {}
    }
    return;
  }
  if (msg.type === "arcrho:project-instance-refresh-datasets") {
    void loadCachedDatasetFilterForSelectedPath({ refresh: true }).then(() => {
      setStatus("Project Instance dataset table refreshed.");
    }).catch((err) => {
      setStatus(`Project Instance refresh failed: ${toText(err?.message) || err}`, true);
    });
    return;
  }
  if (msg.type === "arcrho:dfm-tab-changed") {
    const frame = findWindowByInstance(msg.inst);
    if (frame) {
      frame.dataset.dfmTab = toText(msg.tab || "");
      notifyActiveDfmWindowState();
      notifyProjectInstanceStateChanged();
    }
    return;
  }
  if (msg.type === "arcrho:hotkey") {
    const action = toText(msg.action);
    if (action === "file_save") {
      routeActiveWindowSaveCommand(false);
      return;
    }
    if (action === "file_save_as") {
      routeActiveWindowSaveCommand(true);
      return;
    }
    if (action === "dfm_undo") {
      routeDfmWindowCommand("arcrho:dfm-undo");
      return;
    }
    if (action === "dfm_redo") {
      routeDfmWindowCommand("arcrho:dfm-redo");
      return;
    }
    if (action === "dfm_exclude_high") {
      routeDfmWindowCommand("arcrho:dfm-exclude-high");
      return;
    }
    if (action === "dfm_exclude_low") {
      routeDfmWindowCommand("arcrho:dfm-exclude-low");
      return;
    }
    if (action === "dfm_include_all") {
      routeDfmWindowCommand("arcrho:dfm-include-all");
      return;
    }
  }
  if (msg.type === "arcrho:status" || msg.type === "arcrho:tooltip") {
    try { window.parent.postMessage(msg, "*"); } catch {}
  }
});

  Object.assign(api, {
    closeActiveDatasetWindowFromShortcut,
    consumeCloseShortcutFromShell,
    forwardRequestToActiveDfm,
    forwardOpenPathRequestToShell,
    initDatasetWindowShortcuts,
    isCloseActiveWindowShortcut,
    requestActiveNestedWindowAssistantContext,
    requestShellOpenPath,
    revealSelectedReservingClassFolder,
    routeDfmRatioHotkey,
    routeDfmWindowCommand,
    routeDatasetWindowCommand,
    routeActiveWindowSaveCommand
  });
}
