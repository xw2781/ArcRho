"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "..", "..");
const nsisUtil = require(path.join(
  repoRoot,
  "frontend",
  "node_modules",
  "app-builder-lib",
  "out",
  "targets",
  "nsis",
  "nsisUtil.js"
));

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments; received ${key || "<end>"}.`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const key of [
    "script",
    "output",
    "payload",
    "deployer",
    "version",
  ]) {
    if (!options[key]) throw new Error(`Missing --${key}.`);
  }
  for (const key of ["script", "output", "payload", "deployer"]) {
    options[key] = path.resolve(options[key]);
  }
  const version = options.version.trim();
  const core = version.split(/[+-]/, 1)[0].split(".");
  if (core.length !== 3 || core.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  nsisUtil.NsisTargetOptions.resolve({});
  const nsisRoot = await nsisUtil.NSIS_PATH();
  const makensis = path.join(nsisRoot, "Bin", "makensis.exe");
  if (!fs.existsSync(makensis)) {
    throw new Error(`makensis was not found: ${makensis}`);
  }
  const args = [
    "-WX",
    "-INPUTCHARSET",
    "UTF8",
    `-DPRODUCT_VERSION=${version}`,
    `-DWINDOWS_VERSION=${core.join(".")}.0`,
    `-DOUTPUT_FILE=${options.output}`,
    `-DPAYLOAD_DIR=${options.payload}`,
    `-DDEPLOYER_EXE=${options.deployer}`,
    options.script,
  ];
  const completed = spawnSync(makensis, args, {
    cwd: path.dirname(options.script),
    env: { ...process.env, NSISDIR: nsisRoot },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(`makensis failed with exit code ${completed.status}.`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
