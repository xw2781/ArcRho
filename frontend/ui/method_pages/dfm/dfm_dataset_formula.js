import {
  readDfmMethodIdentityFromPage,
  resolveDfmDatasetReferences,
} from "/ui/method_pages/dfm/dfm_method_api.js?v=20260814b";
import {
  findDfmDatasetReferences,
  substituteDfmDatasetReferenceLabels,
  substituteDfmDatasetReferences,
} from "/ui/method_pages/dfm/dfm_dataset_reference.js?v=20260811b";

// Last-resolved dataset-reference values for this page session, keyed by
// project, reserving class, and the reference text exactly as stored in the
// formula. Synchronous summary recalculation reuses these values when a
// referenced average-formula row changes, without a new precedent read.
const resolvedDatasetReferenceValues = new Map();

function datasetReferenceCacheKey(identity, referenceMatch) {
  return `${identity.project_name}\u001f${identity.reserving_class}\u001f${referenceMatch}`;
}

export function substituteCachedDfmDatasetReferencesInFormula(rawFormula) {
  const formula = String(rawFormula || "");
  let references;
  try {
    references = findDfmDatasetReferences(formula);
  } catch {
    return { ok: false, formula };
  }
  if (!references.length) return { ok: true, formula };
  const identity = readDfmMethodIdentityFromPage();
  if (!identity.project_name || !identity.reserving_class) return { ok: false, formula };
  const resolvedResults = [];
  for (const reference of references) {
    const cached = resolvedDatasetReferenceValues.get(datasetReferenceCacheKey(identity, reference.match));
    if (!Number.isFinite(cached)) return { ok: false, formula };
    resolvedResults.push({ value: cached });
  }
  return { ok: true, formula: substituteDfmDatasetReferences(formula, references, resolvedResults) };
}

/**
 * Session-cached values for the dataset references in one formula, in the order
 * the references appear. An entry is null when that reference has not resolved
 * yet, so a caller can tell "value not known" apart from a resolved zero, and
 * the result is empty when the formula holds no readable reference at all.
 */
export function getCachedDfmDatasetReferenceValues(rawFormula) {
  let references;
  try {
    references = findDfmDatasetReferences(String(rawFormula || ""));
  } catch {
    return [];
  }
  if (!references.length) return [];
  const identity = readDfmMethodIdentityFromPage();
  if (!identity.project_name || !identity.reserving_class) return references.map(() => null);
  return references.map((reference) => {
    const cached = resolvedDatasetReferenceValues.get(datasetReferenceCacheKey(identity, reference.match));
    return Number.isFinite(cached) ? cached : null;
  });
}

export async function resolveDfmDatasetReferencesInFormulasDetailed(rawFormulas, options = {}) {
  const formulas = Array.isArray(rawFormulas) ? rawFormulas.map((value) => String(value || "")) : [];
  const parsedByFormula = formulas.map((formula) => findDfmDatasetReferences(formula));
  const references = parsedByFormula.flat();
  if (!references.length) {
    return formulas.map((formula) => ({
      formula,
      resolvedFormula: formula,
      displayFormula: formula,
    }));
  }

  const identity = readDfmMethodIdentityFromPage();
  if (!identity.project_name || !identity.reserving_class) {
    throw new Error("Project and reserving class are required to resolve dataset references.");
  }
  const response = await resolveDfmDatasetReferences({
    project_name: identity.project_name,
    reserving_class: identity.reserving_class,
    references: references.map((reference) => ({
      dataset_name: reference.datasetName,
      row_idx: reference.rowIndex,
      ...(reference.colIndex ? { col_idx: reference.colIndex } : {}),
    })),
  }, options);
  const results = Array.isArray(response?.results) ? response.results : [];
  references.forEach((reference, index) => {
    const value = Number(results[index]?.value);
    if (Number.isFinite(value)) {
      resolvedDatasetReferenceValues.set(datasetReferenceCacheKey(identity, reference.match), value);
    }
  });
  let resultOffset = 0;
  return formulas.map((formula, formulaIndex) => {
    const formulaReferences = parsedByFormula[formulaIndex];
    const formulaResults = results.slice(resultOffset, resultOffset + formulaReferences.length);
    resultOffset += formulaReferences.length;
    return {
      formula,
      resolvedFormula: substituteDfmDatasetReferences(formula, formulaReferences, formulaResults),
      displayFormula: substituteDfmDatasetReferenceLabels(formula, formulaReferences, formulaResults),
    };
  });
}

export async function resolveDfmDatasetReferencesInFormulas(rawFormulas, options = {}) {
  const resolved = await resolveDfmDatasetReferencesInFormulasDetailed(rawFormulas, options);
  return resolved.map((item) => item.resolvedFormula);
}

export async function resolveDfmDatasetReferencesInFormula(rawFormula, options = {}) {
  const [resolved] = await resolveDfmDatasetReferencesInFormulas([rawFormula], options);
  return resolved;
}

export async function resolveDfmDatasetReferencesInFormulaDetailed(rawFormula, options = {}) {
  const [resolved] = await resolveDfmDatasetReferencesInFormulasDetailed([rawFormula], options);
  return resolved;
}
