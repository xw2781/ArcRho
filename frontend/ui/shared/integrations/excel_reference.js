// Pure helpers for ArcRho's external Excel-reference syntax.

// Standalone: ='dir\[filename.xlsx]Sheet'!A1 or ...!A1:C3. Excel
// escapes apostrophes inside the quoted source as two apostrophes.
const EXCEL_REFERENCE_RE = /^\s*=?\s*(?:'((?:[^']|'')*)'|([^!]+))!(\$?[A-Z]+\$?[0-9]+)(?::(\$?[A-Z]+\$?[0-9]+))?\s*$/i;

// Inline references retain Excel's surrounding single quotes so paths and
// worksheet names may contain spaces and formula operators remain unambiguous.
const EXCEL_REFERENCE_INLINE_RE = /'((?:[^']|'')*)'!(\$?[A-Z]+\$?[0-9]+)(?::(\$?[A-Z]+\$?[0-9]+))?/gi;
const EXCEL_ADDRESS_AFTER_BANG_RE = /(!\s*\$?)([A-Z]+)(\$?[0-9]+)(?::(\$?)([A-Z]+)(\$?[0-9]+))?/gi;

export function normalizeExcelReferenceAddressCase(value) {
  return String(value || "").replace(
    EXCEL_ADDRESS_AFTER_BANG_RE,
    (_match, startPrefix, startCol, startRow, endDollar, endCol, endRow) => {
      const start = `${startPrefix}${String(startCol).toUpperCase()}${startRow}`;
      const end = endCol ? `:${endDollar || ""}${String(endCol).toUpperCase()}${endRow}` : "";
      return start + end;
    },
  );
}

export function normalizeExcelCellAddress(value) {
  return String(value || "").replace(/\$/g, "").toUpperCase();
}

function parseExcelSource(rawSource) {
  const source = String(rawSource || "").trim().replace(/''/g, "'");
  const openBracket = source.indexOf("[");
  const closeBracket = source.indexOf("]", openBracket + 1);
  if (openBracket < 0 || closeBracket <= openBracket + 1 || closeBracket >= source.length - 1) {
    return null;
  }
  const dir = source.slice(0, openBracket);
  const filename = source.slice(openBracket + 1, closeBracket);
  const sheet = source.slice(closeBracket + 1);
  return { bookPath: dir + filename, dir, filename, sheet };
}

export function parseExcelReference(text) {
  const match = EXCEL_REFERENCE_RE.exec(String(text || ""));
  if (!match) return null;
  const source = parseExcelSource(match[1] ?? match[2]);
  if (!source) return null;
  const cell = normalizeExcelCellAddress(match[3]);
  const endCell = normalizeExcelCellAddress(match[4] || match[3]);
  return {
    ...source,
    cell,
    endCell,
  };
}

export function findExcelReferences(text) {
  const source = String(text || "");
  const references = [];
  EXCEL_REFERENCE_INLINE_RE.lastIndex = 0;
  let match;
  while ((match = EXCEL_REFERENCE_INLINE_RE.exec(source)) !== null) {
    const parsedSource = parseExcelSource(match[1]);
    if (!parsedSource) continue;
    references.push({
      match: match[0],
      ...parsedSource,
      cell: normalizeExcelCellAddress(match[2]),
      endCell: normalizeExcelCellAddress(match[3] || match[2]),
    });
  }
  if (references.length) return references;

  // Preserve support for the optional-quote standalone form. The inline
  // syntax intentionally requires quotes because unquoted paths cannot be
  // distinguished safely from surrounding formula operators.
  const standalone = parseExcelReference(source);
  if (!standalone) return references;
  const standaloneMatch = source.trim().replace(/^=\s*/, "");
  references.push({ match: standaloneMatch, ...standalone });
  return references;
}

export function containsExcelReference(text) {
  const source = String(text || "");
  if (parseExcelReference(source)) return true;
  EXCEL_REFERENCE_INLINE_RE.lastIndex = 0;
  return EXCEL_REFERENCE_INLINE_RE.test(source);
}

export function formatExcelReference(bookPath, sheet, cell, endCell = "") {
  const path = String(bookPath || "");
  const lastSeparator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dir = lastSeparator >= 0 ? path.slice(0, lastSeparator + 1) : "";
  const filename = lastSeparator >= 0 ? path.slice(lastSeparator + 1) : path;
  const startAddress = String(cell || "");
  const finishAddress = String(endCell || "");
  const address = finishAddress && normalizeExcelCellAddress(finishAddress) !== normalizeExcelCellAddress(startAddress)
    ? `${startAddress}:${finishAddress}`
    : startAddress;
  const source = `${dir}[${filename}]${String(sheet || "")}`.replace(/'/g, "''");
  return normalizeExcelReferenceAddressCase(`='${source}'!${address}`);
}

export function excelColumnToIndex(column) {
  const text = String(column || "").toUpperCase();
  let value = 0;
  for (const character of text) {
    const digit = character.charCodeAt(0) - 64;
    if (digit < 1 || digit > 26) return -1;
    value = value * 26 + digit;
  }
  return value - 1;
}

export function excelColumnFromIndex(index) {
  let value = Number(index) + 1;
  if (!Number.isInteger(value) || value <= 0) return "";
  let column = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

export function parseExcelCellAddress(value) {
  const match = /^([A-Z]+)([1-9][0-9]*)$/i.exec(normalizeExcelCellAddress(value));
  if (!match) return null;
  const col = excelColumnToIndex(match[1]);
  const row = Number(match[2]) - 1;
  return Number.isInteger(col) && col >= 0 && Number.isInteger(row) && row >= 0
    ? { row, col }
    : null;
}

export function parseStandaloneExcelRange(raw) {
  const reference = parseExcelReference(raw);
  if (!reference || reference.cell === reference.endCell) return null;
  const start = parseExcelCellAddress(reference.cell);
  const end = parseExcelCellAddress(reference.endCell);
  if (!start || !end) return null;
  const row0 = Math.min(start.row, end.row);
  const row1 = Math.max(start.row, end.row);
  const col0 = Math.min(start.col, end.col);
  const col1 = Math.max(start.col, end.col);
  return {
    ...reference,
    rowCount: row1 - row0 + 1,
    colCount: col1 - col0 + 1,
    row0,
    col0,
  };
}

export function buildExcelRangeSourceCells(range) {
  const cells = [];
  for (let rowOffset = 0; rowOffset < range.rowCount; rowOffset++) {
    const row = [];
    for (let colOffset = 0; colOffset < range.colCount; colOffset++) {
      row.push(`${excelColumnFromIndex(range.col0 + colOffset)}${range.row0 + rowOffset + 1}`);
    }
    cells.push(row);
  }
  return cells;
}
