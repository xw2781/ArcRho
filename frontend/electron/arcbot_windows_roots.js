const { execFile } = require("child_process");
const https = require("https");
const tls = require("tls");

// A TLS-inspecting proxy (CrowdStrike Falcon on the Server PC) re-signs every
// certificate with a root that only the Windows store trusts; Node checks
// against its own bundled roots. After one such failure the Claude calls retry
// with the Windows roots added, and keep using them for the rest of the session.
const CERT_TRUST_ERRORS = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const EXPORT_ROOTS_SCRIPT =
  "Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root | ForEach-Object { [Convert]::ToBase64String($_.RawData) }";

let agentPromise = null;
let activeAgent = null;

function isCertTrustError(error) {
  return CERT_TRUST_ERRORS.has(error?.code);
}

function toPem(base64) {
  return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----`;
}

// Resolves to an https.Agent trusting Node's roots plus the Windows ones, or null.
function loadWindowsRootAgent() {
  if (agentPromise) return agentPromise;
  agentPromise = new Promise((resolve) => {
    if (process.platform !== "win32") { resolve(null); return; }
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", EXPORT_ROOTS_SCRIPT],
      { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const roots = [...new Set(String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
        if (error || !roots.length) { resolve(null); return; }
        activeAgent = new https.Agent({ keepAlive: true, ca: [...tls.rootCertificates, ...roots.map(toPem)] });
        resolve(activeAgent);
      });
  });
  return agentPromise;
}

// The agent to start a request with: the Windows-roots one once a proxy was seen.
function currentAgent() {
  return activeAgent || undefined;
}

module.exports = { currentAgent, isCertTrustError, loadWindowsRootAgent };
