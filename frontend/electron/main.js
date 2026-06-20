const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const path = require("path");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { registerArcBotIpc } = require("./arcbot_host");

// Detect Windows 11 (build number >= 22000)
function isWindows11() {
  if (process.platform !== "win32") return false;
  const release = os.release(); // e.g., "10.0.22000"
  const parts = release.split(".");
  const build = parseInt(parts[2], 10);
  return !isNaN(build) && build >= 22000;
}

const IS_WIN11 = isWindows11();

const PACKAGED_PRODUCT_NAME = String(app.getName?.() || "").trim().toLowerCase();
const APP_MODE = (
  String(process.env.ARCRHO_APP_MODE || "").trim().toLowerCase() === "arcode"
  || (app.isPackaged && PACKAGED_PRODUCT_NAME.includes("arcode"))
)
  ? "arcode"
  : "arcrho";
if (APP_MODE === "arcode") {
  app.setName("Arcode");
  app.setAppUserModelId("com.arcode.app");
} else {
  app.setAppUserModelId("com.arcrho.app");
}
const HOST = process.env.ARCRHO_HOST || "127.0.0.1";
const DEFAULT_PORT = APP_MODE === "arcode" ? "28766" : "28765";
const PORT = parseInt(process.env.ARCRHO_PORT || process.env.ARCODE_PORT || DEFAULT_PORT, 10);
const UI_VERSION = process.env.ARCRHO_UI_VERSION || process.env.ARCODE_UI_VERSION || String(Date.now());
const URL = `http://${HOST}:${PORT}/ui/?v=${encodeURIComponent(UI_VERSION)}`;
const ARCODE_URL = `http://${HOST}:${PORT}/ui/arcode/main.html?v=${encodeURIComponent(UI_VERSION)}`;
const BACKEND_HEALTH_URL = `http://${HOST}:${PORT}/app/health`;
const BACKEND_TOKEN = crypto.randomBytes(16).toString("hex");
const START_BACKEND = (APP_MODE === "arcode" ? process.env.ARCODE_START_BACKEND : process.env.ARCRHO_START_BACKEND) !== "0";
const PYTHON_EXE = process.env.PYTHON_EXE || process.env.PYTHON || "python";
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
function getDfmRatioUndoRoot() {
  return path.join(app.getPath("temp"), "ArcRho", "dfm-ratio-undo");
}

function sanitizeDfmRatioUndoSessionId(value) {
  const text = String(value || "").trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return text || `dfm_${Date.now()}`;
}

function resolveDfmRatioUndoDir(dirPath) {
  const root = path.resolve(getDfmRatioUndoRoot());
  const resolved = path.resolve(String(dirPath || ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid DFM ratio undo temp path.");
  }
  return resolved;
}

const PRELOAD_PATH = path.join(__dirname, "preload.js");
const MAIN_WINDOW_PREFS_FILE = "main_window_prefs.json";
const ARCODE_USER_SETTINGS_FILE = "settings.json";
const SCRIPTING_SHORTCUTS_FILE = "scripting_shortcuts.json";
const SCRIPTING_NOTEBOOK_PREFS_FILE = "scripting_notebook_prefs.json";
const WORKSPACE_PATHS_FILE = "workspace_paths.json";
const BACKEND_CONTROL_FLAGS = [
  ".restart_app",
  ".shutdown_app",
  ".restart_electron",
  ".shutdown_electron",
];
const BACKEND_STARTUP_TIMEOUT_MS = Math.max(
  5000,
  parseInt(
    (APP_MODE === "arcode" ? process.env.ARCODE_BACKEND_STARTUP_TIMEOUT_MS : process.env.ARCRHO_BACKEND_STARTUP_TIMEOUT_MS)
      || "30000",
    10
  ) || 30000
);
const BACKEND_STARTUP_ATTEMPTS = Math.max(
  1,
  parseInt(
    (APP_MODE === "arcode" ? process.env.ARCODE_BACKEND_STARTUP_ATTEMPTS : process.env.ARCRHO_BACKEND_STARTUP_ATTEMPTS)
      || "2",
    10
  ) || 2
);
const UPDATE_FEED_DIR = APP_MODE === "arcode"
  ? (process.env.ARCODE_UPDATE_DIR || "E:\\Arcode Server\\releases\\arcode-installers")
  : (process.env.ARCRHO_UPDATE_DIR || "E:\\ArcRho Server\\releases\\installers");
const UPDATE_MANIFEST_FILE = (APP_MODE === "arcode" ? process.env.ARCODE_UPDATE_MANIFEST_FILE : process.env.ARCRHO_UPDATE_MANIFEST_FILE) || "latest.json";
const UPDATE_CHECK_TIMEOUT_MS = Math.max(
  1000,
  parseInt(
    (APP_MODE === "arcode" ? process.env.ARCODE_UPDATE_CHECK_TIMEOUT_MS : process.env.ARCRHO_UPDATE_CHECK_TIMEOUT_MS)
      || "3000",
    10
  ) || 3000
);
const UPDATE_INSTALLER_NAME_RE = APP_MODE === "arcode"
  ? /^Arcode-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$/i
  : /^ArcRho-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$/i;
const SHA256_RE = /\b[a-fA-F0-9]{64}\b/;

function getBundledServerPath() {
  // Check if running as packaged app
  if (app.isPackaged) {
    const serverName = APP_MODE === "arcode" ? "arcode_server" : "arcrho_server";
    const resourcesPath = process.resourcesPath;
    return path.join(resourcesPath, serverName, `${serverName}.exe`);
  }
  return null;
}

let win = null;
let arcodeWin = null;
let splashWin = null;
let serverProc = null;
let serverLogStream = null;
let lastServerLogPath = "";
let electronLogPath = "";
let allowClose = false;
let backendOwned = false;
let pseudoMaximized = false;
let lastBounds = null;
let pendingClearCacheReloadRestore = null;
let serverSpawnError = null;
let backendShutdownPromise = null;
let backendClientMarkerPath = "";
function toggleDevPanelForWindow(target = BrowserWindow.getFocusedWindow() || win) {
  if (!target || target.isDestroyed()) return { ok: false, error: "Window unavailable." };
  target.webContents.toggleDevTools();
  return { ok: true, open: target.webContents.isDevToolsOpened() };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatJsonForSave(data) {
  const text = formatJsonWithCompactRowArrays(data);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function isRowArray(value) {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

function formatJsonWithCompactRowArrays(value, indent = "") {
  if (isRowArray(value)) {
    if (!value.length) return "[]";
    return `[\n${formatRowArrayLines(value, `${indent}  `)}\n${indent}]`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const childIndent = `${indent}  `;
    const lines = value.map((item, index) => {
      const rendered = `${childIndent}${formatJsonWithCompactRowArrays(item, childIndent)}`;
      return index < value.length - 1 ? `${rendered},` : rendered;
    });
    return `[\n${lines.join("\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const childIndent = `${indent}  `;
    const lines = keys.map((key, index) => {
      const rendered = `${childIndent}${JSON.stringify(key)}: ${formatJsonWithCompactRowArrays(value[key], childIndent)}`;
      return index < keys.length - 1 ? `${rendered},` : rendered;
    });
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function formatRowArrayLines(rows, indent) {
  return rows
    .map((row) => {
      const vals = row.map((value) => JSON.stringify(value)).join(", ");
      return `${indent}[${vals}]`;
    })
    .join(",\n");
}

function createBackendLogStream() {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const appLabel = APP_MODE === "arcode" ? "arcode" : "arcrho";
    lastServerLogPath = path.join(logDir, `${appLabel}-server-${getTimestampForFileName()}.log`);
    const stream = fs.createWriteStream(lastServerLogPath, { flags: "a" });
    stream.write(`${APP_MODE === "arcode" ? "Arcode" : "ArcRho"} packaged app-server log\nStarted: ${new Date().toISOString()}\n\n`);
    return stream;
  } catch (err) {
    console.warn(`Could not create app-server log file: ${err?.message || err}`);
    lastServerLogPath = "";
    return null;
  }
}

function closeBackendLogStream() {
  if (!serverLogStream) return;
  const stream = serverLogStream;
  serverLogStream = null;
  try {
    stream.end(`\nEnded: ${new Date().toISOString()}\n`);
  } catch {}
}

function writeBackendLog(prefix, chunk) {
  if (!serverLogStream || !chunk) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  if (!text) return;
  try {
    serverLogStream.write(prefix ? `[${prefix}] ${text}` : text);
  } catch {}
}

function attachBackendLogPipes(proc) {
  if (!proc || !serverLogStream) return;
  proc.stdout?.on("data", (chunk) => writeBackendLog("stdout", chunk));
  proc.stderr?.on("data", (chunk) => writeBackendLog("stderr", chunk));
}

function getElectronLogPath() {
  if (electronLogPath) return electronLogPath;
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    electronLogPath = path.join(logDir, `electron-main-${getTimestampForFileName()}.log`);
  } catch {
    const fallbackDir = path.join(os.homedir(), "AppData", "Roaming", "arcrho-electron", "logs");
    fs.mkdirSync(fallbackDir, { recursive: true });
    electronLogPath = path.join(fallbackDir, `electron-main-${getTimestampForFileName()}.log`);
  }
  return electronLogPath;
}

function formatErrorForLog(err) {
  if (!err) return "";
  if (err instanceof Error) return err.stack || err.message || String(err);
  return String(err);
}

function appendElectronLog(message, err = null) {
  try {
    const lines = [`[${new Date().toISOString()}] ${message}`];
    if (err) lines.push(formatErrorForLog(err));
    fs.appendFileSync(getElectronLogPath(), `${lines.join("\n")}\n`, "utf8");
  } catch {}
}

process.on("uncaughtException", (err) => {
  appendElectronLog("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  appendElectronLog("Unhandled promise rejection", reason);
});

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function parseVersion(value) {
  const text = String(value || "").trim().replace(/^v/i, "");
  const withoutBuild = text.split("+")[0];
  const [main, prerelease = ""] = withoutBuild.split("-", 2);
  const parts = main.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }
  return { parts, prerelease };
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return 0;
  for (let i = 0; i < 3; i += 1) {
    const delta = leftVersion.parts[i] - rightVersion.parts[i];
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (leftVersion.prerelease === rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  return leftVersion.prerelease.localeCompare(rightVersion.prerelease, undefined, { numeric: true });
}

function parseSha256Text(value) {
  const match = String(value || "").match(SHA256_RE);
  return match ? match[0].toLowerCase() : "";
}

function resolveUpdateInstallerPath(installerName) {
  const feedRoot = path.resolve(UPDATE_FEED_DIR);
  const rawName = String(installerName || "").trim();
  if (!rawName || rawName.includes("\0")) return "";
  const resolved = path.resolve(feedRoot, rawName);
  if (resolved !== feedRoot && !resolved.startsWith(feedRoot + path.sep)) {
    return "";
  }
  if (!UPDATE_INSTALLER_NAME_RE.test(path.basename(resolved))) {
    return "";
  }
  return resolved;
}

async function readInstallerSha256(installerPath, manifestSha256 = "") {
  const manifestHash = parseSha256Text(manifestSha256);
  if (manifestHash) return manifestHash;

  try {
    const raw = await fs.promises.readFile(`${installerPath}.sha256`, "utf8");
    return parseSha256Text(raw);
  } catch {
    return "";
  }
}

function createUpdateInfo(version, installerPath, sha256, source, manifest = {}) {
  return {
    version,
    installerPath,
    sha256,
    source,
    releaseNotes: String(manifest.releaseNotes || manifest.notes || "").trim(),
    mandatory: manifest.mandatory === true,
    publishedAt: String(manifest.publishedAt || "").trim(),
  };
}

function createUpdateIssue(status, version, installerPath, source, message, detail = "") {
  return {
    status,
    version,
    installerPath,
    source,
    message,
    detail,
  };
}

function isInstallableUpdate(updateInfo) {
  return !!(updateInfo && !updateInfo.status && updateInfo.version && updateInfo.installerPath && updateInfo.sha256);
}

async function updateInfoFromManifest(manifest, options = {}) {
  const reportIssues = options.reportIssues === true;
  const version = String(manifest?.version || "").trim();
  if (!parseVersion(version) || compareVersions(version, app.getVersion()) <= 0) {
    return null;
  }

  const installerName = manifest.installer || manifest.installerPath || `ArcRho-Setup-${version}.exe`;
  const installerPath = resolveUpdateInstallerPath(installerName);
  if (!installerPath) {
    console.warn("ArcRho update manifest references an invalid installer path.");
    if (reportIssues) {
      return createUpdateIssue(
        "invalid-update",
        version,
        "",
        "manifest",
        "ArcRho found a newer update manifest, but its installer path is invalid."
      );
    }
    return null;
  }

  const stat = await fs.promises.stat(installerPath).catch(() => null);
  if (!stat?.isFile()) {
    console.warn(`ArcRho update installer was not found: ${installerPath}`);
    if (reportIssues) {
      return createUpdateIssue(
        "missing-installer",
        version,
        installerPath,
        "manifest",
        "ArcRho found a newer update manifest, but the installer file is missing."
      );
    }
    return null;
  }

  const sha256 = await readInstallerSha256(installerPath, manifest.sha256);
  if (!sha256) {
    console.warn(`ArcRho update installer is missing a SHA-256 checksum: ${installerPath}`);
    if (reportIssues) {
      return createUpdateIssue(
        "missing-checksum",
        version,
        installerPath,
        "manifest",
        "ArcRho found a newer installer, but it is missing a SHA-256 checksum.",
        `Add a checksum in ${path.basename(installerPath)}.sha256 or in ${UPDATE_MANIFEST_FILE}.`
      );
    }
    return null;
  }

  return createUpdateInfo(version, installerPath, sha256, "manifest", manifest);
}

async function readManifestUpdate(options = {}) {
  const manifestPath = path.join(UPDATE_FEED_DIR, UPDATE_MANIFEST_FILE);
  let raw = "";
  try {
    raw = await fs.promises.readFile(manifestPath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`ArcRho update manifest could not be read: ${err?.message || err}`);
    }
    return null;
  }

  try {
    return updateInfoFromManifest(JSON.parse(raw), options);
  } catch (err) {
    console.warn(`ArcRho update manifest is invalid: ${err?.message || err}`);
    return null;
  }
}

async function scanInstallerFolderUpdate(options = {}) {
  const reportIssues = options.reportIssues === true;
  let entries = [];
  try {
    entries = await fs.promises.readdir(UPDATE_FEED_DIR, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`ArcRho update folder could not be scanned: ${err?.message || err}`);
    }
    return null;
  }

  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(UPDATE_INSTALLER_NAME_RE);
    if (!match) continue;
    const version = match[1];
    if (compareVersions(version, app.getVersion()) <= 0) continue;
    if (!newest || compareVersions(version, newest.version) > 0) {
      newest = { version, installerPath: path.join(UPDATE_FEED_DIR, entry.name) };
    }
  }

  if (!newest) return null;
  const sha256 = await readInstallerSha256(newest.installerPath);
  if (!sha256) {
    console.warn(`ArcRho update installer is missing a SHA-256 checksum: ${newest.installerPath}`);
    if (reportIssues) {
      return createUpdateIssue(
        "missing-checksum",
        newest.version,
        newest.installerPath,
        "folder",
        "ArcRho found a newer installer, but it is missing a SHA-256 checksum.",
        `Add ${path.basename(newest.installerPath)}.sha256 beside the installer.`
      );
    }
    return null;
  }
  return createUpdateInfo(newest.version, newest.installerPath, sha256, "folder");
}

async function findAvailableUpdate(options = {}) {
  const manifestUpdate = await readManifestUpdate(options);
  if (isInstallableUpdate(manifestUpdate)) return manifestUpdate;
  const folderUpdate = await scanInstallerFolderUpdate(options);
  if (isInstallableUpdate(folderUpdate)) return folderUpdate;
  return manifestUpdate || folderUpdate || null;
}

function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

async function verifyUpdateInstaller(updateInfo) {
  try {
    const actual = await calculateFileSha256(updateInfo.installerPath);
    return actual === String(updateInfo.sha256 || "").toLowerCase();
  } catch (err) {
    console.warn(`ArcRho update installer checksum failed: ${err?.message || err}`);
    return false;
  }
}

function showMainWindowMessageBox(options) {
  if (win && !win.isDestroyed()) {
    return dialog.showMessageBox(win, options);
  }
  return dialog.showMessageBox(options);
}

async function confirmUpdateShutdown() {
  if (!win || win.isDestroyed()) return true;
  try {
    return !!(await win.webContents.executeJavaScript(
      "window.__arcrho_confirm_app_shutdown ? window.__arcrho_confirm_app_shutdown() : true"
    ));
  } catch {
    return true;
  }
}

function launchUpdateInstaller(installerPath) {
  const child = spawn(installerPath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

async function promptForUpdateInstall(updateInfo) {
  if (!updateInfo || !win || win.isDestroyed()) return { status: "unavailable" };
  const detailLines = [
    `Current version: ${app.getVersion()}`,
    `Available version: ${updateInfo.version}`,
    `Installer: ${updateInfo.installerPath}`,
  ];
  if (updateInfo.publishedAt) detailLines.push(`Published: ${updateInfo.publishedAt}`);
  if (updateInfo.releaseNotes) detailLines.push("", updateInfo.releaseNotes);
  if (updateInfo.mandatory) detailLines.push("", "This update is marked as mandatory.");

  const response = await showMainWindowMessageBox({
    type: "info",
    title: "ArcRho update available",
    message: `ArcRho ${updateInfo.version} is available.`,
    detail: detailLines.join("\n"),
    buttons: ["Update now", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response.response !== 0) return { status: "deferred", version: updateInfo.version };
  const canShutdown = await confirmUpdateShutdown();
  if (!canShutdown) return { status: "cancelled", version: updateInfo.version };

  const verified = await verifyUpdateInstaller(updateInfo);
  if (!verified) {
    await showMainWindowMessageBox({
      type: "error",
      title: "Update could not be verified",
      message: "ArcRho did not install the update.",
      detail: "The installer checksum did not match the published SHA-256 value.",
      buttons: ["OK"],
      noLink: true,
    });
    return { status: "verification-failed", version: updateInfo.version };
  }

  try {
    launchUpdateInstaller(updateInfo.installerPath);
    app.quit();
    return { status: "launching", version: updateInfo.version };
  } catch (err) {
    await showMainWindowMessageBox({
      type: "error",
      title: "Update could not be started",
      message: "ArcRho could not launch the update installer.",
      detail: String(err?.message || err),
      buttons: ["OK"],
      noLink: true,
    });
    return { status: "launch-failed", version: updateInfo.version };
  }
}

async function checkForUpdate(options = {}) {
  const showNoUpdate = options.showNoUpdate === true;
  if (process.platform !== "win32") {
    if (showNoUpdate) {
      await showMainWindowMessageBox({
        type: "info",
        title: "Update check unavailable",
        message: "ArcRho update checks are available in the Windows desktop app.",
        buttons: ["OK"],
        noLink: true,
      });
    }
    return { status: "unsupported" };
  }

  let updateInfo = null;
  try {
    updateInfo = await withTimeout(
      findAvailableUpdate({ reportIssues: showNoUpdate }),
      UPDATE_CHECK_TIMEOUT_MS,
      "ArcRho update check"
    );
  } catch (err) {
    console.warn(`ArcRho update check skipped: ${err?.message || err}`);
    if (showNoUpdate) {
      await showMainWindowMessageBox({
        type: "info",
        title: "Update location unavailable",
        message: "ArcRho could not reach the update location.",
        detail: [
          `Update location: ${UPDATE_FEED_DIR}`,
          String(err?.message || err),
        ].join("\n"),
        buttons: ["OK"],
        noLink: true,
      });
    }
    return { status: "unavailable" };
  }

  if (updateInfo?.status) {
    if (showNoUpdate) {
      await showMainWindowMessageBox({
        type: updateInfo.status === "missing-checksum" ? "warning" : "info",
        title: "Update installer is not ready",
        message: updateInfo.message || "ArcRho found an update, but it cannot be installed yet.",
        detail: [
          `Current version: ${app.getVersion()}`,
          updateInfo.version ? `Available version: ${updateInfo.version}` : "",
          updateInfo.installerPath ? `Installer: ${updateInfo.installerPath}` : "",
          updateInfo.detail || "",
        ].filter(Boolean).join("\n"),
        buttons: ["OK"],
        noLink: true,
      });
    }
    return {
      status: updateInfo.status,
      version: updateInfo.version || "",
      installerPath: updateInfo.installerPath || "",
    };
  }

  if (!updateInfo) {
    if (showNoUpdate) {
      await showMainWindowMessageBox({
        type: "info",
        title: "No update available",
        message: "ArcRho is up to date.",
        detail: `Current version: ${app.getVersion()}`,
        buttons: ["OK"],
        noLink: true,
      });
    }
    return { status: "none" };
  }

  return promptForUpdateInstall(updateInfo);
}

async function checkForStartupUpdate() {
  return checkForUpdate({ showNoUpdate: false });
}

function getMainWindowPrefsPath() {
  return path.join(getPrefsDir(), MAIN_WINDOW_PREFS_FILE);
}

function getPrefsDir() {
  return path.join(app.getPath("appData"), "ArcRho", "prefs");
}

function getScriptingShortcutsPath() {
  return path.join(getPrefsDir(), SCRIPTING_SHORTCUTS_FILE);
}

function getScriptingNotebookPrefsPath() {
  return path.join(getPrefsDir(), SCRIPTING_NOTEBOOK_PREFS_FILE);
}

function normalizeRecentIpynbPaths(value, fallbackPath = "") {
  const inputs = Array.isArray(value) ? value : [];
  if (fallbackPath) inputs.unshift(fallbackPath);
  const seen = new Set();
  const paths = [];
  for (const item of inputs) {
    const notebookPath = String(item || "").trim();
    if (!notebookPath || path.extname(notebookPath).toLowerCase() !== ".ipynb") continue;
    const key = path.resolve(notebookPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(notebookPath);
    if (paths.length >= 5) break;
  }
  return paths;
}

function getWorkspacePathsPath() {
  return path.join(app.getPath("appData"), "ArcRho", WORKSPACE_PATHS_FILE);
}

function getArcodeUserSettingsPath() {
  return path.join(app.getPath("appData"), "Arcode", ARCODE_USER_SETTINGS_FILE);
}

function readArcodeUserSettingsFile() {
  const filePath = getArcodeUserSettingsPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeArcodeUserSettingsFile(settingsLike) {
  const settings = settingsLike && typeof settingsLike === "object" && !Array.isArray(settingsLike)
    ? settingsLike
    : {};
  const filePath = getArcodeUserSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(filePath, "utf8")) || {}; } catch { existing = {}; }
  const payload = {
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    ...settings,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  return { ok: true, settings: payload };
}

function isWindowsAppsPath(filePath) {
  return /\\WindowsApps\\/iu.test(String(filePath || ""));
}

function findExecutableOnPath(names) {
  const pathText = String(process.env.PATH || process.env.Path || "");
  const pathParts = pathText.split(path.delimiter).filter(Boolean);
  for (const dir of pathParts) {
    if (isWindowsAppsPath(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Skip inaccessible PATH entries.
      }
    }
  }
  return "";
}

function runHostCommand(command, args = [], options = {}) {
  const {
    cwd = APP_ROOT,
    env = process.env,
    input = "",
    timeoutMs = 15000,
    windowsHide = true,
    shell: useShell = process.platform === "win32",
    onStdout = null,
    onStderr = null,
    cancelKey = "",
    cancelRegistry = null,
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let canceled = false;
    let proc = null;
    const registry = cancelRegistry && typeof cancelRegistry.get === "function"
      && typeof cancelRegistry.set === "function"
      && typeof cancelRegistry.delete === "function"
      ? cancelRegistry
      : null;
    const unregisterCancel = () => {
      if (!cancelKey || !registry) return;
      const active = registry.get(cancelKey);
      if (active === cancelProcess) {
        registry.delete(cancelKey);
      } else if (active && typeof active === "object" && active.cancelProcess === cancelProcess) {
        active.cancelProcess = null;
      }
    };
    const killProcessTree = () => {
      if (!proc || !proc.pid) return;
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Fall back to killing the immediate process.
        }
      }
      try {
        proc.kill();
      } catch {
        // ignore
      }
    };
    const cancelProcess = () => {
      if (settled) return false;
      canceled = true;
      killProcessTree();
      return true;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      unregisterCancel();
      resolve({
        ok: result.code === 0 && !timedOut && !canceled,
        code: result.code,
        signal: result.signal,
        stdout,
        stderr,
        timedOut,
        canceled,
        error: result.error || "",
      });
    };

    try {
      proc = spawn(command, args, {
        cwd,
        env,
        shell: useShell,
        windowsHide,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: -1, signal: null, error: String(err?.message || err) });
      return;
    }

    if (cancelKey && registry) {
      const active = registry.get(cancelKey);
      if (active && typeof active === "object") {
        active.cancelProcess = cancelProcess;
        if (active.canceled) cancelProcess();
      } else {
        registry.set(cancelKey, cancelProcess);
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree();
    }, Math.max(1000, timeoutMs));

    proc.stdout?.on("data", (chunk) => {
      const text = String(chunk || "");
      stdout += text;
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
      if (typeof onStdout === "function") onStdout(text);
    });
    proc.stderr?.on("data", (chunk) => {
      const text = String(chunk || "");
      stderr += text;
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
      if (typeof onStderr === "function") onStderr(text);
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      finish({ code: -1, signal: null, error: String(err?.message || err) });
    });
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      finish({ code: Number.isFinite(code) ? code : -1, signal });
    });

    if (input) proc.stdin?.write(String(input));
    proc.stdin?.end();
  });
}

function getVsCodeCommand() {
  const configured = String(process.env.ARCRHO_VSCODE_CMD || "").trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const candidates = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", "code.cmd") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe") : "",
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd") : "",
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe") : "",
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Microsoft VS Code", "bin", "code.cmd") : "",
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe") : "",
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "bin", "code.cmd") : "",
      findExecutableOnPath(["code.cmd", "code.exe", "code-insiders.cmd", "code-insiders.exe"]),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && !isWindowsAppsPath(candidate)) return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return "";
  }
  return findExecutableOnPath(["code", "code-insiders"]) || "code";
}

async function openPathInVsCode(targetPath) {
  const codeCommand = getVsCodeCommand();
  if (!codeCommand) return { ok: false, missing: true, error: "VS Code command not found." };
  try {
    const child = spawn(codeCommand, ["-r", targetPath], {
      cwd: fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath),
      detached: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(codeCommand),
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, opener: "vscode" };
  } catch (err) {
    return { ok: false, error: `VS Code open failed: ${String(err?.message || err)}` };
  }
}

function isExcelWorkbookPath(targetPath) {
  return /\.(xlsx|xlsm|xlsb|xls)$/iu.test(String(targetPath || "").trim());
}

function getExcelCommand() {
  const configured = String(process.env.ARCRHO_EXCEL_CMD || "").trim();
  if (configured) return configured;
  if (process.platform !== "win32") {
    return findExecutableOnPath(["excel"]) || "";
  }
  const officeVersions = ["Office16", "Office15", "Office14", "Office12"];
  const roots = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Microsoft Office", "root") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Microsoft Office", "root") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Microsoft Office") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Microsoft Office") : "",
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    for (const version of officeVersions) {
      candidates.push(path.join(root, version, "EXCEL.EXE"));
    }
  }
  candidates.push(findExecutableOnPath(["EXCEL.EXE", "excel.exe"]));
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (fs.existsSync(candidate) && !isWindowsAppsPath(candidate)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

function quotePowerShellString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function spawnDetachedOpen(command, args = []) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        child?.unref?.();
      } catch {
        // ignore
      }
      resolve(result);
    };
    try {
      child = spawn(command, args, {
        cwd: APP_ROOT,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, error: String(err?.message || err) });
      return;
    }
    child.once("spawn", () => finish({ ok: true }));
    child.once("error", (err) => finish({ ok: false, error: String(err?.message || err) }));
  });
}

async function openExcelWorkbookReadOnly(targetPath) {
  if (!isExcelWorkbookPath(targetPath)) {
    return { ok: false, error: "Read-only open is only available for Excel workbook files." };
  }
  if (process.platform !== "win32") {
    return { ok: false, error: "Excel read-only open is only supported on Windows." };
  }

  const excelCommand = getExcelCommand();
  if (excelCommand) {
    const directResult = await spawnDetachedOpen(excelCommand, ["/r", targetPath]);
    if (directResult?.ok) return { ok: true, opener: "excel-read-only" };
  }

  const excelReadOnlyArgs = `/r "${targetPath}"`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Start-Process -FilePath 'excel.exe' -ArgumentList ${quotePowerShellString(excelReadOnlyArgs)}`,
  ].join("; ");
  const result = await runHostCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    cwd: APP_ROOT,
    shell: false,
    timeoutMs: 10000,
  });
  if (result?.ok) return { ok: true, opener: "excel-read-only" };
  const detail = String(result?.stderr || result?.stdout || result?.error || "").trim();
  return { ok: false, error: detail || "Excel read-only open failed." };
}

function loadMainWindowPrefs() {
  try {
    const prefPath = getMainWindowPrefsPath();
    if (!fs.existsSync(prefPath)) return null;
    const raw = fs.readFileSync(prefPath, "utf8");
    const parsed = JSON.parse(raw);
    const width = Math.round(Number(parsed?.width || 0));
    const height = Math.round(Number(parsed?.height || 0));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < 820 || height < 620) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function saveMainWindowPrefs(sizeLike) {
  try {
    const width = Math.round(Number(sizeLike?.width || 0));
    const height = Math.round(Number(sizeLike?.height || 0));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width < 820 || height < 620) return;

    const prefPath = getMainWindowPrefsPath();
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });

    const payload = {
      width,
      height,
      updated_at: new Date().toISOString(),
    };
    const tmpPath = `${prefPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, prefPath);
  } catch {
    // ignore preference write failures
  }
}

function createSplashWindow() {
  splashWin = new BrowserWindow({
    width: 500,
    height: 400,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: false,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWin.loadFile(path.join(APP_ROOT, "ui", "splash.html"));
  return splashWin;
}

function updateSplashProgress(progress, text) {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.webContents.send("splash-progress", { progress, text });
  }
}

function closeSplash() {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.close();
    splashWin = null;
  }
}

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

function getBackendFlagRoots() {
  const roots = new Set([APP_ROOT]);
  const bundledServer = getBundledServerPath();
  if (bundledServer) roots.add(path.dirname(bundledServer));
  return Array.from(roots);
}

function clearBackendControlFlags() {
  for (const root of getBackendFlagRoots()) {
    for (const flagName of BACKEND_CONTROL_FLAGS) {
      const flagPath = path.join(root, flagName);
      try {
        if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
      } catch {
        // ignore stale-flag cleanup failures
      }
    }
  }
}

function isBackendProcAlive(proc) {
  return !!proc && !proc.killed && proc.exitCode == null;
}

function getBackendClientDir() {
  return path.join(app.getPath("userData"), "backend_clients");
}

function getBackendClientMarkerPath() {
  return path.join(getBackendClientDir(), `${process.pid}.json`);
}

function registerBackendClient() {
  try {
    const dir = getBackendClientDir();
    fs.mkdirSync(dir, { recursive: true });
    backendClientMarkerPath = getBackendClientMarkerPath();
    fs.writeFileSync(backendClientMarkerPath, JSON.stringify({
      pid: process.pid,
      mode: APP_MODE,
      port: PORT,
      started_at: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch {
    backendClientMarkerPath = "";
  }
}

function unregisterBackendClient() {
  if (!backendClientMarkerPath) return;
  try {
    if (fs.existsSync(backendClientMarkerPath)) fs.unlinkSync(backendClientMarkerPath);
  } catch {
    // Stale markers are cleaned up by the next process.
  }
  backendClientMarkerPath = "";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getOtherBackendClientCount() {
  let count = 0;
  try {
    const dir = getBackendClientDir();
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      let pid = 0;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        pid = Number(JSON.parse(raw)?.pid || 0);
      } catch {
        pid = Number(path.basename(entry.name, ".json")) || 0;
      }
      if (!isProcessAlive(pid)) {
        try { fs.unlinkSync(filePath); } catch {}
        continue;
      }
      if (pid !== process.pid) count += 1;
    }
  } catch {
    return 0;
  }
  return count;
}

async function waitForProcExit(proc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isBackendProcAlive(proc) && Date.now() < deadline) {
    await sleep(120);
  }
  return !isBackendProcAlive(proc);
}

function forceKillBackendProc(proc) {
  if (!proc || !proc.pid || !isBackendProcAlive(proc)) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  proc.kill("SIGTERM");
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function requestBackendHealth(timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(BACKEND_HEALTH_URL, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy(new Error("health response too large"));
      });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`health status ${res.statusCode || "unknown"}`));
          return;
        }
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

async function getBackendPortListenerPids() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true });
    const pids = new Set();
    for (const line of String(stdout || "").split(/\r?\n/)) {
      if (!line.includes(`:${PORT}`) || !/\bLISTENING\b/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

function isCompatibleBackendHealth(health) {
  if (!health || health.ok !== true) return false;
  const healthApp = String(health.app || "").trim().toLowerCase();
  if (healthApp && healthApp !== APP_MODE) return false;
  if (health.token === BACKEND_TOKEN) return true;
  const projectRoot = String(health.project_root || health.projectRoot || "").trim();
  if (!projectRoot) return false;
  try {
    return path.resolve(projectRoot).toLowerCase() === path.resolve(APP_ROOT).toLowerCase();
  } catch {
    return false;
  }
}

async function stopMismatchedBackendListener() {
  let health = null;
  try {
    health = await requestBackendHealth(700);
  } catch {}
  if (isCompatibleBackendHealth(health)) return;
  const pids = await getBackendPortListenerPids();
  for (const pid of pids) {
    if (serverProc && pid === serverProc.pid) continue;
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {}
  }
  if (pids.length) await sleep(700);
}

function startBackend() {
  const env = { ...process.env };
  env.TRI_DATA_DIR = env.TRI_DATA_DIR || APP_ROOT;
  if (APP_MODE === "arcode") {
    env.ARCODE_DATA_DIR = env.ARCODE_DATA_DIR || path.join(os.homedir(), "Documents", "Arcode", "scripts");
    env.ARCODE_BACKEND_TOKEN = BACKEND_TOKEN;
    env.ARCRHO_APP_MODE = "arcode";
  } else {
    env.ARCRHO_WORKFLOW_DIR =
      env.ARCRHO_WORKFLOW_DIR ||
      path.join(os.homedir(), "Documents", "ArcRho", "workflows");
  }
  env.ARCRHO_BACKEND_TOKEN = BACKEND_TOKEN;
  serverSpawnError = null;
  backendOwned = true;

  const bundledServer = getBundledServerPath();

  if (bundledServer && fs.existsSync(bundledServer)) {
    // Use bundled server exe
    const args = ["--host", HOST, "--port", String(PORT)];
    closeBackendLogStream();
    serverLogStream = createBackendLogStream();
    serverProc = spawn(bundledServer, args, {
      cwd: path.dirname(bundledServer),
      env,
      stdio: serverLogStream ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
    });
    attachBackendLogPipes(serverProc);
    serverProc.once("exit", closeBackendLogStream);
  } else {
    // Development mode: use Python
    const appShell = path.join(APP_ROOT, "app_shell.py");
    const cmd = [appShell, "--host", HOST, "--port", String(PORT)];
    const args = ["-u", cmd[0], ...cmd.slice(1)];
    const backendConsoleMode = String(env.ARCRHO_BACKEND_CONSOLE || "").trim().toLowerCase();
    const backendStdio = backendConsoleMode === "same" ? "inherit" : "ignore";
    serverProc = spawn(PYTHON_EXE, args, {
      cwd: APP_ROOT,
      env,
      stdio: backendStdio,
      windowsHide: backendConsoleMode !== "same",
    });
  }

  serverProc.once("error", (err) => {
    serverSpawnError = err;
  });
}

async function waitForServer(timeoutMs = BACKEND_STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverSpawnError) {
      const msg = String(serverSpawnError?.message || serverSpawnError);
      throw new Error(`App server spawn failed: ${msg}`);
    }
    if (serverProc && serverProc.exitCode != null) {
      const signal = serverProc.signalCode || "none";
      const logHint = lastServerLogPath ? ` See app-server log: ${lastServerLogPath}` : "";
      throw new Error(
        `App server process exited before readiness (code=${serverProc.exitCode}, signal=${signal}).${logHint}`
      );
    }
    try {
      const payload = await requestBackendHealth(1500);
      if (!isCompatibleBackendHealth(payload)) {
        throw new Error("health response is not compatible with this ArcRho frontend");
      }
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error("Server did not start in time");
}

async function startBackendWithRetry() {
  let lastErr = null;
  for (let attempt = 1; attempt <= BACKEND_STARTUP_ATTEMPTS; attempt++) {
    clearBackendControlFlags();
    try {
      const existing = await requestBackendHealth(700);
      if (isCompatibleBackendHealth(existing)) {
        backendOwned = false;
        serverProc = null;
        appendElectronLog(`Reusing existing ArcRho backend on ${HOST}:${PORT}.`);
        return;
      }
    } catch {
      // No compatible backend is listening yet; start one below.
    }
    await stopMismatchedBackendListener();
    startBackend();
    try {
      await waitForServer(BACKEND_STARTUP_TIMEOUT_MS);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`App server startup attempt ${attempt}/${BACKEND_STARTUP_ATTEMPTS} failed:`, err);
      await terminateBackend({ force: true });
      if (attempt < BACKEND_STARTUP_ATTEMPTS) {
        await sleep(700);
      }
    }
  }
  throw lastErr || new Error("Server did not start in time");
}

async function terminateBackend(options = {}) {
  const { force = false, gracefulTimeoutMs = 1600 } = options;
  const proc = serverProc;
  if (!proc) return;

  if (force) {
    forceKillBackendProc(proc);
    await waitForProcExit(proc, 900);
    if (serverProc === proc) serverProc = null;
    backendOwned = false;
    closeBackendLogStream();
    return;
  }

  const exitedGracefully = await waitForProcExit(proc, gracefulTimeoutMs);
  if (!exitedGracefully) {
    forceKillBackendProc(proc);
    await waitForProcExit(proc, 900);
  }
  if (serverProc === proc) serverProc = null;
  backendOwned = false;
  closeBackendLogStream();
}

async function requestBackendShutdown() {
  if (!backendOwned || !serverProc) {
    return;
  }
  const otherClients = getOtherBackendClientCount();
  if (otherClients > 0) {
    appendElectronLog(`Leaving shared backend running for ${otherClients} other frontend client(s).`);
    return;
  }
  if (backendShutdownPromise) {
    await backendShutdownPromise;
    return;
  }
  backendShutdownPromise = (async () => {
    await httpPost("/app/shutdown");
    await terminateBackend();
  })();
  try {
    await backendShutdownPromise;
  } finally {
    backendShutdownPromise = null;
  }
}

function wireAppWindowInput(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.on("before-input-event", (event, input) => {
    if (!targetWindow || targetWindow.isDestroyed()) return;
    const messagePrefix = (APP_MODE === "arcode" || targetWindow === arcodeWin) ? "arcode" : "arcrho";

    const key = String(input.key || "").toUpperCase();
    const ctrl = !!input.control;
    const alt = !!input.alt;
    const shift = !!input.shift;
    const type = String(input.type || "");

    const sendHotkey = (action) => {
      targetWindow.webContents.send(`${messagePrefix}:hotkey`, { action });
    };

    if (ctrl && !alt && shift && key === "I") {
      event.preventDefault();
      toggleDevPanelForWindow(targetWindow);
      return;
    }

    if (type === "mouseWheel" && ctrl) {
      event.preventDefault();
      const deltaY = Number(input.deltaY || 0);
      targetWindow.webContents.send(`${messagePrefix}:zoom`, { deltaY });
      return;
    }

    if (ctrl && !alt && (key === "-" || key === "_")) {
      event.preventDefault();
      targetWindow.webContents.send(`${messagePrefix}:zoom-step`, { delta: -1 });
      return;
    }
    if (ctrl && !alt && (key === "=" || key === "+")) {
      event.preventDefault();
      targetWindow.webContents.send(`${messagePrefix}:zoom-step`, { delta: 1 });
      return;
    }
    if (ctrl && !alt && key === "0") {
      event.preventDefault();
      targetWindow.webContents.send(`${messagePrefix}:zoom-reset`);
      return;
    }

    if (!alt && key === "F5") {
      event.preventDefault();
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

    if (alt && !ctrl && !shift && key === "W") {
      event.preventDefault();
      targetWindow.webContents.send(`${messagePrefix}:close-active-tab`);
      return;
    }
    if (ctrl && !alt && !shift && key === "W") {
      event.preventDefault();
      targetWindow.webContents.send(`${messagePrefix}:close-active-tab`);
    }
  });
}

function buildArcodeUrl(options = {}) {
  const params = new URLSearchParams();
  params.set("v", String(options.uiVersion || UI_VERSION));
  const openPath = String(options.path || options.openPath || "").trim();
  if (openPath) params.set("path", openPath);
  if (options.fresh) params.set("fresh", "1");
  return `http://${HOST}:${PORT}/ui/arcode/main.html?${params.toString()}`;
}

function createWindow() {
  const savedSize = loadMainWindowPrefs();
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenWidth = Math.round(Number(primaryDisplay?.size?.width || 0));
  const screenHeight = Math.round(Number(primaryDisplay?.size?.height || 0));
  const launchMaxWidth = screenWidth > 0 ? Math.max(320, Math.floor(screenWidth * 0.9)) : 1400;
  const launchMaxHeight = screenHeight > 0 ? Math.max(320, Math.floor(screenHeight * 0.93)) : 900;
  const launchWidth = Math.min(Math.round(savedSize?.width || 1400), launchMaxWidth);
  const launchHeight = Math.min(Math.round(savedSize?.height || 900), launchMaxHeight);
  win = new BrowserWindow({
    width: launchWidth,
    height: launchHeight,
    frame: false,
    thickFrame: true,  // Adds Windows border for resize handles and visibility on Win10
    show: false,  // Hidden until splash closes
    backgroundColor: "#ffffff",
    title: APP_MODE === "arcode" ? "Arcode" : "ArcRho",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on("close", async (e) => {
    if (allowClose) return;
    e.preventDefault();
    try {
      const shouldIntercept = await win.webContents.executeJavaScript(
        "window.__arcrho_should_intercept_close && window.__arcrho_should_intercept_close()"
      );
      if (shouldIntercept) {
        win.webContents.executeJavaScript(
          "window.postMessage({type:'arcrho:close-active-tab'}, '*');"
        );
        return;
      }
    } catch {
      // ignore
    }

    try {
      const confirmed = await win.webContents.executeJavaScript(
        "window.__arcrho_confirm_app_shutdown ? window.__arcrho_confirm_app_shutdown() : (window.__arcode_confirm_window_close ? window.__arcode_confirm_window_close() : true)"
      );
      if (!confirmed) {
        return;
      }
    } catch {
      // ignore
    }

    allowClose = true;
    await requestBackendShutdown();
    setTimeout(() => {
      try { win.close(); } catch {}
    }, 0);
  });

  let windowSizeSaveTimer = null;
  const scheduleWindowSizeSave = () => {
    if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
    windowSizeSaveTimer = setTimeout(() => {
      windowSizeSaveTimer = null;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized() || win.isMaximized() || win.isFullScreen() || pseudoMaximized) return;
      const [width, height] = win.getSize();
      saveMainWindowPrefs({ width, height });
    }, 200);
  };
  win.on("resize", scheduleWindowSizeSave);
  win.on("closed", () => {
    if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
    windowSizeSaveTimer = null;
  });

  win.loadURL(APP_MODE === "arcode" ? ARCODE_URL : URL);
  wireAppWindowInput(win);
}

function createArcodeWindow(options = {}) {
  if (arcodeWin && !arcodeWin.isDestroyed()) {
    const openPath = String(options.path || options.openPath || "").trim();
    if (arcodeWin.isMinimized()) arcodeWin.restore();
    arcodeWin.show();
    arcodeWin.focus();
    if (openPath) {
      arcodeWin.webContents.send("arcode:open-file", { path: openPath });
    }
    return arcodeWin;
  }

  arcodeWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    thickFrame: true,
    show: false,
    backgroundColor: "#f7f8fa",
    title: "Arcode",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let arcodeAllowClose = false;
  arcodeWin.on("close", (event) => {
    if (arcodeAllowClose) return;
    event.preventDefault();
    try {
      arcodeWin.webContents.executeJavaScript(
        "window.__arcode_confirm_window_close ? window.__arcode_confirm_window_close() : true"
      ).then((confirmed) => {
        if (!confirmed || !arcodeWin || arcodeWin.isDestroyed()) return;
        arcodeAllowClose = true;
        arcodeWin.close();
      }).catch(() => {
        if (!arcodeWin || arcodeWin.isDestroyed()) return;
        arcodeAllowClose = true;
        arcodeWin.close();
      });
    } catch {
      arcodeAllowClose = true;
      arcodeWin.close();
    }
  });
  arcodeWin.on("closed", () => {
    arcodeWin = null;
  });
  arcodeWin.loadURL(buildArcodeUrl(options));
  arcodeWin.once("ready-to-show", () => {
    if (!arcodeWin || arcodeWin.isDestroyed()) return;
    arcodeWin.show();
    arcodeWin.focus();
  });
  wireAppWindowInput(arcodeWin);
  return arcodeWin;
}

ipcMain.handle("pick-open-workflow", async (event, payload) => {
  const startDir = payload?.startDir || "";
  const result = await dialog.showOpenDialog(getIpcWindow(event), {
    defaultPath: startDir || undefined,
    properties: ["openFile"],
    filters: [{ name: "Workflow", extensions: ["arcwf", "json"] }],
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("pick-open-table-file", async (event, payload) => {
  const startDir = payload?.startDir || "";
  const result = await dialog.showOpenDialog(getIpcWindow(event), {
    defaultPath: startDir || undefined,
    properties: ["openFile"],
    filters: [
      { name: "Data Files", extensions: ["csv", "txt", "parquet", "xlsx", "xlsm", "xls"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("pick-folder", async (event, payload) => {
  const startDir = String(payload?.startDir || "").trim();
  const defaultPath = startDir && fs.existsSync(startDir) ? startDir : undefined;
  const result = await dialog.showOpenDialog(getIpcWindow(event), {
    defaultPath,
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("find-arcrho-server-root", async () => {
  if (process.platform !== "win32") return { found: false, path: "" };
  for (let code = 68; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    const candidate = path.join(drive, "ArcRho Server");
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return { found: true, path: candidate };
      }
    } catch {
      // Skip unavailable or inaccessible drives.
    }
  }
  return { found: false, path: "" };
});

ipcMain.handle("pick-save-workflow", async (event, payload) => {
  const suggestedName = payload?.suggestedName || "workflow.arcwf";
  const startDir = payload?.startDir || "";
  const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
  const result = await dialog.showSaveDialog(getIpcWindow(event), {
    defaultPath,
    filters: [{ name: "Workflow", extensions: ["arcwf", "json"] }],
  });
  if (result.canceled || !result.filePath) return "";
  return result.filePath;
});

ipcMain.handle("pick-open-file", async (event, payload) => {
  const startDir = payload?.startDir || "";
  const filters = Array.isArray(payload?.filters) && payload.filters.length
    ? payload.filters
    : [{ name: "All Files", extensions: ["*"] }];
  const result = await dialog.showOpenDialog(getIpcWindow(event), {
    defaultPath: startDir || undefined,
    properties: ["openFile"],
    filters,
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("arcode-list-folder", async (_event, payload) => {
  const folderPath = String(payload?.path || "").trim();
  const includeHidden = !!payload?.includeHidden;
  if (!folderPath) return { ok: false, error: "Empty folder path.", entries: [] };
  try {
    const stat = await fs.promises.stat(folderPath);
    if (!stat.isDirectory()) return { ok: false, error: `Not a folder: ${folderPath}`, entries: [] };
    const dirents = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const entries = dirents
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .map((entry) => {
        const entryPath = path.join(folderPath, entry.name);
        return {
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    return { ok: true, path: folderPath, entries };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not list folder."), entries: [] };
  }
});

ipcMain.handle("open-path", async (_event, payload) => {
  const targetPath = String(payload?.path || "").trim();
  const preferredApp = String(payload?.preferredApp || payload?.preferred_app || "").trim().toLowerCase();
  const readOnly = !!payload?.readOnly
    || !!payload?.read_only
    || preferredApp === "excel-read-only"
    || String(payload?.openMode || payload?.open_mode || "").trim().toLowerCase() === "read-only";
  if (!targetPath) return { ok: false, error: "Empty path." };
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: false, error: `Path not found: ${targetPath}` };
    }
    if (readOnly) {
      return openExcelWorkbookReadOnly(targetPath);
    }
    let preferredError = "";
    if (preferredApp === "arcode") {
      createArcodeWindow({ path: targetPath });
      return { ok: true, opener: "arcode" };
    }
    if (preferredApp === "vscode" || preferredApp === "code") {
      const preferred = await openPathInVsCode(targetPath);
      if (preferred?.ok) return { ok: true, opener: preferred.opener || "vscode" };
      if (!preferred?.missing) return { ok: false, error: String(preferred?.error || "VS Code open failed.") };
      preferredError = String(preferred?.error || "").trim();
    }
    const openErr = await shell.openPath(targetPath);
    if (openErr) return { ok: false, error: preferredError ? `${preferredError}; ${String(openErr)}` : String(openErr) };
    return { ok: true, opener: "default" };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("show-item-in-folder", async (_event, payload) => {
  const targetPath = String(payload?.path || "").trim();
  if (!targetPath) return { ok: false, error: "Empty path." };
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: false, error: `Path not found: ${targetPath}` };
    }
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("open-terminal", async (_event, payload) => {
  const folderPath = String(payload?.cwd || payload?.path || "").trim();
  if (!folderPath) return { ok: false, error: "Empty terminal folder." };
  try {
    const stat = await fs.promises.stat(folderPath);
    if (!stat.isDirectory()) return { ok: false, error: `Not a folder: ${folderPath}` };
    if (process.platform === "win32") {
      const folder = quotePowerShellString(folderPath);
      const script = [
        `$folder = ${folder}`,
        "if (Get-Command wt.exe -ErrorAction SilentlyContinue) {",
        "  Start-Process -FilePath 'wt.exe' -ArgumentList @('-d', $folder)",
        "} else {",
        "  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $folder",
        "}",
      ].join("; ");
      const result = await runHostCommand("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ], {
        cwd: folderPath,
        shell: false,
        timeoutMs: 5000,
      });
      if (!result.ok) {
        return { ok: false, error: result.stderr || result.stdout || result.error || "Could not open terminal." };
      }
      return { ok: true, cwd: folderPath };
    }
    const opener = process.platform === "darwin" ? "open" : "x-terminal-emulator";
    const args = process.platform === "darwin" ? ["-a", "Terminal", folderPath] : [];
    const result = await runHostCommand(opener, args, {
      cwd: folderPath,
      shell: false,
      timeoutMs: 5000,
      windowsHide: false,
    });
    return result.ok
      ? { ok: true, cwd: folderPath }
      : { ok: false, error: result.stderr || result.stdout || result.error || "Could not open terminal." };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("save-json-file", async (event, payload) => {
  const data = payload?.data ?? null;
  const suggestedName = payload?.suggestedName || "data.json";
  const startDir = payload?.startDir || "";
  const filters = Array.isArray(payload?.filters) && payload.filters.length
    ? payload.filters
    : [{ name: "JSON", extensions: ["json"] }];
  let filePath = payload?.path || "";

  if (!filePath) {
    const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
    const result = await dialog.showSaveDialog(getIpcWindow(event), {
      defaultPath,
      filters,
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

ipcMain.handle("save-text-file", async (event, payload) => {
  const data = payload?.data ?? "";
  const suggestedName = payload?.suggestedName || "data.txt";
  const startDir = payload?.startDir || "";
  let filePath = payload?.path || "";

  if (!filePath) {
    const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
    const result = await dialog.showSaveDialog(getIpcWindow(event), { defaultPath });
    if (result.canceled || !result.filePath) return { path: "", canceled: true };
    filePath = result.filePath;
  }

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, String(data), "utf8");
    return { path: filePath, canceled: false };
  } catch (err) {
    return { path: "", canceled: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("read-text-file", async (_event, payload) => {
  const filePath = String(payload?.path || "");
  const maxBytes = Math.max(1024, Math.min(500000, Number(payload?.maxBytes || 200000) || 200000));
  if (!filePath) return { ok: false, error: "Empty path." };
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: "Path is not a file." };
    if (stat.size > maxBytes) {
      return { ok: false, error: `File is too large for ArcBot context (${stat.size.toLocaleString()} bytes).` };
    }
    const raw = fs.readFileSync(filePath);
    if (raw.includes(0)) return { ok: false, error: "Binary files cannot be attached as ArcBot text context." };
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath),
      size: stat.size,
      revision: {
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: crypto.createHash("sha256").update(raw).digest("hex"),
      },
      text: raw.toString("utf8"),
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not read file.") };
  }
});

ipcMain.handle("read-json-file", async (_event, payload) => {
  const filePath = String(payload?.path || "");
  if (!filePath) return { exists: false };
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const raw = fs.readFileSync(filePath, "utf8");
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return { exists: true, data: JSON.parse(raw), revision: { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, hash } };
  } catch (err) {
    return { exists: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("get-file-revision", async (_event, payload) => {
  const filePath = String(payload?.path || "");
  if (!filePath) return { exists: false };
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { exists: false, error: "Path is not a file." };
    const raw = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return { exists: true, revision: { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, hash } };
  } catch (err) {
    return { exists: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("rename-file", async (_event, payload) => {
  const filePath = String(payload?.path || "").trim();
  const newName = String(payload?.newName || "").trim();
  if (!filePath) return { ok: false, error: "Empty path." };
  if (!newName) return { ok: false, error: "Empty filename." };
  if (/[\\/:*?"<>|]/.test(newName) || path.basename(newName) !== newName) {
    return { ok: false, error: "Filename cannot include path separators or Windows filename characters." };
  }
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: "Path is not a file." };
    const targetPath = path.join(path.dirname(filePath), newName);
    if (path.resolve(targetPath) === path.resolve(filePath)) {
      const raw = fs.readFileSync(filePath);
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      return { ok: true, path: filePath, revision: { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, hash } };
    }
    if (fs.existsSync(targetPath)) return { ok: false, error: `File already exists: ${targetPath}` };
    fs.renameSync(filePath, targetPath);
    const nextStat = fs.statSync(targetPath);
    const raw = fs.readFileSync(targetPath);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return { ok: true, path: targetPath, revision: { path: targetPath, size: nextStat.size, mtimeMs: nextStat.mtimeMs, hash } };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("dfm-ratio-undo-session-create", async (_event, payload) => {
  try {
    const root = getDfmRatioUndoRoot();
    const sessionId = sanitizeDfmRatioUndoSessionId(payload?.inst || payload?.sessionId || "");
    const dir = path.join(root, `${sessionId}-${Date.now()}`);
    const resolved = resolveDfmRatioUndoDir(dir);
    fs.rmSync(resolved, { recursive: true, force: true });
    fs.mkdirSync(resolved, { recursive: true });
    return { ok: true, dir: resolved };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not create DFM ratio undo temp session.") };
  }
});

ipcMain.handle("dfm-ratio-undo-step-save", async (_event, payload) => {
  try {
    const dir = resolveDfmRatioUndoDir(payload?.dir);
    fs.mkdirSync(dir, { recursive: true });
    const index = Math.max(0, Math.min(9999, Number.parseInt(String(payload?.index ?? "0"), 10) || 0));
    const filePath = path.join(dir, `step-${String(index).padStart(4, "0")}.json`);
    fs.writeFileSync(filePath, formatJsonForSave(payload?.data ?? null), "utf8");
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not save DFM ratio undo step.") };
  }
});

ipcMain.handle("dfm-ratio-undo-session-clear", async (_event, payload) => {
  try {
    const dir = resolveDfmRatioUndoDir(payload?.dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not clear DFM ratio undo temp session.") };
  }
});

ipcMain.handle("scripting-shortcuts-load", async () => {
  const filePath = getScriptingShortcutsPath();
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const bindings = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed.bindings && typeof parsed.bindings === "object" && !Array.isArray(parsed.bindings)
        ? parsed.bindings
        : parsed)
      : null;
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
      return { exists: false, error: "Invalid shortcut settings format" };
    }
    return { exists: true, bindings };
  } catch (err) {
    return { exists: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("scripting-shortcuts-save", async (_event, payload) => {
  const bindings = payload?.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    return { ok: false, error: "Invalid shortcuts payload" };
  }
  const filePath = getScriptingShortcutsPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data = {
      bindings,
      updated_at: new Date().toISOString(),
    };
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("arcode-user-settings-load", async () => {
  try {
    return readArcodeUserSettingsFile();
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not load Arcode settings.") };
  }
});

ipcMain.handle("arcode-user-settings-save", async (_event, payload) => {
  try {
    const settings = payload?.settings && typeof payload.settings === "object" ? payload.settings : {};
    return writeArcodeUserSettingsFile(settings);
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not save Arcode settings.") };
  }
});

ipcMain.handle("scripting-last-notebook-load", async () => {
  const filePath = getScriptingNotebookPrefsPath();
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const recentPaths = normalizeRecentIpynbPaths(parsed?.recentIpynbPaths, parsed?.lastIpynbPath || parsed?.lastNotebookPath || "");
    const notebookPath = recentPaths[0] || "";
    if (!notebookPath || path.extname(notebookPath).toLowerCase() !== ".ipynb") {
      return { exists: false, recentPaths };
    }
    if (!fs.existsSync(notebookPath)) {
      return { exists: false, path: notebookPath, missing: true, recentPaths };
    }
    const stat = fs.statSync(notebookPath);
    if (!stat.isFile()) return { exists: false, path: notebookPath, error: "Path is not a file.", recentPaths };
    return { exists: true, path: notebookPath, recentPaths, updated_at: String(parsed?.updated_at || "") };
  } catch (err) {
    return { exists: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("scripting-recent-notebooks-load", async () => {
  const filePath = getScriptingNotebookPrefsPath();
  try {
    if (!fs.existsSync(filePath)) return { exists: false, recentPaths: [] };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const recentPaths = normalizeRecentIpynbPaths(parsed?.recentIpynbPaths, parsed?.lastIpynbPath || parsed?.lastNotebookPath || "")
      .filter((notebookPath) => {
        try {
          return fs.existsSync(notebookPath) && fs.statSync(notebookPath).isFile();
        } catch {
          return false;
        }
      });
    return { exists: recentPaths.length > 0, recentPaths, updated_at: String(parsed?.updated_at || "") };
  } catch (err) {
    return { exists: false, recentPaths: [], error: String(err?.message || err) };
  }
});

ipcMain.handle("scripting-last-notebook-save", async (_event, payload) => {
  const notebookPath = String(payload?.path || "").trim();
  if (!notebookPath) return { ok: false, error: "Empty notebook path." };
  if (path.extname(notebookPath).toLowerCase() !== ".ipynb") {
    return { ok: false, error: "Only .ipynb notebook paths are stored." };
  }
  const filePath = getScriptingNotebookPrefsPath();
  try {
    let existing = {};
    if (fs.existsSync(filePath)) {
      try { existing = JSON.parse(fs.readFileSync(filePath, "utf8")) || {}; } catch { existing = {}; }
    }
    const recentIpynbPaths = normalizeRecentIpynbPaths(existing?.recentIpynbPaths, notebookPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data = {
      lastIpynbPath: recentIpynbPaths[0] || notebookPath,
      recentIpynbPaths,
      updated_at: new Date().toISOString(),
    };
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("app-shutdown", async () => {
  allowClose = true;
  await requestBackendShutdown();
  app.quit();
  return true;
});

ipcMain.handle("app-check-for-update", async () => checkForUpdate({ showNoUpdate: true }));

ipcMain.handle("app-toggle-dev-panel", () => {
  return toggleDevPanelForWindow();
});

ipcMain.handle("arcode-window-open", async (_event, payload) => {
  createArcodeWindow(payload || {});
  return { ok: true };
});

ipcMain.handle("app-clear-cache-reload", async (event, payload) => {
  const targetWindow = getIpcWindow(event) || win;
  if (!targetWindow || targetWindow.isDestroyed()) return false;
  pendingClearCacheReloadRestore = payload?.restore && typeof payload.restore === "object"
    ? payload.restore
    : null;
  try {
    await targetWindow.webContents.session.clearCache();
    await targetWindow.webContents.session.clearStorageData();
  } catch {
    // ignore
  }
  try {
    const uiVersion = String(Date.now());
    const isArcodeReload = APP_MODE === "arcode"
      || targetWindow === arcodeWin
      || pendingClearCacheReloadRestore?.kind === "arcode-clear-cache-reload-restore-v1";
    const reloadUrl = isArcodeReload
      ? buildArcodeUrl({ uiVersion })
      : `http://${HOST}:${PORT}/ui/?v=${encodeURIComponent(uiVersion)}`;
    await targetWindow.loadURL(reloadUrl);
  } catch {
    try {
      targetWindow.webContents.reloadIgnoringCache();
    } catch {
      // ignore
    }
  }
  return true;
});

ipcMain.handle("app-consume-clear-cache-reload-restore", async () => {
  const restore = pendingClearCacheReloadRestore;
  pendingClearCacheReloadRestore = null;
  return restore || null;
});

const arcBotHost = registerArcBotIpc({
  ipcMain,
  app,
  APP_ROOT,
  REPO_ROOT,
  PYTHON_EXE,
  getPrefsDir,
  getWorkspacePathsPath,
  findExecutableOnPath,
  runHostCommand,
});
function getIpcWindow(event) {
  return BrowserWindow.fromWebContents(event?.sender) || BrowserWindow.getFocusedWindow() || win;
}

ipcMain.handle("focus-window", (event) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
});
ipcMain.handle("get-documents-path", () => {
  try {
    return app.getPath("documents") || "";
  } catch {
    return "";
  }
});
ipcMain.handle("get-windows-user-name", () => {
  const envUser = String(process.env.USERNAME || process.env.USER || "").trim();
  if (envUser) return envUser;
  try {
    return String(os.userInfo()?.username || "").trim();
  } catch {
    return "";
  }
});
ipcMain.handle("is-windows-11", () => IS_WIN11);
ipcMain.handle("window-minimize", (event) => getIpcWindow(event)?.minimize());
ipcMain.handle("window-maximize", (event) => getIpcWindow(event)?.maximize());
ipcMain.handle("window-restore-native", (event) => getIpcWindow(event)?.restore());
ipcMain.handle("window-close", (event) => getIpcWindow(event)?.close());
ipcMain.handle("window-is-maximized", (event) => !!getIpcWindow(event)?.isMaximized());
ipcMain.handle("window-is-fullscreen", (event) => !!getIpcWindow(event)?.isFullScreen());
ipcMain.handle("window-set-fullscreen", (event, payload) => {
  const enabled = !!payload?.enabled;
  getIpcWindow(event)?.setFullScreen(enabled);
});
ipcMain.handle("window-get-size", (event) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow) return { width: 0, height: 0 };
  const [width, height] = targetWindow.getSize();
  return { width, height };
});
ipcMain.handle("window-resize", (event, payload) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow) return;
  const w = Math.max(200, Number(payload?.width || 0));
  const h = Math.max(200, Number(payload?.height || 0));
  if (w && h) targetWindow.setSize(Math.round(w), Math.round(h));
});

ipcMain.handle("zoom-get", (event) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow) return 1;
  return targetWindow.webContents.getZoomFactor();
});

ipcMain.handle("zoom-set", (event, payload) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow) return 1;
  const factor = Number(payload?.factor || 1);
  const safe = Math.max(0.5, Math.min(2, factor));
  targetWindow.webContents.setZoomFactor(safe);
  return safe;
});

ipcMain.handle("window-pseudo-maximize", (event, payload) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow) return;
  const margin = Math.max(0, Number(payload?.margin ?? 1));
  lastBounds = targetWindow.getBounds();
  const display = screen.getDisplayMatching(lastBounds);
  const wa = display.workArea;
  const w = Math.max(200, wa.width - margin * 2);
  const h = Math.max(200, wa.height - margin * 2);
  targetWindow.setBounds({ x: wa.x + margin, y: wa.y + margin, width: w, height: h }, true);
  pseudoMaximized = true;
});

ipcMain.handle("window-is-pseudo-maximized", () => !!pseudoMaximized);

ipcMain.handle("window-restore-to-last", (event) => {
  const targetWindow = getIpcWindow(event);
  if (!targetWindow) return;
  if (lastBounds) targetWindow.setBounds(lastBounds, true);
  pseudoMaximized = false;
});

app.whenReady().then(async () => {
  appendElectronLog(
    `ArcRho startup begin. packaged=${app.isPackaged}; version=${app.getVersion()}; appPath=${app.getAppPath()}; resourcesPath=${process.resourcesPath}`
  );
  registerBackendClient();

  // Show splash screen first
  appendElectronLog("Creating splash window.");
  createSplashWindow();

  // Small delay to ensure splash is visible
  await new Promise((r) => setTimeout(r, 300));

  try {
    if (START_BACKEND) {
      updateSplashProgress(10, "Starting app server...");
      clearBackendControlFlags();

      updateSplashProgress(30, "Waiting for server...");
      appendElectronLog("Starting bundled/backend app server.");
      await startBackendWithRetry();

      updateSplashProgress(60, "Server connected");
      appendElectronLog("App server connected.");
    }

    updateSplashProgress(80, "Loading interface...");
    appendElectronLog("Creating main window.");
    createWindow();

    // Wait for main window to be ready before closing splash
    win.webContents.once("did-finish-load", () => {
      appendElectronLog("Main window finished loading.");
      updateSplashProgress(100, "Launching application...");
      setTimeout(() => {
        closeSplash();
        win.show();
        win.focus();
        if (APP_MODE !== "arcode") {
          setTimeout(() => {
            checkForStartupUpdate().catch((err) => {
              console.warn(`ArcRho startup update check failed: ${err?.message || err}`);
            });
          }, 750);
        }
      }, 400);
    });

  } catch (err) {
    appendElectronLog("Startup error", err);
    console.error("Startup error:", err);
    closeSplash();
    dialog.showErrorBox(
      "ArcRho startup failed",
      `${String(err?.message || err)}\n\nLog: ${getElectronLogPath()}`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  allowClose = true;
  arcBotHost?.stop();
  await requestBackendShutdown();
  unregisterBackendClient();
});
