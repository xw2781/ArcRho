export class DfmDatasetReferenceSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = "DfmDatasetReferenceSyntaxError";
  }
}

function splitCoordinates(raw) {
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
    if (character === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) throw new DfmDatasetReferenceSyntaxError("Dataset reference contains an unclosed quote.");
  parts.push(current.trim());
  return parts;
}

export function findDfmDatasetReferences(rawFormula) {
  const text = String(rawFormula || "");
  const references = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "[") continue;
    const datasetEnd = text.indexOf("]", start + 1);
    if (datasetEnd < 0) continue;
    let coordinateStart = datasetEnd + 1;
    while (/\s/.test(text[coordinateStart] || "")) coordinateStart += 1;
    if (text[coordinateStart] !== "[") continue;

    let quote = "";
    let coordinateEnd = -1;
    for (let index = coordinateStart + 1; index < text.length; index += 1) {
      const character = text[index];
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
    if (coordinateEnd < 0) {
      throw new DfmDatasetReferenceSyntaxError("Dataset reference is missing its closing bracket.");
    }

    const datasetName = text.slice(start + 1, datasetEnd).trim();
    const coordinates = splitCoordinates(text.slice(coordinateStart + 1, coordinateEnd));
    if (!datasetName) throw new DfmDatasetReferenceSyntaxError("Dataset reference name cannot be blank.");
    if (!coordinates[0]) throw new DfmDatasetReferenceSyntaxError("Dataset reference row index is required.");
    if (coordinates.length > 2 || (coordinates.length === 2 && !coordinates[1])) {
      throw new DfmDatasetReferenceSyntaxError(
        "Use [Dataset][row] for a vector or [Dataset][row, col] for a triangle."
      );
    }
    references.push({
      match: text.slice(start, coordinateEnd + 1),
      start,
      end: coordinateEnd + 1,
      datasetName,
      rowIndex: coordinates[0],
      colIndex: coordinates.length === 2 ? coordinates[1] : null,
    });
    start = coordinateEnd;
  }
  return references;
}

export function containsDfmDatasetReference(rawFormula) {
  return findDfmDatasetReferences(rawFormula).length > 0;
}

function insideSingleQuotedSegment(text, index) {
  let quoted = false;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "'") quoted = !quoted;
  }
  return quoted;
}

export function findActiveDfmDatasetNameQuery(rawFormula, caretPosition) {
  const text = String(rawFormula || "");
  const caret = Math.max(0, Math.min(text.length, Number(caretPosition) || 0));
  const open = text.lastIndexOf("[", caret - 1);
  if (open < 0 || text.slice(open + 1, caret).includes("]")) return null;
  if (insideSingleQuotedSegment(text, open)) return null;

  let prior = open - 1;
  while (prior >= 0 && /\s/.test(text[prior])) prior -= 1;
  // A bracket immediately following a completed bracket is the coordinate
  // portion of [Dataset][row, col], not a new dataset-name token.
  if (prior >= 0 && text[prior] === "]") return null;

  return {
    start: open,
    end: caret,
    query: text.slice(open + 1, caret),
  };
}

export function filterDfmDatasetNames(datasetNames, rawQuery) {
  const query = String(rawQuery || "").trim().toLocaleLowerCase();
  const seen = new Set();
  const matches = [];
  for (const rawName of Array.isArray(datasetNames) ? datasetNames : []) {
    const name = String(rawName || "").trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key) || (query && !key.includes(query))) continue;
    seen.add(key);
    matches.push(name);
  }
  return matches.sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function completeDfmDatasetName(rawFormula, activeQuery, datasetName) {
  const text = String(rawFormula || "");
  const start = Number(activeQuery?.start);
  const end = Number(activeQuery?.end);
  const name = String(datasetName || "").trim();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || !name) {
    return null;
  }
  const insertion = `[${name}][`;
  return {
    value: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    caret: start + insertion.length,
  };
}

export function substituteDfmDatasetReferences(rawFormula, references, resolvedResults) {
  const source = String(rawFormula || "");
  const refs = Array.isArray(references) ? references : [];
  const results = Array.isArray(resolvedResults) ? resolvedResults : [];
  if (refs.length !== results.length) throw new Error("Dataset reference response is incomplete.");
  let output = source;
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const value = Number(results[index]?.value);
    if (!Number.isFinite(value)) throw new Error(`Dataset reference ${refs[index].match} is not numeric.`);
    output = `${output.slice(0, refs[index].start)}${value}${output.slice(refs[index].end)}`;
  }
  return output;
}

function resolvedCoordinateLabel(result, key) {
  const label = String(result?.[key] ?? "").trim();
  if (!label) throw new Error("Dataset reference response is missing its resolved label.");
  return label;
}

export function substituteDfmDatasetReferenceLabels(rawFormula, references, resolvedResults) {
  const source = String(rawFormula || "");
  const refs = Array.isArray(references) ? references : [];
  const results = Array.isArray(resolvedResults) ? resolvedResults : [];
  if (refs.length !== results.length) throw new Error("Dataset reference response is incomplete.");
  let output = source;
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const reference = refs[index];
    const result = results[index];
    const rowLabel = resolvedCoordinateLabel(result, "row_label");
    const coordinateLabels = reference.colIndex === null
      ? rowLabel
      : `${rowLabel}, ${resolvedCoordinateLabel(result, "col_label")}`;
    const displayReference = `[${reference.datasetName}][${coordinateLabels}]`;
    output = `${output.slice(0, reference.start)}${displayReference}${output.slice(reference.end)}`;
  }
  return output;
}
