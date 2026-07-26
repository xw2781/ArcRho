const fs = require("fs");
const path = require("path");

const BACKEND_ARTIFACT_MANIFEST = "backend-artifact.json";
const BACKEND_ARTIFACT_FORMAT = "arcrho-backend-artifact-v1";

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
  if (expectedToken && String(health.token || "").trim() === expectedToken) return true;

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
  isCompatibleBackendHealth,
};
