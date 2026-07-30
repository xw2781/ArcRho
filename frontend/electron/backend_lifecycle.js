// Bundled app-server lifecycle: spawn, health, port selection, client markers,
// endpoint publishing, and shutdown coordination for the Electron host.
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  backendArtifactIdForBundle,
  isCompatibleBackendHealth: isCompatibleBackendHealthResponse,
} = require("./backend_health_compatibility");
const {
  resolvePreferredBackendPort,
  findAvailableBackendPort,
  writeAppEndpointFile,
  removeAppEndpointFile,
} = require("./backend_port");
const {
  sleep,
  getTimestampForFileName,
  appendElectronLog,
  execFileAsync,
  isProcessAlive,
} = require("./host_support");

const BACKEND_CONTROL_FLAGS = [
  ".restart_app",
  ".shutdown_app",
  ".restart_electron",
  ".shutdown_electron",
];

// Host context; set once via initBackendLifecycle before any other call.
let APP_MODE = "arcrho";
let HOST = "127.0.0.1";
let BACKEND_TOKEN = "";
let APP_ROOT = "";
let PYTHON_EXE = "python";
let PREFERRED_PORT = 28765;
// The effective backend port. Starts at the preferred port and moves to a free
// fallback port when the preferred one is held by a listener this process
// cannot reuse or clear (for example another user's session on a shared PC).
let PORT = 28765;
let BACKEND_STARTUP_TIMEOUT_MS = 30000;
let BACKEND_STARTUP_ATTEMPTS = 2;

let serverProc = null;
let serverLogStream = null;
let lastServerLogPath = "";
let backendOwned = false;
let serverSpawnError = null;
let backendShutdownPromise = null;
let backendClientMarkerPath = "";
let backendArtifactId = "";
let backendArtifactIdPromise = null;

function initBackendLifecycle({ appMode, host, backendToken, appRoot, pythonExe } = {}) {
  APP_MODE = appMode === "arcode" ? "arcode" : "arcrho";
  HOST = host || "127.0.0.1";
  BACKEND_TOKEN = String(backendToken || "");
  APP_ROOT = appRoot || "";
  PYTHON_EXE = pythonExe || "python";
  PREFERRED_PORT = resolvePreferredBackendPort({ appMode: APP_MODE, env: process.env });
  PORT = PREFERRED_PORT;
  BACKEND_STARTUP_TIMEOUT_MS = Math.max(
    5000,
    parseInt(
      (APP_MODE === "arcode" ? process.env.ARCODE_BACKEND_STARTUP_TIMEOUT_MS : process.env.ARCRHO_BACKEND_STARTUP_TIMEOUT_MS)
        || "30000",
      10
    ) || 30000
  );
  BACKEND_STARTUP_ATTEMPTS = Math.max(
    1,
    parseInt(
      (APP_MODE === "arcode" ? process.env.ARCODE_BACKEND_STARTUP_ATTEMPTS : process.env.ARCRHO_BACKEND_STARTUP_ATTEMPTS)
        || "2",
      10
    ) || 2
  );
}

function getBackendPort() {
  return PORT;
}

function cleanupBackendEndpoint() {
  removeAppEndpointFile({ appMode: APP_MODE, pid: process.pid });
}

function getBundledServerPath() {
  // Check if running as packaged app
  if (app.isPackaged) {
    const serverName = APP_MODE === "arcode" ? "arcode_server" : "arcrho_server";
    const resourcesPath = process.resourcesPath;
    return path.join(resourcesPath, serverName, `${serverName}.exe`);
  }
  return null;
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


function readAliveBackendClientMarkers() {
  const markers = [];
  try {
    const dir = getBackendClientDir();
    if (!fs.existsSync(dir)) return markers;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      let payload = null;
      let pid = 0;
      try {
        payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
        pid = Number(payload?.pid || 0);
      } catch {
        pid = Number(path.basename(entry.name, ".json")) || 0;
      }
      if (!isProcessAlive(pid)) {
        try { fs.unlinkSync(filePath); } catch {}
        continue;
      }
      markers.push({ pid, mode: String(payload?.mode || ""), port: Number(payload?.port || 0) });
    }
  } catch {
    return markers;
  }
  return markers;
}

function getOtherBackendClientCount() {
  return readAliveBackendClientMarkers().filter((marker) => marker.pid !== process.pid).length;
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


function requestBackendHealth(timeoutMs = 1000, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${HOST}:${port}/app/health`, (res) => {
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

async function getBackendPortListenerPids(port = PORT) {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true });
    const pids = new Set();
    for (const line of String(stdout || "").split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/\bLISTENING\b/i.test(line)) continue;
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
  return isCompatibleBackendHealthResponse(health, {
    appMode: APP_MODE,
    backendToken: BACKEND_TOKEN,
    appRoot: APP_ROOT,
    backendArtifactId,
    allowProjectRootFallback: !app.isPackaged,
  });
}

async function ensureBackendArtifactId() {
  if (!app.isPackaged) return "";
  if (backendArtifactId) return backendArtifactId;
  const bundledServer = getBundledServerPath();
  if (!bundledServer || !fs.existsSync(bundledServer)) {
    throw new Error("Bundled app server executable is missing.");
  }
  if (!backendArtifactIdPromise) {
    backendArtifactIdPromise = backendArtifactIdForBundle(bundledServer)
      .then((artifactId) => {
        backendArtifactId = artifactId;
        return artifactId;
      })
      .catch((error) => {
        backendArtifactIdPromise = null;
        throw error;
      });
  }
  return backendArtifactIdPromise;
}

async function stopMismatchedBackendListener(port = PORT) {
  let health = null;
  try {
    health = await requestBackendHealth(700, port);
  } catch {}
  if (isCompatibleBackendHealth(health)) return;
  const pids = await getBackendPortListenerPids(port);
  for (const pid of pids) {
    if (serverProc && pid === serverProc.pid) continue;
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {}
  }
  if (pids.length) await sleep(700);
}

function getKnownBackendClientPorts() {
  const ports = [];
  for (const marker of readAliveBackendClientMarkers()) {
    if (marker.pid === process.pid) continue;
    if (marker.mode && marker.mode !== APP_MODE) continue;
    if (Number.isInteger(marker.port) && marker.port > 0 && marker.port <= 65535) {
      ports.push(marker.port);
    }
  }
  return ports;
}

async function findReusableBackendPort() {
  const candidates = new Set([PREFERRED_PORT, PORT, ...getKnownBackendClientPorts()]);
  for (const port of candidates) {
    try {
      const health = await requestBackendHealth(700, port);
      if (isCompatibleBackendHealth(health)) return port;
    } catch {
      // No compatible backend on this candidate port.
    }
  }
  return null;
}

function publishBackendEndpoint() {
  try {
    writeAppEndpointFile({ appMode: APP_MODE, host: HOST, port: PORT, pid: process.pid });
  } catch (err) {
    appendElectronLog(`Failed to write app endpoint file: ${err?.message || err}`);
  }
}

function startBackend() {
  const env = { ...process.env };
  env.TRI_DATA_DIR = env.TRI_DATA_DIR || APP_ROOT;
  delete env.ARCODE_BACKEND_ARTIFACT_ID;
  delete env.ARCRHO_BACKEND_ARTIFACT_ID;
  if (APP_MODE === "arcode") {
    env.ARCODE_DATA_DIR = env.ARCODE_DATA_DIR || path.join(os.homedir(), "Documents", "Arcode", "scripts");
    env.ARCODE_BACKEND_TOKEN = BACKEND_TOKEN;
    if (backendArtifactId) env.ARCODE_BACKEND_ARTIFACT_ID = backendArtifactId;
    env.ARCRHO_APP_MODE = "arcode";
  } else {
    env.ARCRHO_WORKFLOW_DIR =
      env.ARCRHO_WORKFLOW_DIR ||
      path.join(os.homedir(), "Documents", "ArcRho", "workflows");
  }
  env.ARCRHO_BACKEND_TOKEN = BACKEND_TOKEN;
  if (backendArtifactId) env.ARCRHO_BACKEND_ARTIFACT_ID = backendArtifactId;
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
  await ensureBackendArtifactId();
  let lastErr = null;
  for (let attempt = 1; attempt <= BACKEND_STARTUP_ATTEMPTS; attempt++) {
    clearBackendControlFlags();
    const reusablePort = await findReusableBackendPort();
    if (reusablePort != null) {
      PORT = reusablePort;
      backendOwned = false;
      serverProc = null;
      appendElectronLog(`Reusing existing ArcRho backend on ${HOST}:${PORT}.`);
      publishBackendEndpoint();
      return;
    }
    await stopMismatchedBackendListener(PREFERRED_PORT);
    const { port, fallback } = await findAvailableBackendPort(HOST, PREFERRED_PORT);
    PORT = port;
    if (fallback) {
      appendElectronLog(
        `Backend port ${PREFERRED_PORT} is unavailable (possibly held by another user session on this machine); using free local port ${PORT} instead.`
      );
    }
    startBackend();
    try {
      await waitForServer(BACKEND_STARTUP_TIMEOUT_MS);
      publishBackendEndpoint();
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

module.exports = {
  initBackendLifecycle,
  getBackendPort,
  startBackendWithRetry,
  requestBackendShutdown,
  registerBackendClient,
  unregisterBackendClient,
  clearBackendControlFlags,
  cleanupBackendEndpoint,
};
