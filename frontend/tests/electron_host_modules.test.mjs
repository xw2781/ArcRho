import assert from "node:assert/strict";
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
