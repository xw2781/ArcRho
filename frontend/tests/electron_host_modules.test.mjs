import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = fs.mkdtempSync(path.join(TESTS_DIR, "electron-host-modules-"));
test.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

const electronStub = {
  app: {
    getPath: () => userDataDir,
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

  const downloadedPath = path.join(userDataDir, "updates", "ArcRho-Setup-0.0.2.exe");
  assert.ok(!fs.existsSync(downloadedPath), "a failed checksum verification must delete the downloaded installer");
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
