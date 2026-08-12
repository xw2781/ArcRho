import {
  readDfmMethodIdentityFromPage,
  resolveDfmDatasetReferences,
} from "/ui/method_pages/dfm/dfm_method_api.js?v=20260811a";
import {
  findDfmDatasetReferences,
  substituteDfmDatasetReferenceLabels,
  substituteDfmDatasetReferences,
} from "/ui/method_pages/dfm/dfm_dataset_reference.js?v=20260811a";

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
