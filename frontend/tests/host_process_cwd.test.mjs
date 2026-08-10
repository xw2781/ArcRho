import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

const readText = (relativePath) => fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8"
);

const mainSource = readText("../electron/main.js");

const spawnFrom = (cwd) => new Promise((resolve) => {
  let child = null;
  try {
    child = spawn(process.execPath, ["-e", "0"], { cwd, stdio: "ignore", windowsHide: true });
  } catch (err) {
    resolve({ ok: false, code: String(err?.code || "") });
    return;
  }
  child.once("spawn", () => resolve({ ok: true, code: "" }));
  child.once("error", (err) => resolve({ ok: false, code: String(err?.code || "") }));
});

test("a working directory inside app.asar makes any spawn fail as ENOENT", async () => {
  const asarCwd = path.join(process.cwd(), "resources", "app.asar");
  assert.equal(fs.existsSync(asarCwd), false, "the fixture path must not exist on disk");

  const insideAsar = await spawnFrom(asarCwd);
  assert.equal(insideAsar.ok, false);
  assert.equal(
    insideAsar.code,
    "ENOENT",
    "an unreadable cwd is reported as a missing executable, so host spawns must never use one"
  );

  const realDir = await spawnFrom(process.cwd());
  assert.equal(realDir.ok, true);
});

test("host commands launch from a real directory rather than APP_ROOT", () => {
  assert.match(
    mainSource,
    /function getHostSpawnCwd\(\)/u,
    "main.js must resolve host spawn cwd through getHostSpawnCwd()"
  );
  assert.match(
    mainSource,
    /const \{\s*\n\s*cwd = getHostSpawnCwd\(\),/u,
    "runHostCommand must default its cwd to getHostSpawnCwd()"
  );
  assert.doesNotMatch(
    mainSource,
    /cwd:\s*APP_ROOT\b/u,
    "APP_ROOT resolves inside resources\\app.asar in a packaged build and is not a spawnable cwd"
  );
});

test("getHostSpawnCwd skips asar candidates and falls back to a writable directory", () => {
  const body = /function getHostSpawnCwd\(\)\s*\{[\s\S]*?\n\}/u.exec(mainSource)?.[0] || "";
  assert.ok(body, "getHostSpawnCwd must be defined in main.js");
  assert.match(body, /if \(isAsarPath\(candidate\)\) continue;/u);
  assert.match(body, /fs\.statSync\(candidate\)\.isDirectory\(\)/u);
  assert.match(body, /os\.tmpdir\(\)/u);
  assert.match(mainSource, /function isAsarPath\(filePath\)[\s\S]*?\\\.asar/u);
});

test("Windows PowerShell host calls resolve the interpreter absolutely", () => {
  assert.match(mainSource, /function getWindowsPowerShellCommand\(\)/u);
  assert.match(
    mainSource,
    /path\.join\(systemRoot, "System32", "WindowsPowerShell", "v1\.0", "powershell\.exe"\)/u
  );
  assert.doesNotMatch(
    mainSource,
    /runHostCommand\("powershell\.exe"/u,
    "PATH lookups for powershell.exe are not reliable in a packaged app"
  );
  const powerShellCalls = mainSource.match(/runHostCommand\(getWindowsPowerShellCommand\(\)/gu) || [];
  assert.equal(powerShellCalls.length, 2, "Excel read-only open and open-terminal both use the resolver");
});

test("Excel read-only open reaches Excel directly before the PowerShell fallback", () => {
  const body = /async function openExcelWorkbookReadOnly\(targetPath\)\s*\{[\s\S]*?\n\}/u
    .exec(mainSource)?.[0] || "";
  assert.ok(body, "openExcelWorkbookReadOnly must be defined in main.js");
  assert.match(body, /spawnDetachedOpen\(excelCommand, \["\/r", targetPath\]\)/u);
  assert.match(body, /runHostCommand\(getWindowsPowerShellCommand\(\)/u);
  assert.match(body, /cwd: getHostSpawnCwd\(\)/u);
});
