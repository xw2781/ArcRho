// The Electron host's copy of the persisted-JSON text layout.
//
// `arcrho_api/io.py` (`persisted_json_text`) owns the on-disk text of every
// persisted ArcRho JSON file: two-space indentation, one row per line for a
// two-dimensional array, and a single trailing newline. The host process
// cannot import Python, so it keeps this one mirror, pinned byte for byte to
// the canonical text by `tests/test_host_json_text_parity.py`.
//
// It exists for files the host writes on its own - DFM templates, Arcode
// notebooks, ratio-undo steps, ArcBot exchange copies and manifests. Persisted
// project data (method JSON, sidecars, index files) is written by the app
// server through the Python owner, never from here: JavaScript cannot tell
// `1` from `1.0`, so a number the Python side would write as `1.0` cannot be
// reproduced from this process at all.
//
// Dependency-free on purpose, so a plain Node process can load it for tests.

function isRowArray(value) {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

function formatRowArrayLines(rows, indent) {
  return rows
    .map((row) => `${indent}[${row.map((value) => JSON.stringify(value)).join(", ")}]`)
    .join(",\n");
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

// The complete on-disk text of a JSON document, trailing newline included.
function formatJsonForSave(data) {
  const text = formatJsonWithCompactRowArrays(data);
  return text.endsWith("\n") ? text : `${text}\n`;
}

module.exports = {
  formatJsonForSave,
};
