import { shell } from "./shell_context.js?v=20260510a";
import { isFloatingTab } from "./floating_tabs.js?v=20260510a";
import {
  getLastViewedDatasetInputs,
  normalizeBrowsingHistoryEntry,
} from "/ui/shell/browsing_history.js";
import {
  normalizeProjectInstanceState,
  normalizeShellActivityEntry,
  pushShellActivityHistoryEntry,
} from "/ui/shell/shell_activity_history.js";

const RESTORABLE_ACTIVITY_TYPES = new Set([
  "dataset",
  "dfm",
  "workflow",
  "project_settings",
  "project_instance",
  "scripting",
  "agent_guide",
]);
let activeHistorySaveTimer = 0;
let pendingActiveHistoryEntry = null;

function buildShellActivityEntry(tab) {
  if (!tab || !RESTORABLE_ACTIVITY_TYPES.has(tab.type)) return null;
  const entry = {
    tabType: tab.type,
    title: tab.title || tab.type,
  };
  if (tab.type === "dataset") {
    entry.datasetInputs = tab.datasetInputs || undefined;
  } else if (tab.type === "dfm") {
    entry.dfmInputs = tab.dfmInputs || undefined;
    entry.dfmTab = tab.dfmTab || "details";
  } else if (tab.type === "project_instance") {
    entry.projectName = String(tab.projectName || tab.title || "").trim();
    entry.projectFolder = String(tab.projectFolder || "").trim() || undefined;
    entry.projectTablePath = String(tab.projectTablePath || "").trim() || undefined;
    entry.projectInstanceState = normalizeProjectInstanceState(tab.projectInstanceState || null) || undefined;
  } else if (tab.type === "project_settings") {
    entry.projectSettingsRibbon = String(tab.projectSettingsRibbon || "summary").trim().toLowerCase();
  } else if (tab.type === "scripting") {
    entry.path = String(tab.scPath || tab.scOpenPath || "").trim() || undefined;
  }
  return normalizeShellActivityEntry(entry);
}

export function recordActiveTabHistory(tabOrId = null) {
  const tab = typeof tabOrId === "string"
    ? shell.state.tabs.find((item) => item.id === tabOrId)
    : (tabOrId || shell.state.tabs.find((item) => item.id === shell.state.activeId));
  const entry = buildShellActivityEntry(tab);
  if (!entry) return;
  pendingActiveHistoryEntry = entry;
  if (activeHistorySaveTimer) window.clearTimeout(activeHistorySaveTimer);
  activeHistorySaveTimer = window.setTimeout(() => {
    const next = pendingActiveHistoryEntry;
    pendingActiveHistoryEntry = null;
    activeHistorySaveTimer = 0;
    if (!next) return;
    pushShellActivityHistoryEntry(next)
      .then(() => shell.notifyBrowsingHistoryTabs?.({ activity: next }))
      .catch((err) => console.warn("Failed to save shell activity history:", err));
  }, 450);
}

export function setActive(id) {
  const tab = shell.state.tabs.find(t => t.id === id) || shell.state.tabs.find(t => t.id === "home");
  if (!tab) return;
  shell.state.activeId = tab.id;
  if (isFloatingTab(tab)) tab.floatZ = shell.state.nextFloatZ++;
  else shell.state.lastDockedActiveId = tab.id;
  if (tab.type !== "dfm") {
    shell.setDfmEditEnabled?.(false);
    shell.setDfmHistoryEnabled?.({ canUndo: false, canRedo: false });
  } else {
    shell.setDfmHistoryEnabled?.({ canUndo: !!tab.dfmCanUndo, canRedo: !!tab.dfmCanRedo });
  }
  shell.render?.();
  shell.saveState?.();
  recordActiveTabHistory(tab);
}

export function setDockedActive(id) {
  shell.state.activeId = id;
  shell.state.lastDockedActiveId = id;
  recordActiveTabHistory(id);
}

export function floatTab(id, rect) {
  const tab = shell.state.tabs.find(t => t.id === id);
  if (!tab || tab.id === "home") return;
  shell.ensureIframe?.(tab);
  tab.layout = "floating";
  tab.floatRect = shell.clampFloatRect?.(rect || shell.defaultFloatRectFromPointer?.(window.innerWidth / 2, window.innerHeight / 2));
  tab.floatZ = shell.state.nextFloatZ++;
  tab.floatMinimized = false;
  tab.floatAnimateIn = true;
  shell.state.activeId = tab.id;
  if (shell.state.lastDockedActiveId === tab.id) shell.state.lastDockedActiveId = shell.getFirstDockedTabId?.() || "home";
  shell.ensureActiveTabInvariant?.();
  shell.render?.();
  shell.saveState?.();
}

export function dockTab(id) {
  const tab = shell.state.tabs.find(t => t.id === id);
  if (!tab || tab.id === "home") return;
  tab.layout = "docked";
  tab.floatRect = null;
  tab.floatZ = 0;
  tab.floatMinimized = false;
  tab.floatRestoreRect = null;
  setDockedActive(tab.id);
  shell.render?.();
  shell.saveState?.();
}

export function closeTab(id, skipConfirm = false) {
  if (id === "home") return;
  const idx = shell.state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = shell.state.tabs[idx];
  if (!skipConfirm && tab.iframe?.contentWindow) {
    try {
      const requestClose = tab.iframe.contentWindow.__arcrho_request_close;
      if (typeof requestClose === "function" && requestClose() === true) return;
    } catch {}
  }
  if (!skipConfirm && tab.isDirty) {
    const confirmed = confirm("This tab has unsaved changes. Are you sure you want to close it?");
    if (!confirmed) return;
  }
  const wasActive = shell.state.activeId === id;
  cleanupDfmRatioHistory(tab);
  if (tab.iframe && tab.iframe.parentNode) tab.iframe.parentNode.removeChild(tab.iframe);
  shell.state.tabs.splice(idx, 1);
  if (wasActive) {
    const fallback = shell.state.tabs[Math.max(0, idx - 1)];
    shell.state.activeId = fallback ? fallback.id : "home";
  }
  if (shell.state.lastDockedActiveId === id) shell.state.lastDockedActiveId = shell.getFirstDockedTabId?.() || "home";
  shell.ensureActiveTabInvariant?.();
  shell.render?.();
  shell.saveState?.();
}

export function openDatasetTab(options = {}) {
  const requestedInputs = normalizeBrowsingHistoryEntry(options?.datasetInputs || null);
  const lastViewedInputs = getLastViewedDatasetInputs();
  const datasetInputs = requestedInputs || lastViewedInputs || null;
  const id = `ds_${shell.state.nextId++}`;
  shell.state.tabs.push({
    id,
    title: "Dataset View",
    type: "dataset",
    iframe: null,
    layout: "docked",
    dsInst: `ds_${id}_${Date.now()}`,
    datasetInputs: datasetInputs || undefined,
  });
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
}

function cleanupDfmRatioHistory(tab) {
  if (!tab || tab.type !== "dfm") return;
  try {
    tab.iframe?.contentWindow?.postMessage({ type: "arcrho:dfm-tab-closing" }, "*");
  } catch {}
  const dir = String(tab.dfmRatioHistoryDir || "").trim();
  if (!dir) return;
  tab.dfmRatioHistoryDir = "";
  const hostApi = shell.getHostApi?.();
  if (typeof hostApi?.clearDfmRatioUndoSession === "function") {
    Promise.resolve(hostApi.clearDfmRatioUndoSession({ dir })).catch(() => {});
  }
}

const ALLOWED_DFM_TAB_IDS = new Set(["details", "data", "ratios", "results", "notes"]);

function normalizeDfmInitialInputs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const project = String(source.project || source.projectName || source.project_name || "").trim();
  const reservingClass = String(
    source.reservingClass
    || source.reserving_class
    || source.path
    || source.class
    || "",
  ).trim();
  const methodName = String(source.methodName || source.method_name || source.name || "").trim();
  const outputType = String(source.outputType || source.output_type || source.outputVector || source.output_vector || "").trim();
  const inputTriangle = String(source.inputTriangle || source.input_triangle || source.datasetName || source.dataset_name || "").trim();
  const out = {};
  if (project) out.project = project;
  if (reservingClass) out.reservingClass = reservingClass;
  if (methodName) out.methodName = methodName;
  if (outputType) out.outputType = outputType;
  if (inputTriangle) out.inputTriangle = inputTriangle;
  return Object.keys(out).length ? out : null;
}

export function openDFMTab(options = {}) {
  const dfmInputs = normalizeDfmInitialInputs(options?.dfmInputs || options?.inputs || null);
  const requestedDfmTab = String(options?.dfmTab || "").trim().toLowerCase();
  const dfmTab = ALLOWED_DFM_TAB_IDS.has(requestedDfmTab) ? requestedDfmTab : "details";
  const id = `dfm_${shell.state.nextId++}`;
  shell.state.tabs.push({
    id,
    title: dfmInputs?.methodName || dfmInputs?.outputType || "DFM",
    type: "dfm",
    iframe: null,
    layout: "docked",
    dsInst: `dfm_${id}_${Date.now()}`,
    dfmTab,
    dfmInputs: dfmInputs || undefined,
    isDirty: false,
  });
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
}

export function openWorkflowTab() {
  const id = `wf_${shell.state.nextId++}`;
  const wfInst = `wf_${shell.state.nextId - 1}_${Date.now()}`;
  const tab = {
    id,
    title: `Workflow ${shell.state.nextId - 1}`,
    type: "workflow",
    iframe: null,
    layout: "docked",
    wfInst,
    isDirty: false,
  };
  shell.state.tabs.push(tab);
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
  return tab;
}

export function openProjectSettingsTab() {
  const existing = shell.state.tabs.find(t => t.type === "project_settings");
  if (existing) {
    if (!existing.projectSettingsRibbon) existing.projectSettingsRibbon = "summary";
    setActive(existing.id);
    return;
  }
  const id = `ps_${shell.state.nextId++}`;
  shell.state.tabs.push({
    id,
    title: "Project Explorer",
    type: "project_settings",
    projectSettingsRibbon: "summary",
    iframe: null,
    layout: "docked",
  });
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
}

function postProjectInstanceRestoreState(tab) {
  const state = normalizeProjectInstanceState(tab?.projectInstanceState || null);
  const iframe = tab?.iframe;
  if (!state || !iframe?.contentWindow) return false;
  try {
    iframe.contentWindow.postMessage({ type: "arcrho:project-instance-restore-state", state }, "*");
    return true;
  } catch {
    return false;
  }
}

export function openProjectInstanceTab(project = {}, options = {}) {
  const projectName = String(project?.name || project?.projectName || "").trim();
  if (!projectName) return null;
  const existing = !options?.forceNew
    ? shell.state.tabs.find(t => t.type === "project_instance" && String(t.projectName || "").trim().toLowerCase() === projectName.toLowerCase())
    : null;
  if (existing) {
    const restoreState = normalizeProjectInstanceState(project?.projectInstanceState || options?.projectInstanceState || null);
    if (restoreState) {
      existing.projectInstanceState = restoreState;
      shell.ensureIframe?.(existing);
      postProjectInstanceRestoreState(existing);
      shell.saveState?.();
    }
    setActive(existing.id);
    return existing;
  }
  const id = `pi_${shell.state.nextId++}`;
  const tab = {
    id,
    title: projectName,
    type: "project_instance",
    projectName,
    projectFolder: String(project?.folder || "").trim(),
    projectTablePath: String(project?.tablePath || "").trim(),
    projectInstanceState: normalizeProjectInstanceState(project?.projectInstanceState || options?.projectInstanceState || null) || undefined,
    iframe: null,
    layout: "docked",
  };
  shell.state.tabs.push(tab);
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
  return tab;
}

export function openShellActivityHistoryEntry(entry) {
  const normalized = normalizeShellActivityEntry(entry);
  if (!normalized) return null;
  if (normalized.tabType === "dataset") {
    openDatasetTab({ datasetInputs: normalized.datasetInputs });
    return null;
  }
  if (normalized.tabType === "dfm") {
    openDFMTab({ dfmInputs: normalized.dfmInputs, dfmTab: normalized.dfmTab });
    return null;
  }
  if (normalized.tabType === "project_settings") {
    const tab = openProjectSettingsTab();
    const active = shell.state.tabs.find(t => t.type === "project_settings");
    if (active) active.projectSettingsRibbon = normalized.projectSettingsRibbon || "summary";
    shell.render?.();
    shell.saveState?.();
    return tab || active || null;
  }
  if (normalized.tabType === "project_instance") {
    return openProjectInstanceTab({
      name: normalized.projectName,
      folder: normalized.projectFolder || "",
      tablePath: normalized.projectTablePath || "",
      projectInstanceState: normalized.projectInstanceState || null,
    });
  }
  if (normalized.tabType === "scripting") {
    return openScriptingTab({ forceNew: true, notebookPath: normalized.path || "" });
  }
  if (normalized.tabType === "workflow") return openWorkflowTab();
  if (normalized.tabType === "agent_guide") return openAgentGuideTab();
  return null;
}

export function openBrowsingHistoryTab() {
  const existing = shell.state.tabs.find(t => t.type === "browsing_history");
  if (existing) {
    setActive(existing.id);
    return;
  }
  const id = `bh_${shell.state.nextId++}`;
  shell.state.tabs.push({ id, title: "Browsing History", type: "browsing_history", iframe: null, layout: "docked" });
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
}

export function openAgentGuideTab() {
  const existing = shell.state.tabs.find(t => t.type === "agent_guide");
  if (existing) {
    setActive(existing.id);
    return existing;
  }
  const id = `ag_${shell.state.nextId++}`;
  const tab = {
    id,
    title: "ArcBot Prompt Guide",
    type: "agent_guide",
    iframe: null,
    layout: "docked",
  };
  shell.state.tabs.push(tab);
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
  return tab;
}

function getFilenameFromPath(pathLike) {
  const normalized = String(pathLike || "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function openScriptingTab(options = {}) {
  const notebookPath = String(options?.notebookPath || options?.openPath || "").trim();
  const forceNew = !!options?.forceNew || !!notebookPath;
  const existing = !forceNew ? shell.state.tabs.find(t => t.type === "scripting") : null;
  if (existing) {
    setActive(existing.id);
    return existing;
  }
  const id = `sc_${shell.state.nextId++}`;
  const scInst = `sc_${shell.state.nextId - 1}_${Date.now()}`;
  const tab = {
    id,
    title: getFilenameFromPath(notebookPath) || "Untitled Notebook",
    type: "scripting",
    scInst,
    scFresh: true,
    scOpenPath: notebookPath || undefined,
    scPath: notebookPath || undefined,
    iframe: null,
    layout: "docked",
  };
  shell.state.tabs.push(tab);
  setDockedActive(id);
  shell.render?.();
  shell.saveState?.();
  return tab;
}

function removeTabById(id) {
  if (id === "home") return;
  const idx = shell.state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = shell.state.tabs[idx];
  cleanupDfmRatioHistory(tab);
  if (tab.iframe && tab.iframe.parentNode) tab.iframe.parentNode.removeChild(tab.iframe);
  shell.state.tabs.splice(idx, 1);
}

export function closeTabsExcept(keepIds) {
  const keep = new Set(keepIds || []);
  keep.add("home");
  const toRemove = shell.state.tabs.filter(t => !keep.has(t.id));
  const dirtyTabs = toRemove.filter(t => t.isDirty);
  if (dirtyTabs.length > 0) {
    const confirmed = confirm(`${dirtyTabs.length} tab(s) have unsaved changes. Are you sure you want to close them?`);
    if (!confirmed) return;
  }
  toRemove.forEach(t => removeTabById(t.id));
  if (!keep.has(shell.state.activeId)) shell.state.activeId = keepIds && keepIds.length ? keepIds[0] : "home";
  shell.ensureActiveTabInvariant?.();
  shell.render?.();
  shell.saveState?.();
}
