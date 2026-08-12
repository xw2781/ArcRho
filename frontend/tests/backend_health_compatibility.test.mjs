import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  backendArtifactIdFromManifestPayload,
  backendProfileIdFromLaunchToken,
  createBackendLaunchToken,
  isBackendHealthFromSameProfile,
  isCompatibleBackendHealth,
} = require("../electron/backend_health_compatibility.js");

const profileOneToken = createBackendLaunchToken({
  appMode: "arcrho",
  userDataPath: "C:\\Users\\profile-one\\AppData\\Roaming\\arcrho-electron",
  nonce: "1".repeat(32),
});
const profileOneOtherLaunchToken = createBackendLaunchToken({
  appMode: "arcrho",
  userDataPath: "C:\\Users\\profile-one\\AppData\\Roaming\\arcrho-electron",
  nonce: "2".repeat(32),
});
const profileTwoToken = createBackendLaunchToken({
  appMode: "arcrho",
  userDataPath: "C:\\Users\\profile-two\\AppData\\Roaming\\arcrho-electron",
  nonce: "3".repeat(32),
});

const packagedOptions = {
  appMode: "arcrho",
  backendToken: profileOneToken,
  appRoot: "E:\\ArcRho",
  backendArtifactId: "sha256:current-backend",
};

test("reuses an independently started packaged backend only for the same profile and artifact", () => {
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
    backend_artifact_id: "sha256:current-backend",
    build_version: "1.1.7",
    project_root: "E:\\ArcRho\\server\\_internal",
  }, packagedOptions), true);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
    backend_artifact_id: "sha256:older-backend",
    build_version: "1.1.7",
    project_root: "E:\\ArcRho",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
    build_version: "1.1.7",
    project_root: "E:\\ArcRho",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
    backend_artifact_id: "sha256:current-backend",
    project_root: "E:\\DifferentArcRho",
  }, packagedOptions), true);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcode",
    token: profileOneOtherLaunchToken,
    backend_artifact_id: "sha256:current-backend",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    token: profileOneOtherLaunchToken,
    backend_artifact_id: "sha256:current-backend",
  }, packagedOptions), false);

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileTwoToken,
    backend_artifact_id: "sha256:current-backend",
  }, packagedOptions), false, "another Windows profile must not reuse the backend");

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: "legacy-unscoped-token",
    backend_artifact_id: "sha256:current-backend",
  }, packagedOptions), false, "an unscoped backend must fail closed");
});

test("accepts the backend started by this Electron launch", () => {
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneToken,
  }, packagedOptions), true);
});

test("preserves same-root backend reuse in development", () => {
  const developmentOptions = {
    appMode: "arcrho",
    backendToken: profileOneToken,
    appRoot: "E:\\ArcRho",
    backendArtifactId: "",
    allowProjectRootFallback: true,
  };

  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
    project_root: "E:\\ArcRho",
  }, developmentOptions), true);
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
    project_root: "E:\\DifferentArcRho",
  }, developmentOptions), false);
  assert.equal(isCompatibleBackendHealth({
    ok: true,
    app: "arcrho",
    token: profileTwoToken,
    project_root: "E:\\ArcRho",
  }, developmentOptions), false);
});

test("backend launch tokens identify the Electron user-data profile without exposing its path", () => {
  assert.equal(
    backendProfileIdFromLaunchToken(profileOneToken),
    backendProfileIdFromLaunchToken(profileOneOtherLaunchToken),
  );
  assert.notEqual(
    backendProfileIdFromLaunchToken(profileOneToken),
    backendProfileIdFromLaunchToken(profileTwoToken),
  );
  assert.equal(profileOneToken.includes("profile-one"), false);
});

test("backend ownership checks fail closed for another or an unscoped profile", () => {
  const options = { appMode: "arcrho", backendToken: profileOneToken };
  assert.equal(isBackendHealthFromSameProfile({
    ok: true,
    app: "arcrho",
    token: profileOneOtherLaunchToken,
  }, options), true);
  assert.equal(isBackendHealthFromSameProfile({
    ok: true,
    app: "arcrho",
    token: profileTwoToken,
  }, options), false);
  assert.equal(isBackendHealthFromSameProfile({
    ok: true,
    app: "arcrho",
    token: "legacy-unscoped-token",
  }, options), false);
});

test("backend lifecycle bypasses a healthy listener outside the current profile", () => {
  const lifecycleSource = readFileSync(new URL("../electron/backend_lifecycle.js", import.meta.url), "utf8");
  assert.match(lifecycleSource, /health\?\.ok === true && !isBackendHealthFromSameProfile/u);
  assert.match(lifecycleSource, /belongs to another or an unscoped user profile/u);
});

test("Electron creates backend tokens from its current user-data profile", () => {
  const mainSource = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
  assert.match(mainSource, /const BACKEND_TOKEN = createBackendLaunchToken\(\{/u);
  assert.match(mainSource, /userDataPath: app\.getPath\("userData"\)/u);
  assert.match(mainSource, /nonce: crypto\.randomBytes\(16\)\.toString\("hex"\)/u);
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
