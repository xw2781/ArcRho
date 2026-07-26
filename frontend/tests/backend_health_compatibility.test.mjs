import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  backendArtifactIdFromManifestPayload,
  isCompatibleBackendHealth,
} = require("../electron/backend_health_compatibility.js");

const packagedOptions = {
  appMode: "arcrho",
  backendToken: "new-launch-token",
  appRoot: "E:\\ArcRho",
  backendArtifactId: "sha256:current-backend",
};

test("reuses an independently started packaged backend only for the same artifact", () => {
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    backend_artifact_id: "sha256:current-backend",
    build_version: "1.1.7",
    project_root: "E:\\ArcRho\\server\\_internal",
  }, packagedOptions), true);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    backend_artifact_id: "sha256:older-backend",
    build_version: "1.1.7",
    project_root: "E:\\ArcRho",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    build_version: "1.1.7",
    project_root: "E:\\ArcRho",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    backend_artifact_id: "sha256:current-backend",
    project_root: "E:\\DifferentArcRho",
  }, packagedOptions), true);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcode",
    backend_artifact_id: "sha256:current-backend",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    backend_artifact_id: "sha256:current-backend",
  }, packagedOptions), false);
});

test("accepts the backend started by this Electron launch", () => {
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: "new-launch-token",
  }, packagedOptions), true);
});

test("preserves same-root backend reuse in development", () => {
  const developmentOptions = {
    appMode: "arcrho",
    backendToken: "new-launch-token",
    appRoot: "E:\\ArcRho",
    backendArtifactId: "",
    allowProjectRootFallback: true,
  };

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    project_root: "E:\\ArcRho",
  }, developmentOptions), true);
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    project_root: "E:\\DifferentArcRho",
  }, developmentOptions), false);
});

test("accepts only a valid collected-backend artifact manifest", () => {
  const artifactId = `sha256:${"a".repeat(64)}`;
  assert.equal(backendArtifactIdFromManifestPayload({
    format: "arcrho-backend-artifact-v1",
    artifact_id: artifactId,
    file_count: 3,
  }), artifactId);
  assert.throws(
    () => backendArtifactIdFromManifestPayload({
      format: "older-format",
      artifact_id: artifactId,
    }),
    /unsupported format/,
  );
  assert.throws(
    () => backendArtifactIdFromManifestPayload({
      format: "arcrho-backend-artifact-v1",
      artifact_id: "sha256:not-a-digest",
    }),
    /invalid artifact ID/,
  );
});
