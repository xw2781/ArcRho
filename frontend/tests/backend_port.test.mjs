import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  resolvePreferredBackendPort,
  findAvailableBackendPort,
  getAppEndpointPath,
  writeAppEndpointFile,
  removeAppEndpointFile,
  APP_ENDPOINT_FORMAT,
} = (await import(new URL("../electron/backend_port.js", import.meta.url))).default;

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function makeTempAppData() {
  return fs.mkdtempSync(path.join(TESTS_DIR, "arcrho-endpoint-test-"));
}

test("resolvePreferredBackendPort uses mode defaults", () => {
  assert.equal(resolvePreferredBackendPort({ appMode: "arcrho", env: {} }), 28765);
  assert.equal(resolvePreferredBackendPort({ appMode: "arcode", env: {} }), 28766);
});

test("resolvePreferredBackendPort prefers env overrides and rejects invalid values", () => {
  assert.equal(resolvePreferredBackendPort({ appMode: "arcrho", env: { ARCRHO_PORT: "31000" } }), 31000);
  assert.equal(resolvePreferredBackendPort({ appMode: "arcrho", env: { ARCODE_PORT: "31001" } }), 31001);
  assert.equal(
    resolvePreferredBackendPort({ appMode: "arcrho", env: { ARCRHO_PORT: "31000", ARCODE_PORT: "31001" } }),
    31000,
  );
  assert.equal(resolvePreferredBackendPort({ appMode: "arcrho", env: { ARCRHO_PORT: "not-a-port" } }), 28765);
  assert.equal(resolvePreferredBackendPort({ appMode: "arcrho", env: { ARCRHO_PORT: "0" } }), 28765);
});

test("findAvailableBackendPort keeps a free preferred port", async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const result = await findAvailableBackendPort("127.0.0.1", freePort);
  assert.equal(result.port, freePort);
  assert.equal(result.fallback, false);
});

test("findAvailableBackendPort falls back to a different free port when occupied", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const occupiedPort = blocker.address().port;
  try {
    const result = await findAvailableBackendPort("127.0.0.1", occupiedPort);
    assert.equal(result.fallback, true);
    assert.notEqual(result.port, occupiedPort);
    assert.ok(Number.isInteger(result.port) && result.port > 0 && result.port <= 65535);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("getAppEndpointPath derives the per-user AppData location by mode", () => {
  const env = { APPDATA: "C:\\Users\\demo\\AppData\\Roaming" };
  assert.equal(
    getAppEndpointPath({ appMode: "arcrho", env }),
    path.join(env.APPDATA, "ArcRho", "app_endpoint.json"),
  );
  assert.equal(
    getAppEndpointPath({ appMode: "arcode", env }),
    path.join(env.APPDATA, "Arcode", "app_endpoint.json"),
  );
});

test("writeAppEndpointFile publishes the endpoint and removeAppEndpointFile respects ownership", () => {
  const appdata = makeTempAppData();
  const env = { APPDATA: appdata };
  try {
    const endpointPath = writeAppEndpointFile({
      appMode: "arcrho",
      host: "127.0.0.1",
      port: 31555,
      pid: 4242,
      env,
    });
    assert.equal(endpointPath, getAppEndpointPath({ appMode: "arcrho", env }));
    const payload = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    assert.equal(payload.format, APP_ENDPOINT_FORMAT);
    assert.equal(payload.app, "arcrho");
    assert.equal(payload.url, "http://127.0.0.1:31555");
    assert.equal(payload.port, 31555);
    assert.equal(payload.pid, 4242);

    assert.equal(removeAppEndpointFile({ appMode: "arcrho", pid: 9999, env }), false);
    assert.ok(fs.existsSync(endpointPath));
    assert.equal(removeAppEndpointFile({ appMode: "arcrho", pid: 4242, env }), true);
    assert.ok(!fs.existsSync(endpointPath));
    assert.equal(removeAppEndpointFile({ appMode: "arcrho", pid: 4242, env }), false);
  } finally {
    fs.rmSync(appdata, { recursive: true, force: true });
  }
});
