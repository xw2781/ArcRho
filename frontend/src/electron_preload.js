const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("ADAHost", {
  pickOpenWorkflowFile: (startDir) => invoke("pick-open-workflow", { startDir }),
  pickSaveWorkflowFile: (suggestedName, startDir) =>
    invoke("pick-save-workflow", { suggestedName, startDir }),
  shutdownApp: () => invoke("app-shutdown"),
  minimizeWindow: () => invoke("window-minimize"),
  maximizeWindow: () => invoke("window-maximize"),
  restoreWindow: () => invoke("window-restore-native"),
  isMaximized: () => invoke("window-is-maximized"),
  isFullscreen: () => invoke("window-is-fullscreen"),
  setFullscreen: (enabled) => invoke("window-set-fullscreen", { enabled }),
  exitFullscreenToLast: () => invoke("window-restore-to-last"),
  getWindowSize: () => invoke("window-get-size"),
  resizeWindow: (width, height) => invoke("window-resize", { width, height }),
  resizeSelfWindow: (width, height) => invoke("window-resize-self", { width, height }),
  isPseudoMaximized: () => invoke("window-is-pseudo-maximized"),
  pseudoMaximize: (margin) => invoke("window-pseudo-maximize", { margin }),
  restoreToLast: () => invoke("window-restore-to-last"),
  getZoomFactor: () => invoke("zoom-get"),
  setZoomFactor: (factor) => invoke("zoom-set", { factor }),
  openTabWindow: (payload) => invoke("open-tab-window", payload),
  openDfmResultsWindow: (payload) => invoke("open-dfm-results-window", payload),
  saveJsonFile: (payload) => invoke("save-json-file", payload),
  readJsonFile: (payload) => invoke("read-json-file", payload),
  clearCacheAndReload: () => invoke("app-clear-cache-reload"),
});

window.addEventListener("DOMContentLoaded", () => {
  try {
    window.dispatchEvent(new Event("adaHostReady"));
  } catch {
    // ignore
  }
});

ipcRenderer.on("adas:close-active-tab", () => {
  try {
    window.postMessage({ type: "adas:close-active-tab" }, "*");
  } catch {
    // ignore
  }
});

ipcRenderer.on("adas:hotkey", (_event, payload) => {
  try {
    window.postMessage({ type: "adas:hotkey", action: payload?.action }, "*");
  } catch {
    // ignore
  }
});

ipcRenderer.on("adas:zoom", (_event, payload) => {
  try {
    window.postMessage({ type: "adas:zoom", deltaY: payload?.deltaY }, "*");
  } catch {
    // ignore
  }
});

ipcRenderer.on("adas:zoom-step", (_event, payload) => {
  try {
    window.postMessage({ type: "adas:zoom-step", delta: payload?.delta }, "*");
  } catch {
    // ignore
  }
});

ipcRenderer.on("adas:zoom-reset", () => {
  try {
    window.postMessage({ type: "adas:zoom-reset" }, "*");
  } catch {
    // ignore
  }
});
