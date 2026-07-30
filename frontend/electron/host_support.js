// Shared host-process utilities: logging, timing, JSON save formatting.
const { app } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let electronLogPath = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatJsonForSave(data) {
  const text = formatJsonWithCompactRowArrays(data);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function isRowArray(value) {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

function formatJsonWithCompactRowArrays(value, indent = "") {
  if (isRowArray(value)) {
    if (!value.length) return "[]";
    return `[\n${formatRowArrayLines(value, `${indent}  `)}\n${indent}]`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const childIndent = `${indent}  `;
    const lines = value.map((item, index) => {
      const rendered = `${childIndent}${formatJsonWithCompactRowArrays(item, childIndent)}`;
      return index < value.length - 1 ? `${rendered},` : rendered;
    });
    return `[\n${lines.join("\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const childIndent = `${indent}  `;
    const lines = keys.map((key, index) => {
      const rendered = `${childIndent}${JSON.stringify(key)}: ${formatJsonWithCompactRowArrays(value[key], childIndent)}`;
      return index < keys.length - 1 ? `${rendered},` : rendered;
    });
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function formatRowArrayLines(rows, indent) {
  return rows
    .map((row) => {
      const vals = row.map((value) => JSON.stringify(value)).join(", ");
      return `${indent}[${vals}]`;
    })
    .join(",\n");
}

function getElectronLogPath() {
  if (electronLogPath) return electronLogPath;
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    electronLogPath = path.join(logDir, `electron-main-${getTimestampForFileName()}.log`);
  } catch {
    const fallbackDir = path.join(os.homedir(), "AppData", "Roaming", "arcrho-electron", "logs");
    fs.mkdirSync(fallbackDir, { recursive: true });
    electronLogPath = path.join(fallbackDir, `electron-main-${getTimestampForFileName()}.log`);
  }
  return electronLogPath;
}

function formatErrorForLog(err) {
  if (!err) return "";
  if (err instanceof Error) return err.stack || err.message || String(err);
  return String(err);
}

function appendElectronLog(message, err = null) {
  try {
    const lines = [`[${new Date().toISOString()}] ${message}`];
    if (err) lines.push(formatErrorForLog(err));
    fs.appendFileSync(getElectronLogPath(), `${lines.join("\n")}\n`, "utf8");
  } catch {}
}

process.on("uncaughtException", (err) => {
  appendElectronLog("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  appendElectronLog("Unhandled promise rejection", reason);
});

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

module.exports = {
  sleep,
  getTimestampForFileName,
  formatJsonForSave,
  getElectronLogPath,
  formatErrorForLog,
  appendElectronLog,
  withTimeout,
  execFileAsync,
  isProcessAlive,
};
