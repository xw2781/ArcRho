import { shell } from "./shell_context.js?v=20260510a";
import { normalizeBrowsingHistoryEntry } from "/ui/shell/browsing_history.js";
import { normalizeProjectInstanceState, normalizeShellActivityEntry } from "/ui/shell/shell_activity_history.js";

let shellMessagesWired = false;

function refreshDirtyIndicators() {
  shell.renderTabs?.();
  shell.renderFloatingWindows?.();
}

function tryConsumeActiveFrameCloseShortcut() {
  const active = shell.state.tabs.find((tab) => tab.id === shell.state.activeId);
  const frameWin = active?.iframe?.contentWindow;
  if (!frameWin) return false;
  try {
    const consume = frameWin.__arcrho_consume_close_shortcut;
    return typeof consume === "function" && consume() === true;
  } catch {
    return false;
  }
}

function getDfmContextTargetTab(contextTabId = "") {
  const requested = String(contextTabId || "").trim();
  const isDfmCapable = (tab) => !!tab && (tab.type === "dfm" || (tab.type === "project_instance" && tab.piDfmActive));
  if (requested) {
    const tab = shell.state.tabs.find((item) => item.id === requested);
    if (isDfmCapable(tab)) return tab;
  }
  const active = shell.state.tabs.find((item) => item.id === shell.state.activeId);
  if (isDfmCapable(active)) return active;
  const lastDocked = shell.state.tabs.find((item) => item.id === shell.state.lastDockedActiveId);
  if (isDfmCapable(lastDocked)) return lastDocked;
  return shell.state.tabs.find(isDfmCapable) || null;
}

function handleTaskDesignerContextRequest(source, msg) {
  const requestId = String(msg?.requestId || "");
  if (!source || !requestId) return;
  const targetTab = getDfmContextTargetTab(msg?.contextTabId || "");
  if (!targetTab) {
    try {
      source.postMessage({
        type: "arcrho:task-designer-context-response",
        requestId,
        context: { available: false, error: "Activate a DFM tab/window before running validation." },
      }, "*");
    } catch {}
    return;
  }
  shell.ensureIframe?.(targetTab);
  const iframe = targetTab.iframe;
  if (!iframe?.contentWindow) {
    try {
      source.postMessage({
        type: "arcrho:task-designer-context-response",
        requestId,
        context: { available: false, error: "The active DFM target is not ready yet." },
      }, "*");
    } catch {}
    return;
  }
  let done = false;
  const finish = (context) => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onContextMessage);
    try {
      source.postMessage({
        type: "arcrho:task-designer-context-response",
        requestId,
        context: context || { available: false, error: "DFM context failed." },
      }, "*");
    } catch {}
  };
  const onContextMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const response = event.data || {};
    if (response.type !== "arcrho:assistant-context-result" || response.requestId !== requestId) return;
    finish(response.context || { available: false, error: "DFM context failed." });
  };
  window.addEventListener("message", onContextMessage);
  try {
    iframe.contentWindow.postMessage({ type: "arcrho:assistant-context-request", requestId }, "*");
  } catch {
    finish({ available: false, error: "Could not request DFM context." });
    return;
  }
  window.setTimeout(() => finish({ available: false, error: "Timed out reading active DFM context." }), 2500);
}

export function initShellMessages() {
  if (shellMessagesWired) return;
  shellMessagesWired = true;
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "arcrho:close-shell-menus") return shell.closeAllShellMenus?.();
    if (msg.type === "arcrho:open-task-designer") {
      const sourceTab = shell.state.tabs.find((tab) => tab.iframe?.contentWindow === e.source);
      shell.openTaskDesigner?.({
        title: String(msg.title || "DFM Validation"),
        contextLabel: String(msg.contextLabel || "Active DFM validation"),
        macroId: String(msg.macroId || ""),
        autoRun: !!msg.autoRun,
        contextTabId: sourceTab?.id || "",
      });
      return;
    }
    if (msg.type === "arcrho:close-task-designer") {
      const tab = shell.state.tabs.find((item) => item.type === "task_designer" && item.iframe?.contentWindow === e.source);
      if (tab) shell.closeTab?.(tab.id);
      return;
    }
    if (msg.type === "arcrho:task-designer-context-request") {
      handleTaskDesignerContextRequest(e.source, msg);
      return;
    }
    if (msg.type === "arcrho:dfm-edit-state") return shell.setDfmEditEnabled?.(!!msg.enabled);
    if (msg.type === "arcrho:dfm-history-state") {
      const inst = String(msg.inst || "");
      const tab = shell.state.tabs.find(t => t.type === "dfm" && ((inst && t.dsInst === inst) || t.iframe?.contentWindow === e.source));
      if (tab) {
        tab.dfmCanUndo = !!msg.canUndo;
        tab.dfmCanRedo = !!msg.canRedo;
      }
      const active = shell.state.tabs.find(t => t.id === shell.state.activeId);
      if (active && active.type === "dfm" && (!tab || active.id === tab.id)) {
        shell.setDfmHistoryEnabled?.({ canUndo: !!msg.canUndo, canRedo: !!msg.canRedo });
      }
      return;
    }
    if (msg.type === "arcrho:dfm-history-session") {
      const inst = String(msg.inst || "");
      const dir = String(msg.dir || "").trim();
      const tab = shell.state.tabs.find(t => t.type === "dfm" && ((inst && t.dsInst === inst) || t.iframe?.contentWindow === e.source));
      if (tab) tab.dfmRatioHistoryDir = dir || "";
      return;
    }
    if (msg.type === "arcrho:project-settings-ribbon-changed") {
      const ribbon = String(msg.ribbon || "").trim().toLowerCase();
      let updated = false;
      for (const tab of shell.state.tabs || []) {
        if (tab.type !== "project_settings" || !tab.iframe) continue;
        if (tab.iframe.contentWindow !== e.source) continue;
        tab.projectSettingsRibbon = ribbon;
        updated = true;
        break;
      }
      if (!updated) {
        const activeTab = shell.state.tabs.find((t) => t.id === shell.state.activeId && t.type === "project_settings");
        if (activeTab) { activeTab.projectSettingsRibbon = ribbon; updated = true; }
      }
      if (updated) { shell.updateFileMenuState?.(); shell.saveState?.(); }
      return;
    }
    if (msg.type === "arcrho:update-workflow-tab-title") {
      const title = String(msg.title || "").trim();
      const inst = String(msg.inst || "");
      if (!title || !inst) return;
      const tab = shell.state.tabs.find(t => t.type === "workflow" && t.wfInst === inst);
      if (!tab) return;
      tab.title = title;
      shell.render?.();
      shell.saveState?.();
      return;
    }
    if (msg.type === "arcrho:workflow-saved") {
      const path = String(msg.path || "").trim();
      if (!path) return;
      const inst = String(msg.inst || "");
      if (inst) {
        const tab = shell.state.tabs.find(t => t.type === "workflow" && t.wfInst === inst);
        if (!tab) return;
        tab.isDirty = false;
        refreshDirtyIndicators();
      }
      const label = msg.source === "auto" ? "Auto-saved" : "Saved";
      shell.updateStatusBar?.(`${label}: ${path} (${shell.formatStatusTimestamp?.()})`);
      shell.setLastWorkflowPath?.(path);
      return;
    }
    if (msg.type === "arcrho:workflow-dirty") {
      const inst = String(msg.inst || "");
      if (!inst) return;
      const tab = shell.state.tabs.find(t => t.type === "workflow" && t.wfInst === inst);
      if (!tab) return;
      const dirty = !!msg.dirty;
      if (tab.isDirty === dirty) return;
      tab.isDirty = dirty;
      if (dirty) shell.clearSavedStatusOnDirty?.();
      refreshDirtyIndicators();
      shell.saveState?.();
      return;
    }
    if (msg.type === "arcrho:project-instance-dirty") {
      const tab = shell.state.tabs.find(t => t.type === "project_instance" && t.iframe?.contentWindow === e.source);
      if (!tab) return;
      const dirty = !!msg.dirty;
      if (tab.isDirty === dirty) return;
      tab.isDirty = dirty;
      if (dirty) shell.clearSavedStatusOnDirty?.();
      refreshDirtyIndicators();
      shell.saveState?.();
      return;
    }
    if (msg.type === "arcrho:dataset-dirty") {
      const inst = String(msg.inst || "");
      const tab = shell.state.tabs.find(t => (t.type === "dataset" || t.type === "result_selection") && (
        (inst && t.dsInst === inst) || t.iframe?.contentWindow === e.source
      ));
      if (!tab) return;
      const dirty = !!msg.dirty;
      if (tab.isDirty === dirty) return;
      tab.isDirty = dirty;
      if (dirty) shell.clearSavedStatusOnDirty?.();
      refreshDirtyIndicators();
      shell.saveState?.();
      return;
    }
    if (msg.type === "arcrho:project-instance-dfm-active-state") {
      const tab = shell.state.tabs.find(t => t.type === "project_instance" && t.iframe?.contentWindow === e.source);
      if (!tab) return;
      tab.piDfmActive = !!msg.active;
      tab.piDfmInst = String(msg.inst || "");
      tab.piDfmTitle = String(msg.title || "");
      tab.dfmTab = String(msg.tab || "");
      tab.dfmCanUndo = !!msg.canUndo;
      tab.dfmCanRedo = !!msg.canRedo;
      tab.dfmEditEnabled = !!msg.editEnabled;
      if (tab.id === shell.state.activeId) {
        shell.setDfmEditEnabled?.(tab.piDfmActive && tab.dfmEditEnabled);
        shell.setDfmHistoryEnabled?.({
          canUndo: tab.piDfmActive && tab.dfmCanUndo,
          canRedo: tab.piDfmActive && tab.dfmCanRedo,
        });
        shell.updateFileMenuState?.();
        shell.updateEditMenuState?.();
        shell.updateHelpMenuState?.();
      }
      return;
    }
    if (msg.type === "arcrho:dfm-tab-changed") {
      const inst = String(msg.inst || "");
      const dfmTab = msg.tab;
      if (!inst || !dfmTab) return;
      const tab = shell.state.tabs.find(t => t.type === "dfm" && t.dsInst === inst);
      if (tab && tab.dfmTab !== dfmTab) {
        tab.dfmTab = dfmTab;
        if (tab.id === shell.state.activeId) shell.updateFileMenuState?.();
        shell.saveState?.();
      }
      return;
    }
    if (msg.type === "arcrho:dfm-dirty") {
      const inst = String(msg.inst || "");
      if (!inst) return;
      const tab = shell.state.tabs.find(t => t.type === "dfm" && t.dsInst === inst);
      if (!tab) return;
      const dirty = !!msg.dirty;
      if (tab.isDirty === dirty) return;
      tab.isDirty = dirty;
      if (dirty) shell.clearSavedStatusOnDirty?.();
      refreshDirtyIndicators();
      shell.saveState?.();
      return;
    }
    if (msg.type === "arcrho:scripting-dirty" || msg.type === "arcode:scripting-dirty") {
      const inst = String(msg.inst || "").trim();
      const tab = shell.state.tabs.find(t => t.type === "scripting" && (
        (inst && t.scInst === inst) || t.iframe?.contentWindow === e.source
      ));
      if (!tab) return;
      const dirty = !!msg.dirty;
      if (tab.isDirty === dirty) return;
      tab.isDirty = dirty;
      if (dirty) shell.clearSavedStatusOnDirty?.();
      refreshDirtyIndicators();
      shell.saveState?.();
      return;
    }
    if (msg.type === "arcrho:zoom") return shell.adjustZoomByDelta?.(Number(msg.deltaY || 0));
    if (msg.type === "arcrho:zoom-step") {
      const delta = Number(msg.delta || 0);
      if (Number.isFinite(delta) && delta) shell.setZoomPercent?.((shell.getZoomPercent?.() || 100) + delta * shell.ZOOM_STEP, true);
      return;
    }
    if (msg.type === "arcrho:zoom-reset") return shell.setZoomPercent?.(100, true);
    if (msg.type === "arcrho:open-path") {
      const requestId = String(msg.requestId || "").trim();
      const targetPath = String(msg.path || "").trim();
      const preferredApp = String(msg.preferredApp || "").trim();
      const readOnly = !!msg.readOnly;
      const source = e?.source;
      const reply = (payload) => { if (requestId && source?.postMessage) { try { source.postMessage({ type: "arcrho:open-path-result", requestId, ...payload }, "*"); } catch {} } };
      if (!requestId) return;
      if (!targetPath) { reply({ ok: false, error: "Empty path." }); return; }
      const hostApi = shell.getHostApi?.();
      if (!hostApi || typeof hostApi.openPath !== "function") { reply({ ok: false, error: "Open path requires desktop app." }); return; }
      Promise.resolve(hostApi.openPath({ path: targetPath, preferredApp, readOnly })).then((result) => reply(result?.ok ? { ok: true } : { ok: false, error: String(result?.error || `Path not found: ${targetPath}`) })).catch((err) => reply({ ok: false, error: String(err?.message || err) }));
      return;
    }
    if (msg.type === "arcrho:agent-guide-load") {
      const requestId = String(msg.requestId || "").trim();
      const source = e?.source;
      const reply = (payload) => { if (requestId && source?.postMessage) { try { source.postMessage({ type: "arcrho:agent-guide-load-result", requestId, ...payload }, "*"); } catch {} } };
      if (!requestId) return;
      const hostApi = shell.getHostApi?.();
      if (!hostApi || typeof hostApi.codexAssistantLoadPromptGuide !== "function") {
        reply({ ok: false, error: "ArcBot prompt guide requires the desktop app host." });
        return;
      }
      Promise.resolve(hostApi.codexAssistantLoadPromptGuide())
        .then((result) => reply(result?.ok ? result : { ok: false, error: String(result?.error || "Could not load ArcBot prompt guide.") }))
        .catch((err) => reply({ ok: false, error: String(err?.message || err) }));
      return;
    }
    if (msg.type === "arcrho:status") { const text = String(msg.text || "").trim(); if (text) shell.updateStatusBar?.(text, { tone: msg.tone || msg.level || "" }); return; }
    if (msg.type === "arcrho:dataset-settings-changed") {
      const active = shell.state.tabs.find(t => t.id === shell.state.activeId);
      const resolved = normalizeBrowsingHistoryEntry(msg?.resolved || null);
      if (active && active.type === "dataset" && resolved) { active.datasetInputs = resolved; shell.saveState?.(); }
      shell.notifyBrowsingHistoryTabs?.({ resolved });
      return;
    }
    if (msg.type === "arcrho:calculated-datasets-updated") {
      shell.notifyCalculatedDatasetTabs?.({ report: msg?.report || null, source: msg?.source || "" });
      return;
    }
    if (msg.type === "arcrho:browsing-history-updated") {
      const active = shell.state.tabs.find(t => t.id === shell.state.activeId);
      const entry = normalizeBrowsingHistoryEntry(msg?.entry || null);
      if (active && active.type === "dataset" && entry) { active.datasetInputs = entry; shell.saveState?.(); }
      shell.notifyBrowsingHistoryTabs?.({ entry });
      return;
    }
    if (msg.type === "arcrho:open-dataset-from-history") { const entry = normalizeBrowsingHistoryEntry(msg?.entry || null); if (entry) shell.openDatasetTab?.({ datasetInputs: entry }); return; }
    if (msg.type === "arcrho:open-dfm") {
      const dfmInputs = msg?.dfmInputs && typeof msg.dfmInputs === "object" ? msg.dfmInputs : {};
      shell.openDFMTab?.({ dfmInputs, dfmTab: msg?.dfmTab });
      return;
    }
    if (msg.type === "arcrho:open-project-instance") {
      const project = msg?.project && typeof msg.project === "object" ? msg.project : {};
      shell.openProjectInstanceTab?.(project);
      return;
    }
    if (msg.type === "arcrho:project-instance-state") {
      const tab = shell.state.tabs.find(t => t.type === "project_instance" && t.iframe?.contentWindow === e.source);
      const state = normalizeProjectInstanceState(msg?.state || null);
      if (tab && state) {
        tab.projectInstanceState = state;
        shell.saveState?.();
        if (shell.state.activeId === tab.id) {
          shell.recordActiveTabHistory?.(tab);
          shell.updateHelpMenuState?.();
        }
        shell.notifyBrowsingHistoryTabs?.({ projectInstanceState: state });
      }
      return;
    }
    if (msg.type === "arcrho:open-shell-activity-history-entry") {
      const entry = normalizeShellActivityEntry(msg?.entry || null);
      if (entry) shell.openShellActivityHistoryEntry?.(entry);
      return;
    }
    if (msg.type === "arcrho:tooltip") {
      if (msg.show) {
        let x = Number(msg.x) || 0;
        let y = Number(msg.y) || 0;
        if (msg.coord === "client") { try { const iframe = shell.state.tabs.find(t => t.id === shell.state.activeId)?.iframe; if (iframe?.getBoundingClientRect) { const rect = iframe.getBoundingClientRect(); x += rect.left; y += rect.top; } } catch {} }
        if (msg.coord === "screen") { try { x -= window.screenX || 0; y -= window.screenY || 0; } catch {} }
        shell.showGlobalTooltip?.(msg.text || "", x, y);
      } else shell.hideGlobalTooltip?.();
      return;
    }
    if (msg.type === "arcrho:workflow-import") return shell.importWorkflow?.();
    if (msg.type === "arcrho:dataset-close-confirmed") {
      const inst = String(msg.inst || "");
      const tab = shell.state.tabs.find(t => (t.type === "dataset" || t.type === "result_selection") && (
        (inst && t.dsInst === inst) || t.iframe?.contentWindow === e.source
      ));
      if (tab) return shell.closeTab?.(tab.id, true);
      return;
    }
    if (msg.type === "arcrho:dfm-close-confirmed") {
      const inst = String(msg.inst || "");
      const tab = shell.state.tabs.find(t => t.type === "dfm" && (
        (inst && t.dsInst === inst) || t.iframe?.contentWindow === e.source
      ));
      if (tab) return shell.closeTab?.(tab.id, true);
      return;
    }
    if (msg.type === "arcrho:close-active-tab") {
      if (tryConsumeActiveFrameCloseShortcut()) return;
      return shell.closeTab?.(shell.state.activeId);
    }
    if (msg.type === "arcrho:app-shutdown") return shell.shutdownApplication?.();
    if (msg.type === "arcrho:hotkey") { const action = String(msg.action || ""); if (action) shell.runHotkeyAction?.(action); return; }
    if (msg.type !== "arcrho:update-active-tab-title" && msg.type !== "arcode:update-active-tab-title") return;
    const title = String(msg.title || "").trim();
    if (!title) return;
    const inst = String(msg.inst || "").trim();
    const tab = shell.state.tabs.find(t => (
      (inst && t.type === "scripting" && t.scInst === inst) ||
      t.iframe?.contentWindow === e.source
    )) || shell.state.tabs.find(t => t.id === shell.state.activeId);
    if (!tab || tab.type === "home" || tab.type === "workflow" || tab.type === "project_settings" || tab.type === "project_instance" || tab.type === "browsing_history") return;
    tab.title = title;
    if (tab.type === "scripting") {
      const path = String(msg.path || "").trim();
      if (path) tab.scPath = path;
    }
    shell.render?.();
    shell.saveState?.();
  });
}
