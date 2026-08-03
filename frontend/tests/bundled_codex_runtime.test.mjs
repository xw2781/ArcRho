import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  assertMinimumCodexVersion,
  assertRequiredBundledModel,
  compareSemanticVersions,
  loadRuntimeContract,
  smokeBundledCodexRuntime,
  validateBundledCodexRuntime,
} = require("../build/validate_bundled_codex_runtime.js");

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(TESTS_DIR, "..");
const RUNTIME_ROOT = path.join(FRONTEND_DIR, "node-portable");

const readText = (relativePath) => fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8",
);

test("tracked ArcBot runtime contract sets the Codex CLI and model floors", () => {
  assert.deepEqual(loadRuntimeContract(), {
    schemaVersion: 1,
    minimumCodexCliVersion: "0.146.0",
    minimumDefaultModel: "gpt-5.6-sol",
  });
});

test("Codex CLI minimum comparison follows semantic-version precedence", () => {
  assert.ok(compareSemanticVersions("0.146.1", "0.146.0") > 0);
  assert.equal(compareSemanticVersions("0.146.0+build.2", "0.146.0"), 0);
  assert.ok(compareSemanticVersions("0.146.0-rc.1", "0.146.0") < 0);
  assert.throws(
    () => assertMinimumCodexVersion("0.145.9", "0.146.0"),
    /below the required minimum 0\.146\.0/iu,
  );
});

test("bundled model catalog requires the configured model to be listed", () => {
  const model = assertRequiredBundledModel(JSON.stringify({
    models: [{ slug: "gpt-5.6-sol", visibility: "list" }],
  }), "gpt-5.6-sol");
  assert.equal(model.slug, "gpt-5.6-sol");
  assert.throws(
    () => assertRequiredBundledModel(JSON.stringify({
      models: [{ slug: "gpt-5.6-sol", visibility: "hide" }],
    }), "gpt-5.6-sol"),
    /not visible/iu,
  );
  assert.throws(
    () => assertRequiredBundledModel(JSON.stringify({ models: [] }), "gpt-5.6-sol"),
    /missing required model/iu,
  );
});

test("bundled Node, npm, and Codex runtime is rejected when stale or fully smoked", async () => {
  const runtimeContract = loadRuntimeContract();
  const installedPackage = JSON.parse(fs.readFileSync(
    path.join(RUNTIME_ROOT, "node_modules", "@openai", "codex", "package.json"),
    "utf8",
  ));
  if (compareSemanticVersions(
    installedPackage.version,
    runtimeContract.minimumCodexCliVersion,
  ) < 0) {
    assert.throws(
      () => validateBundledCodexRuntime(RUNTIME_ROOT),
      new RegExp(
        `Codex CLI ${installedPackage.version} is below the required minimum ${runtimeContract.minimumCodexCliVersion}`,
        "iu",
      ),
    );
    return;
  }

  const smokeCwd = fs.mkdtempSync(path.join(TESTS_DIR, "bundled-codex-runtime-"));
  try {
    const result = await smokeBundledCodexRuntime(RUNTIME_ROOT, {
      cwd: smokeCwd,
      timeoutMs: 8_000,
    });

    assert.equal(result.runtimeRoot, fs.realpathSync(RUNTIME_ROOT));
    assert.match(result.npmVersion, /^\d+\.\d+\.\d+/u);
    assert.match(result.codexVersion, /^codex-cli\s+\d+\.\d+\.\d+/u);
    assert.equal(result.codexCliVersion, result.codexPackageVersion);
    assert.equal(result.requiredModel.slug, runtimeContract.minimumDefaultModel);
    assert.equal(result.requiredModel.visibility, "list");
    for (const filePath of Object.values(result.files)) {
      assert.ok(fs.statSync(filePath).isFile(), filePath);
      assert.ok(fs.statSync(filePath).size > 0, filePath);
    }
    assert.doesNotMatch(result.cwd, /\.asar(?:[\\/]|$)/iu);
  } finally {
    fs.rmSync(smokeCwd, { recursive: true, force: true });
  }
});

test("runtime inventory rejects an incomplete portable Node directory", () => {
  const incompleteRoot = fs.mkdtempSync(path.join(TESTS_DIR, "incomplete-codex-runtime-"));
  try {
    assert.throws(
      () => validateBundledCodexRuntime(incompleteRoot),
      /node\.exe is missing/iu,
    );
  } finally {
    fs.rmSync(incompleteRoot, { recursive: true, force: true });
  }
});

test("ArcRho and Arcode package node-portable as an external runtime resource", () => {
  const packageJson = JSON.parse(readText("../package.json"));
  const arcodeConfig = JSON.parse(readText("../electron-builder.arcode.json"));

  for (const [name, config] of [
    ["ArcRho", packageJson.build],
    ["Arcode", arcodeConfig],
  ]) {
    assert.ok(config.files.includes("!node-portable/**"), `${name} must keep node-portable out of app.asar`);
    assert.deepEqual(
      config.extraResources.find((resource) => resource.from === "node-portable"),
      { from: "node-portable", to: "node-portable" },
      `${name} must copy the complete portable runtime beside app.asar`,
    );
  }
});

test("source ZIP validation requires the full npm and Codex payload", () => {
  const sourceZip = readText("../build/create_build_source_zip.ps1");
  for (const requiredPath of [
    "frontend/build/refresh_bundled_codex_runtime.ps1",
    "frontend/build/validate_bundled_codex_runtime.js",
    "frontend/electron/arcbot_runtime_contract.json",
    "frontend/node-portable/node.exe",
    "frontend/node-portable/npm.cmd",
    "frontend/node-portable/node_modules/npm/bin/npm-cli.js",
    "frontend/node-portable/codex.cmd",
    "frontend/node-portable/node_modules/@openai/codex/bin/codex.js",
    "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  ]) {
    assert.ok(sourceZip.includes(`"${requiredPath}"`), `ZIP contract is missing ${requiredPath}`);
  }
  assert.match(sourceZip, /--runtime-root \$bundledRuntimeRoot --inventory-only/u);
});

test("bundled runtime refresh reads the tracked CLI version contract", () => {
  const refreshScript = readText("../build/refresh_bundled_codex_runtime.ps1");
  assert.match(refreshScript, /arcbot_runtime_contract\.json/u);
  assert.match(refreshScript, /minimumCodexCliVersion/u);
  assert.match(refreshScript, /"@openai\/codex@\$codexVersion"/u);
  assert.match(refreshScript, /validate_bundled_codex_runtime\.js/u);
});

test("the one-click build smokes source and packaged runtimes before publication and cleanup", () => {
  const wrapper = readText("../build/build_app_via_local_workspace.bat");
  const sourceSmokeAt = wrapper.indexOf('call :validate_bundled_codex_runtime "%NODE_HOME%" "%APP_ROOT%"');
  const electronBuildAt = wrapper.indexOf("call :run_electron");
  const packagedRootAt = wrapper.indexOf("dist\\win-unpacked\\resources\\node-portable");
  const packagedSmokeAt = wrapper.indexOf(
    'call :validate_bundled_codex_runtime "%PACKAGED_NODE_HOME%" "%APP_ROOT%"',
  );
  const publishAt = wrapper.indexOf("Step 6: Publishing installer update feed");
  const cleanupAt = wrapper.indexOf('rmdir /s /q "dist\\win-unpacked"');

  assert.ok(sourceSmokeAt >= 0 && sourceSmokeAt < electronBuildAt);
  assert.ok(electronBuildAt < packagedRootAt && packagedRootAt < packagedSmokeAt);
  assert.ok(packagedSmokeAt < publishAt && publishAt < cleanupAt);
  assert.match(
    wrapper,
    /call "%~1\\node\.exe" "%APP_ROOT%\\build\\validate_bundled_codex_runtime\.js"/u,
  );
});
