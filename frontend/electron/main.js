const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const path = require("path");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

// Detect Windows 11 (build number >= 22000)
function isWindows11() {
  if (process.platform !== "win32") return false;
  const release = os.release(); // e.g., "10.0.22000"
  const parts = release.split(".");
  const build = parseInt(parts[2], 10);
  return !isNaN(build) && build >= 22000;
}

const IS_WIN11 = isWindows11();

const HOST = process.env.ARCRHO_HOST || "127.0.0.1";
const PORT = parseInt(process.env.ARCRHO_PORT || "28765", 10);
const UI_VERSION = process.env.ARCRHO_UI_VERSION || String(Date.now());
const URL = `http://${HOST}:${PORT}/ui/?v=${encodeURIComponent(UI_VERSION)}`;
const BACKEND_HEALTH_URL = `http://${HOST}:${PORT}/app/health`;
const BACKEND_TOKEN = crypto.randomBytes(16).toString("hex");
const START_BACKEND = process.env.ARCRHO_START_BACKEND !== "0";
const PYTHON_EXE = process.env.PYTHON_EXE || process.env.PYTHON || "python";
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const PYTHON_API_SRC = path.join(REPO_ROOT, "python-api", "src");
const PYTHON_API_WHEEL_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "python_packages")
  : path.join(APP_ROOT, "build", "python_packages");
const ARCBOT_PROMPT_TEMPLATE_PATH = path.join(__dirname, "prompts", "arcbot_prompt.md");
const ARCBOT_SERVER_PROMPT_RELATIVE_PATH = path.join("config", "arcbot", "arcbot_prompt.md");
const ARCBOT_LEGACY_SERVER_PROMPT_RELATIVE_PATH = path.join("config", "arcbot_prompt.md");
const ARCBOT_SERVER_INSTRUCTIONS_RELATIVE_DIR = path.join("config", "arcbot", "instructions");
const ARCBOT_SERVER_INSTRUCTION_PLACEHOLDERS = [
  ["data_labels.md", "# Data Labels\n\nAdd shared definitions for dataset labels, triangle names, abbreviations, and common naming patterns.\n"],
  ["dfm_workflow.md", "# DFM Workflow\n\nAdd DFM-specific review, analysis, and editing practices.\n"],
  ["reserving_practice.md", "# Reserving Practice\n\nAdd reserving workflow expectations, review standards, and business judgment notes.\n"],
  ["project_workflow.md", "# Project Workflow\n\nAdd project, reserving class, and folder conventions.\n"],
  ["scripting_console.md", "# Scripting Console\n\nAdd notebook and scripting-console usage guidance.\n"],
  ["excel_addin.md", "# Excel Add-in\n\nAdd Excel add-in, UDF, and request-handler workflow guidance.\n"],
];

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
const SCRIPTING_SHORTCUTS_FILE = "scripting_shortcuts.json";
const SCRIPTING_NOTEBOOK_PREFS_FILE = "scripting_notebook_prefs.json";
const WORKSPACE_PATHS_FILE = "workspace_paths.json";
const ARCBOT_READABLE_ROOTS_FILE = "arcbot_readable_roots.json";
const ARCBOT_CHAT_SESSIONS_DIR = "arcbot_chat_sessions";
const CODEX_ASSISTANT_TIMEOUT_MS = Math.max(
  15000,
  parseInt(process.env.ARCRHO_CODEX_ASSISTANT_TIMEOUT_MS || "120000", 10) || 120000
);
const CODEX_ASSISTANT_CONTEXT_WINDOW_TOKENS = Math.max(
  1000,
  parseInt(process.env.ARCRHO_CODEX_ASSISTANT_CONTEXT_WINDOW_TOKENS || "200000", 10) || 200000
);
const CODEX_APP_SERVER_ENABLED = process.env.ARCRHO_CODEX_APP_SERVER !== "0";
const BACKEND_CONTROL_FLAGS = [
  ".restart_app",
  ".shutdown_app",
  ".restart_electron",
  ".shutdown_electron",
];
const BACKEND_STARTUP_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.ARCRHO_BACKEND_STARTUP_TIMEOUT_MS || "30000", 10) || 30000
);
const BACKEND_STARTUP_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.ARCRHO_BACKEND_STARTUP_ATTEMPTS || "2", 10) || 2
);
const UPDATE_FEED_DIR = process.env.ARCRHO_UPDATE_DIR || "E:\\ArcRho Server\\releases\\installers";
const UPDATE_MANIFEST_FILE = process.env.ARCRHO_UPDATE_MANIFEST_FILE || "latest.json";
const UPDATE_CHECK_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.ARCRHO_UPDATE_CHECK_TIMEOUT_MS || "3000", 10) || 3000
);
const UPDATE_INSTALLER_NAME_RE = /^ArcRho-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$/i;
const SHA256_RE = /\b[a-fA-F0-9]{64}\b/;

function getBundledServerPath() {
  // Check if running as packaged app
  if (app.isPackaged) {
    // In packaged app, server is in resources/arcrho_server/arcrho_server.exe
    const resourcesPath = process.resourcesPath;
    return path.join(resourcesPath, "arcrho_server", "arcrho_server.exe");
  }
  return null;
}

let win = null;
let splashWin = null;
let serverProc = null;
let serverLogStream = null;
let lastServerLogPath = "";
let electronLogPath = "";
let allowClose = false;
let pseudoMaximized = false;
let lastBounds = null;
let serverSpawnError = null;
let backendShutdownPromise = null;
const mappedDriveRemoteCache = new Map();
const activeCodexAssistantRequests = new Map();
const arcBotCodexThreads = new Map();
const arcBotRequestLoggers = new Map();
let codexAppServerClient = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function createBackendLogStream() {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    lastServerLogPath = path.join(logDir, `arcrho-server-${getTimestampForFileName()}.log`);
    const stream = fs.createWriteStream(lastServerLogPath, { flags: "a" });
    stream.write(`ArcRho packaged app-server log\nStarted: ${new Date().toISOString()}\n\n`);
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

function getArcBotReadableRootsPath() {
  return path.join(getPrefsDir(), ARCBOT_READABLE_ROOTS_FILE);
}

function getPythonApiWheelPath() {
  try {
    const wheels = fs.readdirSync(PYTHON_API_WHEEL_DIR)
      .filter((name) => /^arcrho_api-.*\.whl$/iu.test(name))
      .sort();
    return wheels.length ? path.join(PYTHON_API_WHEEL_DIR, wheels[wheels.length - 1]) : "";
  } catch {
    return "";
  }
}

function getArcBotChatSessionsDir() {
  return path.join(app.getPath("userData"), ARCBOT_CHAT_SESSIONS_DIR);
}

function sanitizeArcBotSessionId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function createArcBotChatSessionId() {
  return `chat-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
}

function getArcBotChatSessionPath(sessionId) {
  const safeId = sanitizeArcBotSessionId(sessionId);
  if (!safeId) return "";
  return path.join(getArcBotChatSessionsDir(), `${safeId}.json`);
}

function normalizeArcBotMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-80).map((message) => ({
    role: String(message?.role || "").toLowerCase() === "assistant" ? "assistant"
      : String(message?.role || "").toLowerCase() === "system" ? "system"
      : "user",
    content: String(message?.content || ""),
    timestamp: String(message?.timestamp || new Date().toISOString()),
  })).filter((message) => message.content.trim());
}

function normalizeArcBotActivities(activities) {
  if (!Array.isArray(activities)) return [];
  return activities.slice(-120).map((activity) => ({
    type: String(activity?.type || "info").slice(0, 32),
    text: String(activity?.text || "").slice(0, 1000),
    elapsedMs: Number.isFinite(activity?.elapsedMs) ? Math.max(0, Math.round(activity.elapsedMs)) : null,
    timestamp: String(activity?.timestamp || new Date().toISOString()),
  })).filter((activity) => activity.text.trim());
}

function normalizeArcBotDebugLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.slice(-300).map((entry) => ({
    type: String(entry?.type || "debug").slice(0, 32),
    text: String(entry?.text || "").slice(0, 8000),
    timestamp: String(entry?.timestamp || new Date().toISOString()),
  })).filter((entry) => entry.text.trim());
}

function normalizeArcBotModel(model) {
  const value = String(model || "codex").trim().toLowerCase();
  const supported = new Set([
    "codex", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
    "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5",
  ]);
  return supported.has(value) ? value : "codex";
}

function normalizeArcBotReasoningEffort(effort) {
  const value = String(effort || "high").trim().toLowerCase();
  const supported = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  return supported.has(value) ? value : "high";
}

function isClaudeArcBotModel(model) {
  return String(model || "").startsWith("claude-");
}

function getClaudeCredentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

function loadClaudeAuthToken() {
  try {
    const raw = fs.readFileSync(getClaudeCredentialsPath(), "utf8");
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const expiresAt = Number(oauth.expiresAt || 0);
    if (expiresAt && Date.now() > expiresAt) return null;
    return String(oauth.accessToken);
  } catch {
    return null;
  }
}

function getClaudeCommand() {
  if (process.platform === "win32") {
    const candidates = [
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "claude.cmd") : "",
      findExecutableOnPath(["claude.cmd", "claude.exe"]),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
    return "";
  }
  return findExecutableOnPath(["claude"]) || "";
}

function buildClaudeSystemPrompt(mode, activeContext, activeJson) {
  const parts = [
    "You are ArcBot, an AI assistant embedded in ArcRho, an actuarial reserving and analytics platform.",
    mode === "edit"
      ? "You are in Edit Mode. Provide clear, actionable guidance to help the user work with their data and models."
      : "You are in Read-Only Review Mode. Analyze and explain; do not modify any data or files.",
  ];
  if (activeContext?.available) {
    const tabLabel = activeContext.title || activeContext.tabType || "active tab";
    parts.push(`Current app context: ${tabLabel}${activeContext.tabType ? ` (${activeContext.tabType})` : ""}.`);
    if (activeContext.targetPath) parts.push(`Active file: ${activeContext.targetPath}`);
  }
  if (activeJson && typeof activeJson === "object" && !activeJson.error) {
    const jsonStr = JSON.stringify(activeJson, null, 2).slice(0, 12000);
    parts.push(`Active page data:\n\`\`\`json\n${jsonStr}\n\`\`\``);
  }
  return parts.join("\n\n");
}

function runClaudeArcBotRequest({ event, requestId, requestState, model, reasoningEffort, systemText, messages, attachments, usage }) {
  const authToken = loadClaudeAuthToken();
  if (!authToken) {
    return Promise.resolve({ ok: false, needsAuth: true, error: "Claude is not authenticated. Run: claude login" });
  }
  const thinkingBudgetMap = { low: 1024, medium: 4096, high: 8192, xhigh: 16000 };
  const thinkingBudget = thinkingBudgetMap[reasoningEffort] ?? 8192;
  const enableThinking = (model === "claude-opus-4-8" || model === "claude-sonnet-4-6") && reasoningEffort !== "low";
  const anthropicMessages = (Array.isArray(messages) ? messages : [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i, arr) => {
      let content = String(m.content || "");
      if (m.role === "user" && i === arr.length - 1 && Array.isArray(attachments) && attachments.length) {
        content += attachments.map((a) => `\n\n--- Attached: ${a.name} ---\n${a.text}`).join("");
      }
      return { role: m.role, content };
    });
  if (!anthropicMessages.length) {
    return Promise.resolve({ ok: false, error: "No messages to send." });
  }
  const bodyObj = {
    model,
    max_tokens: enableThinking ? thinkingBudget + 8192 : 8192,
    system: systemText,
    messages: anthropicMessages,
    stream: true,
  };
  if (enableThinking) bodyObj.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  const requestBodyStr = JSON.stringify(bodyObj);
  const https = require("https");
  return new Promise((resolve) => {
    const reqHeaders = {
      "Authorization": `Bearer ${authToken}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(requestBodyStr),
    };
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: reqHeaders,
    }, (res) => {
      if (res.statusCode !== 200) {
        let errorText = "";
        res.on("data", (chunk) => { errorText += chunk; });
        res.on("end", () => resolve({
          ok: false,
          needsAuth: res.statusCode === 401,
          error: `Anthropic API error ${res.statusCode}: ${String(errorText).slice(0, 300)}`,
        }));
        return;
      }
      if (requestState) requestState.cancelProcess = () => { req.destroy(); return true; };
      let fullText = "";
      let buffer = "";
      let inputTokens = 0;
      let outputTokens = 0;
      res.on("data", (chunk) => {
        if (requestState?.canceled) { req.destroy(); return; }
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const evt = JSON.parse(data);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              fullText += evt.delta.text;
              sendArcBotActivity(event, requestId, "stdout", evt.delta.text);
            } else if (evt.type === "message_delta" && evt.usage) {
              outputTokens = Number(evt.usage.output_tokens || 0);
            } else if (evt.type === "message_start" && evt.message?.usage) {
              inputTokens = Number(evt.message.usage.input_tokens || 0);
            }
          } catch {}
        }
      });
      res.on("end", () => {
        if (requestState?.canceled) { resolve({ ok: false, canceled: true, error: "Request canceled." }); return; }
        if (inputTokens || outputTokens) {
          const total = inputTokens + outputTokens;
          sendArcBotActivity(event, requestId, "usage",
            `Context: ~${total.toLocaleString()} tokens (${inputTokens.toLocaleString()} in, ${outputTokens.toLocaleString()} out).`,
            { usage: { ...(usage || {}), estimatedTokens: total } });
        }
        resolve({ ok: true, stdout: fullText });
      });
      res.on("error", (err) => resolve({ ok: false, error: String(err?.message || err || "Claude stream error.") }));
    });
    req.on("error", (err) => {
      if (requestState?.canceled) resolve({ ok: false, canceled: true, error: "Request canceled." });
      else resolve({ ok: false, error: String(err?.message || err || "Claude request failed.") });
    });
    req.write(requestBodyStr);
    req.end();
  });
}

function getArcBotRuntimeModel(model) {
  const normalized = normalizeArcBotModel(model);
  return normalized === "codex" ? null : normalized;
}

function deriveArcBotSessionTitle(messages, fallback = "New ArcBot Chat") {
  const firstUser = normalizeArcBotMessages(messages).find((message) => message.role === "user");
  const title = String(firstUser?.content || fallback).replace(/\s+/g, " ").trim();
  return title.length > 42 ? `${title.slice(0, 39)}...` : title || fallback;
}

function readArcBotChatSession(sessionId) {
  const filePath = getArcBotChatSessionPath(sessionId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || sanitizeArcBotSessionId(parsed.id) !== sanitizeArcBotSessionId(sessionId)) return null;
    return {
      id: sanitizeArcBotSessionId(parsed.id),
      title: String(parsed.title || "ArcBot Chat"),
      createdAt: String(parsed.createdAt || new Date().toISOString()),
      updatedAt: String(parsed.updatedAt || parsed.createdAt || new Date().toISOString()),
      mode: String(parsed.mode || "edit"),
      model: normalizeArcBotModel(parsed.model),
      reasoningEffort: normalizeArcBotReasoningEffort(parsed.reasoningEffort),
      archived: parsed.archived === true,
      messages: normalizeArcBotMessages(parsed.messages),
      activities: normalizeArcBotActivities(parsed.activities),
      debugLogs: normalizeArcBotDebugLogs(parsed.debugLogs),
      context: parsed.context && typeof parsed.context === "object" ? parsed.context : null,
      usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null,
    };
  } catch {
    return null;
  }
}

function writeArcBotChatSession(sessionLike) {
  const now = new Date().toISOString();
  const existing = sessionLike?.id ? readArcBotChatSession(sessionLike.id) : null;
  const id = sanitizeArcBotSessionId(sessionLike?.id) || createArcBotChatSessionId();
  const messages = normalizeArcBotMessages(sessionLike?.messages || existing?.messages || []);
  const session = {
    id,
    title: String(sessionLike?.title || existing?.title || deriveArcBotSessionTitle(messages)).slice(0, 80),
    createdAt: String(existing?.createdAt || sessionLike?.createdAt || now),
    updatedAt: now,
    mode: String(sessionLike?.mode || existing?.mode || "edit"),
    model: normalizeArcBotModel(sessionLike?.model || existing?.model),
    reasoningEffort: normalizeArcBotReasoningEffort(sessionLike?.reasoningEffort || existing?.reasoningEffort),
    archived: Object.prototype.hasOwnProperty.call(sessionLike || {}, "archived")
      ? sessionLike?.archived === true
      : existing?.archived === true,
    messages,
    activities: normalizeArcBotActivities(sessionLike?.activities || existing?.activities || []),
    debugLogs: normalizeArcBotDebugLogs(sessionLike?.debugLogs || existing?.debugLogs || []),
    context: sessionLike?.context && typeof sessionLike.context === "object" ? sessionLike.context : existing?.context || null,
    usage: sessionLike?.usage && typeof sessionLike.usage === "object" ? sessionLike.usage : existing?.usage || null,
  };
  fs.mkdirSync(getArcBotChatSessionsDir(), { recursive: true });
  const filePath = getArcBotChatSessionPath(id);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  return session;
}

function listArcBotChatSessions(options = {}) {
  const includeArchived = options?.includeArchived === true;
  fs.mkdirSync(getArcBotChatSessionsDir(), { recursive: true });
  return fs.readdirSync(getArcBotChatSessionsDir())
    .filter((name) => /\.json$/i.test(name))
    .map((name) => readArcBotChatSession(path.basename(name, ".json")))
    .filter(Boolean)
    .filter((session) => includeArchived || !session.archived)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      messageCount: session.messages.length,
      archived: session.archived === true,
    }));
}

function archiveArcBotChatSession(sessionId, archived = true) {
  const session = readArcBotChatSession(sessionId);
  if (!session) return null;
  return writeArcBotChatSession({ ...session, archived: !!archived });
}

function deleteArcBotChatSession(sessionId) {
  const filePath = getArcBotChatSessionPath(sessionId);
  if (!filePath || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

function getConfiguredWorkspaceRoot() {
  try {
    const filePath = getWorkspacePathsPath();
    if (!fs.existsSync(filePath)) return "";
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.workspace_root || "").trim();
  } catch {
    return "";
  }
}

function getCodexAssistantProjectRoot() {
  const configuredRoot = getConfiguredWorkspaceRoot();
  if (configuredRoot) return configuredRoot;
  return APP_ROOT;
}

function isUncPath(filePath) {
  return /^\\\\[^\\]+\\[^\\]+/u.test(String(filePath || "").trim());
}

function getLocalArcRhoAssistantRoot() {
  const userHome = process.env.USERPROFILE || os.homedir();
  const basePath = path.join(userHome, "Documents");
  return path.join(basePath, "ArcRho");
}

function ensureLocalArcRhoAssistantRoot() {
  const localRoot = getLocalArcRhoAssistantRoot();
  fs.mkdirSync(localRoot, { recursive: true });
  return localRoot;
}

function parseNetUseRemoteName(output) {
  const match = String(output || "").match(/^\s*Remote name\s+(.+?)\s*$/im);
  return match ? match[1].trim() : "";
}

function toMappedDriveUncPath(localPath, remoteName) {
  const text = String(localPath || "").trim();
  const remote = String(remoteName || "").trim();
  if (!/^[A-Za-z]:[\\/]/u.test(text) || !/^\\\\[^\\]+\\[^\\]+/u.test(remote)) return text;
  const rest = text.slice(2).replace(/^[\\/]+/u, "");
  return rest ? path.win32.join(remote, rest) : remote;
}

function normalizeComparablePath(filePath) {
  return String(filePath || "")
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/u, "")
    .toLowerCase();
}

function isPathWithinRoot(filePath, rootPath) {
  const file = normalizeComparablePath(filePath);
  const root = normalizeComparablePath(rootPath);
  if (!file || !root) return false;
  return file === root || file.startsWith(`${root}\\`);
}

async function resolveMappedDrivePath(localPath) {
  const text = String(localPath || "").trim();
  if (process.platform !== "win32" || !/^[A-Za-z]:[\\/]/u.test(text)) return text;

  const drive = text.slice(0, 2).toUpperCase();
  if (!mappedDriveRemoteCache.has(drive)) {
    const result = await runHostCommand("net", ["use", drive], {
      timeoutMs: 3000,
      shell: false,
    });
    mappedDriveRemoteCache.set(drive, result.ok ? parseNetUseRemoteName(combinedCommandOutput(result)) : "");
  }

  const remoteName = mappedDriveRemoteCache.get(drive);
  return remoteName ? toMappedDriveUncPath(text, remoteName) : text;
}

async function getArcBotReadableRootsForSandbox() {
  const roots = [];
  for (const root of readArcBotReadableRoots()) {
    roots.push(await resolveMappedDrivePath(root));
  }
  return normalizeSandboxRoots(roots);
}

async function getCodexAssistantProjectRoots(options = {}) {
  const { ensureLocalRoot = false } = options;
  const configuredRoot = getCodexAssistantProjectRoot();
  const resolvedProjectRoot = await resolveMappedDrivePath(configuredRoot);
  const configuredReadableRoots = await getArcBotReadableRootsForSandbox();
  const networkRoot = isUncPath(resolvedProjectRoot);
  const localArcRhoRoot = networkRoot
    ? (ensureLocalRoot ? ensureLocalArcRhoAssistantRoot() : getLocalArcRhoAssistantRoot())
    : "";
  return {
    projectRoot: resolvedProjectRoot,
    cliRoot: networkRoot ? localArcRhoRoot : resolvedProjectRoot,
    serverReadRoots: normalizeSandboxRoots([resolvedProjectRoot, ...configuredReadableRoots]),
    configuredReadableRoots,
    networkRoot,
  };
}

function getBundledNpmCommand() {
  if (process.platform === "win32") {
    const bundled = path.join(APP_ROOT, "node-portable", "npm.cmd");
    return fs.existsSync(bundled) ? bundled : "";
  }
  const bundled = path.join(APP_ROOT, "node-portable", "npm");
  return fs.existsSync(bundled) ? bundled : "";
}

function getNpmCommand() {
  const configured = String(process.env.ARCRHO_NPM_CMD || "").trim();
  if (configured) return configured;
  return getBundledNpmCommand() || "npm";
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

function getCodexCommand() {
  const configured = String(process.env.ARCRHO_CODEX_CMD || "").trim();
  if (configured) return configured;

  if (process.platform === "win32") {
    const candidates = [
      path.join(APP_ROOT, "node-portable", "codex.cmd"),
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "codex.cmd") : "",
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.cmd")
        : "",
      findExecutableOnPath(["codex.cmd", "codex.exe"]),
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

  return findExecutableOnPath(["codex"]) || "codex";
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
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let canceled = false;
    let proc = null;
    const unregisterCancel = () => {
      if (!cancelKey) return;
      const active = activeCodexAssistantRequests.get(cancelKey);
      if (active === cancelProcess) {
        activeCodexAssistantRequests.delete(cancelKey);
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

    if (cancelKey) {
      const active = activeCodexAssistantRequests.get(cancelKey);
      if (active && typeof active === "object") {
        active.cancelProcess = cancelProcess;
        if (active.canceled) cancelProcess();
      } else {
        activeCodexAssistantRequests.set(cancelKey, cancelProcess);
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

function getArcBotCodexEnv(env = process.env) {
  const nextEnv = { ...env };
  if (fs.existsSync(PYTHON_API_SRC)) {
    const existing = String(nextEnv.PYTHONPATH || nextEnv.PythonPath || "");
    nextEnv.PYTHONPATH = existing
      ? `${PYTHON_API_SRC}${path.delimiter}${existing}`
      : PYTHON_API_SRC;
    nextEnv.ARCRHO_PYTHON_API_SRC = PYTHON_API_SRC;
  }
  nextEnv.ARCRHO_PYTHON_API_WHEEL_DIR = PYTHON_API_WHEEL_DIR;
  const wheelPath = getPythonApiWheelPath();
  if (wheelPath) nextEnv.ARCRHO_PYTHON_API_WHEEL = wheelPath;
  return nextEnv;
}

function quoteWindowsCmdArg(value) {
  const text = String(value ?? "");
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function runWindowsCmdCommand(command, args = [], options = {}) {
  const commandLine = [command, ...args].map(quoteWindowsCmdArg).join(" ");
  return runHostCommand("cmd.exe", ["/d", "/c", "call", commandLine], {
    ...options,
    shell: false,
  });
}

function runCodexCommand(args = [], options = {}) {
  const command = getCodexCommand();
  if (!command) {
    return Promise.resolve({
      ok: false,
      code: -1,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: "Codex CLI was not found. Install Codex CLI before using ArcBot.",
    });
  }
  if (process.platform === "win32") {
    const bundledCodexCmd = path.join(APP_ROOT, "node-portable", "codex.cmd");
    if (command.toLowerCase() === bundledCodexCmd.toLowerCase()) {
      const bundledNode = path.join(APP_ROOT, "node-portable", "node.exe");
      const bundledCodexJs = path.join(APP_ROOT, "node-portable", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(bundledNode) && fs.existsSync(bundledCodexJs)) {
        return runHostCommand(bundledNode, [bundledCodexJs, ...args], {
          ...options,
          env: getArcBotCodexEnv(options.env || process.env),
          shell: false,
        });
      }
    }
    if (/\.(cmd|bat)$/iu.test(command)) {
      return runWindowsCmdCommand(command, args, {
        ...options,
        env: getArcBotCodexEnv(options.env || process.env),
      });
    }
    return runHostCommand(command, args, {
      ...options,
      env: getArcBotCodexEnv(options.env || process.env),
      shell: false,
    });
  }
  return runHostCommand(command, args, {
    ...options,
    env: getArcBotCodexEnv(options.env || process.env),
    shell: false,
  });
}

function getCodexSpawnSpec(args = []) {
  const command = getCodexCommand();
  if (!command) return null;
  const nextArgs = args.map((arg) => String(arg));
  if (process.platform === "win32") {
    const bundledCodexCmd = path.join(APP_ROOT, "node-portable", "codex.cmd");
    if (command.toLowerCase() === bundledCodexCmd.toLowerCase()) {
      const bundledNode = path.join(APP_ROOT, "node-portable", "node.exe");
      const bundledCodexJs = path.join(APP_ROOT, "node-portable", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(bundledNode) && fs.existsSync(bundledCodexJs)) {
        return { command: bundledNode, args: [bundledCodexJs, ...nextArgs], shell: false };
      }
    }
    if (/\.(cmd|bat)$/iu.test(command)) {
      const commandLine = [command, ...nextArgs].map(quoteWindowsCmdArg).join(" ");
      return { command: "cmd.exe", args: ["/d", "/c", "call", commandLine], shell: false };
    }
  }
  return { command, args: nextArgs, shell: false };
}

function getArcBotCodexThreadKey(payload, mode) {
  const sessionId = sanitizeArcBotSessionId(payload?.sessionId || "");
  const model = normalizeArcBotModel(payload?.model);
  const effort = normalizeArcBotReasoningEffort(payload?.reasoningEffort);
  return sessionId ? `${mode}:${model}:${effort}:${sessionId}` : "";
}

function normalizeSandboxRoots(paths = []) {
  const seen = new Set();
  const roots = [];
  for (const candidate of paths) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    const key = normalizeComparablePath(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    roots.push(value);
  }
  return roots;
}

function normalizeArcBotReadableRootEntries(paths = []) {
  const seen = new Set();
  const roots = [];
  for (const candidate of Array.isArray(paths) ? paths : []) {
    const raw = String(candidate || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const key = normalizeComparablePath(resolved);
    if (!key || seen.has(key)) continue;
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    roots.push(resolved);
  }
  return roots.slice(0, 30);
}

function readArcBotReadableRoots() {
  const filePath = getArcBotReadableRootsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeArcBotReadableRootEntries(parsed?.folders || parsed?.roots || []);
  } catch {
    return [];
  }
}

function writeArcBotReadableRoots(paths = []) {
  const roots = normalizeArcBotReadableRootEntries(paths);
  const filePath = getArcBotReadableRootsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    folders: roots,
  }, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  return roots;
}

function getCodexSandboxPolicy(sandboxMode, codexCwd, readableRoots = []) {
  const extraReadableRoots = normalizeSandboxRoots(readableRoots);
  if (sandboxMode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [codexCwd],
      readableRoots: extraReadableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return {
    type: "readOnly",
    readableRoots: extraReadableRoots,
    networkAccess: false,
  };
}

function extractAgentTextFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items
    .filter((item) => item?.type === "agentMessage" && String(item?.text || "").trim())
    .map((item) => String(item.text || "").trim());
  return messages.length ? messages[messages.length - 1] : "";
}

class CodexAppServerClient {
  constructor() {
    this.proc = null;
    this.started = false;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.stdoutBuffer = "";
    this.stderr = "";
    this.lastError = "";
  }

  isAlive() {
    return !!this.proc && !this.proc.killed && this.proc.exitCode == null;
  }

  async start() {
    if (this.started && this.isAlive()) return this;
    if (this.starting) return this.starting;
    this.starting = this.startFresh();
    try {
      await this.starting;
      return this;
    } finally {
      this.starting = null;
    }
  }

  async startFresh() {
    this.stop();
    const spec = getCodexSpawnSpec(["app-server", "--listen", "stdio://"]);
    if (!spec) throw new Error("Codex CLI was not found. Install Codex CLI before using ArcBot.");
    this.proc = spawn(spec.command, spec.args, {
      cwd: APP_ROOT,
      env: getArcBotCodexEnv(process.env),
      shell: spec.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.started = false;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.lastError = "";
    this.proc.stdout?.on("data", (chunk) => this.handleStdout(chunk));
    this.proc.stderr?.on("data", (chunk) => {
      const text = String(chunk || "");
      this.stderr += text;
      if (this.stderr.length > 200000) this.stderr = this.stderr.slice(-200000);
    });
    this.proc.once("error", (err) => {
      this.failAll(String(err?.message || err || "Codex app-server failed."));
      this.started = false;
    });
    this.proc.once("close", (code, signal) => {
      this.failAll(`Codex app-server exited (code=${code ?? "unknown"}, signal=${signal || "none"}).`);
      this.started = false;
      arcBotCodexThreads.clear();
    });
    await this.request("initialize", {
      clientInfo: { name: "ArcRho ArcBot", title: "ArcRho ArcBot", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
      },
    }, 15000);
    this.notify("initialized");
    this.started = true;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.started = false;
    this.stdoutBuffer = "";
    if (proc && proc.exitCode == null && !proc.killed) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    this.failAll("Codex app-server stopped.");
    arcBotCodexThreads.clear();
  }

  failAll(message) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  handleStdout(chunk) {
    this.stdoutBuffer += String(chunk || "");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleMessageLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    if (this.stdoutBuffer.length > 100000) this.stdoutBuffer = this.stdoutBuffer.slice(-100000);
  }

  handleMessageLine(line) {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr += `${line}\n`;
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      if (message.method && !this.pending.has(message.id)) {
        this.respondUnsupported(message.id, message.method);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const detail = String(message.error?.message || message.error || "Codex app-server request failed.");
        pending.reject(new Error(detail));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message?.method) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message);
        } catch {
          // One stale listener should not break the app-server stream.
        }
      }
    }
  }

  writeMessage(message) {
    if (!this.isAlive()) throw new Error("Codex app-server is not running.");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = CODEX_ASSISTANT_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  respondUnsupported(id, method) {
    try {
      this.writeMessage({
        id,
        error: {
          code: -32601,
          message: `ArcRho does not handle Codex app-server request '${method}'.`,
        },
      });
    } catch {
      // ignore
    }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async ensureThread(threadKey, mode, codexCwd, model) {
    if (threadKey && arcBotCodexThreads.has(threadKey)) {
      return arcBotCodexThreads.get(threadKey);
    }
    const result = await this.request("thread/start", {
      model: getArcBotRuntimeModel(model),
      cwd: codexCwd,
      approvalPolicy: "never",
      sandbox: mode === "edit" ? "workspace-write" : "read-only",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = String(result?.thread?.id || "");
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    if (threadKey) arcBotCodexThreads.set(threadKey, threadId);
    return threadId;
  }
}

async function ensureCodexAppServerStarted() {
  if (!CODEX_APP_SERVER_ENABLED) throw new Error("Codex app-server is disabled.");
  if (!codexAppServerClient) codexAppServerClient = new CodexAppServerClient();
  return codexAppServerClient.start();
}

async function runCodexWarmTurn({ event, requestId, requestState, payload, mode, model, reasoningEffort, codexCwd, codexSandbox, prompt, readableRoots = [] }) {
  const client = await ensureCodexAppServerStarted();
  const threadKey = getArcBotCodexThreadKey(payload, mode);
  const threadId = await client.ensureThread(threadKey, mode, codexCwd, model);
  let turnId = "";
  let agentText = "";
  let canceled = false;
  let agentStartedSent = false;
  let lastNotificationSummary = "";
  const cancelTurn = () => {
    canceled = true;
    if (turnId) {
      client.request("turn/interrupt", { threadId }, 8000).catch(() => {});
    }
    return true;
  };
  if (requestState) {
    requestState.cancelProcess = cancelTurn;
    if (requestState.canceled) cancelTurn();
  }
  const waitForCompletedTurn = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Codex app-server turn timed out."));
    }, CODEX_ASSISTANT_TIMEOUT_MS);
    const cleanup = client.onNotification((message) => {
      if (message?.method === "item/agentMessage/delta" &&
          message.params?.threadId === threadId &&
          message.params?.turnId === turnId) {
        agentText += String(message.params?.delta || "");
        if (!agentStartedSent) {
          agentStartedSent = true;
          sendArcBotActivity(event, requestId, "activity", "ArcBot is drafting a response.");
        }
      } else {
        const notificationSummary = summarizeCodexTurnNotification(message);
        const summary = typeof notificationSummary === "string"
          ? notificationSummary
          : String(notificationSummary?.text || "");
        if (summary && summary !== lastNotificationSummary) {
          lastNotificationSummary = summary;
          const extra = notificationSummary && typeof notificationSummary === "object"
            ? { debugText: notificationSummary.debugText || "" }
            : {};
          sendArcBotActivity(event, requestId, "activity", summary, extra);
        }
      }
      if (message?.method === "turn/completed" &&
          message.params?.threadId === threadId &&
          message.params?.turn?.id === turnId) {
        clearTimeout(timer);
        cleanup();
        resolve(message.params?.turn || null);
      }
      if (message?.method === "error") {
        const detail = String(message.params?.message || message.params?.error || "Codex app-server turn failed.");
        clearTimeout(timer);
        cleanup();
        reject(new Error(detail));
      }
    });
  });
  const started = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    cwd: codexCwd,
    model: getArcBotRuntimeModel(model),
    effort: normalizeArcBotReasoningEffort(reasoningEffort),
    approvalPolicy: "never",
    sandboxPolicy: getCodexSandboxPolicy(codexSandbox, codexCwd, readableRoots),
  });
  turnId = String(started?.turn?.id || "");
  sendArcBotActivity(event, requestId, "activity", "Codex warm session accepted the request.");
  if (canceled || requestState?.canceled) {
    cancelTurn();
    return { ok: false, canceled: true, stdout: "", stderr: "", error: "Request canceled." };
  }
  const turn = started?.turn?.status === "completed" ? started.turn : await waitForCompletedTurn();
  if (canceled || requestState?.canceled) {
    return { ok: false, canceled: true, stdout: "", stderr: "", error: "Request canceled." };
  }
  const turnText = extractAgentTextFromTurn(turn);
  return {
    ok: true,
    code: 0,
    signal: null,
    stdout: String(turnText || agentText || "").trim(),
    stderr: "",
    timedOut: false,
    canceled: false,
  };
}

function combinedCommandOutput(result) {
  return `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
}

function normalizeHostError(result, fallback) {
  if (result?.canceled) return "Request canceled.";
  if (result?.timedOut) return "The command timed out.";
  return combinedCommandOutput(result) || result?.error || fallback;
}

function isAuthFailure(result) {
  const raw = combinedCommandOutput(result).toLowerCase();
  return /not\s+logged\s+in|not\s+authenticated|authentication|required|sign\s*in|login/.test(raw);
}

function getArcBotLatestEditPath() {
  return path.join(app.getPath("userData"), "arcbot_latest_edit.json");
}

function getArcBotSessionRoot() {
  return path.join(ensureLocalArcRhoAssistantRoot(), "ArcBot", "sessions");
}

function getArcBotWorkspaceRoot() {
  return path.join(ensureLocalArcRhoAssistantRoot(), "ArcBot", "workspace");
}

function getArcBotRequestLogsDir() {
  return path.join(ensureLocalArcRhoAssistantRoot(), "ArcBot", "request_logs");
}

function sanitizeLogFilePart(value, fallback = "request") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function truncateLogValue(value, maxLength = 4000) {
  const text = typeof value === "string" ? value : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value ?? "");
    }
  })();
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]` : text;
}

function safeLogDetails(details = {}) {
  if (!details || typeof details !== "object") return {};
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "string") {
      safe[key] = truncateLogValue(value);
    } else {
      safe[key] = truncateLogValue(value, 8000);
    }
  }
  return safe;
}

function createArcBotRequestLogger({ requestId, payload, mode, model, reasoningEffort }) {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const sessionId = sanitizeArcBotSessionId(payload?.sessionId || "");
  const logDir = getArcBotRequestLogsDir();
  fs.mkdirSync(logDir, { recursive: true });
  const fileName = `${startedAtIso.replace(/[:.]/g, "-")}_${sanitizeLogFilePart(requestId || sessionId)}.json`;
  const filePath = path.join(logDir, fileName);
  let lastMs = startedAtMs;
  let finalized = false;
  const activePhases = new Map();
  const log = {
    requestId,
    sessionId,
    mode,
    model,
    reasoningEffort,
    startedAt: startedAtIso,
    endedAt: "",
    totalMs: 0,
    status: "running",
    filePath,
    events: [],
    phases: [],
  };
  const nowRelative = () => {
    const nowMs = Date.now();
    const elapsedMs = nowMs - startedAtMs;
    const deltaMs = nowMs - lastMs;
    lastMs = nowMs;
    return { nowMs, elapsedMs, deltaMs };
  };
  let lastFlushMs = 0;
  const flush = () => {
    try {
      fs.writeFileSync(filePath, JSON.stringify(log, null, 2) + "\n", "utf8");
    } catch {
      // Diagnostics logging must not break ArcBot requests.
    }
  };
  const flushSoon = (nowMs, force = false) => {
    if (!force && nowMs - lastFlushMs < 1000) return;
    lastFlushMs = nowMs;
    flush();
  };
  const mark = (name, details = {}) => {
    if (finalized) return;
    const timing = nowRelative();
    log.events.push({
      type: "mark",
      name,
      elapsedMs: timing.elapsedMs,
      deltaMs: timing.deltaMs,
      timestamp: new Date(timing.nowMs).toISOString(),
      details: safeLogDetails(details),
    });
    flushSoon(timing.nowMs);
  };
  const start = (name, details = {}) => {
    if (finalized) return;
    const timing = nowRelative();
    activePhases.set(name, { startMs: timing.elapsedMs, details: safeLogDetails(details) });
    log.events.push({
      type: "phase-start",
      name,
      elapsedMs: timing.elapsedMs,
      deltaMs: timing.deltaMs,
      timestamp: new Date(timing.nowMs).toISOString(),
      details: safeLogDetails(details),
    });
    flushSoon(timing.nowMs, true);
  };
  const end = (name, details = {}) => {
    if (finalized) return;
    const timing = nowRelative();
    const phase = activePhases.get(name);
    activePhases.delete(name);
    const startMs = Number.isFinite(phase?.startMs) ? phase.startMs : timing.elapsedMs;
    const mergedDetails = { ...(phase?.details || {}), ...safeLogDetails(details) };
    log.phases.push({
      name,
      startMs,
      endMs: timing.elapsedMs,
      durationMs: Math.max(0, timing.elapsedMs - startMs),
      details: mergedDetails,
    });
    log.events.push({
      type: "phase-end",
      name,
      elapsedMs: timing.elapsedMs,
      deltaMs: timing.deltaMs,
      timestamp: new Date(timing.nowMs).toISOString(),
      details: mergedDetails,
    });
    flushSoon(timing.nowMs, true);
  };
  const activity = (type, text, extra = {}) => {
    if (finalized) return;
    const timing = nowRelative();
    log.events.push({
      type: "activity",
      activityType: String(type || "activity"),
      elapsedMs: timing.elapsedMs,
      deltaMs: timing.deltaMs,
      timestamp: new Date(timing.nowMs).toISOString(),
      text: truncateLogValue(text || "", 3000),
      details: safeLogDetails(extra),
    });
    flushSoon(timing.nowMs);
  };
  const finish = (status = "completed", details = {}) => {
    if (finalized) return filePath;
    for (const phaseName of Array.from(activePhases.keys())) {
      end(phaseName, { autoClosed: true });
    }
    const timing = nowRelative();
    log.status = status;
    log.endedAt = new Date(timing.nowMs).toISOString();
    log.totalMs = timing.elapsedMs;
    log.events.push({
      type: "finish",
      name: status,
      elapsedMs: timing.elapsedMs,
      deltaMs: timing.deltaMs,
      timestamp: new Date(timing.nowMs).toISOString(),
      details: safeLogDetails(details),
    });
    finalized = true;
    flushSoon(timing.nowMs, true);
    return filePath;
  };
  return { filePath, mark, start, end, activity, finish };
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
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
      const vals = row.map((v) => JSON.stringify(v)).join(", ");
      return `${indent}[${vals}]`;
    })
    .join(",\n");
}

function formatJsonForArcBot(data) {
  return formatJsonForSave(data);
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Continue with fenced/object extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue with first object extraction.
    }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function extractJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // Continue with fenced/object extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const candidate = fenced[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Continue with first object extraction.
    }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = raw.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return "";
    }
  }
  return "";
}

function getAssistantTargetJsonPath(activeContext) {
  const page = activeContext && typeof activeContext === "object" ? activeContext : {};
  const candidates = [
    page.methodPath,
    page.filePath,
    page.targetPath,
    page?.dfm?.methodPath,
  ];
  return String(candidates.find((candidate) => String(candidate || "").trim()) || "").trim();
}

async function getArcBotEditRoots() {
  const configuredRoot = getConfiguredWorkspaceRoot();
  if (!configuredRoot) {
    return {
      configuredRoot: "",
      resolvedRoot: "",
    };
  }
  const resolvedRoot = await resolveMappedDrivePath(configuredRoot);
  return {
    configuredRoot,
    resolvedRoot,
  };
}

async function validateArcBotJsonTarget(targetPath, options = {}) {
  const cleanPath = String(targetPath || "").trim();
  if (!cleanPath) return { ok: false, error: "ArcBot has no active JSON-backed file to edit." };
  const extension = path.extname(cleanPath).toLowerCase();
  const isNotebook = extension === ".ipynb" || extension === ".arcnb";
  if (![".json", ".ipynb", ".arcnb"].includes(extension)) {
    return { ok: false, error: "ArcBot can only edit JSON, IPYNB, and ARC notebook files in this MVP." };
  }
  const roots = await getArcBotEditRoots();
  const allowed = [roots.configuredRoot, roots.resolvedRoot].filter(Boolean);
  if (allowed.length === 0) {
    return {
      ok: false,
      error: "ArcBot needs a configured Server Connection Root Path before it can edit files.",
    };
  }
  if (!allowed.some((root) => isPathWithinRoot(cleanPath, root))) {
    if (isNotebook && options.allowActiveNotebook === true) {
      return {
        ok: true,
        targetPath: cleanPath,
        roots: {
          configuredRoot: "active-page-context",
          resolvedRoot: "",
        },
      };
    }
    return {
      ok: false,
      error: "ArcBot refused to edit a file outside the configured Server Connection root.",
    };
  }
  return { ok: true, targetPath: cleanPath, roots };
}

function getArcBotHistoryDir(targetPath) {
  return path.join(path.dirname(targetPath), "history");
}

function writeArcBotLatestEdit(manifest) {
  const latestPath = getArcBotLatestEditPath();
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.writeFileSync(latestPath, formatJsonForArcBot(manifest), "utf8");
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getJsonValueAtPath(root, keyPath = []) {
  let cursor = root;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setJsonValueAtPath(root, keyPath = [], value) {
  let cursor = root;
  for (let index = 0; index < keyPath.length - 1; index += 1) {
    const key = keyPath[index];
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keyPath[keyPath.length - 1]] = value;
}

function getKnownDfmCsvPathFields() {
  return [
    ["data tab", "input data triangle csv path"],
    ["results tab", "ultimate vector csv path"],
  ];
}

function findRootForPath(filePath, roots = []) {
  return roots.find((root) => root && isPathWithinRoot(filePath, root)) || "";
}

function relativePathForPrompt(fromDir, targetPath) {
  const relative = path.relative(fromDir, targetPath) || path.basename(targetPath);
  return relative.startsWith("..") ? targetPath : relative;
}

function copyFileIfPossible(sourcePath, destPath, role, manifestFiles) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return false;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
    manifestFiles.push({
      role,
      serverPath: sourcePath,
      localPath: destPath,
      writable: role === "dfm",
      beforeSha256: sha256Text(fs.readFileSync(destPath, "utf8")),
    });
    return true;
  } catch {
    return false;
  }
}

function stageArcBotLinkedCsv({
  activeJson,
  keyPath,
  targetPath,
  localTargetPath,
  exchangeRoot,
  allowedRoots,
  manifestFiles,
  csvRewrites,
}) {
  const rawValue = getJsonValueAtPath(activeJson, keyPath);
  const text = String(rawValue || "").trim();
  if (!text || !/\.csv$/iu.test(text)) return;
  const sourcePath = path.isAbsolute(text) ? text : path.resolve(path.dirname(targetPath), text);
  const root = findRootForPath(sourcePath, allowedRoots);
  const localCsvPath = root
    ? path.join(exchangeRoot, path.relative(root, sourcePath))
    : path.join(path.dirname(localTargetPath), path.basename(sourcePath));
  if (!copyFileIfPossible(sourcePath, localCsvPath, "linked-csv", manifestFiles)) return;
  const localReference = relativePathForPrompt(path.dirname(localTargetPath), localCsvPath);
  setJsonValueAtPath(activeJson, keyPath, localReference);
  csvRewrites.push({
    keyPath,
    originalValue: text,
    exchangeValue: localReference,
    serverPath: sourcePath,
    localPath: localCsvPath,
  });
}

function stageArcBotReservingClassCsvs({ targetPath, localTargetPath, manifestFiles }) {
  const sourceDir = path.dirname(targetPath);
  const localDir = path.dirname(localTargetPath);
  let copied = 0;
  try {
    for (const item of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!item.isFile() || path.extname(item.name).toLowerCase() !== ".csv") continue;
      const sourcePath = path.join(sourceDir, item.name);
      const destPath = path.join(localDir, item.name);
      if (copyFileIfPossible(sourcePath, destPath, "reserving-class-csv", manifestFiles)) copied += 1;
    }
  } catch {
    // The active DFM JSON can still be edited even when linked CSV staging fails.
  }
  return copied;
}

function restoreExchangeJsonForApply(editSession, editedJson) {
  if (!editSession?.csvRewrites?.length || !editedJson || typeof editedJson !== "object" || Array.isArray(editedJson)) {
    return editedJson;
  }
  const restored = cloneJsonValue(editedJson);
  for (const rewrite of editSession.csvRewrites) {
    const current = String(getJsonValueAtPath(restored, rewrite.keyPath) || "").trim();
    if (current === String(rewrite.exchangeValue || "").trim()) {
      setJsonValueAtPath(restored, rewrite.keyPath, rewrite.originalValue);
    }
  }
  return restored;
}

function createArcBotEditSession({ targetPath, activeJson, roots = null }) {
  if (activeJson == null || typeof activeJson !== "object" || Array.isArray(activeJson)) {
    return null;
  }
  const sessionsRoot = getArcBotSessionRoot();
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const sessionDir = fs.mkdtempSync(path.join(sessionsRoot, "session-"));
  const sharedWorkspaceRoot = getArcBotWorkspaceRoot();
  const allowedRoots = [roots?.resolvedRoot, roots?.configuredRoot].filter(Boolean);
  const matchedRoot = findRootForPath(targetPath, allowedRoots);
  const exchangeRoot = sharedWorkspaceRoot;
  const relativeTarget = matchedRoot ? path.relative(matchedRoot, targetPath) : "";
  const jsonPath = matchedRoot
    ? path.join(exchangeRoot, relativeTarget)
    : path.join(exchangeRoot, "_active", path.basename(targetPath) || "active-method.json");
  const metaPath = path.join(sessionDir, "session.json");
  const exchangeJson = cloneJsonValue(activeJson);
  const manifestFiles = [];
  const csvRewrites = [];
  if (matchedRoot) {
    stageArcBotReservingClassCsvs({ targetPath, localTargetPath: jsonPath, manifestFiles });
    for (const keyPath of getKnownDfmCsvPathFields()) {
      stageArcBotLinkedCsv({
        activeJson: exchangeJson,
        keyPath,
        targetPath,
        localTargetPath: jsonPath,
        exchangeRoot,
        allowedRoots,
        manifestFiles,
        csvRewrites,
      });
    }
  }
  const beforeText = formatJsonForArcBot(exchangeJson);
  manifestFiles.unshift({
    role: "dfm",
    serverPath: String(targetPath || ""),
    localPath: jsonPath,
    writable: true,
    beforeSha256: sha256Text(beforeText),
  });
  const session = {
    sessionDir,
    exchangeRoot,
    jsonPath,
    metaPath,
    codexCwd: exchangeRoot || sessionDir,
    editablePathForPrompt: relativePathForPrompt(exchangeRoot || sessionDir, jsonPath),
    targetPath: String(targetPath || ""),
    beforeSha256: sha256Text(beforeText),
    csvRewrites,
    manifestFiles,
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, beforeText, "utf8");
  fs.writeFileSync(metaPath, formatJsonForArcBot({
    type: "arcbot-edit-session",
    createdAt: new Date().toISOString(),
    targetPath: session.targetPath,
    editableFile: jsonPath,
    exchangeRoot,
    editablePathForPrompt: session.editablePathForPrompt,
    files: manifestFiles,
    csvRewrites,
  }), "utf8");
  return session;
}

async function applyArcBotJsonEdit({ targetPath, replacementJson, requestText, reply, originalJson }) {
  const hasOriginalFallback = originalJson != null && typeof originalJson === "object" && !Array.isArray(originalJson);
  const validation = await validateArcBotJsonTarget(targetPath, { allowActiveNotebook: hasOriginalFallback });
  if (!validation.ok) return validation;
  if (replacementJson == null || typeof replacementJson !== "object" || Array.isArray(replacementJson)) {
    return { ok: false, error: "ArcBot did not provide a valid JSON object replacement." };
  }
  let targetExists = false;
  try {
    const stat = fs.statSync(validation.targetPath);
    targetExists = stat.isFile();
  } catch {
    targetExists = false;
  }
  if (!targetExists && !hasOriginalFallback) {
    return { ok: false, error: `Target JSON-backed file was not found: ${validation.targetPath}` };
  }
  let beforeText = "";
  let backupSource = "file";
  try {
    beforeText = fs.readFileSync(validation.targetPath, "utf8");
    JSON.parse(beforeText);
  } catch (err) {
    if (!hasOriginalFallback) {
      const message = String(err?.message || err || "Target file could not be read.");
      return { ok: false, error: `Target file could not be backed up, so ArcBot did not modify it. ${message}` };
    }
    beforeText = formatJsonForArcBot(originalJson);
    backupSource = "active-page-context";
  }

  const nextText = formatJsonForArcBot(replacementJson);
  const historyDir = getArcBotHistoryDir(validation.targetPath);
  fs.mkdirSync(historyDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(validation.targetPath, path.extname(validation.targetPath));
  const backupPath = path.join(historyDir, `${baseName}.${stamp}.bak.json`);
  const manifestPath = path.join(historyDir, `${baseName}.${stamp}.arcbot.json`);
  const tmpPath = `${validation.targetPath}.arcbot.tmp`;

  if (backupSource === "file") {
    fs.copyFileSync(validation.targetPath, backupPath);
  } else {
    fs.writeFileSync(backupPath, beforeText, "utf8");
  }
  fs.writeFileSync(tmpPath, nextText, "utf8");
  fs.renameSync(tmpPath, validation.targetPath);

  const manifest = {
    type: "arcbot-json-edit",
    timestamp: new Date().toISOString(),
    targetPath: validation.targetPath,
    backupPath,
    manifestPath,
    requestText: String(requestText || ""),
    reply: String(reply || ""),
    beforeSha256: sha256Text(beforeText),
    afterSha256: sha256Text(nextText),
    backupSource,
    allowedRoot: validation.roots.configuredRoot,
    resolvedAllowedRoot: validation.roots.resolvedRoot,
  };
  fs.writeFileSync(manifestPath, formatJsonForArcBot(manifest), "utf8");
  writeArcBotLatestEdit(manifest);
  return {
    ok: true,
    targetPath: validation.targetPath,
    backupPath,
    manifestPath,
    reply: manifest.reply || "Updated the active JSON-backed file.",
  };
}

async function revertLatestArcBotEdit() {
  const latestPath = getArcBotLatestEditPath();
  if (!fs.existsSync(latestPath)) {
    return { ok: false, error: "No ArcBot edit history is available to revert." };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    return { ok: false, error: "ArcBot latest edit manifest is invalid." };
  }
  const validation = await validateArcBotJsonTarget(manifest?.targetPath, { allowActiveNotebook: true });
  if (!validation.ok) return validation;
  const backupPath = String(manifest?.backupPath || "").trim();
  if (!backupPath || !fs.existsSync(backupPath)) {
    return { ok: false, error: "ArcBot backup file is missing, so the latest edit cannot be reverted." };
  }
  if (fs.existsSync(validation.targetPath)) {
    const currentText = fs.readFileSync(validation.targetPath, "utf8");
    if (manifest.afterSha256 && sha256Text(currentText) !== manifest.afterSha256) {
      return {
        ok: false,
        error: "ArcBot refused to revert because the target file changed after the latest ArcBot edit.",
      };
    }
  }
  fs.copyFileSync(backupPath, validation.targetPath);
  try {
    fs.unlinkSync(latestPath);
  } catch {
    // ignore stale latest-manifest cleanup errors
  }
  return {
    ok: true,
    targetPath: validation.targetPath,
    backupPath,
    reply: `Reverted the latest ArcBot edit for ${validation.targetPath}.`,
  };
}

function isRevertLatestRequest(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  const text = String(last?.content || "").toLowerCase();
  return /\b(revert|undo|restore)\b/.test(text) && /\b(latest|last|previous|arcbot)\b/.test(text);
}

function getCodexInstallScriptPath() {
  return path.join(app.getPath("userData"), "install_codex_cli.ps1");
}

function writeCodexInstallScript() {
  const scriptPath = getCodexInstallScriptPath();
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  const script = [
    "param([string]$NpmCommand = 'npm')",
    "$ErrorActionPreference = 'Stop'",
    "Write-Output 'ArcRho is installing Codex CLI with: npm install -g @openai/codex'",
    "$resolvedNpm = $null",
    "if (Test-Path -LiteralPath $NpmCommand) {",
    "  $resolvedNpm = Resolve-Path -LiteralPath $NpmCommand",
    "} else {",
    "  $resolvedNpm = Get-Command $NpmCommand -ErrorAction SilentlyContinue",
    "  if (-not $resolvedNpm) { throw 'npm was not found. Install Node.js/npm, then try again.' }",
    "}",
    "$npmPath = if ($resolvedNpm.Path) { $resolvedNpm.Path } else { [string]$resolvedNpm }",
    "$npmDir = Split-Path -Parent $npmPath",
    "if ($npmDir) { $env:Path = \"$npmDir;$env:Path\" }",
    "& $NpmCommand install -g @openai/codex",
    "Write-Output 'Codex CLI install completed.'",
    "$codexCmd = Join-Path $npmDir 'codex.cmd'",
    "if (Test-Path -LiteralPath $codexCmd) { & $codexCmd --version } else { & codex --version }",
    "",
  ].join("\r\n");
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

function readBundledArcBotPromptTemplate() {
  try {
    return fs.readFileSync(ARCBOT_PROMPT_TEMPLATE_PATH, "utf8");
  } catch (err) {
    throw new Error(`ArcBot prompt template could not be read: ${ARCBOT_PROMPT_TEMPLATE_PATH}: ${err?.message || err}`);
  }
}

function getArcBotServerPromptTemplatePath() {
  const configuredRoot = getConfiguredWorkspaceRoot();
  return configuredRoot ? path.join(configuredRoot, ARCBOT_SERVER_PROMPT_RELATIVE_PATH) : "";
}

function getArcBotLegacyServerPromptTemplatePath() {
  const configuredRoot = getConfiguredWorkspaceRoot();
  return configuredRoot ? path.join(configuredRoot, ARCBOT_LEGACY_SERVER_PROMPT_RELATIVE_PATH) : "";
}

function getArcBotServerInstructionsDir() {
  const configuredRoot = getConfiguredWorkspaceRoot();
  return configuredRoot ? path.join(configuredRoot, ARCBOT_SERVER_INSTRUCTIONS_RELATIVE_DIR) : "";
}

function seedArcBotServerPromptFiles(serverPromptPath, bundledTemplate) {
  if (!serverPromptPath) return;
  fs.mkdirSync(path.dirname(serverPromptPath), { recursive: true });
  if (!fs.existsSync(serverPromptPath)) {
    const legacyPromptPath = getArcBotLegacyServerPromptTemplatePath();
    const seedText = legacyPromptPath && fs.existsSync(legacyPromptPath)
      ? fs.readFileSync(legacyPromptPath, "utf8")
      : bundledTemplate;
    fs.writeFileSync(serverPromptPath, seedText, "utf8");
  }
  const instructionsDir = getArcBotServerInstructionsDir();
  if (!instructionsDir) return;
  fs.mkdirSync(instructionsDir, { recursive: true });
  for (const [fileName, placeholderText] of ARCBOT_SERVER_INSTRUCTION_PLACEHOLDERS) {
    const filePath = path.join(instructionsDir, fileName);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, placeholderText, "utf8");
  }
}

function readArcBotSharedInstructions() {
  const instructionsDir = getArcBotServerInstructionsDir();
  if (!instructionsDir || !fs.existsSync(instructionsDir)) return "No shared instruction files were found.";
  const parts = [];
  const maxFileChars = 30000;
  const maxTotalChars = 80000;
  for (const item of fs.readdirSync(instructionsDir, { withFileTypes: true })) {
    if (!item.isFile() || path.extname(item.name).toLowerCase() !== ".md") continue;
    if (item.name.startsWith(".") || item.name.startsWith("_")) continue;
    const filePath = path.join(instructionsDir, item.name);
    let text = fs.readFileSync(filePath, "utf8").trim();
    if (!text) continue;
    if (text.length > maxFileChars) {
      text = `${text.slice(0, maxFileChars)}\n\n[Instruction file truncated at ${maxFileChars} characters.]`;
    }
    parts.push(`## ${item.name}\n\n${text}`);
  }
  if (!parts.length) return "No shared instruction files contain content yet.";
  const combined = parts.join("\n\n---\n\n");
  return combined.length > maxTotalChars
    ? `${combined.slice(0, maxTotalChars)}\n\n[Shared instruction files truncated at ${maxTotalChars} characters.]`
    : combined;
}

function ensureArcBotSharedInstructionsPlaceholder(template) {
  const text = String(template || "");
  if (text.includes("{{SHARED_INSTRUCTIONS}}")) return text;
  if (text.includes("{{MODE_INSTRUCTIONS}}")) {
    return text.replace(
      "{{MODE_INSTRUCTIONS}}",
      "{{MODE_INSTRUCTIONS}}\n\nShared team instructions:\n{{SHARED_INSTRUCTIONS}}"
    );
  }
  return `${text}\n\nShared team instructions:\n{{SHARED_INSTRUCTIONS}}\n`;
}

function readArcBotPromptComponentsForGuide() {
  const bundledTemplate = readBundledArcBotPromptTemplate();
  const serverPromptPath = getArcBotServerPromptTemplatePath();
  if (serverPromptPath) seedArcBotServerPromptFiles(serverPromptPath, bundledTemplate);
  const promptPath = serverPromptPath || ARCBOT_PROMPT_TEMPLATE_PATH;
  const components = [{
    id: "entry",
    title: "Entry Prompt",
    path: promptPath,
    text: ensureArcBotSharedInstructionsPlaceholder(
      serverPromptPath && fs.existsSync(serverPromptPath)
        ? fs.readFileSync(serverPromptPath, "utf8")
        : bundledTemplate
    ),
  }];
  const instructionsDir = getArcBotServerInstructionsDir();
  const included = new Set();
  for (const [fileName, placeholderText] of ARCBOT_SERVER_INSTRUCTION_PLACEHOLDERS) {
    const filePath = instructionsDir ? path.join(instructionsDir, fileName) : fileName;
    included.add(fileName.toLowerCase());
    components.push({
      id: fileName.replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/g, ""),
      title: fileName,
      path: filePath,
      text: instructionsDir && fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : placeholderText,
    });
  }
  if (instructionsDir && fs.existsSync(instructionsDir)) {
    const extraFiles = fs.readdirSync(instructionsDir, { withFileTypes: true })
      .filter((item) => item.isFile() && path.extname(item.name).toLowerCase() === ".md")
      .map((item) => item.name)
      .filter((fileName) => !included.has(fileName.toLowerCase()) && !fileName.startsWith(".") && !fileName.startsWith("_"))
      .sort((a, b) => a.localeCompare(b));
    for (const fileName of extraFiles) {
      const filePath = path.join(instructionsDir, fileName);
      components.push({
        id: fileName.replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/g, ""),
        title: fileName,
        path: filePath,
        text: fs.readFileSync(filePath, "utf8"),
      });
    }
  }
  return components;
}

function readArcBotPromptTemplate() {
  const bundledTemplate = readBundledArcBotPromptTemplate();
  const serverPromptPath = getArcBotServerPromptTemplatePath();
  if (!serverPromptPath) return ensureArcBotSharedInstructionsPlaceholder(bundledTemplate);
  try {
    seedArcBotServerPromptFiles(serverPromptPath, bundledTemplate);
    return ensureArcBotSharedInstructionsPlaceholder(fs.readFileSync(serverPromptPath, "utf8"));
  } catch (err) {
    throw new Error(`ArcBot server prompt template could not be read: ${serverPromptPath}: ${err?.message || err}`);
  }
}

function extractArcBotPromptSection(template, sectionName) {
  const name = String(sectionName || "").trim().toUpperCase();
  const pattern = new RegExp(`<!--\\s*ARCBOT:${name}\\s*-->([\\s\\S]*?)<!--\\s*ARCBOT:END_${name}\\s*-->`, "u");
  const match = String(template || "").match(pattern);
  if (!match) throw new Error(`ArcBot prompt template is missing section ${name}.`);
  return match[1].trim();
}

function renderArcBotPromptTemplate(template, values) {
  return String(template || "").replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key) => {
    const value = values?.[key];
    return value == null ? "" : String(value);
  });
}

function buildAssistantPrompt(
  messages,
  mode = "edit",
  projectRoot = "",
  cliRoot = "",
  networkRoot = false,
  activeContext = null,
  activeJson = null,
  editSession = null,
  attachments = []
) {
  const safeMessages = Array.isArray(messages) ? messages.slice(-12) : [];
  const safeAttachments = Array.isArray(attachments)
    ? attachments.slice(0, 5).map((item) => ({
        name: String(item?.name || path.basename(String(item?.path || "")) || "attachment"),
        path: String(item?.path || ""),
        size: Number.isFinite(item?.size) ? Math.max(0, Math.round(item.size)) : 0,
        text: String(item?.text || "").slice(0, 60000),
      })).filter((item) => item.text.trim())
    : [];
  const transcript = safeMessages
    .map((message) => {
      const role = String(message?.role || "").toLowerCase() === "assistant" ? "Assistant" : "User";
      const text = String(message?.content || "").trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const contextForPrompt = activeContext && typeof activeContext === "object"
    ? { ...activeContext }
    : { available: false };
  delete contextForPrompt.activeJson;
  const attachmentText = safeAttachments.length
    ? safeAttachments.map((item, index) => [
        `Attachment ${index + 1}: ${item.name}`,
        item.path ? `Path: ${item.path}` : "",
        item.size ? `Size: ${item.size} bytes` : "",
        "Content:",
        item.text,
      ].filter(Boolean).join("\n")).join("\n\n---\n\n")
    : "No additional files were attached.";
  const template = readArcBotPromptTemplate();
  const baseSection = extractArcBotPromptSection(template, "BASE");
  const modeSection = extractArcBotPromptSection(template, mode === "edit" ? "EDIT_MODE" : "REVIEW_MODE");
  const activeJsonName = editSession?.editablePathForPrompt || (editSession?.jsonPath ? path.basename(editSession.jsonPath) : "active-method.json");
  const exchangeRoot = editSession?.exchangeRoot || "";
  const pythonApiWheelPath = getPythonApiWheelPath();
  return renderArcBotPromptTemplate(baseSection, {
    MODE_LABEL: mode === "edit" ? "Edit Mode" : "Review Mode",
    PROJECT_ROOT: projectRoot || APP_ROOT,
    CLI_ROOT: cliRoot || projectRoot || APP_ROOT,
    NETWORK_ROOT_NOTE: networkRoot
      ? "The project folder is a network path, so the CLI process starts from the local Documents\\ArcRho folder to avoid Windows/Codex startup failures with UNC working directories."
      : "",
    MODE_INSTRUCTIONS: renderArcBotPromptTemplate(modeSection, {
      EDITABLE_JSON_BASENAME: activeJsonName,
      EXCHANGE_SERVER_ROOT: exchangeRoot || "No local exchange workspace is available.",
      EDITABLE_JSON_NOTE: editSession?.jsonPath
        ? `Editable active JSON-backed copy: ${activeJsonName}.${exchangeRoot ? ` Local ArcRho exchange server root: ${exchangeRoot}.` : ""}`
        : "No editable active JSON-backed copy is available for this request.",
    }),
    PYTHON_API_SRC,
    PYTHON_API_WHEEL_DIR,
    PYTHON_API_WHEEL_PATH: pythonApiWheelPath || "No bundled arcrho-api wheel was found.",
    PYTHON_API_INSTALL_COMMAND: pythonApiWheelPath ? `${PYTHON_EXE} -m pip install ${quoteWindowsCmdArg(pythonApiWheelPath)}` : "",
    PYTHON_API_COMMAND: `${PYTHON_EXE} -m arcrho_api.agent --file ${quoteWindowsCmdArg(activeJsonName)}`,
    ACTIVE_CONTEXT_JSON: JSON.stringify(contextForPrompt, null, 2),
    ACTIVE_JSON_DATA: editSession?.jsonPath
      ? `The active JSON-backed file is available as ${activeJsonName} in the current working folder. Use the ArcRho Python API helper for DFM reads and edits before falling back to raw JSON inspection. When using the public ArcRho Python API directly, use ArcRhoClient(${JSON.stringify(exchangeRoot || ".")}) so API reads and writes stay inside the local exchange workspace.`
      : (activeJson ? JSON.stringify(activeJson, null, 2) : "No active JSON-backed data was loaded."),
    SHARED_INSTRUCTIONS: readArcBotSharedInstructions(),
    ATTACHMENT_TEXT: attachmentText,
    TRANSCRIPT: transcript || "User: Hello",
  });
}

function clampCodexPrompt(prompt) {
  const text = String(prompt || "");
  const maxChars = 200000;
  if (text.length <= maxChars) return text;
  return [
    text.slice(0, 150000),
    "",
    "[Prompt was truncated to keep the Codex CLI request bounded.]",
    "",
    text.slice(-45000),
  ].join("\n");
}

function estimateArcBotContextUsage(prompt, messages, activeContext, activeJson, clampedPrompt, attachments = []) {
  const promptText = String(prompt || "");
  const clampedText = String(clampedPrompt || promptText);
  const estimatedTokens = Math.ceil(clampedText.length / 4);
  const contextPercentUsed = Math.min(100, Math.max(0, (estimatedTokens / CODEX_ASSISTANT_CONTEXT_WINDOW_TOKENS) * 100));
  const activeJsonText = activeJson ? JSON.stringify(activeJson) : "";
  const contextText = activeContext ? JSON.stringify(activeContext) : "";
  const attachmentText = Array.isArray(attachments)
    ? attachments.map((item) => String(item?.text || "")).join("\n")
    : "";
  const chatText = Array.isArray(messages)
    ? messages.map((message) => String(message?.content || "")).join("\n")
    : "";
  return {
    promptChars: clampedText.length,
    estimatedTokens,
    contextWindowTokens: CODEX_ASSISTANT_CONTEXT_WINDOW_TOKENS,
    contextPercentUsed,
    maxPromptChars: 200000,
    maxPromptTokens: Math.ceil(200000 / 4),
    truncated: clampedText.length < promptText.length,
    includedMessages: Array.isArray(messages) ? Math.min(messages.length, 12) : 0,
    chatChars: chatText.length,
    activeContextChars: contextText.length,
    activeJsonChars: activeJsonText.length,
    attachmentChars: attachmentText.length,
    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
  };
}

function sendArcBotActivity(event, requestId, type, text, extra = {}) {
  const logger = arcBotRequestLoggers.get(String(requestId || ""));
  if (logger) logger.activity(type, text, extra);
  if (!event?.sender || !requestId) return;
  try {
    event.sender.send("codex-assistant-event", {
      requestId,
      type,
      text: String(text || ""),
      timestamp: new Date().toISOString(),
      ...extra,
    });
  } catch {
    // ignore stale renderer activity updates
  }
}

function describeArcRhoApiAgentAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  const labels = {
    inspect: "ArcBot is bundling the active DFM method details in one helper read.",
    summary: "ArcBot is reading the active DFM method summary.",
    component: "ArcBot is inspecting a DFM method component.",
    "ratio-row": "ArcBot is reading ratio-row details from the DFM method.",
    "exclude-ratio": "ArcBot is marking selected ratio cells as excluded.",
    "include-ratio": "ArcBot is restoring selected ratio cells.",
    "select-average": "ArcBot is updating the selected average formula.",
    "set-user-entry": "ArcBot is setting a user-entered selected factor.",
    validate: "ArcBot is checking that the proposed DFM update is valid.",
  };
  return labels[normalized] || "ArcBot is using the ArcRho Python helper for the active DFM method.";
}

function summarizeCodexTurnNotification(message) {
  const method = String(message?.method || "").toLowerCase();
  if (!method || method === "item/agentmessage/delta" || method === "turn/completed") return "";
  const paramsText = (() => {
    try {
      return JSON.stringify(message?.params || {});
    } catch {
      return "";
    }
  })();
  const apiMatch = paramsText.match(/arcrho_api\.agent[^"'`]*?\s(inspect|summary|component|ratio-row|exclude-ratio|include-ratio|select-average|set-user-entry|validate)\b/iu);
  if (apiMatch) {
    return {
      text: describeArcRhoApiAgentAction(apiMatch[1]),
      debugText: `ArcRho Python API helper call notification: ${message?.method || ""} ${paramsText}`.trim(),
    };
  }
  if (method.includes("command") || method.includes("exec") || method.includes("shell")) return "ArcBot is running a local check.";
  if (method.includes("web") || method.includes("search")) return "ArcBot is searching for supporting context.";
  if (method.includes("tool")) return "ArcBot is using a tool.";
  if (method.includes("patch") || method.includes("file")) return "ArcBot is preparing file changes.";
  if (method.includes("plan")) return "ArcBot updated the task plan.";
  return "";
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

async function stopMismatchedBackendListener() {
  let health = null;
  try {
    health = await requestBackendHealth(700);
  } catch {}
  if (health && health.ok === true && health.token === BACKEND_TOKEN) return;
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
  env.ARCRHO_WORKFLOW_DIR =
    env.ARCRHO_WORKFLOW_DIR ||
    path.join(require("os").homedir(), "Documents", "ArcRho", "workflows");
  env.ARCRHO_BACKEND_TOKEN = BACKEND_TOKEN;
  serverSpawnError = null;

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
      if (!payload || payload.ok !== true || payload.token !== BACKEND_TOKEN) {
        throw new Error("health token mismatch");
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
    closeBackendLogStream();
    return;
  }

  const exitedGracefully = await waitForProcExit(proc, gracefulTimeoutMs);
  if (!exitedGracefully) {
    forceKillBackendProc(proc);
    await waitForProcExit(proc, 900);
  }
  if (serverProc === proc) serverProc = null;
  closeBackendLogStream();
}

async function requestBackendShutdown() {
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
        "window.__arcrho_confirm_app_shutdown ? window.__arcrho_confirm_app_shutdown() : true"
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

  win.loadURL(URL);

  win.webContents.on("before-input-event", (event, input) => {
    if (!win || win.isDestroyed()) return;

    const key = String(input.key || "").toUpperCase();
    const ctrl = !!input.control;
    const alt = !!input.alt;
    const shift = !!input.shift;
    const type = String(input.type || "");

    const sendHotkey = (action) => {
      win.webContents.send("arcrho:hotkey", { action });
    };

    if (type === "mouseWheel" && ctrl) {
      event.preventDefault();
      const deltaY = Number(input.deltaY || 0);
      win.webContents.send("arcrho:zoom", { deltaY });
      return;
    }

    // Zoom shortcuts (Ctrl +/-/0)
    if (ctrl && !alt && (key === "-" || key === "_")) {
      event.preventDefault();
      win.webContents.send("arcrho:zoom-step", { delta: -1 });
      return;
    }
    if (ctrl && !alt && (key === "=" || key === "+")) {
      event.preventDefault();
      win.webContents.send("arcrho:zoom-step", { delta: 1 });
      return;
    }
    if (ctrl && !alt && key === "0") {
      event.preventDefault();
      win.webContents.send("arcrho:zoom-reset");
      return;
    }

    // Block F5-based refresh shortcuts app-wide.
    if (!alt && key === "F5") {
      event.preventDefault();
      return;
    }
    // Refresh shortcuts
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
      win.webContents.send("arcrho:close-active-tab");
      return;
    }
    if (ctrl && !alt && !shift && key === "W") {
      event.preventDefault();
      win.webContents.send("arcrho:close-active-tab");
    }
  });
}

ipcMain.handle("pick-open-workflow", async (_event, payload) => {
  const startDir = payload?.startDir || "";
  const result = await dialog.showOpenDialog(win, {
    defaultPath: startDir || undefined,
    properties: ["openFile"],
    filters: [{ name: "Workflow", extensions: ["arcwf", "json"] }],
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("pick-open-table-file", async (_event, payload) => {
  const startDir = payload?.startDir || "";
  const result = await dialog.showOpenDialog(win, {
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

ipcMain.handle("pick-folder", async (_event, payload) => {
  const startDir = String(payload?.startDir || "").trim();
  const defaultPath = startDir && fs.existsSync(startDir) ? startDir : undefined;
  const result = await dialog.showOpenDialog(win, {
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

ipcMain.handle("pick-save-workflow", async (_event, payload) => {
  const suggestedName = payload?.suggestedName || "workflow.arcwf";
  const startDir = payload?.startDir || "";
  const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
  const result = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: "Workflow", extensions: ["arcwf", "json"] }],
  });
  if (result.canceled || !result.filePath) return "";
  return result.filePath;
});

ipcMain.handle("pick-open-file", async (_event, payload) => {
  const startDir = payload?.startDir || "";
  const filters = Array.isArray(payload?.filters) && payload.filters.length
    ? payload.filters
    : [{ name: "All Files", extensions: ["*"] }];
  const result = await dialog.showOpenDialog(win, {
    defaultPath: startDir || undefined,
    properties: ["openFile"],
    filters,
  });
  if (result.canceled || !result.filePaths?.length) return "";
  return result.filePaths[0];
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

ipcMain.handle("save-json-file", async (_event, payload) => {
  const data = payload?.data ?? null;
  const suggestedName = payload?.suggestedName || "data.json";
  const startDir = payload?.startDir || "";
  const filters = Array.isArray(payload?.filters) && payload.filters.length
    ? payload.filters
    : [{ name: "JSON", extensions: ["json"] }];
  let filePath = payload?.path || "";

  if (!filePath) {
    const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
    const result = await dialog.showSaveDialog(win, {
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

ipcMain.handle("save-text-file", async (_event, payload) => {
  const data = payload?.data ?? "";
  const suggestedName = payload?.suggestedName || "data.txt";
  const startDir = payload?.startDir || "";
  let filePath = payload?.path || "";

  if (!filePath) {
    const defaultPath = startDir ? path.join(startDir, suggestedName) : suggestedName;
    const result = await dialog.showSaveDialog(win, { defaultPath });
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

ipcMain.handle("app-clear-cache-reload", async () => {
  if (!win || win.isDestroyed()) return false;
  try {
    await win.webContents.session.clearCache();
    await win.webContents.session.clearStorageData();
  } catch {
    // ignore
  }
  try {
    const reloadUrl = `http://${HOST}:${PORT}/ui/?v=${encodeURIComponent(String(Date.now()))}`;
    await win.loadURL(reloadUrl);
  } catch {
    try {
      win.webContents.reloadIgnoringCache();
    } catch {
      // ignore
    }
  }
  return true;
});

ipcMain.handle("codex-assistant-status", async () => {
  const version = await runCodexCommand(["--version"], {
    timeoutMs: 8000,
  });
  if (!version.ok) {
    return {
      installed: false,
      authenticated: false,
      claudeAuthenticated: !!loadClaudeAuthToken(),
      version: "",
      error: normalizeHostError(version, "Codex CLI was not found."),
    };
  }

  const auth = await runCodexCommand(["login", "status"], {
    timeoutMs: 8000,
  });
  if (auth.ok && CODEX_APP_SERVER_ENABLED) {
    ensureCodexAppServerStarted().catch(() => {
      // The send path falls back to one-shot codex exec if the warm server is unavailable.
    });
  }
  return {
    installed: true,
    authenticated: auth.ok,
    claudeAuthenticated: !!loadClaudeAuthToken(),
    version: combinedCommandOutput(version).split(/\r?\n/)[0] || "codex",
    authStatus: combinedCommandOutput(auth),
    error: auth.ok ? "" : normalizeHostError(auth, "Codex CLI is not signed in."),
  };
});

ipcMain.handle("codex-assistant-readable-roots-load", async () => {
  try {
    const folders = readArcBotReadableRoots();
    return { ok: true, folders };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not load ArcBot readable folders.") };
  }
});

ipcMain.handle("codex-assistant-readable-roots-save", async (_event, payload) => {
  try {
    const folders = writeArcBotReadableRoots(payload?.folders || []);
    return { ok: true, folders };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not save ArcBot readable folders.") };
  }
});

ipcMain.handle("codex-assistant-prompt-guide-load", async () => {
  try {
    const components = readArcBotPromptComponentsForGuide();
    return {
      ok: true,
      serverRoot: getConfiguredWorkspaceRoot(),
      instructionsDir: getArcBotServerInstructionsDir(),
      entryPromptPath: getArcBotServerPromptTemplatePath() || ARCBOT_PROMPT_TEMPLATE_PATH,
      components,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not load ArcBot prompt guide.") };
  }
});

ipcMain.handle("codex-assistant-install", async () => {
  if (process.platform === "win32") {
    const scriptPath = writeCodexInstallScript();
    const result = await runHostCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-NpmCommand",
      getNpmCommand(),
    ], {
      timeoutMs: 10 * 60 * 1000,
      windowsHide: false,
      shell: false,
    });
    return {
      ok: result.ok,
      output: combinedCommandOutput(result),
      error: result.ok ? "" : normalizeHostError(result, "Codex CLI installation failed."),
    };
  }

  const result = await runHostCommand(getNpmCommand(), ["install", "-g", "@openai/codex"], {
    timeoutMs: 10 * 60 * 1000,
    windowsHide: false,
  });
  return {
    ok: result.ok,
    output: combinedCommandOutput(result),
    error: result.ok ? "" : normalizeHostError(result, "Codex CLI installation failed."),
  };
});

ipcMain.handle("codex-assistant-login", async (_event, payload) => {
  const provider = String(payload?.provider || "openai").trim().toLowerCase();
  if (provider === "anthropic") {
    try {
      const claudeCmd = getClaudeCommand();
      if (!claudeCmd) return { ok: false, error: "Claude CLI (claude) was not found. Install it to sign in." };
      if (process.platform === "win32") {
        const child = spawn("cmd.exe", ["/d", "/k", `${quoteWindowsCmdArg(claudeCmd)} login`], {
          cwd: APP_ROOT, detached: true, stdio: "ignore", windowsHide: false, shell: false,
        });
        child.unref();
        return { ok: true };
      }
      const child = spawn(claudeCmd, ["login"], {
        cwd: APP_ROOT, detached: true, stdio: "ignore", windowsHide: false, shell: false,
      });
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  try {
    const codexCommand = getCodexCommand();
    if (!codexCommand) {
      return { ok: false, error: "Codex CLI was not found. Install Codex CLI before signing in." };
    }
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/d", "/k", `${quoteWindowsCmdArg(codexCommand)} login`], {
        cwd: APP_ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: false,
      });
      child.unref();
      return { ok: true };
    }
    const child = spawn(codexCommand, ["login"], {
      cwd: APP_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("codex-assistant-sessions-list", async (_event, payload) => {
  try {
    return { ok: true, sessions: listArcBotChatSessions({ includeArchived: payload?.includeArchived === true }) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not list ArcBot sessions.") };
  }
});

ipcMain.handle("codex-assistant-session-create", async (_event, payload) => {
  try {
    const session = writeArcBotChatSession({
      title: String(payload?.title || "New ArcBot Chat"),
      mode: String(payload?.mode || "edit"),
      model: normalizeArcBotModel(payload?.model),
      reasoningEffort: normalizeArcBotReasoningEffort(payload?.reasoningEffort),
      messages: [],
      activities: [],
    });
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not create ArcBot session.") };
  }
});

ipcMain.handle("codex-assistant-session-load", async (_event, payload) => {
  try {
    const session = readArcBotChatSession(payload?.sessionId);
    return session ? { ok: true, session } : { ok: false, error: "ArcBot session was not found." };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not load ArcBot session.") };
  }
});

ipcMain.handle("codex-assistant-session-save", async (_event, payload) => {
  try {
    const session = writeArcBotChatSession(payload?.session || {});
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not save ArcBot session.") };
  }
});

ipcMain.handle("codex-assistant-session-archive", async (_event, payload) => {
  try {
    const session = archiveArcBotChatSession(payload?.sessionId, payload?.archived !== false);
    return session ? { ok: true, session } : { ok: false, error: "ArcBot session was not found." };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not archive ArcBot session.") };
  }
});

ipcMain.handle("codex-assistant-session-delete", async (_event, payload) => {
  try {
    const deleted = deleteArcBotChatSession(payload?.sessionId);
    return deleted ? { ok: true } : { ok: false, error: "ArcBot session was not found." };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "Could not delete ArcBot session.") };
  }
});

ipcMain.handle("codex-assistant-send", async (event, payload) => {
  const requestId = String(payload?.requestId || "");
  const mode = String(payload?.mode || "edit").trim().toLowerCase();
  const model = normalizeArcBotModel(payload?.model);
  const reasoningEffort = normalizeArcBotReasoningEffort(payload?.reasoningEffort);
  const requestLog = createArcBotRequestLogger({ requestId, payload, mode, model, reasoningEffort });
  if (requestId) arcBotRequestLoggers.set(requestId, requestLog);
  requestLog.mark("request_received", {
    messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
    attachmentCount: Array.isArray(payload?.attachments) ? payload.attachments.length : 0,
  });
  const finishArcBotRequest = (response, status = "") => {
    const ok = response && response.ok !== false;
    const finalStatus = status || (response?.canceled ? "canceled" : ok ? "completed" : "failed");
    requestLog.finish(finalStatus, {
      ok,
      error: response?.error || "",
      editApplied: !!response?.editApplied,
      targetPath: response?.targetPath || "",
      backupPath: response?.backupPath || "",
      usageTokens: response?.usage?.estimatedTokens || 0,
    });
    if (requestId) arcBotRequestLoggers.delete(requestId);
    return response;
  };
  if (mode !== "edit" && mode !== "review") {
    return finishArcBotRequest({
      ok: false,
      needsAuth: false,
      error: "Unsupported ArcBot mode.",
    }, "failed");
  }
  if (mode === "edit" && isRevertLatestRequest(payload?.messages)) {
    requestLog.start("revert_latest_edit");
    sendArcBotActivity(event, requestId, "activity", "Checking latest ArcBot edit history...");
    const reverted = await revertLatestArcBotEdit();
    requestLog.end("revert_latest_edit", { ok: !!reverted.ok, error: reverted.error || "" });
    return finishArcBotRequest(reverted.ok
      ? { ok: true, text: reverted.reply || "Reverted the latest ArcBot edit." }
      : { ok: false, needsAuth: false, error: reverted.error || "ArcBot revert failed." });
  }
  const requestState = requestId ? { canceled: false, cancelProcess: null } : null;
  if (requestId) activeCodexAssistantRequests.set(requestId, requestState);
  const canceledResponse = (usage = null) => ({
    ok: false,
    needsAuth: false,
    canceled: true,
    error: "Request canceled.",
    ...(usage ? { usage } : {}),
  });
  sendArcBotActivity(event, requestId, "activity", "Resolving ArcBot project and working folders...");
  requestLog.start("resolve_project_roots");
  const roots = await getCodexAssistantProjectRoots({ ensureLocalRoot: true });
  requestLog.end("resolve_project_roots", {
    projectRoot: roots.projectRoot,
    cliRoot: roots.cliRoot,
    networkRoot: !!roots.networkRoot,
    serverReadRoots: roots.serverReadRoots || [],
  });
  if (roots.serverReadRoots?.length) {
    sendArcBotActivity(event, requestId, "activity", "ArcBot can read the configured folders for this request.", {
      debugText: `ArcBot readable roots: ${roots.serverReadRoots.join("; ")}`,
    });
  }
  const activeContext = payload?.activeContext && typeof payload.activeContext === "object"
    ? payload.activeContext
    : null;
  requestLog.mark("active_context_received", {
    available: !!activeContext?.available,
    tabType: activeContext?.tabType || "home",
    title: activeContext?.title || "",
    targetPath: activeContext?.targetPath || activeContext?.path || "",
  });
  sendArcBotActivity(event, requestId, "context", activeContext?.available ? "Loaded active tab context." : "No active tab context was provided.", {
    context: {
      tabType: activeContext?.tabType || "home",
      title: activeContext?.title || "",
      targetPath: activeContext?.targetPath || activeContext?.path || "",
    },
  });
  const targetPath = getAssistantTargetJsonPath(activeContext);
  const attachments = Array.isArray(payload?.attachments)
    ? payload.attachments.slice(0, 5).map((item) => ({
        name: String(item?.name || path.basename(String(item?.path || "")) || "attachment"),
        path: String(item?.path || ""),
        size: Number.isFinite(item?.size) ? Math.max(0, Math.round(item.size)) : 0,
        text: String(item?.text || "").slice(0, 60000),
      })).filter((item) => item.text.trim())
    : [];
  requestLog.mark("attachments_prepared", {
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((item) => item.name),
    attachmentChars: attachments.reduce((sum, item) => sum + item.text.length, 0),
  });
  let activeJson = null;
  const activeJsonFallback = activeContext?.activeJson != null &&
    typeof activeContext.activeJson === "object" &&
    !Array.isArray(activeContext.activeJson)
    ? activeContext.activeJson
    : null;
  if (targetPath) {
    sendArcBotActivity(event, requestId, "activity", "Checking active JSON-backed file access...");
    requestLog.start("check_active_json_access", { targetPath });
    const validation = await validateArcBotJsonTarget(targetPath, { allowActiveNotebook: !!activeJsonFallback });
    requestLog.end("check_active_json_access", {
      ok: !!validation.ok,
      targetPath: validation.targetPath || targetPath,
      error: validation.error || "",
    });
    if (validation.ok) {
      if (activeJsonFallback) {
        requestLog.mark("active_json_source", { source: "active_context" });
        activeJson = activeJsonFallback;
      } else {
        try {
          requestLog.start("read_active_json_file", { targetPath: validation.targetPath });
          activeJson = JSON.parse(fs.readFileSync(validation.targetPath, "utf8"));
          requestLog.end("read_active_json_file", { ok: true });
        } catch (err) {
          requestLog.end("read_active_json_file", { ok: false, error: String(err?.message || err || "") });
          activeJson = {
            error: "Active JSON-backed file exists but could not be parsed or read.",
            detail: String(err?.message || err || ""),
          };
        }
      }
    } else if (!validation.ok) {
      activeJson = activeJsonFallback || { error: validation.error };
    }
  } else if (activeJsonFallback) {
    activeJson = activeJsonFallback;
  }
  let editSession = null;
  const activeJsonIsError = activeJson && typeof activeJson.error === "string";
  if (mode === "edit" && targetPath && activeJson && !activeJsonIsError && !isClaudeArcBotModel(model)) {
    requestLog.start("validate_edit_target", { targetPath });
    const validation = await validateArcBotJsonTarget(targetPath, { allowActiveNotebook: !!activeJsonFallback });
    requestLog.end("validate_edit_target", {
      ok: !!validation.ok,
      targetPath: validation.targetPath || targetPath,
      error: validation.error || "",
    });
    if (validation.ok) {
      sendArcBotActivity(event, requestId, "activity", "Creating editable local JSON-backed copy...");
      requestLog.start("create_edit_session", { targetPath: validation.targetPath });
      editSession = createArcBotEditSession({ targetPath: validation.targetPath, activeJson, roots: validation.roots });
      requestLog.end("create_edit_session", {
        sessionDir: editSession.sessionDir,
        jsonPath: editSession.jsonPath,
        exchangeRoot: editSession.exchangeRoot || "",
        stagedFileCount: editSession.manifestFiles?.length || 0,
        csvRewriteCount: editSession.csvRewrites?.length || 0,
      });
    }
  }
  const codexCwd = editSession?.codexCwd || editSession?.sessionDir || roots.cliRoot;
  const codexSandbox = editSession ? "workspace-write" : "read-only";
  requestLog.start("build_prompt", {
    mode,
    codexCwd,
    codexSandbox,
    hasEditSession: !!editSession,
  });
  const rawPrompt = buildAssistantPrompt(
    payload?.messages,
    mode,
    roots.projectRoot,
    codexCwd,
    roots.networkRoot,
    activeContext,
    activeJson,
    editSession,
    attachments
  );
  const prompt = clampCodexPrompt(rawPrompt);
  requestLog.end("build_prompt", {
    rawPromptChars: rawPrompt.length,
    promptChars: prompt.length,
    truncated: prompt.length < rawPrompt.length,
  });
  requestLog.start("estimate_context_usage");
  const usage = estimateArcBotContextUsage(rawPrompt, payload?.messages, activeContext, activeJson, prompt, attachments);
  requestLog.end("estimate_context_usage", {
    estimatedTokens: usage.estimatedTokens,
    contextWindowTokens: usage.contextWindowTokens,
    contextPercentUsed: usage.contextPercentUsed,
  });
  if (requestState?.canceled) {
    activeCodexAssistantRequests.delete(requestId);
    return finishArcBotRequest(canceledResponse(usage), "canceled");
  }
  sendArcBotActivity(
    event,
    requestId,
    "usage",
    `Context estimate: ~${usage.estimatedTokens.toLocaleString()} of ${usage.contextWindowTokens.toLocaleString()} tokens (${usage.contextPercentUsed.toFixed(usage.contextPercentUsed < 10 ? 1 : 0)}%).`,
    { usage }
  );
  let result = null;
  if (isClaudeArcBotModel(model)) {
    requestLog.start("claude_request", { model, reasoningEffort });
    result = await runClaudeArcBotRequest({
      event,
      requestId,
      requestState,
      model,
      reasoningEffort,
      systemText: buildClaudeSystemPrompt(mode, activeContext, activeJson),
      messages: payload?.messages,
      attachments,
      usage,
    });
    requestLog.end("claude_request", {
      ok: !!result?.ok,
      canceled: !!result?.canceled,
      stdoutChars: String(result?.stdout || "").length,
      error: result?.error || "",
    });
  } else {
    sendArcBotActivity(event, requestId, "activity", `Starting warm Codex session with ${model === "codex" ? "the Codex default model" : model} at ${reasoningEffort} reasoning in ${mode === "edit" ? "Edit Mode" : "Review Mode"}...`);
    requestLog.start("warm_codex_turn", {
      codexCwd,
      codexSandbox,
      mode,
      model,
      reasoningEffort,
      readableRoots: roots.serverReadRoots || [],
    });
    try {
      result = await runCodexWarmTurn({
        event,
        requestId,
        requestState,
        payload,
        mode,
        model,
        reasoningEffort,
        codexCwd,
        codexSandbox,
        prompt,
        readableRoots: roots.serverReadRoots,
      });
      requestLog.end("warm_codex_turn", {
        ok: !!result?.ok,
        code: result?.code ?? null,
        canceled: !!result?.canceled,
        stdoutChars: String(result?.stdout || "").length,
        stderrChars: String(result?.stderr || "").length,
        error: result?.error || "",
      });
    } catch (err) {
      requestLog.end("warm_codex_turn", {
        ok: false,
        canceled: !!requestState?.canceled,
        error: String(err?.message || err || "Codex warm session failed."),
      });
      if (requestState?.canceled) {
        result = { ok: false, canceled: true, stdout: "", stderr: "", error: "Request canceled." };
      } else {
        const warmError = String(err?.message || err || "Codex warm session failed.");
        sendArcBotActivity(event, requestId, "stderr", `${warmError}\n`);
        sendArcBotActivity(event, requestId, "activity", "Warm Codex session unavailable; using one-shot Codex CLI.");
        const execArgs = [
          "exec",
          "--ephemeral",
          "--color",
          "never",
          "--sandbox",
          codexSandbox,
          "--skip-git-repo-check",
          "--cd",
          codexCwd,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
        ];
        const runtimeModel = getArcBotRuntimeModel(model);
        if (runtimeModel) execArgs.push("--model", runtimeModel);
        requestLog.start("fallback_codex_cli", {
          codexCwd,
          codexSandbox,
          mode,
          model,
          reasoningEffort,
        });
        try {
          result = await runCodexCommand(execArgs, {
            input: prompt,
            timeoutMs: CODEX_ASSISTANT_TIMEOUT_MS,
            cancelKey: requestId,
            onStdout: (chunk) => sendArcBotActivity(event, requestId, "stdout", chunk),
            onStderr: (chunk) => sendArcBotActivity(event, requestId, "stderr", chunk),
          });
          requestLog.end("fallback_codex_cli", {
            ok: !!result?.ok,
            code: result?.code ?? null,
            signal: result?.signal || "",
            timedOut: !!result?.timedOut,
            canceled: !!result?.canceled,
            stdoutChars: String(result?.stdout || "").length,
            stderrChars: String(result?.stderr || "").length,
            error: result?.error || "",
          });
        } catch (execErr) {
          requestLog.end("fallback_codex_cli", {
            ok: false,
            error: String(execErr?.message || execErr || "Codex CLI fallback failed."),
          });
          result = {
            ok: false,
            stdout: "",
            stderr: "",
            error: String(execErr?.message || execErr || "Codex CLI fallback failed."),
          };
        }
      }
    }
  }
  if (requestId && activeCodexAssistantRequests.get(requestId) === requestState) {
    activeCodexAssistantRequests.delete(requestId);
  }

  if (!result.ok) {
    sendArcBotActivity(event, requestId, "error", normalizeHostError(result, "Codex CLI request failed."));
    return finishArcBotRequest({
      ok: false,
      needsAuth: isAuthFailure(result),
      canceled: !!result.canceled,
      error: normalizeHostError(result, "Codex CLI request failed."),
      usage,
    }, result.canceled ? "canceled" : "failed");
  }
  const rawText = String(result.stdout || "").trim();
  requestLog.mark("response_received", {
    stdoutChars: rawText.length,
    stderrChars: String(result.stderr || "").length,
  });
  sendArcBotActivity(event, requestId, "activity", "ArcBot response received.");
  if (mode === "edit") {
    if (editSession) {
      let editedJson = null;
      let editedText = "";
      try {
        requestLog.start("read_edited_json_copy", { jsonPath: editSession.jsonPath });
        editedText = fs.readFileSync(editSession.jsonPath, "utf8");
        try {
          editedJson = JSON.parse(editedText);
        } catch {
          const extractedJsonText = extractJsonText(editedText);
          if (!extractedJsonText) throw new Error("Edited JSON copy did not contain a valid JSON object.");
          editedJson = JSON.parse(extractedJsonText);
          editedText = formatJsonForArcBot(editedJson);
          fs.writeFileSync(editSession.jsonPath, editedText, "utf8");
          sendArcBotActivity(event, requestId, "activity", "Cleaned explanatory text from the edited JSON-backed copy.");
        }
        requestLog.end("read_edited_json_copy", {
          ok: true,
          changed: sha256Text(editedText) !== editSession.beforeSha256,
          chars: editedText.length,
        });
      } catch (err) {
        requestLog.end("read_edited_json_copy", {
          ok: false,
          error: String(err?.message || err || "Edited JSON copy could not be read."),
        });
        const message = String(err?.message || err || "Edited JSON copy could not be read.");
        return finishArcBotRequest({
          ok: false,
          needsAuth: false,
          error: `ArcBot could not apply the temp JSON copy. ${message}`,
          usage,
        }, "failed");
      }
      if (sha256Text(editedText) !== editSession.beforeSha256) {
        sendArcBotActivity(event, requestId, "activity", "Validating and applying edited JSON-backed copy...");
        const structured = extractJsonObject(rawText);
        requestLog.start("apply_json_edit", {
          targetPath: editSession.targetPath,
          replyFromStructuredOutput: !!structured?.reply,
        });
        const applied = await applyArcBotJsonEdit({
          targetPath: editSession.targetPath,
          replacementJson: restoreExchangeJsonForApply(editSession, editedJson),
          requestText: String((payload?.messages || []).slice(-1)[0]?.content || ""),
          reply: structured?.reply || rawText,
          originalJson: activeJson,
        });
        requestLog.end("apply_json_edit", {
          ok: !!applied.ok,
          targetPath: applied.targetPath || editSession.targetPath,
          backupPath: applied.backupPath || "",
          error: applied.error || "",
        });
        return finishArcBotRequest(applied.ok
          ? {
              ok: true,
              text: applied.reply || "Updated the active JSON-backed file.",
              editApplied: true,
              targetPath: applied.targetPath,
              backupPath: applied.backupPath,
              usage,
            }
          : { ok: false, needsAuth: false, error: applied.error || "ArcBot JSON-backed edit failed.", usage });
      }
    }
    const structured = extractJsonObject(rawText);
    if (structured?.action === "answer" || structured?.action === "edited" || structured?.action === "no_edit") {
      return finishArcBotRequest({
        ok: true,
        text: String(structured.reply || "").trim() || "No response.",
        usage,
      });
    }
  }
  return finishArcBotRequest({
    ok: true,
    text: rawText,
    progress: String(result.stderr || "").trim(),
    usage,
  });
});

ipcMain.handle("codex-assistant-cancel", async (_event, payload) => {
  const requestId = String(payload?.requestId || "");
  if (!requestId) return { ok: false, error: "Missing ArcBot request id." };
  arcBotRequestLoggers.get(requestId)?.mark("cancel_requested");
  const active = activeCodexAssistantRequests.get(requestId);
  if (typeof active === "function") {
    const canceled = active();
    return canceled ? { ok: true } : { ok: false, error: "ArcBot request already completed." };
  }
  if (!active || typeof active !== "object") return { ok: false, error: "No active ArcBot request to cancel." };
  active.canceled = true;
  const canceled = typeof active.cancelProcess === "function" ? active.cancelProcess() : true;
  return canceled ? { ok: true } : { ok: false, error: "ArcBot request already completed." };
});

ipcMain.handle("focus-window", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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

app.whenReady().then(async () => {
  appendElectronLog(
    `ArcRho startup begin. packaged=${app.isPackaged}; version=${app.getVersion()}; appPath=${app.getAppPath()}; resourcesPath=${process.resourcesPath}`
  );

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
        setTimeout(() => {
          checkForStartupUpdate().catch((err) => {
            console.warn(`ArcRho startup update check failed: ${err?.message || err}`);
          });
        }, 750);
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
  codexAppServerClient?.stop();
  await requestBackendShutdown();
});
