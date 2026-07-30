const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const APP_ENDPOINT_FILE = "app_endpoint.json";
const APP_ENDPOINT_FORMAT = "arcrho-app-endpoint-v1";

function resolvePreferredBackendPort({ appMode, env = process.env } = {}) {
  const defaultPort = appMode === "arcode" ? 28766 : 28765;
  const configured = parseInt(String(env.ARCRHO_PORT || env.ARCODE_PORT || ""), 10);
  if (Number.isInteger(configured) && configured > 0 && configured <= 65535) return configured;
  return defaultPort;
}

function tryBindPort(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(null));
    probe.listen(port, host, () => {
      const boundPort = probe.address().port;
      probe.close(() => resolve(boundPort));
    });
  });
}

async function findAvailableBackendPort(host, preferredPort) {
  if ((await tryBindPort(host, preferredPort)) === preferredPort) {
    return { port: preferredPort, fallback: false };
  }
  const freePort = await tryBindPort(host, 0);
  if (freePort == null) {
    throw new Error(`No free local port is available on ${host}.`);
  }
  return { port: freePort, fallback: true };
}

function getAppEndpointPath({ appMode, env = process.env } = {}) {
  const appdata = String(env.APPDATA || "").trim()
    || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appdata, appMode === "arcode" ? "Arcode" : "ArcRho", APP_ENDPOINT_FILE);
}

function writeAppEndpointFile({ appMode, host, port, pid, env = process.env } = {}) {
  const endpointPath = getAppEndpointPath({ appMode, env });
  const payload = {
    format: APP_ENDPOINT_FORMAT,
    app: appMode === "arcode" ? "arcode" : "arcrho",
    url: `http://${host}:${port}`,
    host: String(host),
    port: Number(port),
    pid: Number(pid),
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
  const tempPath = `${endpointPath}.${pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, endpointPath);
  return endpointPath;
}

function removeAppEndpointFile({ appMode, pid, env = process.env } = {}) {
  const endpointPath = getAppEndpointPath({ appMode, env });
  try {
    const payload = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    if (Number(payload?.pid) !== Number(pid)) return false;
    fs.unlinkSync(endpointPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  APP_ENDPOINT_FORMAT,
  resolvePreferredBackendPort,
  findAvailableBackendPort,
  getAppEndpointPath,
  writeAppEndpointFile,
  removeAppEndpointFile,
};
