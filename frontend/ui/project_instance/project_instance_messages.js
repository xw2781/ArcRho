import { sanitizeDataFolderPart, sanitizeFileNamePart } from "/ui/shared/utils/filename.js";
import {
  getBerquistShermanContract,
  normalizeBerquistShermanVariant,
} from "/ui/shared/dataset/berquist_sherman_contract.js";
import { waitForDependentPropagationOutcome } from "/ui/shared/services/dependent_propagation_job.js?v=20260807b";
import {
  PROPAGATION_SCOPE_FINISHED_MESSAGE,
  PROPAGATION_SCOPE_STARTED_MESSAGE,
} from "/ui/shared/services/object_change_watch.js?v=20260807a";

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
  const isBerquistShermanWindow = (...args) => api.isBerquistShermanWindow(...args);
  const isBornhuetterFergusonWindow = (...args) => api.isBornhuetterFergusonWindow(...args);
  const isCapeCodWindow = (...args) => api.isCapeCodWindow(...args);
  const isResultSelectionWindow = (...args) => api.isResultSelectionWindow(...args);
  const maximizeDatasetWindow = (...args) => api.maximizeDatasetWindow(...args);
  const notifyActiveDfmWindowState = (...args) => api.notifyActiveDfmWindowState(...args);
  const notifyProjectInstanceStateChanged = (...args) => api.notifyProjectInstanceStateChanged(...args);
  const normalizeLookupKey = (...args) => api.normalizeLookupKey(...args);
  const openDatasetWindow = (...args) => api.openDatasetWindow(...args);
  const openDfmWindow = (...args) => api.openDfmWindow(...args);
  const openBerquistShermanWindow = (...args) => api.openBerquistShermanWindow(...args);
  const openBornhuetterFergusonWindow = (...args) => api.openBornhuetterFergusonWindow(...args);
  const openCapeCodWindow = (...args) => api.openCapeCodWindow(...args);
  const openResultSelectionWindow = (...args) => api.openResultSelectionWindow(...args);
  const postMessageToDatasetWindows = (...args) => api.postMessageToDatasetWindows(...args);
  const refreshCachedDatasetTableFromDisk = (...args) => api.refreshCachedDatasetTableFromDisk(...args);
  const restoreDatasetWindow = (...args) => api.restoreDatasetWindow(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const setWindowDirtyState = (...args) => api.setWindowDirtyState(...args);
  const syncDfmWindowIdentity = (...args) => api.syncDfmWindowIdentity(...args);
  const syncBerquistShermanWindowIdentity = (...args) => api.syncBerquistShermanWindowIdentity(...args);
  const toText = (...args) => api.toText(...args);
  const activeCalculatedPreviewTargetsBySource = new Map();

function normalizeDependencyText(value) {
  return toText(value).toLowerCase();
}

function normalizeReservingClassPath(value) {
  return toText(value).replace(/\\+/g, "\\");
}

function indexedDfmMethodName(...names) {
  const keys = new Set(names.map(normalizeLookupKey).filter(Boolean));
  if (!keys.size) return "";
  const rows = Array.isArray(state.cachedDatasetFilter?.instanceRows)
    ? state.cachedDatasetFilter.instanceRows
    : [];
  const match = rows.find((item) => (
    normalizeLookupKey(item?.method_type) === "dfm"
    && (
      keys.has(normalizeLookupKey(item?.name))
      || keys.has(normalizeLookupKey(item?.dataset_type))
    )
  ));
  return toText(match?.method_name || match?.name);
}

function indexedDatasetTypeName(datasetName) {
  const key = normalizeLookupKey(datasetName);
  if (!key) return "";
  const rows = Array.isArray(state.cachedDatasetFilter?.instanceRows)
    ? state.cachedDatasetFilter.instanceRows
    : [];
  const match = rows.find((item) => normalizeLookupKey(item?.name) === key);
  return toText(match?.dataset_type);
}

function dependencyMessageNames(message = {}) {
  return [
    ...(Array.isArray(message.names) ? message.names : []),
    message.datasetName,
    message.datasetTypeName,
    message.name,
  ].map(toText).filter(Boolean);
}

function dependencySourceKey(message = {}) {
  return [
    normalizeDependencyText(message.project || projectName),
    normalizeDependencyText(normalizeReservingClassPath(message.reservingClass || message.reserving_class || state.selectedPath)),
    ...dependencyMessageNames(message).map(normalizeDependencyText).sort(),
  ].join("\u001f");
}

function matrixValuesFromDependencyMessage(message = {}) {
  if (Array.isArray(message.matrixValues)) {
    return message.matrixValues.filter((row) => Array.isArray(row));
  }
  if (Array.isArray(message.values)) {
    return message.values.map((value) => [value]);
  }
  return [];
}

function buildCalculatedPreviewMessage(step = {}, sourceMessage = {}) {
  const datasetName = toText(step.dataset_name || step.dataset_type_name);
  if (!datasetName) return null;
  const matrixValues = Array.isArray(step.matrix_values)
    ? step.matrix_values
    : (Array.isArray(step.matrixValues) ? step.matrixValues : []);
  if (!matrixValues.length) return null;
  const datasetTypeName = toText(step.dataset_type_name || datasetName);
  return {
    type: "arcrho:dependency-source-preview",
    inst: toText(sourceMessage.inst),
    project: toText(sourceMessage.project || projectName),
    reservingClass: toText(sourceMessage.reservingClass || sourceMessage.reserving_class || state.selectedPath),
    datasetName,
    datasetTypeName,
    names: [datasetName, datasetTypeName].filter(Boolean),
    methodType: "Calculated Dataset",
    sourceKind: "calculated_preview",
    dataFormat: toText(step.data_format || step.dataFormat),
    reason: "calculated-preview",
    values: Array.isArray(step.values) ? step.values : [],
    matrixValues,
    mask: Array.isArray(step.mask) ? step.mask : [],
    originLabels: Array.isArray(step.origin_labels) ? step.origin_labels.map(String) : [],
    developmentLabels: Array.isArray(step.development_labels) ? step.development_labels.map(String) : [],
    originLength: Array.isArray(step.origin_labels) ? step.origin_labels.length : undefined,
    developmentLength: Array.isArray(step.development_labels) ? step.development_labels.length : undefined,
  };
}

const pendingDependencyClearJobIds = new Set();
const pendingDependencyClearSourceCounts = new Map();

function relayDependencySourceCleared(msg, excludeSource) {
  postMessageToDatasetWindows({ ...msg, propagationJobId: "" }, excludeSource, { includeDfm: true });
  clearCalculatedPreviewTargetsForSource(msg, toText(msg.reason) || "clean");
}

async function deferDependencyClearUntilPropagation(msg, excludeSource) {
  // A save that enqueued an Engine propagation job posts its cleared message
  // with the job id. Dependent windows keep their live-preview values until
  // the job's terminal status so they never snap back to stale values, and
  // the scope broadcasts pause their change watches so a job this app
  // started never raises the "updated outside this window" alert.
  const jobId = toText(msg.propagationJobId);
  const sourceKey = dependencySourceKey(msg);
  if (!jobId) {
    // Save flows can fire more than one clean transition; only the first
    // cleared message carries the job id. Relaying a job-less duplicate while
    // its deferral is pending would clear downstream previews early and
    // reload pre-walk (stale) values, so swallow it — the deferred relay
    // clears the same source at the job's terminal status.
    if (pendingDependencyClearSourceCounts.get(sourceKey) > 0) return;
    relayDependencySourceCleared(msg, excludeSource);
    return;
  }
  if (pendingDependencyClearJobIds.has(jobId)) return;
  pendingDependencyClearJobIds.add(jobId);
  pendingDependencyClearSourceCounts.set(sourceKey, (pendingDependencyClearSourceCounts.get(sourceKey) || 0) + 1);
  const scope = {
    project: toText(msg.project),
    reservingClass: toText(msg.reservingClass || msg.reserving_class),
    jobId,
  };
  postMessageToDatasetWindows(
    { type: PROPAGATION_SCOPE_STARTED_MESSAGE, ...scope },
    null,
    { includeDfm: true },
  );
  try {
    await waitForDependentPropagationOutcome(jobId);
  } finally {
    pendingDependencyClearJobIds.delete(jobId);
    const remaining = (pendingDependencyClearSourceCounts.get(sourceKey) || 0) - 1;
    if (remaining > 0) pendingDependencyClearSourceCounts.set(sourceKey, remaining);
    else pendingDependencyClearSourceCounts.delete(sourceKey);
    relayDependencySourceCleared(msg, excludeSource);
    postMessageToDatasetWindows(
      { type: PROPAGATION_SCOPE_FINISHED_MESSAGE, ...scope },
      null,
      { includeDfm: true },
    );
  }
}

function clearCalculatedPreviewTargetsForSource(sourceMessage = {}, reason = "clean", keepKeys = new Set()) {
  const sourceKey = dependencySourceKey(sourceMessage);
  const targets = activeCalculatedPreviewTargetsBySource.get(sourceKey) || new Map();
  for (const [targetKey, message] of Array.from(targets.entries())) {
    if (keepKeys?.has?.(targetKey)) continue;
    targets.delete(targetKey);
    postMessageToDatasetWindows({
      ...message,
      type: "arcrho:dependency-source-cleared",
      reason,
    }, null, { includeDfm: true });
  }
  if (targets.size) {
    activeCalculatedPreviewTargetsBySource.set(sourceKey, targets);
  } else {
    activeCalculatedPreviewTargetsBySource.delete(sourceKey);
  }
}

async function publishCalculatedDependencyPreviews(sourceMessage = {}, excludeSource = null) {
  const values = matrixValuesFromDependencyMessage(sourceMessage);
  if (!values.length) {
    clearCalculatedPreviewTargetsForSource(sourceMessage, "preview-stale");
    return;
  }
  const names = dependencyMessageNames(sourceMessage);
  const response = await fetch("/dataset/calculated/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: toText(sourceMessage.project || projectName),
      reserving_class: toText(sourceMessage.reservingClass || sourceMessage.reserving_class || state.selectedPath),
      changed_dataset_name: toText(sourceMessage.datasetName || names[0]),
      changed_dataset_type_name: toText(sourceMessage.datasetTypeName || names[1] || names[0]),
      values,
      mask: Array.isArray(sourceMessage.mask) ? sourceMessage.mask : undefined,
      origin_labels: Array.isArray(sourceMessage.originLabels) ? sourceMessage.originLabels : undefined,
      development_labels: Array.isArray(sourceMessage.developmentLabels) ? sourceMessage.developmentLabels : undefined,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    clearCalculatedPreviewTargetsForSource(sourceMessage, "preview-stale");
    return;
  }
  const sourceKey = dependencySourceKey(sourceMessage);
  const targets = activeCalculatedPreviewTargetsBySource.get(sourceKey) || new Map();
  const keepKeys = new Set();
  for (const step of Array.isArray(payload.steps) ? payload.steps : []) {
    if (!step?.ok) continue;
    const message = buildCalculatedPreviewMessage(step, sourceMessage);
    if (!message) continue;
    const targetKey = dependencySourceKey(message);
    targets.set(targetKey, message);
    keepKeys.add(targetKey);
    postMessageToDatasetWindows(message, excludeSource, { includeDfm: true });
  }
  activeCalculatedPreviewTargetsBySource.set(sourceKey, targets);
  clearCalculatedPreviewTargetsForSource(sourceMessage, "preview-stale", keepKeys);
}

function getReservingClassFolderPathFromSnapshot(payload) {
  const folderPaths = payload?.folder_paths && typeof payload.folder_paths === "object"
    ? payload.folder_paths
    : payload?.folderPaths && typeof payload.folderPaths === "object"
      ? payload.folderPaths
      : null;
  return toText(folderPaths?.data || payload?.folder_path || payload?.folderPath);
}

function getFolderPathsFromSnapshot(payload) {
  const folderPaths = payload?.folder_paths && typeof payload.folder_paths === "object"
    ? payload.folder_paths
    : payload?.folderPaths && typeof payload.folderPaths === "object"
      ? payload.folderPaths
      : {};
  const data = toText(folderPaths.data || payload?.folder_path || payload?.folderPath);
  return {
    data,
    methods: toText(folderPaths.methods) || (data ? `${data}\\methods` : ""),
    sidecars: toText(folderPaths.sidecars) || (data ? `${data}\\sidecars` : ""),
  };
}

function joinWindowsPath(...parts) {
  return parts
    .map((part, index) => {
      const text = toText(part);
      if (!text) return "";
      return index === 0 ? text.replace(/[\\/]+$/g, "") : text.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter(Boolean)
    .join("\\");
}

function requestShellOpenPath(targetPath, options = {}) {
  const path = toText(targetPath);
  if (!path) return Promise.resolve({ ok: false, error: "Empty path." });
  const requestId = `pi_reveal_path_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const preferredApp = toText(options.preferredApp);
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
      window.parent?.postMessage({ type: "arcrho:open-path", requestId, path, preferredApp }, "*");
    } catch (err) {
      finish({ ok: false, error: toText(err?.message) || "Failed to send open-path request." });
    }
  });
}

function getActiveWindowJsonKind(frame) {
  const methodType = toText(getWindowMethodType(frame)).toLowerCase();
  if (isDfmWindow(frame) || methodType === "dfm") return "dfm";
  if (isResultSelectionWindow(frame) || methodType === "result selection") return "result_selection";
  if (isBornhuetterFergusonWindow(frame) || methodType === "bornhuetter ferguson") return "bornhuetter_ferguson";
  if (isCapeCodWindow(frame) || methodType === "cape cod") return "cape_cod";
  if (isBerquistShermanWindow(frame) || normalizeBerquistShermanVariant(methodType)) return "berquist_sherman";
  return "";
}

async function openActiveDatasetRelatedFile(fileKind) {
  const activeFrame = getActiveDatasetWindow();
  const datasetName = toText(activeFrame?.dataset?.windowItemName || activeFrame?.dataset?.windowDatasetName);
  const windowPath = toText(getWindowPath(activeFrame) || activeFrame?.dataset?.windowPath || state.selectedPath);
  if (!activeFrame || !datasetName || !windowPath) {
    setStatus("No active Project Instance dataset window.", true);
    return false;
  }

  let payload = null;
  try {
    payload = await fetchCachedDatasetSnapshot(windowPath);
  } catch (err) {
    setStatus(toText(err?.message) || "Could not resolve dataset file folders.", true);
    return false;
  }
  const folders = getFolderPathsFromSnapshot(payload);
  let targetPath = "";
  if (fileKind === "sidecar") {
    if (!folders.sidecars) {
      setStatus("Could not resolve dataset sidecar folder.", true);
      return false;
    }
    targetPath = joinWindowsPath(folders.sidecars, `${sanitizeFileNamePart(datasetName, "Dataset")}.json`);
  } else {
    const jsonKind = getActiveWindowJsonKind(activeFrame);
    if (!jsonKind) {
      setStatus("The active dataset does not have a method JSON file.", true);
      return false;
    }
    if (!folders.methods) {
      setStatus("Could not resolve dataset JSON folder.", true);
      return false;
    }
    const namePart = sanitizeFileNamePart(datasetName, "Name");
    let filename = "";
    if (jsonKind === "dfm") {
      filename = `DFM@${namePart}.json`;
    } else if (jsonKind === "bornhuetter_ferguson") {
      filename = `BF@${namePart}.json`;
    } else if (jsonKind === "cape_cod") {
      filename = `CC@${namePart}.json`;
    } else if (jsonKind === "berquist_sherman") {
      const contract = getBerquistShermanContract(activeFrame.dataset.bsVariant || getWindowMethodType(activeFrame));
      if (!contract) {
        setStatus("Could not determine the Berquist Sherman JSON filename.", true);
        return false;
      }
      filename = `${contract.filenamePrefix}${namePart}.json`;
    } else {
      filename = `RS@${namePart}.json`;
    }
    targetPath = joinWindowsPath(folders.methods, filename);
  }

  const label = fileKind === "sidecar" ? "dataset sidecar" : "dataset JSON file";
  setStatus(`Opening ${label}...`);
  const result = await requestShellOpenPath(targetPath, { preferredApp: "arcode" });
  if (result?.ok) {
    setStatus(`Opened ${label}: ${targetPath}`);
    return true;
  }
  setStatus(toText(result?.error) || `Could not open ${label}.`, true);
  return false;
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
      "arcrho:dfm-toggle-ratios-mode": "Toggled DFM Ratios mode.",
      "arcrho:dfm-apply-highlighted-ratio-range": "Applied highlighted DFM Ratios cells.",
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
    outputDataset: toText(frame.dataset.windowOutputDataset || ""),
    active: getActiveDatasetWindow() === frame,
    hidden: frame.dataset.hidden === "1" || frame.style.display === "none",
    maximized: !!isDatasetWindowMaximized(frame),
    dirty: frame.dataset.dirty === "1",
    bsTab: isBerquistShermanWindow(frame) ? toText(frame.dataset.bsTab) : "",
    bsVariant: isBerquistShermanWindow(frame) ? normalizeBerquistShermanVariant(frame.dataset.bsVariant) : "",
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
  const requestedMethodType = toText(args.methodType || args.method_type);
  const openMethod = !!args.openMethod || !!args.open_method;
  const methodType = requestedMethodType.toLowerCase();
  const dfmMethodName = toText(args.methodName || args.method_name)
    || indexedDfmMethodName(datasetName, args.datasetTypeName, args.dataset_type_name)
    || datasetName;
  const bsVariant = normalizeBerquistShermanVariant(args.variant || args.bsVariant || args.bs_variant || requestedMethodType);
  const frame = openMethod && methodType === "dfm"
    ? openDfmWindow(dfmMethodName, {
      path: state.selectedPath,
      methodType: "DFM",
      outputType: toText(args.datasetTypeName || args.dataset_type_name),
      outputDataset: datasetName,
    })
    : openMethod && methodType === "result selection"
      ? openResultSelectionWindow(datasetName, {
        path: state.selectedPath,
        initialTab: "method",
        methodType: "Result Selection",
      })
      : openMethod && methodType === "bornhuetter ferguson"
        ? openBornhuetterFergusonWindow(datasetName, {
          path: state.selectedPath,
          initialTab: "method",
          methodType: "Bornhuetter Ferguson",
        })
        : openMethod && methodType === "cape cod"
          ? openCapeCodWindow(datasetName, {
            path: state.selectedPath,
            initialTab: "method",
            methodType: "Cape Cod",
          })
          : openMethod && bsVariant
            ? openBerquistShermanWindow(datasetName, {
              path: state.selectedPath,
              initialTab: "method",
              variant: bsVariant,
              methodType: getBerquistShermanContract(bsVariant)?.methodType,
            })
            : openDatasetWindow(datasetName, {
              datasetTypeName: toText(args.datasetTypeName || args.dataset_type_name) || datasetName,
              readOnly: args.readOnly,
              methodType: requestedMethodType,
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

function handleAutomationProjectInstanceContext(message, sourceWindow) {
  const requestId = toText(message?.requestId);
  const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
  if (!requestId) return true;
  const selectedPath = toText(state.selectedPath);
  if (!projectName || !selectedPath) {
    reply({
      ok: false,
      result: {
        projectName,
        project_name: projectName,
        selectedPath,
        selected_path: selectedPath,
        path: selectedPath,
      },
      error: "Select a reserving class path in the active Project Instance page before running this UI command.",
    });
    return true;
  }
  reply({
    ok: true,
    result: {
      pageType: "project_instance",
      tabType: "project_instance",
      projectName,
      project_name: projectName,
      selectedPath,
      selected_path: selectedPath,
      path: selectedPath,
    },
  });
  return true;
}

// Put the page into a deterministic starting state. Without this, every other projectInstance.*
// command fails from a cold start because no reserving-class path is selected yet.
async function handleAutomationProjectInstanceSelectPath(message, sourceWindow) {
  const requestId = toText(message?.requestId);
  const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
  if (!requestId) return true;

  const args = message?.args || {};
  const requestedPath = toText(args.path || args.selectedPath || args.selected_path);
  if (!requestedPath) {
    reply({ ok: false, error: "projectInstance.selectPath requires a reserving class path." });
    return true;
  }
  if (!projectName) {
    reply({ ok: false, error: "The Project Instance page has no project name." });
    return true;
  }

  try {
    await api.setSelectedPath(requestedPath, { persist: args.persist === true });
    if (args.reveal !== false) {
      await api.revealPathTreeSelection(requestedPath);
    }
    await api.waitForPathTreeRender();
  } catch (err) {
    reply({ ok: false, error: toText(err?.message) || "Failed to select the reserving class path." });
    return true;
  }

  const selectedPath = toText(state.selectedPath);
  const matched = selectedPath.toLowerCase() === requestedPath.toLowerCase();
  reply({
    ok: matched,
    result: {
      projectName,
      project_name: projectName,
      requestedPath,
      selectedPath,
      selected_path: selectedPath,
      path: selectedPath,
    },
    error: matched
      ? ""
      : `Requested path was not selected. Requested "${requestedPath}", page reports "${selectedPath}".`,
  });
  return true;
}

async function handleAutomationProjectInstanceRefreshDatasets(message, sourceWindow) {
  const requestId = toText(message?.requestId);
  const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
  if (!requestId) return true;
  const selectedPath = toText(state.selectedPath);
  if (!projectName || !selectedPath) {
    reply({
      ok: false,
      result: {
        projectName,
        project_name: projectName,
        selectedPath,
        selected_path: selectedPath,
        path: selectedPath,
      },
      error: "Select a reserving class path in the active Project Instance page before reloading the dataset table.",
    });
    return true;
  }
  try {
    const refreshed = await refreshCachedDatasetTableFromDisk();
    reply({
      ok: !!refreshed,
      result: {
        projectName,
        project_name: projectName,
        selectedPath,
        selected_path: selectedPath,
        path: selectedPath,
        refreshed: !!refreshed,
      },
      error: refreshed ? "" : "Dataset table reload failed.",
    });
  } catch (err) {
    const detail = toText(err?.message) || String(err || "Dataset table reload failed.");
    setStatus(`Project Instance refresh failed: ${detail}`, true);
    reply({
      ok: false,
      result: {
        projectName,
        project_name: projectName,
        selectedPath,
        selected_path: selectedPath,
        path: selectedPath,
        refreshed: false,
      },
      error: detail,
    });
  }
  return true;
}

function handleOpenDependentDataset(message, sourceWindow) {
  const datasetName = toText(message?.datasetName || message?.dataset_name || message?.name);
  if (!datasetName) {
    setStatus("Dependent dataset name is required.", true);
    return true;
  }
  const sourceFrame = findWindowByMessageSource(sourceWindow);
  const targetPath = toText(message?.reservingClass || message?.reserving_class)
    || toText(getWindowPath(sourceFrame) || sourceFrame?.dataset?.windowPath)
    || state.selectedPath;
  if (!targetPath) {
    setStatus("Select a reserving class path before opening a dependent dataset.", true);
    return true;
  }
  const openMethod = !!message?.openMethod || !!message?.open_method;
  const datasetTypeName = toText(message?.datasetTypeName || message?.dataset_type_name)
    || indexedDatasetTypeName(datasetName)
    || datasetName;
  const methodTypeMap = state.cachedDatasetFilter?.methodTypesByName instanceof Map
    ? state.cachedDatasetFilter.methodTypesByName
    : new Map();
  const resolvedMethodType = toText(message?.methodType || message?.method_type)
    || toText(methodTypeMap.get(normalizeLookupKey(datasetName)))
    || toText(methodTypeMap.get(normalizeLookupKey(datasetTypeName)));
  const methodType = resolvedMethodType.toLowerCase();
  const dfmMethodName = toText(message?.methodName || message?.method_name)
    || indexedDfmMethodName(datasetName, datasetTypeName)
    || datasetName;
  const bsVariant = normalizeBerquistShermanVariant(
    message?.variant || message?.bsVariant || message?.bs_variant || resolvedMethodType
  );
  let frame = null;
  if (openMethod && methodType === "dfm") {
    frame = openDfmWindow(dfmMethodName, {
      path: targetPath,
      methodType: "DFM",
      outputType: datasetTypeName,
      outputDataset: datasetName,
    });
  } else if (openMethod && methodType === "result selection") {
    frame = openResultSelectionWindow(datasetName, {
      path: targetPath,
      initialTab: "method",
      methodType: "Result Selection",
    });
  } else if (openMethod && methodType === "bornhuetter ferguson") {
    frame = openBornhuetterFergusonWindow(datasetName, {
      path: targetPath,
      initialTab: "method",
      methodType: "Bornhuetter Ferguson",
    });
  } else if (openMethod && methodType === "cape cod") {
    frame = openCapeCodWindow(datasetName, {
      path: targetPath,
      initialTab: "method",
      methodType: "Cape Cod",
    });
  } else if (openMethod && bsVariant) {
    frame = openBerquistShermanWindow(datasetName, {
      path: targetPath,
      initialTab: "method",
      variant: bsVariant,
      methodType: getBerquistShermanContract(bsVariant)?.methodType,
    });
  } else {
    frame = openDatasetWindow(datasetName, {
      datasetTypeName,
      path: targetPath,
      methodType: resolvedMethodType,
    });
  }
  if (frame) {
    const methodLabel = methodType === "dfm"
      ? "DFM"
      : methodType === "bornhuetter ferguson"
        ? "Bornhuetter Ferguson"
        : methodType === "cape cod"
          ? "Cape Cod"
          : bsVariant
            ? getBerquistShermanContract(bsVariant)?.methodType || "Berquist Sherman"
            : "Result Selection";
    setStatus(openMethod && (methodType || bsVariant)
      ? `Opened ${methodLabel} method ${datasetName}.`
      : `Opened dependent dataset ${datasetName}.`);
  } else {
    setStatus(openMethod && (methodType || bsVariant)
      ? `Could not open method ${datasetName}.`
      : `Could not open dependent dataset ${datasetName}.`, true);
  }
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
  const targetWindowId = toText(message?.targetWindowId);
  const frame = targetWindowId ? findWindowByInstance(targetWindowId) : getActiveDfmWindow();
  const iframe = getWindowIframe(frame);
  if (!frame || !isDfmWindow(frame) || !iframe?.contentWindow) {
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
  const targetWindowId = toText(message?.targetWindowId);
  const frame = targetWindowId ? findWindowByInstance(targetWindowId) : getActiveDatasetWindow();
  const iframe = getWindowIframe(frame);
  const fallbackContext = createProjectInstanceAssistantContext(
    frame
      ? {}
      : { error: targetWindowId
        ? "The requested Project Instance DFM window is no longer available."
        : "No visible nested window is available in the Project Instance page." }
  );
  if (!frame || (targetWindowId && !isDfmWindow(frame)) || !iframe?.contentWindow) {
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

function activeDfmCanApplyHighlightedRatioRange() {
  const frame = getActiveDfmWindow();
  if (!frame || toText(frame.dataset.dfmTab).toLowerCase() !== "ratios") return false;
  try {
    const doc = getWindowIframe(frame)?.contentDocument;
    const wrap = doc?.getElementById("ratioWrap");
    return wrap?.dataset?.interactionMode === "select"
      && !!wrap.querySelector(
        "table.ratioMainTable td.ratioCell.dfmTableHighlight, table.ratioSummaryTable td.summaryCell.dfmTableHighlight"
      );
  } catch {
    return false;
  }
}

function activeDfmCanNavigateHighlightedRatioRange() {
  const frame = getActiveDfmWindow();
  if (!frame || toText(frame.dataset.dfmTab).toLowerCase() !== "ratios") return false;
  try {
    const doc = getWindowIframe(frame)?.contentDocument;
    const wrap = doc?.getElementById("ratioWrap");
    return wrap?.dataset?.interactionMode === "select" && !!wrap.querySelector("td.dfmTableHighlight");
  } catch {
    return false;
  }
}

function routeDfmHighlightNavigation(event) {
  const frame = getActiveDfmWindow();
  const iframe = getWindowIframe(frame);
  if (!iframe?.contentWindow) return false;
  try {
    iframe.contentWindow.postMessage({
      type: "arcrho:dfm-navigate-highlighted-ratio-range",
      key: String(event.key || ""),
      shiftKey: !!event.shiftKey,
      ctrlKey: !!event.ctrlKey,
      metaKey: !!event.metaKey,
    }, "*");
    return true;
  } catch {
    return false;
  }
}

function routeDfmRatioHotkey(event) {
  const key = String(event.key || "").toLowerCase();
  const tag = event.target?.tagName?.toLowerCase();
  const isTypingTarget = tag === "input"
    || tag === "textarea"
    || tag === "select"
    || tag === "button"
    || event.target?.isContentEditable;
  const isArrowKey = key === "arrowup"
    || key === "arrowdown"
    || key === "arrowleft"
    || key === "arrowright";
  if (
    isArrowKey
    && !event.altKey
    && !isTypingTarget
    && activeDfmCanNavigateHighlightedRatioRange()
  ) {
    event.preventDefault();
    event.stopPropagation();
    return routeDfmHighlightNavigation(event);
  }
  if (
    key === "enter"
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.shiftKey
    && !event.repeat
    && !isTypingTarget
    && activeDfmCanApplyHighlightedRatioRange()
  ) {
    event.preventDefault();
    event.stopPropagation();
    return routeDfmWindowCommand("arcrho:dfm-apply-highlighted-ratio-range");
  }
  if (!event?.ctrlKey || event.altKey || event.metaKey) return false;
  if (key === "e" && !event.shiftKey) {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return true;
    return routeDfmWindowCommand("arcrho:dfm-toggle-ratios-mode");
  }
  if (isTypingTarget) return false;
  const commandByKey = {
    h: "arcrho:dfm-exclude-high",
    l: "arcrho:dfm-exclude-low",
    i: "arcrho:dfm-include-all",
    z: "arcrho:dfm-undo",
    y: "arcrho:dfm-redo",
    pageup: "arcrho:dfm-tab-prev",
    pagedown: "arcrho:dfm-tab-next",
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
  if (msg.type === "arcrho:project-instance-open-active-dataset-json") {
    void openActiveDatasetRelatedFile("json");
    return;
  }
  if (msg.type === "arcrho:project-instance-open-active-dataset-sidecar") {
    void openActiveDatasetRelatedFile("sidecar");
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
    || msg.type === "arcrho:dfm-toggle-ratios-mode"
    || msg.type === "arcrho:dfm-apply-highlighted-ratio-range"
    || msg.type === "arcrho:dfm-undo"
    || msg.type === "arcrho:dfm-redo"
    || msg.type === "arcrho:dfm-tab-prev"
    || msg.type === "arcrho:dfm-tab-next"
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
  if (msg.type === "arcrho:automation-project-instance-context") {
    handleAutomationProjectInstanceContext(msg, event.source);
    return;
  }
  if (msg.type === "arcrho:automation-project-instance-refresh-datasets") {
    void handleAutomationProjectInstanceRefreshDatasets(msg, event.source);
    return;
  }
  if (msg.type === "arcrho:automation-project-instance-select-path") {
    void handleAutomationProjectInstanceSelectPath(msg, event.source);
    return;
  }
  if (msg.type === "arcrho:project-instance-open-dependent-dataset") {
    handleOpenDependentDataset(msg, event.source);
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
  if (msg.type === "arcrho:dfm-identity") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isDfmWindow(frame)) {
      const methodName = toText(msg.methodName || msg.method_name);
      const outputDataset = toText(msg.outputDataset || msg.output_dataset);
      if (methodName) {
        syncDfmWindowIdentity(frame, methodName, outputDataset);
      } else {
        if (outputDataset) frame.dataset.windowOutputDataset = outputDataset;
        notifyProjectInstanceStateChanged();
      }
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
      postMessageToDatasetWindows(relay, null, { includeDfm: true });
    } else {
      try { window.parent?.postMessage(relay, "*"); } catch {}
    }
    return;
  }
  if (msg.type === "arcrho:dependency-source-preview") {
    postMessageToDatasetWindows({ ...msg }, event.source, { includeDfm: true });
    void publishCalculatedDependencyPreviews(msg, event.source).catch((err) => {
      setStatus(`Calculated live preview failed: ${toText(err?.message) || err}`, true);
    });
    return;
  }
  if (msg.type === "arcrho:dependency-source-cleared") {
    void deferDependencyClearUntilPropagation(msg, event.source);
    return;
  }
  if (msg.type === "arcrho:project-instance-refresh-datasets") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    const savedDatasetName = toText(msg.savedDatasetName || msg.saved_dataset_name);
    if (frame && isBerquistShermanWindow(frame) && savedDatasetName) {
      syncBerquistShermanWindowIdentity(
        frame,
        savedDatasetName,
        msg.variant || msg.bsVariant || msg.bs_variant || getWindowMethodType(frame),
      );
    }
    void refreshCachedDatasetTableFromDisk().catch((err) => {
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
  if (msg.type === "arcrho:result-selection-tab-changed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isResultSelectionWindow(frame)) {
      frame.dataset.rsTab = toText(msg.tab || "");
      notifyProjectInstanceStateChanged();
    }
    return;
  }
  if (msg.type === "arcrho:bf-tab-changed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isBornhuetterFergusonWindow(frame)) {
      frame.dataset.bfTab = toText(msg.tab || "");
      notifyProjectInstanceStateChanged();
    }
    return;
  }
  if (msg.type === "arcrho:cc-tab-changed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isCapeCodWindow(frame)) {
      frame.dataset.ccTab = toText(msg.tab || "");
      notifyProjectInstanceStateChanged();
    }
    return;
  }
  if (msg.type === "arcrho:berquist-sherman-tab-changed") {
    const frame = findWindowByInstance(msg.inst) || findWindowByMessageSource(event.source);
    if (frame && isBerquistShermanWindow(frame)) {
      frame.dataset.bsTab = toText(msg.tab || "");
      const variant = normalizeBerquistShermanVariant(msg.variant || frame.dataset.bsVariant);
      if (variant) frame.dataset.bsVariant = variant;
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
