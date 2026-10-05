import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = path.join(repo, "test");
fs.mkdirSync(tempRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(tempRoot, "arcbot-install-"));
const require = createRequire(import.meta.url);
const { registerArcBotIpc, testHooks } = require("../electron/arcbot_host.js");
const host = registerArcBotIpc({
  ipcMain: { handle() {} }, app: { isPackaged: false, getPath: () => scratch },
  APP_ROOT: path.join(repo, "frontend"), REPO_ROOT: repo,
  getPrefsDir: () => scratch, getWorkspacePathsPath: () => "",
});
test.after(() => { host.stop(); fs.rmSync(scratch, { recursive: true, force: true }); });

function install(name, npmLines, versionExit = null) {
  const folder = path.join(scratch, name);
  fs.mkdirSync(folder);
  const prefix = path.join(folder, "install prefix");
  fs.mkdirSync(prefix);
  if (versionExit !== null) fs.writeFileSync(path.join(prefix, "codex.cmd"), `@echo off\r\necho test-codex\r\nexit /b ${versionExit}\r\n`);
  const npm = path.join(folder, "npm.cmd");
  fs.writeFileSync(npm, ["@echo off", ...npmLines, ""].join("\r\n"));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", testHooks.writeCodexInstallScript(), "-NpmCommand", npm, "-InstallPrefix", prefix], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, TEMP: scratch, TMP: scratch },
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr, prefix };
}

test("npm failure cannot report success or accept a stale installed launcher", { skip: process.platform !== "win32" }, () => {
  const result = install("disk-full", ["echo ENOSPC: no space left on device", "exit /b 28"], 0);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /ENOSPC/);
  assert.match(result.output, /npm installation failed/);
  assert.doesNotMatch(result.output, /ARCRHO_CODEX_CMD=|Codex CLI install completed|test-codex/);
});
test("missing per-user launcher is not reported as a successful installation", { skip: process.platform !== "win32" }, () => {
  const result = install("missing-launcher", ["exit /b 0"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /did not create/);
  assert.doesNotMatch(result.output, /Codex CLI install completed/);
});
test("a launcher that cannot start is not saved as the repaired command", { skip: process.platform !== "win32" }, () => {
  const result = install("broken-launcher", ["exit /b 0"], 7);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /could not start/);
  assert.doesNotMatch(result.output, /ARCRHO_CODEX_CMD=|Codex CLI install completed/);
});
test("success follows verification of the launcher inside a prefix containing spaces", { skip: process.platform !== "win32" }, () => {
  const result = install("success", ["exit /b 0"], 0);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes(`ARCRHO_CODEX_CMD=${path.join(result.prefix, "codex.cmd")}`));
  assert.match(result.output, /test-codex[\s\S]*Codex CLI install completed/);
});
