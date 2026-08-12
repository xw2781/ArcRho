const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BACKEND_ARTIFACT_MANIFEST = "backend-artifact.json";
const BACKEND_ARTIFACT_FORMAT = "arcrho-backend-artifact-v1";
const BACKEND_TOKEN_FORMAT = "arcrho-backend-token-v2";

function backendProfileIdForUserData({ appMode, userDataPath }) {
  const mode = appMode === "arcode" ? "arcode" : "arcrho";
  const rawPath = String(userDataPath || "").trim();
  if (!rawPath) throw new Error("Electron user-data path is required.");
  let profilePath = path.resolve(rawPath);
  if (process.platform === "win32") profilePath = profilePath.toLowerCase();
  return crypto.createHash("sha256").update(`${mode}\0${profilePath}`, "utf8").digest("hex");
}

function createBackendLaunchToken({ appMode, userDataPath, nonce }) {
  const nonceText = String(nonce || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32,}$/.test(nonceText)) {
    throw new Error("Backend launch-token nonce must be at least 128 bits of hexadecimal text.");
  }
  const profileId = backendProfileIdForUserData({ appMode, userDataPath });
  return `${BACKEND_TOKEN_FORMAT}:${profileId}:${nonceText}`;
}

function backendProfileIdFromLaunchToken(value) {
  const match = new RegExp(`^${BACKEND_TOKEN_FORMAT}:([a-f0-9]{64}):[a-f0-9]{32,}$`).exec(
    String(value || "").trim().toLowerCase(),
  );
  return match ? match[1] : "";
}

function isBackendHealthFromSameProfile(health, { appMode, backendToken }) {
  if (!health || health.ok !== true) return false;
  const expectedApp = appMode === "arcode" ? "arcode" : "arcrho";
  if (String(health.app || "").trim().toLowerCase() !== expectedApp) return false;
  const expectedProfileId = backendProfileIdFromLaunchToken(backendToken);
  const healthProfileId = backendProfileIdFromLaunchToken(health.token);
  return !!expectedProfileId && healthProfileId === expectedProfileId;
}

function backendArtifactIdFromManifestPayload(payload) {
  if (!payload || payload.format !== BACKEND_ARTIFACT_FORMAT) {
    throw new Error("Bundled backend artifact manifest has an unsupported format.");
  }
  const artifactId = String(payload.artifact_id || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(artifactId)) {
    throw new Error("Bundled backend artifact manifest has an invalid artifact ID.");
  }
  return artifactId;
}

async function backendArtifactIdForBundle(serverExecutablePath) {
  const executablePath = String(serverExecutablePath || "").trim();
  if (!executablePath) throw new Error("Backend executable path is required.");
  const manifestPath = path.join(path.dirname(path.resolve(executablePath)), BACKEND_ARTIFACT_MANIFEST);
  const raw = await fs.promises.readFile(manifestPath, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Bundled backend artifact manifest is invalid JSON: ${error.message}`);
  }
  return backendArtifactIdFromManifestPayload(payload);
}

function pathsMatch(left, right) {
  const leftText = String(left || "").trim();
  const rightText = String(right || "").trim();
  if (!leftText || !rightText) return false;
  try {
    return path.resolve(leftText).toLowerCase() === path.resolve(rightText).toLowerCase();
  } catch {
    return false;
  }
}

function isCompatibleBackendHealth(health, {
  appMode,
  backendToken,
  appRoot,
  backendArtifactId,
  allowProjectRootFallback = false,
}) {
  if (!health || health.ok !== true) return false;
  const expectedApp = String(appMode || "").trim().toLowerCase();
  const healthApp = String(health.app || "").trim().toLowerCase();
  if (!expectedApp || healthApp !== expectedApp) return false;
  const expectedToken = String(backendToken || "").trim();
  const healthToken = String(health.token || "").trim();
  if (expectedToken && healthToken === expectedToken) return true;

  // A packaged artifact can be reused by another ArcRho window only inside the same Electron
  // user-data profile. Loopback ports are machine-wide on Windows, so artifact identity alone
  // would let another signed-in Windows user attach to this backend and read its %APPDATA% state.
  if (!isBackendHealthFromSameProfile(health, { appMode, backendToken: expectedToken })) return false;

  const expectedArtifactId = String(backendArtifactId || "").trim().toLowerCase();
  const healthArtifactId = String(
    health.backend_artifact_id || health.backendArtifactId || "",
  ).trim().toLowerCase();
  if (expectedArtifactId) {
    return healthArtifactId === expectedArtifactId;
  }

  return allowProjectRootFallback
    && pathsMatch(health.project_root || health.projectRoot, appRoot);
}

module.exports = {
  backendArtifactIdForBundle,
  backendArtifactIdFromManifestPayload,
  backendProfileIdForUserData,
  backendProfileIdFromLaunchToken,
  createBackendLaunchToken,
  isBackendHealthFromSameProfile,
  isCompatibleBackendHealth,
};
