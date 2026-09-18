import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TEMP_ROOT = path.resolve(FRONTEND_DIR, "..", "test");
fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
const CLOSER = path.join(FRONTEND_DIR, "build", "installer", "close_arcrho_processes.ps1");
// The 32-bit PowerShell, which is what $SYSDIR resolves to for the 32-bit NSIS
// installer; a 64-bit-only machine layout falls back to the native one.
const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const POWERSHELL = [
  path.join(SYSTEM_ROOT, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
].find((candidate) => fs.existsSync(candidate));

function runCloser(args) {
  return spawnSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CLOSER, ...args],
    { encoding: "utf8", timeout: 90000 }
  );
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
}

test(
  "the installer's process closer ends a background process running from the install folder",
  { skip: process.platform !== "win32" || !POWERSHELL },
  async () => {
    const installDir = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, "install-"));
    // A windowless 64-bit process deep in the folder, like the bundled app server.
    const serverDir = path.join(installDir, "resources", "arcrho_server");
    fs.mkdirSync(serverDir, { recursive: true });
    const serverExe = path.join(serverDir, "arcrho_server.exe");
    fs.copyFileSync(process.execPath, serverExe);
    const child = spawn(serverExe, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    try {
      const detect = runCloser(["-InstallDir", installDir, "-DetectOnly"]);
      assert.equal(detect.status, 1, `${detect.stdout}${detect.stderr}`);
      assert.match(detect.stdout, new RegExp(`arcrho_server\\.exe \\(PID ${child.pid}\\)`));
      assert.equal(child.exitCode, null, "-DetectOnly must not close anything");

      const close = runCloser(["-InstallDir", installDir]);
      assert.equal(close.status, 0, `${close.stdout}${close.stderr}`);
      await waitForExit(child);

      const nothingLeft = runCloser(["-InstallDir", installDir]);
      assert.equal(nothingLeft.status, 0, `${nothingLeft.stdout}${nothingLeft.stderr}`);
      assert.equal(nothingLeft.stdout.trim(), "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForExit(child);
      // The copied executable stays locked for a moment after its process ends.
      fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    }
  }
);
