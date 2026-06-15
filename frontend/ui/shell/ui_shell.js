import { getHostApi, registerShellApi } from "./shell_context.js?v=20260510a";
import { buildShellStateSnapshot, ensureActiveTabInvariant, getFirstDockedTabId, loadState, persistShellStateSnapshot, saveState, state } from "./shell_state.js?v=20260610b";
import { applyAppFont, applyZoom, adjustZoomByDelta, broadcastAppFont, broadcastZoomToIframes, closeFontSettingsModal, closeForceRebuildSettingsModal, getAutoSaveEnabled, getForceRebuildEnabled, getZoomPercent, hideGlobalTooltip, hostZoomAvailable, initAutoSaveToggle, initFontSettingsModal, initForceRebuildSettingsModal, initShellPreferences, initZoomControls, loadAppFont, openFontSettingsModal, openForceRebuildSettingsModal, setAutoSaveEnabled, setForceRebuildEnabled, setZoomPercent, showGlobalTooltip, ZOOM_STEP } from "./shell_preferences.js?v=20260510a";
import { clearSavedStatusOnDirty, formatStatusTimestamp, getStatusBarHeight, initClock, updateStatusBar } from "./status_bar.js?v=20260510a";
import { closeRootPathSettingsModal, initRootPathSettingsModal, openRootPathSettingsModal } from "./root_path_settings.js?v=20260510a";
import { clearCacheAndReload, customHardRefresh, initAppLifecycle, refreshActiveTab, restartApplication, sendShutdownSignal, showAppConfirm, shutdownApplication } from "./app_lifecycle.js?v=20260610b";
import { clearTestData, getLastWorkflowDir, getLastWorkflowPath, getWorkflowTabState, importWorkflow, postToWorkflowTab, setLastWorkflowPath } from "./workflow_host_actions.js?v=20260510a";
import { closeTab, closeTabsExcept, dockTab, floatTab, openAgentGuideTab, openBrowsingHistoryTab, openDatasetTab, openDFMTab, openProjectInstanceTab, openProjectSettingsTab, openScriptingTab, openShellActivityHistoryEntry, openWorkflowTab, recordActiveTabHistory, setActive, setDockedActive } from "./tab_actions.js?v=20260520a";
import { applyDockedIframeLayout, clampFloatingTabsToContent, clampFloatRect, defaultFloatRectFromPointer, ensureContentContainers, ensureIframe, notifyBrowsingHistoryTabs, notifyCalculatedDatasetTabs, notifyServerConnectionUpdated, notifyTabActivated, printActiveTab, removeFloatPreview, renderContent, renderFloatingWindows, updateFloatPreview } from "./shell_content.js?v=20260531a";
import { closeTabCtxMenu, initTabStrip, isTabStripDragging, openTabCtxMenu, renderTabs, togglePlusMenu } from "./tab_strip.js?v=20260520b";
import { closeAllShellMenus, initShellMenus, isActiveDFMDetailsTab, isActiveDFMTab, isActiveProjectInstanceTab, isActiveProjectSettingsDatasetTypesTab, isActiveProjectSettingsReservingClassTypesTab, isActiveScriptingTab, isActiveWorkflowTab, openDevPanel, sendDFMCommand, sendProjectInstanceCommand, sendProjectSettingsCommand, sendScriptingCommand, sendWorkflowCommand, setDfmEditEnabled, setDfmHistoryEnabled, toggleNavigationPanel, updateEditMenuState, updateFileMenuState, updateHelpMenuState, updateViewMenuState } from "./shell_menus.js?v=20260608a";
import { initHotkeys, runHotkeyAction } from "./shell_hotkeys.js?v=20260608a";
import { initShellMessages } from "./shell_messages.js?v=20260531a";
import { handleShellFileDragOver, handleShellFileDrop, initShellFileDrops } from "./shell_file_drop.js?v=20260612a";
import { initTitlebarControls } from "./titlebar_controls.js?v=20260517a";
import { initAiAssistant } from "../ai-assistant/arcrho.js?v=20260615a";
import { closeMacroWindow, initMacroWindow, openMacroWindow } from "../macro/macro_window.js?v=20260601a";

const UI_VERSION_PARAM = new URLSearchParams(window.location.search).get("v") || String(Date.now());
const CLEAR_CACHE_RESTORE_KIND = "arcrho-clear-cache-reload-restore-v1";

function render() {
  if (isTabStripDragging()) return;
  renderTabs();
  renderContent();
  updateFileMenuState();
  updateEditMenuState();
  updateViewMenuState();
  updateHelpMenuState();
  saveState();
}

function wire() {
  initZoomControls();
  initAutoSaveToggle();
  initFontSettingsModal();
  initRootPathSettingsModal();
  initForceRebuildSettingsModal();
  initShellMenus();
  initTabStrip();
  initShellMessages();
  initShellFileDrops();
  initHotkeys();
  initAppLifecycle();
  initAiAssistant();
  initMacroWindow();
}

registerShellApi({
  ZOOM_STEP,
  adjustZoomByDelta,
  applyAppFont,
  applyDockedIframeLayout,
  applyZoom,
  broadcastAppFont,
  broadcastZoomToIframes,
  buildShellStateSnapshot,
  clampFloatingTabsToContent,
  clampFloatRect,
  clearCacheAndReload,
  clearSavedStatusOnDirty,
  clearTestData,
  closeAllShellMenus,
  closeFontSettingsModal,
  closeForceRebuildSettingsModal,
  closeMacroWindow,
  closeRootPathSettingsModal,
  closeTab,
  closeTabCtxMenu,
  closeTabsExcept,
  customHardRefresh,
  defaultFloatRectFromPointer,
  dockTab,
  ensureActiveTabInvariant,
  ensureContentContainers,
  ensureIframe,
  floatTab,
  formatStatusTimestamp,
  getAutoSaveEnabled,
  getFirstDockedTabId,
  getForceRebuildEnabled,
  getHostApi,
  getLastWorkflowDir,
  getLastWorkflowPath,
  getStatusBarHeight,
  getWorkflowTabState,
  getZoomPercent,
  handleShellFileDragOver,
  handleShellFileDrop,
  hideGlobalTooltip,
  hostZoomAvailable,
  importWorkflow,
  isActiveDFMDetailsTab,
  isActiveDFMTab,
  isActiveProjectInstanceTab,
  isActiveProjectSettingsDatasetTypesTab,
  isActiveProjectSettingsReservingClassTypesTab,
  isActiveScriptingTab,
  isActiveWorkflowTab,
  loadAppFont,
  loadState,
  notifyBrowsingHistoryTabs,
  notifyCalculatedDatasetTabs,
  notifyServerConnectionUpdated,
  notifyTabActivated,
  openBrowsingHistoryTab,
  openAgentGuideTab,
  openDatasetTab,
  openDFMTab,
  openDevPanel,
  openFontSettingsModal,
  openForceRebuildSettingsModal,
  openMacroWindow,
  openProjectSettingsTab,
  openShellActivityHistoryEntry,
  openProjectInstanceTab,
  openRootPathSettingsModal,
  openTabCtxMenu,
  openScriptingTab,
  openWorkflowTab,
  postToWorkflowTab,
  printActiveTab,
  recordActiveTabHistory,
  refreshActiveTab,
  removeFloatPreview,
  render,
  renderContent,
  renderFloatingWindows,
  renderTabs,
  restartApplication,
  runHotkeyAction,
  saveState,
  sendDFMCommand,
  sendProjectInstanceCommand,
  sendProjectSettingsCommand,
  sendScriptingCommand,
  sendShutdownSignal,
  sendWorkflowCommand,
  setActive,
  setAutoSaveEnabled,
  setDfmEditEnabled,
  setDfmHistoryEnabled,
  setDockedActive,
  setForceRebuildEnabled,
  setLastWorkflowPath,
  setZoomPercent,
  showAppConfirm,
  showGlobalTooltip,
  shutdownApplication,
  state,
  toggleNavigationPanel,
  togglePlusMenu,
  uiVersionParam: UI_VERSION_PARAM,
  updateEditMenuState,
  updateFileMenuState,
  updateHelpMenuState,
  updateFloatPreview,
  updateStatusBar,
  updateViewMenuState,
});

async function restoreShellStateAfterClearCacheReload() {
  const hostApi = getHostApi();
  if (typeof hostApi?.consumeClearCacheReloadRestore !== "function") return false;
  try {
    const payload = await hostApi.consumeClearCacheReloadRestore();
    if (payload?.kind !== CLEAR_CACHE_RESTORE_KIND) return false;
    return persistShellStateSnapshot(payload.shellState || null);
  } catch {
    return false;
  }
}

async function bootShell() {
  initShellPreferences();
  await restoreShellStateAfterClearCacheReload();
  loadState();
  ensureContentContainers();
  wire();
  render();

  if (getHostApi()) initTitlebarControls();
  window.addEventListener("adaHostReady", () => initTitlebarControls());
  initClock();
}

void bootShell();
