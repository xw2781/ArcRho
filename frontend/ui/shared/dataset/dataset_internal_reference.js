/*
===============================================================================
Internal Dataset Reference
The standalone reference a Dataset grid cell uses to link its value to a cell
or range of another dataset in the same reserving class. The syntax is the DFM
dataset-reference style extended with an inclusive start:end range:

    =[C 82 - Prior Qtr Selected][1:6]
    =[Paid Claims][2024, 12]
    =[Paid Claims][1:6, 2]

Index semantics (quoted label, 1-based position, negative from the valid
boundary, bare label fallback) are resolved by the app server, which owns them
for DFM references too. This module owns only the client-side shape checks and
the canonical text.
===============================================================================
*/

export const INTERNAL_REFERENCE_SYNTAX_HINT =
  "Use =[Dataset][row] or =[Dataset][start:end] for a vector, and "
  + "=[Dataset][row, col] or =[Dataset][rows, cols] for a triangle.";

function splitQuoteAware(raw, separator) {
  const parts = [];
  let current = "";
  let quote = "";
  for (const character of String(raw || "")) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === separator) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) return null;
  parts.push(current.trim());
  return parts;
}

function parseAxisSpec(raw) {
  const endpoints = splitQuoteAware(raw, ":");
  if (!endpoints || endpoints.length > 2 || !endpoints[0] || (endpoints.length === 2 && !endpoints[1])) {
    return null;
  }
  return {
    start: endpoints[0],
    end: endpoints.length === 2 ? endpoints[1] : null,
  };
}

/**
 * Parse one standalone internal reference.
 * Returns `{ok: true, datasetName, row, col}` or `{ok: false, error}`.
 */
export function parseInternalDatasetReference(rawText) {
  const invalid = (error) => ({ ok: false, error });
  let text = String(rawText || "").trim();
  if (text.startsWith("=")) text = text.slice(1).trimStart();
  if (!text.startsWith("[")) return invalid(INTERNAL_REFERENCE_SYNTAX_HINT);
  const nameEnd = text.indexOf("]", 1);
  if (nameEnd < 0) return invalid("Dataset reference is missing its closing bracket.");
  const datasetName = text.slice(1, nameEnd).trim();
  if (!datasetName) return invalid("Dataset reference name cannot be blank.");
  const remainder = text.slice(nameEnd + 1).trimStart();
  if (!remainder.startsWith("[")) return invalid(INTERNAL_REFERENCE_SYNTAX_HINT);
  let quote = "";
  let coordinateEnd = -1;
  for (let index = 1; index < remainder.length; index += 1) {
    const character = remainder[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "]") {
      coordinateEnd = index;
      break;
    }
  }
  if (coordinateEnd < 0) return invalid("Dataset reference is missing its closing bracket.");
  if (remainder.slice(coordinateEnd + 1).trim()) {
    return invalid(
      `An internal dataset link must be a single standalone reference. ${INTERNAL_REFERENCE_SYNTAX_HINT}`,
    );
  }
  const coordinates = splitQuoteAware(remainder.slice(1, coordinateEnd), ",");
  if (!coordinates) return invalid("Dataset reference contains an unclosed quote.");
  if (!coordinates[0]) return invalid("Dataset reference row index is required.");
  if (coordinates.length > 2 || (coordinates.length === 2 && !coordinates[1])) {
    return invalid(INTERNAL_REFERENCE_SYNTAX_HINT);
  }
  const row = parseAxisSpec(coordinates[0]);
  if (!row) return invalid(`Row range must be one index or start:end. ${INTERNAL_REFERENCE_SYNTAX_HINT}`);
  let col = null;
  if (coordinates.length === 2) {
    col = parseAxisSpec(coordinates[1]);
    if (!col) return invalid(`Column range must be one index or start:end. ${INTERNAL_REFERENCE_SYNTAX_HINT}`);
  }
  return { ok: true, datasetName, row, col };
}

/** True when the draft is a complete, parseable internal reference. */
export function isInternalDatasetReference(rawText) {
  return parseInternalDatasetReference(rawText).ok === true;
}

// The tail of a draft a picked reference may replace: one complete
// `[Dataset][coords]` reference, or one still being typed from its first "[".
const TRAILING_REFERENCE_RE = /\[[^\]]*(?:\](?:\s*\[[^\]]*\]?)?)?\s*$/;
// The tail a picked reference may follow: the formula's "=", an operator, or
// an opening parenthesis, so `=[A][1:6] * ` accepts a pick where Excel would.
const REFERENCE_SLOT_RE = /(?:^=|[-+*/^(])\s*$/;

/**
 * True while the draft has a place for a picked reference: a lone "=", a
 * formula waiting on its next operand, or one whose last operand is a
 * dataset reference that a new pick re-aims. Excel drafts (`='C:\...`) never
 * match, so their commit-on-blur behavior is unchanged.
 */
export function isInternalReferencePickDraft(rawText) {
  const text = String(rawText || "").trim();
  if (!text.startsWith("=")) return false;
  return REFERENCE_SLOT_RE.test(text) || TRAILING_REFERENCE_RE.test(text);
}

/**
 * The draft with `referenceText` (without its leading "=") in the place the
 * pick is aimed at: replacing the trailing dataset reference the way Excel
 * re-aims the reference under the caret, or appended after an operator.
 * Returns "" when the draft has no such place.
 */
export function insertPickedDatasetReference(rawDraft, referenceText) {
  const draft = String(rawDraft || "").trim();
  const reference = String(referenceText || "").replace(/^=/, "");
  if (!draft.startsWith("=") || !reference) return "";
  if (TRAILING_REFERENCE_RE.test(draft)) return draft.replace(TRAILING_REFERENCE_RE, reference);
  if (REFERENCE_SLOT_RE.test(draft)) return `${draft}${/[-+*/^]$/.test(draft) ? " " : ""}${reference}`;
  return "";
}

function axisText(spec) {
  if (!spec) return "";
  return spec.end !== null && spec.end !== undefined && spec.end !== ""
    ? `${spec.start}:${spec.end}`
    : String(spec.start);
}

/** Canonical stored text for a parsed reference. */
export function formatInternalDatasetReference(parsed) {
  if (!parsed?.datasetName) return "";
  let coordinates = axisText(parsed.row);
  if (parsed.col) coordinates = `${coordinates}, ${axisText(parsed.col)}`;
  return `=[${parsed.datasetName}][${coordinates}]`;
}

/** Reference text for a picked source rectangle, in 1-based positions. */
export function buildInternalDatasetReferenceText({
  datasetName,
  rowStart,
  rowEnd,
  colStart = 0,
  colEnd = 0,
  isVector = false,
} = {}) {
  const name = String(datasetName || "").trim();
  const r0 = Number(rowStart);
  const r1 = Number(rowEnd);
  const c0 = Number(colStart);
  const c1 = Number(colEnd);
  if (!name || !Number.isInteger(r0) || !Number.isInteger(r1) || r0 < 0 || r1 < r0) return "";
  const row = { start: r0 + 1, end: r1 > r0 ? r1 + 1 : null };
  const col = isVector && c0 === 0 && c1 === 0
    ? null
    : { start: c0 + 1, end: c1 > c0 ? c1 + 1 : null };
  return formatInternalDatasetReference({ datasetName: name, row, col });
}
