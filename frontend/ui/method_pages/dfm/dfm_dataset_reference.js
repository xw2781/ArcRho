import { findArcRhoFormulaReferences } from "/ui/shared/dataset/dataset_formula.js?v=20260917a";
import { formulaMatrixLiteral } from "/ui/shared/components/formula_bar/formula_api.js?v=20260917a";

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
  const calls = findArcRhoFormulaReferences(text);
  const references = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "[") continue;
    if (calls.some(call => start >= call.start && start < call.end)) continue;
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
  return [...references, ...calls.map(call => ({ ...call, kind: "arcrho" }))].sort((a, b) => a.start - b.start);
}

export function containsDfmDatasetReference(rawFormula) {
  return findDfmDatasetReferences(rawFormula).length > 0;
}

export { completeDfmDatasetName, filterDfmDatasetNames, findActiveDfmDatasetNameQuery } from "/ui/shared/components/formula_bar/formula_completion.js?v=20260917a";

export function substituteDfmDatasetReferences(rawFormula, references, resolvedResults) {
  const source = String(rawFormula || "");
  const refs = Array.isArray(references) ? references : [];
  const results = Array.isArray(resolvedResults) ? resolvedResults : [];
  if (refs.length !== results.length) throw new Error("Dataset reference response is incomplete.");
  let output = source;
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    if (results[index]?.matrix) {
      output = `${output.slice(0, refs[index].start)}${formulaMatrixLiteral(results[index].matrix)}${output.slice(refs[index].end)}`;
      continue;
    }
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
    if (reference.kind === "arcrho") continue;
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
