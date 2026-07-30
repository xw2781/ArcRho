// Installer update feed checking and update-install prompting for the desktop host.
const { app, dialog } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { withTimeout } = require("./host_support");

const SHA256_RE = /\b[a-fA-F0-9]{64}\b/;

let getMainWindow = () => null;
let UPDATE_FEED_DIR = "";
let UPDATE_MANIFEST_FILE = "latest.json";
let UPDATE_CHECK_TIMEOUT_MS = 3000;
let UPDATE_INSTALLER_NAME_RE = /$^/;
let DEV_UPDATE_CHECK_ENABLED = false;

function initUpdateChecker({ appMode, getMainWindow: getWin } = {}) {
  getMainWindow = typeof getWin === "function" ? getWin : () => null;
  UPDATE_FEED_DIR = appMode === "arcode"
    ? (process.env.ARCODE_UPDATE_DIR || "E:\\Arcode Server\\releases\\arcode-installers")
    : (process.env.ARCRHO_UPDATE_DIR || "E:\\ArcRho Server\\releases\\installers");
  UPDATE_MANIFEST_FILE = (appMode === "arcode" ? process.env.ARCODE_UPDATE_MANIFEST_FILE : process.env.ARCRHO_UPDATE_MANIFEST_FILE) || "latest.json";
  UPDATE_CHECK_TIMEOUT_MS = Math.max(
    1000,
    parseInt(
      (appMode === "arcode" ? process.env.ARCODE_UPDATE_CHECK_TIMEOUT_MS : process.env.ARCRHO_UPDATE_CHECK_TIMEOUT_MS)
        || "3000",
      10
    ) || 3000
  );
  UPDATE_INSTALLER_NAME_RE = appMode === "arcode"
    ? /^Arcode-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$/i
    : /^ArcRho-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$/i;
  DEV_UPDATE_CHECK_ENABLED = String(
    appMode === "arcode" ? process.env.ARCODE_ENABLE_DEV_UPDATE_CHECK : process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK
  ).trim() === "1";
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

function areInstallerUpdateChecksEnabled() {
  return app.isPackaged || DEV_UPDATE_CHECK_ENABLED;
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
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    return dialog.showMessageBox(win, options);
  }
  return dialog.showMessageBox(options);
}

async function confirmUpdateShutdown() {
  const win = getMainWindow();
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
  const win = getMainWindow();
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
  if (!areInstallerUpdateChecksEnabled()) {
    if (showNoUpdate) {
      await showMainWindowMessageBox({
        type: "info",
        title: "Update check unavailable",
        message: "ArcRho installer update checks are disabled in development mode.",
        detail: [
          "Development launches run from the local source tree instead of an installed package.",
          "Set ARCRHO_ENABLE_DEV_UPDATE_CHECK=1 before launch to test installer update checks from a dev app.",
        ].join("\n"),
        buttons: ["OK"],
        noLink: true,
      });
    }
    return { status: "development" };
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

module.exports = { initUpdateChecker, checkForUpdate, checkForStartupUpdate };
