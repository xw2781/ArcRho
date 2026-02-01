const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");

const HOST = process.env.ADAS_HOST || "127.0.0.1";
const PORT = parseInt(process.env.ADAS_PORT || "8000", 10);
const UI_VERSION = process.env.ADAS_UI_VERSION || String(Date.now());
const URL = `http://${HOST}:${PORT}/ui/?v=${encodeURIComponent(UI_VERSION)}`;
const START_BACKEND = process.env.ADAS_START_BACKEND !== "0";
const PYTHON_EXE = process.env.PYTHON_EXE || process.env.PYTHON || "python";

let win = null;
let serverProc = null;
let allowClose = false;
let pseudoMaximized = false;
let lastBounds = null;
const extraWindows = new Set();

function httpPost(pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        method: "POST",
        host: HOST,
        port: PORT,
        path: pathname,
        timeout: 1500,
      },
      () => resolve(true)
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

function startBackend() {
  const appShell = path.join(__dirname, "app_shell.py");
  const cmd = [appShell, "--host", HOST, "--port", String(PORT)];
  const args = ["-u", cmd[0], ...cmd.slice(1)];
  const env = { ...process.env };
  env.TRI_DATA_DIR = env.TRI_DATA_DIR || __dirname;
  env.ADAS_WORKFLOW_DIR =
    env.ADAS_WORKFLOW_DIR ||
    path.join(require("os").homedir(), "Documents", "ADAS", "workflows");

  serverProc = spawn(PYTHON_EXE, args, {
    cwd: __dirname,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(URL, (res) => {
          res.destroy();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) resolve();
          else reject();
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error("Server did not start in time");
}

function terminateBackend() {
  if (!serverProc || serverProc.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"]);
    return;
  }
  serverProc.kill("SIGTERM");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "electron_preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on("close", async (e) => {
    if (allowClose) return;
    e.preventDefault();
    try {
      const shouldIntercept = await win.webContents.executeJavaScript(
        "window.__adas_should_intercept_close && window.__adas_should_intercept_close()"
      );
      if (shouldIntercept) {
        win.webContents.executeJavaScript(
          "window.postMessage({type:'adas:close-active-tab'}, '*');"
        );
        return;
      }
    } catch {
      // ignore
    }

    try {
      const confirmed = await win.webContents.executeJavaScript(
        "window.__adas_confirm_app_shutdown ? window.__adas_confirm_app_shutdown() : true"
      );
      if (!confirmed) {
        return;
      }
    } catch {
      // ignore
    }

    allowClose = true;
    await httpPost("/app/shutdown");
    terminateBackend();
    setTimeout(() => {
      try { win.close(); } catch {}
    }, 0);
  });

  win.loadURL(URL);

  win.webContents.on("before-input-event", (event, input) => {
    if (!win || win.isDestroyed()) return;

    const key = String(input.key || "").toUpperCase();
    const ctrl = !!input.control;
    const alt = !!input.alt;
    const shift = !!input.shift;
    const type = String(input.type || "");

    const sendHotkey = (action) => {
      win.webContents.send("adas:hotkey", { action });
    };

    if (type === "mouseWheel" && ctrl) {
      event.preventDefault();
      const deltaY = Number(input.deltaY || 0);
      win.webContents.send("adas:zoom", { deltaY });
      return;
    }

    // Zoom shortcuts (Ctrl +/-/0)
    if (ctrl && !alt && (key === "-" || key === "_")) {
      event.preventDefault();
      win.webContents.send("adas:zoom-step", { delta: -1 });
      return;
    }
    if (ctrl && !alt && (key === "=" || key === "+")) {
      event.preventDefault();
      win.webContents.send("adas:zoom-step", { delta: 1 });
      return;
    }
    if (ctrl && !alt && key === "0") {
      event.preventDefault();
      win.webContents.send("adas:zoom-reset");
      return;
    }

    // Refresh shortcuts
    if (!alt && key === "F5") {
      event.preventDefault();
      sendHotkey("custom_refresh");
      return;
    }
    if (ctrl && !alt && key === "R" && shift) {
      event.preventDefault();
      sendHotkey("custom_hard_refresh");
      return;
    }
    if (ctrl && !alt && key === "R" && !shift) {
      event.preventDefault();
      sendHotkey("custom_refresh");
      return;
    }

    // File/menu shortcuts
    if (ctrl && !alt && !shift && key === "S") {
      event.preventDefault();
      sendHotkey("file_save");
      return;
    }
    if (ctrl && !alt && shift && key === "S") {
      event.preventDefault();
      sendHotkey("file_save_as");
      return;
    }
    if (ctrl && !alt && !shift && key === "O") {
      event.preventDefault();
      sendHotkey("file_import");
      return;
    }
    if (ctrl && !alt && !shift && key === "P") {
      event.preventDefault();
      sendHotkey("file_print");
      return;
    }
    if (ctrl && !alt && shift && key === "F") {
      event.preventDefault();
      sendHotkey("view_toggle_nav");
      return;
    }
    if (ctrl && !alt && !shift && key === "Q") {
      event.preventDefault();
      sendHotkey("app_shutdown");
      return;
    }
    if (ctrl && alt && key === "R") {
      event.preventDefault();
      sendHotkey("file_restart");
      return;
    }
    if (ctrl && !alt && shift && key === "K") {
      event.preventDefault();
      sendHotkey("clear_test_data");
      return;
    }

    // Tab management
    if (alt && !ctrl && !shift && key === "W") {
      event.preventDefault();
      win.webContents.send("adas:close-active-tab");
      return;
    }
    if (ctrl && !alt && !shift && key === "W") {
      event.preventDefault();
      win.webContents.send("adas:close-active-tab");
    }
  });
}

function createDetachedWindow(loadUrl, title, opts = {}) {
  const child = new BrowserWindow({
    width: Math.max(400, Number(opts.width || 1200)),
    height: Math.max(300, Number(opts.height || 820)),
    frame: opts.frame !== false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: !!opts.hideMenu,
    alwaysOnTop: !!opts.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "electron_preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (title) {
    child.setTitle(String(title));
  }
  if (opts.hideMenu) {
    try { child.setMenu(null); } catch {}
    try { child.setMenuBarVisibility(false); } catch {}
    try { child.setAutoHideMenuBar(true); } catch {}
  }
  child.loadURL(loadUrl);
  child.on("closed", () => {
    extraWindows.delete(child);
  });
  extraWindows.add(child);
  return child;
}

ipcMain.handle("pick-open-workflow", async (_event, payload) => {
  const startDir = payload?.startDir || "";
  const result = await dialog.showOpenDialog(win, {
    defaultPath: startDir || undefined,
    properties: ["openFile"],
    filters: [{ name: "Workflow", extensions: ["adaswf", "json"] }],
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("pick-save-workflow", async (_event, payload) => {
  const suggestedName = payload?.suggestedName || "workflow.adaswf";
  const startDir = payload?.startDir || "";
  const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
  const result = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: "Workflow", extensions: ["adaswf", "json"] }],
  });
  if (result.canceled || !result.filePath) return "";
  return result.filePath;
});

ipcMain.handle("save-json-file", async (_event, payload) => {
  const data = payload?.data ?? null;
  const suggestedName = payload?.suggestedName || "data.json";
  const startDir = payload?.startDir || "";
  let filePath = payload?.path || "";

  if (!filePath) {
    const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
    const result = await dialog.showSaveDialog(win, {
      defaultPath,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { path: "", canceled: true };
    filePath = result.filePath;
  }

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const content = formatJsonForSave(data);
    fs.writeFileSync(filePath, content, "utf8");
    return { path: filePath, canceled: false };
  } catch (err) {
    return { path: "", canceled: false, error: String(err?.message || err) };
  }
});

function formatJsonForSave(data) {
  if (Array.isArray(data) && data.every((row) => Array.isArray(row))) {
    return formatRowArrayJson(data);
  }
  if (data && typeof data === "object") {
    const pattern = data.pattern;
    const avgFormula = data["average formula"];
    const avgIndex = data["average index"];
    const hasPattern = Array.isArray(pattern) && pattern.every((row) => Array.isArray(row));
    const hasAvgIndex = Array.isArray(avgIndex) && avgIndex.every((row) => Array.isArray(row));
    const hasSelected = "selected" in data;
    const hasAvgFormula = "average formula" in data;
    if (hasPattern || hasAvgIndex || hasSelected || hasAvgFormula) {
      const lines = [];
      lines.push("{");
      let wroteSection = false;
      if (hasPattern) {
        lines.push('  "pattern": [');
        lines.push(formatRowArrayLines(pattern, "    "));
        lines.push("  ]");
        wroteSection = true;
      }
      if (hasAvgFormula) {
        if (wroteSection) lines[lines.length - 1] += ",";
        lines.push(`  "average formula": ${JSON.stringify(avgFormula)}`);
        wroteSection = true;
      }
      if (hasAvgIndex) {
        if (wroteSection) lines[lines.length - 1] += ",";
        lines.push('  "average index": [');
        lines.push(formatRowArrayLines(avgIndex, "    "));
        lines.push("  ]");
        wroteSection = true;
      }
      if (hasSelected) {
        if (wroteSection) lines[lines.length - 1] += ",";
        lines.push(`  "selected": ${JSON.stringify(data.selected)}`);
        wroteSection = true;
      }
      lines.push("}");
      return `${lines.join("\n")}\n`;
    }
  }
  return JSON.stringify(data, null, 2);
}

function formatRowArrayLines(rows, indent) {
  return rows
    .map((row) => {
      const vals = row.map((v) => JSON.stringify(v)).join(", ");
      return `${indent}[${vals}]`;
    })
    .join(",\n");
}

function formatRowArrayJson(rows) {
  const lines = [];
  lines.push("[");
  lines.push(formatRowArrayLines(rows, "  "));
  lines.push("]");
  return `${lines.join("\n")}\n`;
}

ipcMain.handle("read-json-file", async (_event, payload) => {
  const filePath = String(payload?.path || "");
  if (!filePath) return { exists: false };
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const raw = fs.readFileSync(filePath, "utf8");
    return { exists: true, data: JSON.parse(raw) };
  } catch (err) {
    return { exists: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("app-shutdown", async () => {
  allowClose = true;
  await httpPost("/app/shutdown");
  terminateBackend();
  app.quit();
  return true;
});

ipcMain.handle("app-clear-cache-reload", async () => {
  if (!win || win.isDestroyed()) return false;
  try {
    await win.webContents.session.clearCache();
    await win.webContents.session.clearStorageData();
  } catch {
    // ignore
  }
  try {
    win.webContents.reloadIgnoringCache();
  } catch {
    // ignore
  }
  return true;
});

ipcMain.handle("window-minimize", () => win?.minimize());
ipcMain.handle("window-maximize", () => win?.maximize());
ipcMain.handle("window-restore-native", () => win?.restore());
ipcMain.handle("window-is-maximized", () => !!win?.isMaximized());
ipcMain.handle("window-is-fullscreen", () => !!win?.isFullScreen());
ipcMain.handle("window-set-fullscreen", (_e, payload) => {
  const enabled = !!payload?.enabled;
  win?.setFullScreen(enabled);
});
ipcMain.handle("window-get-size", () => {
  if (!win) return { width: 0, height: 0 };
  const [width, height] = win.getSize();
  return { width, height };
});
ipcMain.handle("window-resize", (_e, payload) => {
  if (!win) return;
  const w = Math.max(200, Number(payload?.width || 0));
  const h = Math.max(200, Number(payload?.height || 0));
  if (w && h) win.setSize(Math.round(w), Math.round(h));
});

ipcMain.handle("window-resize-self", (e, payload) => {
  const target = BrowserWindow.fromWebContents(e.sender);
  if (!target) return;
  const w = Math.max(200, Number(payload?.width || 0));
  const h = Math.max(200, Number(payload?.height || 0));
  if (w && h) target.setSize(Math.round(w), Math.round(h));
});

ipcMain.handle("zoom-get", () => {
  if (!win) return 1;
  return win.webContents.getZoomFactor();
});

ipcMain.handle("zoom-set", (_e, payload) => {
  if (!win) return 1;
  const factor = Number(payload?.factor || 1);
  const safe = Math.max(0.5, Math.min(2, factor));
  win.webContents.setZoomFactor(safe);
  return safe;
});

ipcMain.handle("window-pseudo-maximize", (_e, payload) => {
  if (!win) return;
  const margin = Math.max(0, Number(payload?.margin ?? 1));
  lastBounds = win.getBounds();
  const display = screen.getDisplayMatching(lastBounds);
  const wa = display.workArea;
  const w = Math.max(200, wa.width - margin * 2);
  const h = Math.max(200, wa.height - margin * 2);
  win.setBounds({ x: wa.x + margin, y: wa.y + margin, width: w, height: h }, true);
  pseudoMaximized = true;
});

ipcMain.handle("window-is-pseudo-maximized", () => !!pseudoMaximized);

ipcMain.handle("window-restore-to-last", () => {
  if (!win) return;
  if (lastBounds) win.setBounds(lastBounds, true);
  pseudoMaximized = false;
});

ipcMain.handle("open-tab-window", (_e, payload) => {
  const type = String(payload?.type || "");
  if (type !== "dataset") return false;
  const params = new URLSearchParams();
  if (payload?.datasetId) params.set("ds", String(payload.datasetId));
  if (payload?.dsInst) params.set("inst", String(payload.dsInst));
  params.set("v", UI_VERSION);
  const url = `http://${HOST}:${PORT}/ui/dataset_viewer.html?${params.toString()}`;
  createDetachedWindow(url, payload?.title || "Dataset");
  return true;
});

ipcMain.handle("open-dfm-results-window", (_e, payload) => {
  const params = new URLSearchParams();
  if (payload?.datasetId) params.set("ds", String(payload.datasetId));
  if (payload?.inst) params.set("inst", String(payload.inst));
  params.set("tab", "results");
  params.set("results_only", "1");
  if (payload?.title) params.set("results_title", String(payload.title));
  params.set("v", UI_VERSION);
  const url = `http://${HOST}:${PORT}/ui/DFM.html?${params.toString()}`;
  createDetachedWindow(url, payload?.title || "Results", {
    hideMenu: true,
    width: 1000,
    height: 700,
    frame: false,
    alwaysOnTop: true,
  });
  return true;
});

app.whenReady().then(async () => {
  if (START_BACKEND) {
    startBackend();
    await waitForServer();
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  allowClose = true;
  await httpPost("/app/shutdown");
  terminateBackend();
});
