const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");

// The one-click build smokes the runtime seconds after unpacking the source ZIP,
// so the first launch of the freshly extracted native Codex binary pays for a
// cold file cache and an on-access virus scan. Keep enough headroom that a warm
// sub-second run never gets confused with a genuine runtime failure.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RUNTIME_CONTRACT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "electron",
  "arcbot_runtime_contract.json",
);
const REQUIRED_RUNTIME_FILES = Object.freeze({
  node: "node.exe",
  npmCommand: "npm.cmd",
  npmCli: path.join("node_modules", "npm", "bin", "npm-cli.js"),
  npmPackage: path.join("node_modules", "npm", "package.json"),
  codexCommand: "codex.cmd",
  codexCli: path.join("node_modules", "@openai", "codex", "bin", "codex.js"),
  codexPackage: path.join("node_modules", "@openai", "codex", "package.json"),
});
const CODEX_WINDOWS_PACKAGE = "@openai/codex-win32-x64";
const CODEX_WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const SEMANTIC_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function parseSemanticVersion(value, label = "semantic version") {
  const normalized = String(value || "").trim();
  const match = SEMANTIC_VERSION_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`Invalid ${label}: ${normalized || "<empty>"}`);
  }
  return {
    raw: normalized,
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftIsNumeric = /^\d+$/u.test(left);
  const rightIsNumeric = /^\d+$/u.test(right);
  if (leftIsNumeric && rightIsNumeric) return Number(left) - Number(right);
  if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSemanticVersions(leftValue, rightValue) {
  const left = parseSemanticVersion(leftValue, "Codex CLI version");
  const right = parseSemanticVersion(rightValue, "minimum Codex CLI version");
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = comparePrereleaseIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function normalizeRuntimeContract(value, sourcePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ArcBot runtime contract must be a JSON object: ${sourcePath}`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`Unsupported ArcBot runtime contract schemaVersion in ${sourcePath}: ${value.schemaVersion}`);
  }
  const minimumCodexCliVersion = parseSemanticVersion(
    value.minimumCodexCliVersion,
    "minimumCodexCliVersion",
  ).raw;
  const minimumDefaultModel = String(value.minimumDefaultModel || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(minimumDefaultModel)) {
    throw new Error(`Invalid minimumDefaultModel in ${sourcePath}: ${minimumDefaultModel || "<empty>"}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    minimumCodexCliVersion,
    minimumDefaultModel,
  });
}

function loadRuntimeContract(contractPath = DEFAULT_RUNTIME_CONTRACT_PATH) {
  const resolvedPath = path.resolve(String(contractPath || ""));
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ArcBot runtime contract: ${resolvedPath}`, { cause: error });
  }
  return normalizeRuntimeContract(value, resolvedPath);
}

function assertMinimumCodexVersion(actualVersion, minimumVersion) {
  if (compareSemanticVersions(actualVersion, minimumVersion) < 0) {
    throw new Error(
      `Bundled Codex CLI ${actualVersion} is below the required minimum ${minimumVersion}. `
      + "Refresh frontend/node-portable before building the installer.",
    );
  }
  return actualVersion;
}

function assertRequiredBundledModel(stdout, requiredModel) {
  let payload;
  try {
    payload = JSON.parse(String(stdout || ""));
  } catch (error) {
    throw new Error("Bundled Codex model catalog did not return valid JSON.", { cause: error });
  }
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const match = models.find((model) => model?.slug === requiredModel);
  if (!match) {
    throw new Error(`Bundled Codex model catalog is missing required model ${requiredModel}.`);
  }
  if (String(match.visibility || "").toLowerCase() !== "list") {
    throw new Error(`Bundled Codex model ${requiredModel} is not visible in the model list.`);
  }
  return match;
}

function assertNonEmptyFile(filePath, label) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`Bundled ${label} is missing: ${filePath}`, { cause: error });
  }
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`Bundled ${label} is not a non-empty file: ${filePath}`);
  }
  return filePath;
}

function resolveNativeCodexExecutable(codexPackagePath) {
  let platformPackagePath;
  try {
    const codexRequire = createRequire(codexPackagePath);
    platformPackagePath = codexRequire.resolve(`${CODEX_WINDOWS_PACKAGE}/package.json`);
  } catch (error) {
    throw new Error(
      `Bundled Codex cannot resolve its ${CODEX_WINDOWS_PACKAGE} optional package from ${codexPackagePath}`,
      { cause: error },
    );
  }
  return path.join(
    path.dirname(platformPackagePath),
    "vendor",
    CODEX_WINDOWS_TARGET,
    "bin",
    "codex.exe",
  );
}

function validateBundledCodexRuntime(runtimeRoot, options = {}) {
  const resolvedRoot = path.resolve(String(runtimeRoot || ""));
  let rootStats;
  try {
    rootStats = fs.statSync(resolvedRoot);
  } catch (error) {
    throw new Error(`Bundled Node runtime directory is missing: ${resolvedRoot}`, { cause: error });
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Bundled Node runtime path is not a directory: ${resolvedRoot}`);
  }

  const files = {};
  for (const [name, relativePath] of Object.entries(REQUIRED_RUNTIME_FILES)) {
    files[name] = assertNonEmptyFile(path.join(resolvedRoot, relativePath), relativePath);
  }
  files.nativeCodex = assertNonEmptyFile(
    resolveNativeCodexExecutable(files.codexPackage),
    `${CODEX_WINDOWS_PACKAGE} executable`,
  );

  const runtimeContract = options.runtimeContract
    ? normalizeRuntimeContract(options.runtimeContract, "provided runtime contract")
    : loadRuntimeContract(options.contractPath);
  let codexPackage;
  try {
    codexPackage = JSON.parse(fs.readFileSync(files.codexPackage, "utf8"));
  } catch (error) {
    throw new Error(`Bundled Codex package metadata is invalid: ${files.codexPackage}`, { cause: error });
  }
  const codexPackageVersion = parseSemanticVersion(
    codexPackage?.version,
    "bundled Codex package version",
  ).raw;
  assertMinimumCodexVersion(codexPackageVersion, runtimeContract.minimumCodexCliVersion);

  return {
    runtimeRoot: resolvedRoot,
    files,
    runtimeContract,
    codexPackageVersion,
  };
}

function resolveRealWorkingDirectory(cwd) {
  const requested = path.resolve(String(cwd || ""));
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch (error) {
    throw new Error(`Codex smoke-test working directory is missing: ${requested}`, { cause: error });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Codex smoke-test working path is not a directory: ${resolved}`);
  }
  if (/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/iu.test(resolved)) {
    throw new Error(`Codex smoke-test working directory must not be inside an ASAR: ${resolved}`);
  }
  return resolved;
}

function runChecked(command, args, options, label) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    }, (error, stdoutValue, stderrValue) => {
      const stdout = String(stdoutValue || "").trim();
      const stderr = String(stderrValue || "").trim();
      if (error) {
        if (error.killed) {
          reject(new Error(
            `${label} timed out after ${options.timeoutMs} ms. `
            + "Re-run the build: the first launch of a freshly extracted runtime is slow.",
          ));
          return;
        }
        const detail = [error.message, stderr, stdout].filter(Boolean).join("\n");
        reject(new Error(`${label} failed${detail ? `:\n${detail}` : "."}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function smokeBundledCodexRuntime(runtimeRoot, options = {}) {
  if (process.platform !== "win32") {
    throw new Error("The bundled Codex Windows runtime smoke test requires Windows.");
  }
  const contract = validateBundledCodexRuntime(runtimeRoot, options);
  const cwd = resolveRealWorkingDirectory(options.cwd || process.cwd());
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("Codex smoke-test timeout must be between 1 and 60000 milliseconds.");
  }

  const smokeHome = fs.mkdtempSync(path.join(cwd, ".arcrho-codex-smoke-"));
  const env = { ...process.env, CODEX_HOME: smokeHome };
  try {
    const npm = await runChecked(
      contract.files.node,
      [contract.files.npmCli, "--version"],
      { cwd, env, timeoutMs },
      "Bundled npm --version smoke test",
    );
    const npmVersion = npm.stdout.split(/\r?\n/u)[0] || "";
    if (!/^\d+\.\d+\.\d+(?:[-+][^\s]+)?$/u.test(npmVersion)) {
      throw new Error(`Bundled npm returned an unexpected version: ${npm.stdout || "<empty>"}`);
    }
    const npmPackageVersion = String(
      JSON.parse(fs.readFileSync(contract.files.npmPackage, "utf8")).version || "",
    );
    if (npmVersion !== npmPackageVersion) {
      throw new Error(
        `Bundled npm executable/package version mismatch: ${npmVersion} versus ${npmPackageVersion || "<empty>"}`,
      );
    }

    const codex = await runChecked(
      contract.files.node,
      [contract.files.codexCli, "--version"],
      { cwd, env, timeoutMs },
      "Bundled Codex --version smoke test",
    );
    const codexVersion = codex.stdout.split(/\r?\n/u)[0] || "";
    const codexVersionMatch = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u.exec(codexVersion);
    if (!codexVersionMatch) {
      throw new Error(`Bundled Codex returned an unexpected version: ${codex.stdout || "<empty>"}`);
    }
    const codexCliVersion = parseSemanticVersion(
      codexVersionMatch[1],
      "bundled Codex executable version",
    ).raw;
    if (codexCliVersion !== contract.codexPackageVersion) {
      throw new Error(
        `Bundled Codex executable/package version mismatch: ${codexCliVersion} versus ${contract.codexPackageVersion}`,
      );
    }

    const models = await runChecked(
      contract.files.node,
      [contract.files.codexCli, "debug", "models", "--bundled"],
      { cwd, env, timeoutMs },
      "Bundled Codex model catalog smoke test",
    );
    const requiredModel = assertRequiredBundledModel(
      models.stdout,
      contract.runtimeContract.minimumDefaultModel,
    );

    return {
      ...contract,
      cwd,
      npmVersion,
      codexVersion,
      codexCliVersion,
      requiredModel,
    };
  } finally {
    fs.rmSync(smokeHome, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { inventoryOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--inventory-only") {
      options.inventoryOnly = true;
      continue;
    }
    if (arg === "--runtime-root" || arg === "--cwd" || arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      if (arg === "--runtime-root") options.runtimeRoot = value;
      if (arg === "--cwd") options.cwd = value;
      if (arg === "--timeout-ms") options.timeoutMs = Number(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.runtimeRoot) throw new Error("--runtime-root is required");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = options.inventoryOnly
    ? validateBundledCodexRuntime(options.runtimeRoot)
    : await smokeBundledCodexRuntime(options.runtimeRoot, options);
  if (options.inventoryOnly) {
    console.log(
      `Bundled Node/npm/Codex inventory passed: Codex ${result.codexPackageVersion} `
      + `(minimum ${result.runtimeContract.minimumCodexCliVersion}) at ${result.runtimeRoot}`,
    );
  } else {
    console.log(
      `Bundled npm ${result.npmVersion}, ${result.codexVersion}, and model `
      + `${result.runtimeContract.minimumDefaultModel} passed from ${result.cwd}`,
    );
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  CODEX_WINDOWS_PACKAGE,
  CODEX_WINDOWS_TARGET,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RUNTIME_CONTRACT_PATH,
  REQUIRED_RUNTIME_FILES,
  assertMinimumCodexVersion,
  assertRequiredBundledModel,
  compareSemanticVersions,
  loadRuntimeContract,
  normalizeRuntimeContract,
  parseArguments,
  parseSemanticVersion,
  resolveNativeCodexExecutable,
  resolveRealWorkingDirectory,
  smokeBundledCodexRuntime,
  validateBundledCodexRuntime,
};
