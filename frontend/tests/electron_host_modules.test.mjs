import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = fs.mkdtempSync(path.join(TESTS_DIR, "electron-host-modules-"));
const downloadsDir = fs.mkdtempSync(path.join(TESTS_DIR, "electron-host-downloads-"));
test.after(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(downloadsDir, { recursive: true, force: true });
});

const electronStub = {
  app: {
    getPath: (name) => (name === "downloads" ? downloadsDir : userDataDir),
    getVersion: () => "0.0.1",
    isPackaged: false,
    quit: () => {},
  },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, ...rest);
};
test.after(() => {
  Module._load = originalLoad;
});

const require = createRequire(import.meta.url);
const hostSupport = require("../electron/host_support.js");
const updateChecker = require("../electron/update_checker.js");
const backendLifecycle = require("../electron/backend_lifecycle.js");

test("host_support exports work outside the update/backend modules", async () => {
  assert.equal(typeof hostSupport.sleep, "function");
  await hostSupport.sleep(1);
  assert.match(hostSupport.getTimestampForFileName(), /^\d{4}-\d{2}-\d{2}T/);
  const text = hostSupport.formatJsonForSave({ rows: [[1, 2], [3, 4]], name: "x" });
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), { rows: [[1, 2], [3, 4]], name: "x" });
  assert.equal(await hostSupport.withTimeout(Promise.resolve("ok"), 500, "test"), "ok");
  assert.equal(hostSupport.isProcessAlive(process.pid), true);
  assert.equal(hostSupport.isProcessAlive(0), false);
  hostSupport.appendElectronLog("electron host module test entry");
  assert.ok(fs.existsSync(hostSupport.getElectronLogPath()));
});

test("update_checker initializes and reports development mode for unpackaged apps", async () => {
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => null });
  const result = await updateChecker.checkForUpdate({ showNoUpdate: false });
  assert.deepEqual(result, { status: "development" });
});

function releaseFixture({ assets, body = "" }) {
  return [{ draft: false, prerelease: false, published_at: "2026-08-01T00:00:00Z", body, assets }];
}

test("update_checker reports up to date when no release asset beats the current version", async () => {
  process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK = "1";
  const fetchStub = async (url) => {
    assert.match(url, /\/releases\?/);
    return {
      ok: true,
      json: async () => releaseFixture({
        assets: [{ name: "ArcRho-Setup-0.0.1.exe", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.1.exe" }],
      }),
    };
  };
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => null, fetchImpl: fetchStub });
  const result = await updateChecker.checkForUpdate({ showNoUpdate: false });
  delete process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK;
  assert.deepEqual(result, { status: "none" });
});

test("update_checker reports missing-checksum when a newer asset has no .sha256 sibling", async () => {
  process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK = "1";
  const fetchStub = async (url) => {
    if (String(url).includes("/releases?")) {
      return {
        ok: true,
        json: async () => releaseFixture({
          assets: [{ name: "ArcRho-Setup-0.0.2.exe", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.2.exe" }],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => null, fetchImpl: fetchStub });
  const result = await updateChecker.checkForUpdate({ showNoUpdate: true });
  delete process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK;
  assert.equal(result.status, "missing-checksum");
  assert.equal(result.version, "0.0.2");
});

test("update_checker shows only user-facing release notes as plain text", async () => {
  const body = [
    "# Release 0.0.2",
    "",
    "Released on 2026-08-10.",
    "",
    "## User-Facing Changes",
    "",
    "### Improvements",
    "- **installer**: ArcRho setup now defaults to a per-user install folder.",
    "  - Fresh installs default to `E:\\<Windows login>\\ArcRho`.",
    "",
    "### Fixes",
    "- **dataset**: Add > Dataset can now save without editing a cell first.",
    "",
    "## Internal Notes",
    "",
    "- **build**: The packaged build no longer kills makensis part-way through.",
    "",
    "## Fragment Sources",
    "",
    "- `changes/unreleased/2026-08-10-example.json`",
    "",
  ].join("\n");

  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/releases?")) {
      return {
        ok: true,
        json: async () => releaseFixture({
          body,
          assets: [
            { name: "ArcRho-Setup-0.0.2.exe", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.2.exe" },
            { name: "ArcRho-Setup-0.0.2.exe.sha256", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.2.exe.sha256" },
          ],
        }),
      };
    }
    return { ok: true, text: async () => `${"a".repeat(64)}  ArcRho-Setup-0.0.2.exe` };
  };

  let detail = "";
  const originalShowMessageBox = electronStub.dialog.showMessageBox;
  electronStub.dialog.showMessageBox = async (winOrOptions, maybeOptions) => {
    const options = maybeOptions || winOrOptions || {};
    if ((options.buttons || []).includes("Update now")) detail = String(options.detail || "");
    return { response: 1 };
  };

  process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK = "1";
  const fakeWin = { isDestroyed: () => false, webContents: { send: () => {}, executeJavaScript: async () => true } };
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => fakeWin, fetchImpl: fetchStub });
  let result;
  try {
    result = await updateChecker.checkForUpdate({ showNoUpdate: false });
  } finally {
    delete process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK;
    electronStub.dialog.showMessageBox = originalShowMessageBox;
  }

  assert.equal(result.status, "deferred");
  assert.match(detail, /^Improvements$/m);
  assert.match(detail, /• installer: ArcRho setup now defaults to a per-user install folder\./);
  assert.match(detail, /^Fixes$/m);
  assert.doesNotMatch(detail, /User-Facing Changes|Internal Notes|Fragment Sources/);
  assert.doesNotMatch(detail, /makensis/, "internal notes must not reach the update dialog");
  assert.doesNotMatch(detail, /[*#`]|^Released on/m, "the dialog must not show markdown syntax");
  assert.doesNotMatch(detail, /Fresh installs/, "per-change detail bullets are dropped to bound the dialog height");
  assert.ok(detail.split("\n").length <= 14, `update dialog detail must stay short, got:\n${detail}`);
});

test("update_checker downloads a newer release with progress events and rejects a bad checksum", async () => {
  const installerContent = Buffer.from("fake-installer-bytes-for-test");
  const wrongSha256 = crypto.createHash("sha256").update("not-the-installer").digest("hex");

  async function* bodyChunks() {
    yield installerContent.subarray(0, 10);
    yield installerContent.subarray(10);
  }

  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/releases?")) {
      return {
        ok: true,
        json: async () => releaseFixture({
          body: "Release notes\nmandatory: true",
          assets: [
            { name: "ArcRho-Setup-0.0.2.exe", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.2.exe" },
            { name: "ArcRho-Setup-0.0.2.exe.sha256", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.2.exe.sha256" },
          ],
        }),
      };
    }
    if (target.endsWith(".sha256")) {
      return { ok: true, text: async () => `${wrongSha256}  ArcRho-Setup-0.0.2.exe` };
    }
    if (target.endsWith(".exe")) {
      return {
        ok: true,
        headers: { get: (name) => (name === "content-length" ? String(installerContent.length) : null) },
        body: bodyChunks(),
      };
    }
    throw new Error(`Unexpected fetch URL in test: ${target}`);
  };

  const progressEvents = [];
  const fakeWin = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        if (channel === "update-download-progress") progressEvents.push(payload);
      },
      executeJavaScript: async () => true,
    },
  };

  const originalShowMessageBox = electronStub.dialog.showMessageBox;
  electronStub.dialog.showMessageBox = async (winOrOptions, maybeOptions) => {
    const options = maybeOptions || winOrOptions || {};
    return (options.buttons || []).includes("Update now") ? { response: 0 } : { response: 1 };
  };

  process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK = "1";
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => fakeWin, fetchImpl: fetchStub });
  let result;
  try {
    result = await updateChecker.checkForUpdate({ showNoUpdate: false });
  } finally {
    delete process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK;
    electronStub.dialog.showMessageBox = originalShowMessageBox;
  }

  assert.equal(result.status, "verification-failed");
  assert.equal(result.version, "0.0.2");
  assert.deepEqual(progressEvents.map((event) => event.phase), ["start", "progress", "progress", "verifying", "error"]);

  const downloadedPath = path.join(downloadsDir, "ArcRho-Setup-0.0.2.exe");
  assert.ok(!fs.existsSync(downloadedPath), "a failed checksum verification must delete the downloaded installer");
  assert.ok(!fs.existsSync(`${downloadedPath}.part`), "no partial download may be left in the Downloads folder");
});

// The host asks the renderer for a choice by evaluating a snippet in the page.
// Running that snippet against a stub window is what a real renderer does, so the
// test covers the serialization the main process actually performs.
function rendererWindow({ onUpdatePayload = () => {}, choice = null } = {}) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: () => {},
      executeJavaScript: async (code) => {
        const pageWindow = choice === null ? {} : {
          __arcrho_show_update_dialog: (payload) => {
            onUpdatePayload(payload);
            return { choice };
          },
        };
        return new Function("window", `return (${code});`)(pageWindow);
      },
    },
  };
}

function releaseWithInstaller(version, body, publishedAt = "2026-08-01T00:00:00Z") {
  return {
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    body,
    assets: [
      { name: `ArcRho-Setup-${version}.exe`, browser_download_url: `https://dl.example/ArcRho-Setup-${version}.exe` },
      {
        name: `ArcRho-Setup-${version}.exe.sha256`,
        browser_download_url: `https://dl.example/ArcRho-Setup-${version}.exe.sha256`,
      },
    ],
  };
}

function skippedReleaseFixture() {
  const notes = (version, extra = "") => [
    `# Release ${version}`,
    "",
    `Released on 2026-08-1${version.at(-1)}.`,
    "",
    "## User-Facing Changes",
    "",
    "### Improvements",
    `- **dataset**: Change shipped in ${version}.`,
    `  - Detail bullet for ${version}.`,
    extra,
    "",
    "## Internal Notes",
    "",
    `- **build**: makensis note for ${version}.`,
    "",
  ].filter((line) => line !== "").join("\n");

  return [
    releaseWithInstaller("0.0.4", notes("0.0.4")),
    releaseWithInstaller("0.0.3", notes("0.0.3")),
    releaseWithInstaller("0.0.2", `${notes("0.0.2")}\nmandatory: true`),
    releaseWithInstaller("0.0.1", notes("0.0.1")),
  ];
}

async function runSkippedVersionCheck(win) {
  const sha256 = "b".repeat(64);
  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/releases?")) {
      return { ok: true, json: async () => skippedReleaseFixture() };
    }
    if (target.endsWith(".sha256")) return { ok: true, text: async () => `${sha256}  installer` };
    throw new Error(`Unexpected fetch URL in test: ${target}`);
  };
  process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK = "1";
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => win, fetchImpl: fetchStub });
  try {
    return await updateChecker.checkForUpdate({ showNoUpdate: false });
  } finally {
    delete process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK;
  }
}

test("update_checker sends every skipped version's notes to the in-app dialog", async () => {
  let payload = null;
  const originalShowMessageBox = electronStub.dialog.showMessageBox;
  let nativeBoxShown = false;
  electronStub.dialog.showMessageBox = async (...args) => {
    nativeBoxShown = true;
    return originalShowMessageBox(...args);
  };

  let result;
  try {
    result = await runSkippedVersionCheck(rendererWindow({
      onUpdatePayload: (value) => { payload = value; },
      choice: "later",
    }));
  } finally {
    electronStub.dialog.showMessageBox = originalShowMessageBox;
  }

  assert.equal(result.status, "deferred");
  assert.equal(result.version, "0.0.4");
  assert.equal(nativeBoxShown, false, "the in-app dialog replaces the native message box");

  assert.equal(payload.mode, "update");
  assert.equal(payload.currentVersion, "0.0.1");
  assert.equal(payload.version, "0.0.4");
  assert.deepEqual(
    payload.releases.map((release) => release.version),
    ["0.0.4", "0.0.3", "0.0.2"],
    "a 0.0.1 -> 0.0.4 jump must carry the notes for 0.0.3 and 0.0.2 the user never saw"
  );

  const flattened = JSON.stringify(payload.releases);
  assert.match(flattened, /Change shipped in 0\.0\.3/);
  assert.match(flattened, /Detail bullet for 0\.0\.4/, "the scrollable dialog keeps per-change detail bullets");
  assert.doesNotMatch(flattened, /makensis/, "internal notes must not reach the update dialog");
  assert.doesNotMatch(flattened, /Released on/, "the released-on line is carried as a field, not a note");
  assert.equal(payload.releases[0].releasedOn, "2026-08-14");
  assert.ok(payload.releases[0].entries.some((entry) => entry.kind === "nested"));
  assert.ok(payload.mandatory, "a mandatory marker on a skipped version still applies to this update");
});

test("update_checker accepts the in-app dialog's update choice", async () => {
  const result = await runSkippedVersionCheck(rendererWindow({ choice: "update" }));
  // The download runs against a stub checksum that cannot match the payload.
  assert.equal(result.status, "download-failed");
  assert.equal(result.version, "0.0.4");
});

test("update_checker falls back to the native prompt when the renderer cannot answer", async () => {
  let detail = "";
  const originalShowMessageBox = electronStub.dialog.showMessageBox;
  electronStub.dialog.showMessageBox = async (winOrOptions, maybeOptions) => {
    const options = maybeOptions || winOrOptions || {};
    if ((options.buttons || []).includes("Update now")) detail = String(options.detail || "");
    return { response: 1 };
  };

  let result;
  try {
    result = await runSkippedVersionCheck(rendererWindow({ choice: null }));
  } finally {
    electronStub.dialog.showMessageBox = originalShowMessageBox;
  }

  assert.equal(result.status, "deferred");
  assert.match(detail, /Available version: 0\.0\.4/);
  assert.match(detail, /Also includes 0\.0\.3, 0\.0\.2\./);
  assert.doesNotMatch(detail, /Detail bullet/, "a native box cannot scroll, so detail bullets stay out of it");
  assert.doesNotMatch(detail, /makensis/);
});

test("update_checker reads the release notes bundled with the installed build", async () => {
  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => null });
  const history = await updateChecker.readLocalReleaseHistory();

  assert.equal(history.mode, "history");
  assert.equal(history.available, true, "every build ships frontend/docs/releases");
  assert.ok(history.releases.length > 1);
  assert.match(history.releasesUrl, /^https:\/\/github\.com\/.+\/releases$/);

  const versions = history.releases.map((release) => release.version);
  assert.deepEqual(
    versions,
    [...versions].sort((left, right) => {
      const parse = (value) => value.split(".").map(Number);
      const [leftParts, rightParts] = [parse(right), parse(left)];
      return leftParts[0] - rightParts[0] || leftParts[1] - rightParts[1] || leftParts[2] - rightParts[2];
    }),
    "the history reads newest first"
  );
  assert.ok(history.releases.every((release) => Array.isArray(release.entries)));
  assert.doesNotMatch(JSON.stringify(history.releases), /Fragment Sources/);
});

test("update_checker deletes the installer recorded for cleanup and legacy update downloads", async () => {
  const installerPath = path.join(downloadsDir, "ArcRho-Setup-0.0.3.exe");
  fs.writeFileSync(installerPath, "completed installer");
  const markerPath = path.join(userDataDir, "pending_update_cleanup.json");
  fs.writeFileSync(markerPath, JSON.stringify({ installerPath, version: "0.0.3" }));
  const legacyDir = path.join(userDataDir, "updates");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "ArcRho-Setup-0.0.2.exe"), "old installer");
  fs.writeFileSync(path.join(legacyDir, "ArcRho-Setup-0.0.2.exe.part"), "old partial");

  updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => null });
  const result = await updateChecker.cleanupCompletedUpdateInstaller();

  assert.equal(result.status, "removed");
  assert.ok(!fs.existsSync(installerPath), "the installer that produced this launch must be deleted");
  assert.ok(!fs.existsSync(markerPath), "the cleanup marker must not survive a successful cleanup");
  assert.ok(!fs.existsSync(legacyDir), "the legacy user-data updates folder must be removed once it is empty");

  assert.deepEqual(await updateChecker.cleanupCompletedUpdateInstaller(), { status: "none" });
});

test("update_checker retries a busy installer launch and records the cleanup marker", async () => {
  const installerContent = Buffer.from("retry-installer-bytes");
  const sha256 = crypto.createHash("sha256").update(installerContent).digest("hex");

  async function* bodyChunks() {
    yield installerContent;
  }

  const fetchStub = async (url) => {
    const target = String(url);
    if (target.includes("/releases?")) {
      return {
        ok: true,
        json: async () => releaseFixture({
          assets: [
            { name: "ArcRho-Setup-0.0.4.exe", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.4.exe" },
            { name: "ArcRho-Setup-0.0.4.exe.sha256", browser_download_url: "https://dl.example/ArcRho-Setup-0.0.4.exe.sha256" },
          ],
        }),
      };
    }
    if (target.endsWith(".sha256")) return { ok: true, text: async () => `${sha256}  ArcRho-Setup-0.0.4.exe` };
    return {
      ok: true,
      headers: { get: (name) => (name === "content-length" ? String(installerContent.length) : null) },
      body: bodyChunks(),
    };
  };

  // Windows reports a busy installer either way: spawn() throws EBUSY
  // synchronously, while other launch failures arrive as an "error" event.
  const spawnCalls = [];
  const spawnStub = (command) => {
    spawnCalls.push(command);
    const busy = Object.assign(new Error("spawn EBUSY"), { code: "EBUSY" });
    if (spawnCalls.length === 1) throw busy;
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit(spawnCalls.length === 2 ? "error" : "spawn", spawnCalls.length === 2 ? busy : undefined));
    return child;
  };

  const originalShowMessageBox = electronStub.dialog.showMessageBox;
  electronStub.dialog.showMessageBox = async (winOrOptions, maybeOptions) => {
    const options = maybeOptions || winOrOptions || {};
    return (options.buttons || []).includes("Update now") ? { response: 0 } : { response: 1 };
  };

  process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK = "1";
  const fakeWin = { isDestroyed: () => false, webContents: { send: () => {}, executeJavaScript: async () => true } };
  updateChecker.initUpdateChecker({
    appMode: "arcrho",
    getMainWindow: () => fakeWin,
    fetchImpl: fetchStub,
    spawnImpl: spawnStub,
  });
  let result;
  try {
    result = await updateChecker.checkForUpdate({ showNoUpdate: false });
  } finally {
    delete process.env.ARCRHO_ENABLE_DEV_UPDATE_CHECK;
    electronStub.dialog.showMessageBox = originalShowMessageBox;
    updateChecker.initUpdateChecker({ appMode: "arcrho", getMainWindow: () => null });
  }

  assert.deepEqual(result, { status: "launching", version: "0.0.4" });
  assert.equal(spawnCalls.length, 3, "a busy launch must be retried rather than reported to the user");

  const installerPath = path.join(downloadsDir, "ArcRho-Setup-0.0.4.exe");
  assert.ok(fs.existsSync(installerPath), "a launched installer stays until the next launch deletes it");
  const marker = JSON.parse(fs.readFileSync(path.join(userDataDir, "pending_update_cleanup.json"), "utf8"));
  assert.deepEqual(marker, { installerPath, version: "0.0.4" });

  assert.equal((await updateChecker.cleanupCompletedUpdateInstaller()).status, "removed");
  assert.ok(!fs.existsSync(installerPath));
});

test("backend_lifecycle initializes, resolves its port, and manages client markers", () => {
  backendLifecycle.initBackendLifecycle({
    appMode: "arcrho",
    host: "127.0.0.1",
    backendToken: "test-token",
    appRoot: userDataDir,
    pythonExe: "python",
  });
  const port = backendLifecycle.getBackendPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);

  backendLifecycle.registerBackendClient();
  const markerPath = path.join(userDataDir, "backend_clients", `${process.pid}.json`);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.port, port);
  backendLifecycle.unregisterBackendClient();
  assert.ok(!fs.existsSync(markerPath));

  backendLifecycle.clearBackendControlFlags();
});
