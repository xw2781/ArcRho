// Thirty-day retention for the log files the Electron host writes.
//
// The host opens a new file per app launch and ArcBot opens one per request,
// so nothing here is ever overwritten and a machine kept every log it had ever
// produced. The rule itself is owned by
// python-api/src/arcrho_log_retention_contract.py; this is the host's mirror of
// it, because JavaScript cannot import the Python module, and
// frontend/tests/log_retention.test.mjs pins the two together.
//
// Retention never fails a launch: every error is swallowed, so a locked file
// only leaves an old log behind.
const fs = require("fs");
const path = require("path");

const LOG_RETENTION_DAYS = 30;
const LOG_FILE_SUFFIXES = [".log", ".jsonl"];

function isLogName(name, suffixes) {
  const lastDot = name.lastIndexOf(".");
  const tail = lastDot < 0 ? "" : name.slice(lastDot + 1);
  const base = tail && /^\d+$/.test(tail) ? name.slice(0, lastDot) : name;
  const lowered = base.toLowerCase();
  return suffixes.some((suffix) => lowered.endsWith(suffix));
}

// Deletes every log file in the directory last written before the cutoff and
// returns how many went. Returns 0 for a directory that does not exist yet.
function pruneAgedLogFiles(directory, { suffixes = LOG_FILE_SUFFIXES, days = LOG_RETENTION_DAYS, now = null } = {}) {
  const lowered = suffixes.map((suffix) => String(suffix).toLowerCase());
  const cutoff = (now === null ? Date.now() : now) - days * 86400000;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      if (!entry.isFile() || !isLogName(entry.name, lowered)) continue;
      const filePath = path.join(directory, entry.name);
      if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

module.exports = {
  LOG_RETENTION_DAYS,
  LOG_FILE_SUFFIXES,
  pruneAgedLogFiles,
};
