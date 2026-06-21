const FILENAME_SEGMENT_REPLACEMENTS = {
  "\\": "_%5C_",
  "/": "_%2F_",
  ":": "_%3A_",
  "*": "_%2A_",
  "?": "_%3F_",
  "\"": "_%22_",
  "<": "_%3C_",
  ">": "_%3E_",
  "|": "_%7C_",
};

export function encodeFileNameSegment(value) {
  return Array.from(String(value ?? ""), (ch) => {
    if (Object.prototype.hasOwnProperty.call(FILENAME_SEGMENT_REPLACEMENTS, ch)) {
      return FILENAME_SEGMENT_REPLACEMENTS[ch];
    }
    const code = ch.charCodeAt(0);
    if (code < 32) return `_%${code.toString(16).toUpperCase().padStart(2, "0")}_`;
    return ch;
  }).join("");
}

export function decodeFileNameSegment(value) {
  return String(value ?? "").replace(/_%([0-9A-Fa-f]{2})_/g, (match, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : match;
  });
}

export function sanitizeFileNamePart(value, fallback = "File") {
  const cleaned = encodeFileNameSegment(String(value ?? "").trim())
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function sanitizeDataFolderPart(value, fallback = "Folder") {
  const cleaned = encodeFileNameSegment(String(value ?? "").trim())
    .replace(/[. ]+$/g, (match) => "^".repeat(match.length))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}
