// GitHub Releases update checking, download-with-progress, update-install prompting, and
// post-install installer cleanup for the desktop host.
const { app, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sleep, withTimeout } = require("./host_support");

const SHA256_RE = /\b[a-fA-F0-9]{64}\b/;
const GITHUB_API_ROOT = "https://api.github.com";
const DOWNLOAD_PROGRESS_CHANNEL = "update-download-progress";
const MANDATORY_MARKER_RE = /\bmandatory\s*:\s*true\b/i;
const MAX_RELEASES_SCANNED = 15;
const USER_SECTION_HEADING_RE = /^##\s+user-facing changes\s*$/i;
const SECTION_HEADING_RE = /^##\s+/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const NESTED_BULLET_RE = /^\s{2,}[-*]\s+/;
const RELEASED_ON_RE = /^released on .*\.$/i;
const MAX_RELEASE_NOTE_BULLETS = 12;
const PENDING_CLEANUP_FILE = "pending_update_cleanup.json";
const CLEANUP_RETRY_DELAY_MS = 20000;
const INSTALLER_LAUNCH_RETRY_DELAYS_MS = [400, 1200, 2500, 5000];
const TRANSIENT_LAUNCH_ERROR_CODES = new Set(["EBUSY", "ETXTBSY", "EACCES", "EPERM"]);
const MAX_INSTALLER_NAME_ATTEMPTS = 100;

let getMainWindow = () => null;
let fetchImpl = typeof fetch === "function" ? fetch : null;
let spawnImpl = spawn;
let UPDATE_GITHUB_REPO = "xw2781/ArcRho";
let UPDATE_GITHUB_TOKEN = "";
let UPDATE_CHECK_TIMEOUT_MS = 3000;
let UPDATE_INSTALLER_NAME_RE = /$^/;
let DEV_UPDATE_CHECK_ENABLED = false;

function initUpdateChecker({
  appMode,
  getMainWindow: getWin,
  fetchImpl: injectedFetch,
  spawnImpl: injectedSpawn,
} = {}) {
  getMainWindow = typeof getWin === "function" ? getWin : () => null;
  if (typeof injectedFetch === "function") fetchImpl = injectedFetch;
  spawnImpl = typeof injectedSpawn === "function" ? injectedSpawn : spawn;
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

function stripInlineMarkdown(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

// A native message box renders plain text only, so the release body is reduced to
// the user-facing section as flat lines: the label itself, the internal and
// fragment-source sections, and the per-change detail bullets are all dropped.
// Those details are what make the box tall enough to need its own scrollbar.
function userFacingReleaseNoteEntries(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const userSectionIndex = lines.findIndex((line) => USER_SECTION_HEADING_RE.test(line.trim()));
  let scoped = lines;
  if (userSectionIndex >= 0) {
    const rest = lines.slice(userSectionIndex + 1);
    const nextSection = rest.findIndex((line) => SECTION_HEADING_RE.test(line.trim()));
    scoped = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  }

  const entries = [];
  for (const line of scoped) {
    const trimmed = line.trim();
    if (!trimmed || RELEASED_ON_RE.test(trimmed)) continue;

    const heading = trimmed.match(HEADING_RE);
    if (heading) {
      // A body with no user-facing section is shown whole; its own release title
      // only repeats the version the dialog already states.
      if (heading[1].length > 1) entries.push({ kind: "title", text: stripInlineMarkdown(heading[2]) });
      continue;
    }

    const bullet = trimmed.match(BULLET_RE);
    if (!bullet) {
      entries.push({ kind: "text", text: stripInlineMarkdown(trimmed) });
      continue;
    }
    if (NESTED_BULLET_RE.test(line)) continue;
    entries.push({ kind: "bullet", text: stripInlineMarkdown(bullet[1]) });
  }
  return entries;
}

function formatReleaseNotesForDialog(body) {
  const entries = userFacingReleaseNoteEntries(body);
  const rendered = [];
  let bullets = 0;
  let dropped = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.kind === "bullet" && bullets >= MAX_RELEASE_NOTE_BULLETS) {
      dropped = entries.slice(i).filter((remaining) => remaining.kind === "bullet").length;
      break;
    }
    if (entry.kind === "bullet") {
      bullets += 1;
      rendered.push(`   • ${entry.text}`);
    } else if (entry.kind === "title") {
      if (rendered.length) rendered.push("");
      rendered.push(entry.text);
    } else {
      rendered.push(entry.text);
    }
  }

  if (dropped > 0) {
    rendered.push(
      "",
      `and ${dropped} more change${dropped === 1 ? "" : "s"} - see https://github.com/${UPDATE_GITHUB_REPO}/releases`
    );
  }
  return rendered.join("\n").trim();
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
    let digest = "";
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => { digest = hash.digest("hex").toLowerCase(); });
    // Resolve on "close" so the read handle on the installer is gone before the
    // caller tries to start it; at "end" the descriptor is still open.
    stream.on("close", () => resolve(digest));
  });
}

function legacyUpdatesDownloadDir() {
  return path.join(app.getPath("userData"), "updates");
}

function installerDownloadDir() {
  // The installer is a user-visible download, so it belongs in the user's own
  // Downloads folder rather than inside the app's user-data tree on C:.
  try {
    const downloads = app.getPath("downloads");
    if (downloads) return downloads;
  } catch (err) {
    console.warn(`ArcRho could not resolve the Downloads folder: ${err?.message || err}`);
  }
  return legacyUpdatesDownloadDir();
}

// The cleanup pass deletes only what ArcRho itself downloaded, so never reuse a
// name that already exists; an installer the user downloaded by hand keeps it.
function reserveInstallerPath(destDir, assetName) {
  const ext = path.extname(assetName);
  const base = path.basename(assetName, ext);
  for (let attempt = 0; attempt < MAX_INSTALLER_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(destDir, attempt === 0 ? assetName : `${base} (${attempt})${ext}`);
    if (!fs.existsSync(candidate) && !fs.existsSync(`${candidate}.part`)) return candidate;
  }
  return path.join(destDir, `${base} (${Date.now()})${ext}`);
}

function pendingCleanupMarkerPath() {
  return path.join(app.getPath("userData"), PENDING_CLEANUP_FILE);
}

function recordPendingInstallerCleanup(installerPath, version) {
  // Written synchronously: app.quit() follows immediately, and a marker that
  // never lands leaves the installer in Downloads forever.
  try {
    fs.writeFileSync(
      pendingCleanupMarkerPath(),
      `${JSON.stringify({ installerPath, version }, null, 2)}\n`,
      "utf8"
    );
  } catch (err) {
    console.warn(`ArcRho could not record the update installer cleanup marker: ${err?.message || err}`);
  }
}

async function deleteInstallerFile(installerPath) {
  try {
    await fs.promises.unlink(installerPath);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    console.warn(`ArcRho could not delete the update installer ${installerPath}: ${err?.message || err}`);
    return false;
  }
}

async function removeLegacyUpdateDownloads() {
  const dir = legacyUpdatesDownloadDir();
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.endsWith(".part") ? entry.slice(0, -".part".length) : entry;
    if (!UPDATE_INSTALLER_NAME_RE.test(name)) continue;
    await deleteInstallerFile(path.join(dir, entry));
  }
  await fs.promises.rmdir(dir).catch(() => {});
}

// Runs at startup: the installer that produced this launch cannot delete itself,
// and it is still locked while it exits, so a failed delete is retried once and
// otherwise left for the next launch.
async function cleanupCompletedUpdateInstaller() {
  await removeLegacyUpdateDownloads();

  const markerPath = pendingCleanupMarkerPath();
  let installerPath = "";
  try {
    installerPath = String(JSON.parse(await fs.promises.readFile(markerPath, "utf8"))?.installerPath || "");
  } catch {
    return { status: "none" };
  }

  const dropMarker = () => fs.promises.unlink(markerPath).catch(() => {});
  if (!installerPath) {
    await dropMarker();
    return { status: "none" };
  }
  if (await deleteInstallerFile(installerPath)) {
    await dropMarker();
    return { status: "removed", installerPath };
  }

  setTimeout(() => {
    deleteInstallerFile(installerPath).then((removed) => {
      if (removed) dropMarker();
    });
  }, CLEANUP_RETRY_DELAY_MS).unref?.();
  return { status: "retry-scheduled", installerPath };
}

function sendDownloadProgress(payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(DOWNLOAD_PROGRESS_CHANNEL, payload);
  }
}

async function downloadReleaseAsset(updateInfo) {
  const destDir = installerDownloadDir();
  await fs.promises.mkdir(destDir, { recursive: true });
  const destPath = reserveInstallerPath(destDir, updateInfo.assetName);
  const partPath = `${destPath}.part`;

  try {
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
      // "close", not the end() callback: that one fires on "finish", while the
      // file descriptor is still open, and Windows refuses to start an
      // executable that another handle is holding.
      await new Promise((resolve) => {
        writeStream.on("close", resolve);
        writeStream.end();
      });
    }

    await fs.promises.rename(partPath, destPath);
    return destPath;
  } catch (err) {
    // A partial file in the user's Downloads folder is litter nothing else clears.
    await fs.promises.unlink(partPath).catch(() => {});
    throw err;
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

// Settles on the child's own outcome: spawn() throws EBUSY synchronously but
// reports EACCES/ENOENT as an "error" event, which with no listener would take
// the main process down instead of reaching the caller's error dialog.
function spawnUpdateInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(installerPath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// A freshly written installer is briefly held by whatever inspects new
// executables - Windows Defender's real-time scan above all - and CreateProcess
// answers that with EBUSY. It clears on its own, so retry before giving up.
async function launchUpdateInstaller(installerPath) {
  let lastError = null;
  for (let attempt = 0; attempt <= INSTALLER_LAUNCH_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(INSTALLER_LAUNCH_RETRY_DELAYS_MS[attempt - 1]);
    try {
      await spawnUpdateInstaller(installerPath);
      return;
    } catch (err) {
      lastError = err;
      if (!TRANSIENT_LAUNCH_ERROR_CODES.has(String(err?.code || ""))) break;
      console.warn(`ArcRho update installer launch attempt ${attempt + 1} failed: ${err?.message || err}`);
    }
  }

  // ShellExecute goes through the shell rather than CreateProcess directly, so
  // it can still start a file the direct launch was refused.
  const openError = shell?.openPath ? await shell.openPath(installerPath) : "no shell available";
  if (!openError) return;
  throw new Error(`${String(lastError?.message || lastError)} (opening the installer also failed: ${openError})`);
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
    await launchUpdateInstaller(installerPath);
    recordPendingInstallerCleanup(installerPath, updateInfo.version);
    app.quit();
    return { status: "launching", version: updateInfo.version };
  } catch (err) {
    // The installer is downloaded and verified, so name it: running it by hand
    // is all that is left to do, and ArcRho keeps running in the meantime.
    await showMainWindowMessageBox({
      type: "error",
      title: "Update could not be started",
      message: "ArcRho could not launch the update installer.",
      detail: [
        String(err?.message || err),
        "",
        "The installer was downloaded and verified. You can run it yourself:",
        installerPath,
      ].join("\n"),
      buttons: ["OK"],
      noLink: true,
    });
    return { status: "launch-failed", version: updateInfo.version, installerPath };
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
  const releaseNotes = formatReleaseNotesForDialog(updateInfo.releaseNotes);
  if (releaseNotes) detailLines.push("", releaseNotes);
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

module.exports = {
  initUpdateChecker,
  checkForUpdate,
  checkForStartupUpdate,
  cleanupCompletedUpdateInstaller,
};
