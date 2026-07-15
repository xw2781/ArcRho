const LINK_FILE_EXTENSIONS = Object.freeze([
  "xlsx",
  "xlsm",
  "xlsb",
  "xls",
  "csv",
  "txt",
  "json",
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
]);

const FILE_EXTENSION_BOUNDARY_RE = new RegExp(
  "\\.(" + LINK_FILE_EXTENSIONS.join("|") + ")(?=$|[\\s)\"'\\x60,;:!?])",
  "iu",
);
const EXCEL_WORKBOOK_RE = /\.(xlsx|xlsm|xlsb|xls)$/iu;
const PATH_PATTERNS = Object.freeze([
  /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n\\]*/gu,
  /\\\\[^\\/:*?"<>|\r\n]+\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n\\]+)*/gu,
]);

/**
 * Removes punctuation that commonly surrounds a Windows path in prose.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeNotesPathToken(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^[("'\x60]+/u, "")
    .replace(/[)"'\x60,.;:!?]+$/u, "");
}

/**
 * Stops a prose match after a known file extension, while preserving paths
 * whose directory name happens to contain one of those extensions.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function trimNotesPathTokenAtKnownFileExtension(raw) {
  const text = String(raw ?? "");
  const match = FILE_EXTENSION_BOUNDARY_RE.exec(text);
  if (!match || !Number.isFinite(match.index)) return text;

  const end = match.index + String(match[0] || "").length;
  if (text.slice(end).includes("\\")) return text;
  return text.slice(0, end);
}

/**
 * Returns true when the target is an Excel workbook supported by the
 * read-only open action.
 *
 * @param {unknown} targetPath
 * @returns {boolean}
 */
export function isExcelWorkbookPath(targetPath) {
  return EXCEL_WORKBOOK_RE.test(sanitizeNotesPathToken(targetPath));
}

/**
 * Finds non-overlapping Windows drive and UNC paths in source text.
 *
 * @param {unknown} value
 * @returns {Array<{start: number, end: number, path: string}>}
 */
export function findNotesPathMatches(value) {
  const source = String(value ?? "");
  if (!source) return [];

  const matches = [];
  for (const pathPattern of PATH_PATTERNS) {
    pathPattern.lastIndex = 0;
    let match;
    while ((match = pathPattern.exec(source)) !== null) {
      const raw = String(match[0] || "");
      if (!raw) continue;

      const leadingLength = raw.match(/^[("'\x60]+/u)?.[0]?.length || 0;
      const trailingLength = raw.match(/[)"'\x60,.;:!?]+$/u)?.[0]?.length || 0;
      const start = match.index + leadingLength;
      let end = match.index + raw.length - trailingLength;
      if (end <= start) continue;

      const candidate = trimNotesPathTokenAtKnownFileExtension(source.slice(start, end));
      end = start + candidate.length;
      const path = sanitizeNotesPathToken(candidate);
      if (!path || !path.includes("\\")) continue;

      matches.push({ start, end, path });
    }
  }

  matches.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return (right.end - right.start) - (left.end - left.start);
  });

  const deduped = [];
  let cursor = -1;
  for (const match of matches) {
    if (match.start < cursor) continue;
    deduped.push(match);
    cursor = match.end;
  }
  return deduped;
}

export const NOTES_PATH_FILE_EXTENSIONS = LINK_FILE_EXTENSIONS;
