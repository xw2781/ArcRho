// GitHub Releases update checking, download-with-progress, and update-install prompting for the desktop host.
const { app, dialog } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { withTimeout } = require("./host_support");

const SHA256_RE = /\b[a-fA-F0-9]{64}\b/;
const GITHUB_API_ROOT = "https://api.github.com";
const DOWNLOAD_PROGRESS_CHANNEL = "update-download-progress";
const MANDATORY_MARKER_RE = /\bmandatory\s*:\s*true\b/i;
const MAX_RELEASES_SCANNED = 15;

let getMainWindow = () => null;
let fetchImpl = typeof fetch === "function" ? fetch : null;
let UPDATE_GITHUB_REPO = "xw2781/ArcRho";
let UPDATE_GITHUB_TOKEN = "";
let UPDATE_CHECK_TIMEOUT_MS = 3000;
let UPDATE_INSTALLER_NAME_RE = /$^/;
let DEV_UPDATE_CHECK_ENABLED = false;

function initUpdateChecker({ appMode, getMainWindow: getWin, fetchImpl: injectedFetch } = {}) {
  getMainWindow = typeof getWin === "function" ? getWin : () => null;
  if (typeof injectedFetch === "function") fetchImpl = injectedFetch;
  UPDATE_GITHUB_REPO = (
    appMode === "arcode" ? process.env.ARCODE_UPDATE_GITHUB_REPO : process.env.ARCRHO_UPDATE_GITHUB_REPO
  ) || "xw2781/ArcRho";
  UPDATE_GITHUB_TOKEN = (
    appMode === "arcode" ? process.env.ARCODE_UPDATE_GITHUB_TOKEN : process.env.ARCRHO_UPDATE_GITHUB_TOKEN
  ) || "";
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

function createUpdateInfo(version, asset, sha256, release) {
  return {
    version,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
    sha256,
    source: "github",
    releaseNotes: String(release?.body || "").trim(),
    mandatory: MANDATORY_MARKER_RE.test(String(release?.body || "")),
    publishedAt: String(release?.published_at || "").trim(),
  };
}

function createUpdateIssue(status, version, assetName, message, detail = "") {
  return { status, version, assetName, source: "github", message, detail };
}

function areInstallerUpdateChecksEnabled() {
  return app.isPackaged || DEV_UPDATE_CHECK_ENABLED;
}

function githubRequestHeaders(extra = {}) {
  const headers = {
    "User-Agent": "ArcRho-Updater",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
  if (UPDATE_GITHUB_TOKEN) headers.Authorization = `Bearer ${UPDATE_GITHUB_TOKEN}`;
  return headers;
}

async function fetchReleases() {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation is available for the update check.");
  }
  const url = `${GITHUB_API_ROOT}/repos/${UPDATE_GITHUB_REPO}/releases?per_page=${MAX_RELEASES_SCANNED}`;
  const response = await fetchImpl(url, { headers: githubRequestHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with status ${response.status}`);
  }
  const releases = await response.json();
  return Array.isArray(releases) ? releases : [];
}

async function readAssetText(url) {
  const response = await fetchImpl(url, { headers: githubRequestHeaders({ Accept: "application/octet-stream" }) });
  if (!response.ok) return "";
  return String(await response.text());
}

async function findAvailableUpdateFromReleases(releases, options = {}) {
  const reportIssues = options.reportIssues === true;
  let best = null;
  let bestIssue = null;

  for (const release of releases) {
    if (release?.draft || release?.prerelease) continue;
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    for (const asset of assets) {
      const match = String(asset?.name || "").match(UPDATE_INSTALLER_NAME_RE);
      if (!match) continue;
      const version = match[1];
      if (compareVersions(version, app.getVersion()) <= 0) continue;
      if (best && compareVersions(version, best.version) <= 0) continue;

      const checksumAsset = assets.find((entry) => entry?.name === `${asset.name}.sha256`);
      if (!checksumAsset) {
        console.warn(`ArcRho update asset is missing a SHA-256 checksum asset: ${asset.name}`);
        bestIssue = createUpdateIssue(
          "missing-checksum",
          version,
          asset.name,
          "ArcRho found a newer installer, but it is missing a SHA-256 checksum.",
          `Add a ${asset.name}.sha256 asset to the release.`
        );
        continue;
      }

      const sha256 = parseSha256Text(await readAssetText(checksumAsset.browser_download_url));
      if (!sha256) {
        console.warn(`ArcRho update checksum asset could not be read: ${checksumAsset.name}`);
        bestIssue = createUpdateIssue(
          "missing-checksum",
          version,
          asset.name,
          "ArcRho found a newer installer, but its SHA-256 checksum could not be read."
        );
        continue;
      }

      best = createUpdateInfo(version, asset, sha256, release);
    }
  }

  if (best) return best;
  return reportIssues ? bestIssue : null;
}

async function findAvailableUpdate(options = {}) {
  const releases = await fetchReleases();
  return findAvailableUpdateFromReleases(releases, options);
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

function updatesDownloadDir() {
  return path.join(app.getPath("userData"), "updates");
}

function sendDownloadProgress(payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(DOWNLOAD_PROGRESS_CHANNEL, payload);
  }
}

async function downloadReleaseAsset(updateInfo) {
  const destDir = updatesDownloadDir();
  await fs.promises.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, updateInfo.assetName);
  const partPath = `${destPath}.part`;

  const response = await fetchImpl(updateInfo.downloadUrl, { headers: githubRequestHeaders() });
  if (!response.ok || !response.body) {
    throw new Error(`Update download request failed with status ${response.status}`);
  }
  const totalBytes = Number.parseInt(response.headers.get("content-length") || "", 10) || 0;
  let receivedBytes = 0;

  sendDownloadProgress({ phase: "start", version: updateInfo.version, receivedBytes: 0, totalBytes });
  const writeStream = fs.createWriteStream(partPath);
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await new Promise((resolve, reject) => {
        writeStream.write(buffer, (err) => (err ? reject(err) : resolve()));
      });
      receivedBytes += buffer.length;
      sendDownloadProgress({ phase: "progress", version: updateInfo.version, receivedBytes, totalBytes });
    }
  } finally {
    await new Promise((resolve) => writeStream.end(resolve));
  }

  await fs.promises.rename(partPath, destPath);
  return destPath;
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

async function downloadVerifyAndInstall(updateInfo) {
  let installerPath = "";
  try {
    installerPath = await downloadReleaseAsset(updateInfo);
  } catch (err) {
    console.warn(`ArcRho update download failed: ${err?.message || err}`);
    sendDownloadProgress({ phase: "error", version: updateInfo.version });
    await showMainWindowMessageBox({
      type: "error",
      title: "Update could not be downloaded",
      message: "ArcRho did not install the update.",
      detail: String(err?.message || err),
      buttons: ["OK"],
      noLink: true,
    });
    return { status: "download-failed", version: updateInfo.version };
  }

  sendDownloadProgress({ phase: "verifying", version: updateInfo.version });
  const actualSha256 = await calculateFileSha256(installerPath).catch(() => "");
  const verified = actualSha256 && actualSha256 === String(updateInfo.sha256 || "").toLowerCase();
  if (!verified) {
    sendDownloadProgress({ phase: "error", version: updateInfo.version });
    await fs.promises.unlink(installerPath).catch(() => {});
    await showMainWindowMessageBox({
      type: "error",
      title: "Update could not be verified",
      message: "ArcRho did not install the update.",
      detail: "The downloaded installer checksum did not match the published SHA-256 value.",
      buttons: ["OK"],
      noLink: true,
    });
    return { status: "verification-failed", version: updateInfo.version };
  }

  sendDownloadProgress({ phase: "done", version: updateInfo.version });
  try {
    launchUpdateInstaller(installerPath);
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

async function promptForUpdateInstall(updateInfo) {
  const win = getMainWindow();
  if (!updateInfo || !win || win.isDestroyed()) return { status: "unavailable" };
  const detailLines = [
    `Current version: ${app.getVersion()}`,
    `Available version: ${updateInfo.version}`,
    `Installer: ${updateInfo.assetName}`,
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

  return downloadVerifyAndInstall(updateInfo);
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
          `Update location: https://github.com/${UPDATE_GITHUB_REPO}/releases`,
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
          updateInfo.assetName ? `Installer: ${updateInfo.assetName}` : "",
          updateInfo.detail || "",
        ].filter(Boolean).join("\n"),
        buttons: ["OK"],
        noLink: true,
      });
    }
    return {
      status: updateInfo.status,
      version: updateInfo.version || "",
      assetName: updateInfo.assetName || "",
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
